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
    this.socket = this.options.createSocket(this.options.url)

    this.socket.onopen = () => {
      this.emit('open', undefined)
    }

    this.socket.onmessage = (event) => {
      try {
        this.emit('message', parseEvent(event.data))
      } catch (error) {
        this.emit('error', error)
      }
    }

    this.socket.onerror = (event) => {
      this.emit('error', event)
    }

    this.socket.onclose = (event) => {
      this.emit('close', event)
    }
  }

  send(event: RemoteAcpxEvent): void {
    if (!this.socket) {
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
    this.socket?.close(code, reason)
    this.socket = undefined
  }

  private emit<K extends keyof ClientEventMap>(eventName: K, payload: ClientEventMap[K]): void {
    for (const handler of this.listeners[eventName]) {
      handler(payload)
    }
  }
}