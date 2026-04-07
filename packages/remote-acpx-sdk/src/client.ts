import { ConnectionError } from './errors.js'
import { parseEvent, serializeEvent } from './events.js'
import type { RemoteAcpxEvent } from './types.js'

export interface SocketMessageEvent {
  data: string
}

export interface RemoteAcpxSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen?: () => void
  onmessage?: (event: SocketMessageEvent) => void
  onerror?: (event?: unknown) => void
  onclose?: (event?: unknown) => void
}

export type RemoteAcpxSocketFactory = (url: string) => RemoteAcpxSocket

export interface RemoteAcpxClientOptions {
  url: string
  createSocket: RemoteAcpxSocketFactory
}

type ClientEventMap = {
  open: void
  message: RemoteAcpxEvent
  error: unknown
  close: unknown
}

export class RemoteAcpxClient {
  private socket?: RemoteAcpxSocket
  private isOpen = false
  private connectPromise?: Promise<void>
  private readonly listeners: {
    [K in keyof ClientEventMap]: Set<(payload: ClientEventMap[K]) => void>
  } = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  }

  constructor(private readonly options: RemoteAcpxClientOptions) {}

  async connect(): Promise<void> {
    if (this.isOpen) {
      return
    }

    if (this.connectPromise) {
      return this.connectPromise
    }

    let socket: RemoteAcpxSocket

    try {
      socket = this.options.createSocket(this.options.url)
    } catch (error) {
      throw new ConnectionError('Failed to create remote ACPX socket', error)
    }

    this.socket = socket

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false

      const rejectConnection = (message: string, details?: unknown) => {
        if (settled) {
          return
        }

        settled = true
        this.isOpen = false
        this.socket = undefined
        this.connectPromise = undefined

        const error = new ConnectionError(message, details)
        this.emit('error', error)
        reject(error)
      }

      socket.onopen = () => {
        settled = true
        this.isOpen = true
        this.connectPromise = undefined
        this.emit('open', undefined)
        resolve()
      }

      socket.onmessage = (event) => {
        try {
          this.emit('message', parseEvent(event.data))
        } catch (error) {
          this.emit('error', error)
        }
      }

      socket.onerror = (event) => {
        if (!settled) {
          rejectConnection('Failed to open remote ACPX socket', event)
          return
        }

        this.emit('error', event)
      }

      socket.onclose = (event) => {
        const wasOpen = this.isOpen
        this.isOpen = false
        this.socket = undefined
        this.connectPromise = undefined

        if (!settled) {
          rejectConnection('RemoteAcpxClient closed before opening', event)
          return
        }

        if (wasOpen) {
          this.emit('close', event)
        }
      }
    })

    return this.connectPromise
  }

  send(event: RemoteAcpxEvent): void {
    if (!this.socket || !this.isOpen) {
      throw new ConnectionError('RemoteAcpxClient is not connected')
    }

    this.socket.send(serializeEvent(event))
  }

  on<K extends keyof ClientEventMap>(
    eventName: K,
    handler: (payload: ClientEventMap[K]) => void,
  ): () => void {
    this.listeners[eventName].add(handler)

    return () => {
      this.listeners[eventName].delete(handler)
    }
  }

  close(code?: number, reason?: string): void {
    const socket = this.socket

    this.isOpen = false
    this.connectPromise = undefined
    this.socket = undefined

    socket?.close(code, reason)
  }

  private emit<K extends keyof ClientEventMap>(eventName: K, payload: ClientEventMap[K]): void {
    for (const handler of this.listeners[eventName]) {
      handler(payload)
    }
  }
}