import { ProtocolError, RemoteAcpxError, TimeoutError } from './errors.js'
import type {
  BaseEvent,
  RemoteAcpxEvent,
  RemoteAcpxEventType,
  SessionEndEvent,
  SessionErrorEvent,
  SessionOutputEvent,
} from './types.js'

export interface CorrelationSelector {
  requestId?: string
  sessionId?: string
  nodeId?: string
  types?: Iterable<RemoteAcpxEventType>
}

export type RequestScopedEvent = Pick<BaseEvent, 'sessionId' | 'nodeId' | 'requestId'> & {
  type?: RemoteAcpxEventType
}

export type RequestAwareEvent<TEvent extends RemoteAcpxEvent = RemoteAcpxEvent> = TEvent & {
  requestId: string
}

export interface PendingRequestSnapshot<TRequest extends RemoteAcpxEvent = RemoteAcpxEvent> {
  requestId: string
  request: RequestAwareEvent<TRequest>
  sessionId: string
  nodeId: string
  requestType: TRequest['type']
  createdAt: number
  lastEventAt: number
  outputs: SessionOutputEvent[]
  settled: boolean
}

export interface CorrelatedRequestResult<TRequest extends RemoteAcpxEvent = RemoteAcpxEvent>
  extends PendingRequestSnapshot<TRequest> {
  settled: true
  finalEvent: SessionOutputEvent | SessionEndEvent
}

export interface TrackRequestOptions {
  timeoutMs?: number
}

export interface RequestCorrelatorOptions {
  timeoutMs?: number
  now?: () => number
  createRequestId?: (prefix?: string) => string
}

export interface PendingRequestHandle<TRequest extends RemoteAcpxEvent = RemoteAcpxEvent> {
  requestId: string
  request: RequestAwareEvent<TRequest>
  waitForCompletion(): Promise<CorrelatedRequestResult<TRequest>>
  getSnapshot(): PendingRequestSnapshot<TRequest>
  cancel(reason?: string): void
}

interface PendingEntry<TRequest extends RemoteAcpxEvent = RemoteAcpxEvent> {
  snapshot: PendingRequestSnapshot<TRequest>
  completion: Promise<CorrelatedRequestResult<TRequest>>
  resolve: (result: CorrelatedRequestResult<TRequest>) => void
  reject: (reason: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

export class RequestCorrelationError extends RemoteAcpxError {
  readonly event: SessionErrorEvent

  constructor(event: SessionErrorEvent) {
    super(
      `Remote request ${event.requestId ?? 'unknown'} failed with ${event.code}: ${event.message}`,
      event,
    )
    this.event = event
  }
}

export function createRequestId(prefix = 'req'): string {
  const safePrefix = prefix.trim() || 'req'

  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${safePrefix}-${globalThis.crypto.randomUUID()}`
  }

  return `${safePrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function withRequestId<TEvent extends RemoteAcpxEvent>(
  event: TEvent,
  requestId = createRequestId(),
): RequestAwareEvent<TEvent> {
  return {
    ...event,
    requestId,
  }
}

export function ensureRequestId<TEvent extends RemoteAcpxEvent>(
  event: TEvent,
  prefix = 'req',
): RequestAwareEvent<TEvent> {
  if (typeof event.requestId === 'string' && event.requestId.length > 0) {
    return event as RequestAwareEvent<TEvent>
  }

  return withRequestId(event, createRequestId(prefix))
}

export function getCorrelationKey(event: RequestScopedEvent): string {
  return `${event.nodeId}:${event.sessionId}:${event.requestId ?? '*'}`
}

export function matchesRequest(event: RequestScopedEvent, selector: CorrelationSelector): boolean {
  if (selector.requestId !== undefined && event.requestId !== selector.requestId) {
    return false
  }

  if (selector.sessionId !== undefined && event.sessionId !== selector.sessionId) {
    return false
  }

  if (selector.nodeId !== undefined && event.nodeId !== selector.nodeId) {
    return false
  }

  if (selector.types !== undefined) {
    if (event.type === undefined) {
      return false
    }

    const typeSet = selector.types instanceof Set ? selector.types : new Set(selector.types)
    if (!typeSet.has(event.type)) {
      return false
    }
  }

  return true
}

export class RequestCorrelator {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(private readonly options: RequestCorrelatorOptions = {}) {}

  track<TRequest extends RemoteAcpxEvent>(
    event: TRequest,
    options: TrackRequestOptions = {},
  ): PendingRequestHandle<TRequest> {
    const request = ensureRequestId(
      event,
      typeof event.type === 'string' ? event.type.replace(/[^a-z0-9]+/gi, '-') : 'req',
    )

    if (this.pending.has(request.requestId)) {
      throw new ProtocolError(`Request ID "${request.requestId}" is already being tracked`, request)
    }

    const now = this.now()
    let resolve!: (result: CorrelatedRequestResult<TRequest>) => void
    let reject!: (reason: unknown) => void

    const snapshot: PendingRequestSnapshot<TRequest> = {
      requestId: request.requestId,
      request,
      sessionId: request.sessionId,
      nodeId: request.nodeId,
      requestType: request.type,
      createdAt: now,
      lastEventAt: now,
      outputs: [],
      settled: false,
    }

    const completion = new Promise<CorrelatedRequestResult<TRequest>>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })

    const entry: PendingEntry<TRequest> = {
      snapshot,
      completion,
      resolve,
      reject,
    }

    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs
    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        this.rejectRequest(
          request.requestId,
          new TimeoutError(`Timed out waiting for remote response for request "${request.requestId}"`, {
            timeoutMs,
            requestId: request.requestId,
            sessionId: request.sessionId,
            nodeId: request.nodeId,
          }),
        )
      }, timeoutMs)
    }

    this.pending.set(request.requestId, entry as unknown as PendingEntry<RemoteAcpxEvent>)

    return {
      requestId: request.requestId,
      request,
      waitForCompletion: () => completion,
      getSnapshot: () => this.cloneSnapshot(entry.snapshot),
      cancel: (reason?: string) => {
        this.rejectRequest(
          request.requestId,
          new RemoteAcpxError(reason ? `Request correlation cancelled: ${reason}` : 'Request correlation cancelled', {
            requestId: request.requestId,
            sessionId: request.sessionId,
            nodeId: request.nodeId,
          }),
        )
      },
    }
  }

  handle(event: RemoteAcpxEvent): boolean {
    if (!event.requestId) {
      return false
    }

    const entry = this.pending.get(event.requestId)
    if (!entry) {
      return false
    }

    if (
      !matchesRequest(event, {
        requestId: entry.snapshot.requestId,
        sessionId: entry.snapshot.sessionId,
        nodeId: entry.snapshot.nodeId,
      })
    ) {
      return false
    }

    entry.snapshot.lastEventAt = this.now()

    switch (event.type) {
      case 'session/output':
        entry.snapshot.outputs.push(event)
        if (event.done) {
          this.resolveRequest(event.requestId, event)
        }
        return true
      case 'session/end':
        this.resolveRequest(event.requestId, event)
        return true
      case 'session/error':
        this.rejectRequest(event.requestId, new RequestCorrelationError(event))
        return true
      default:
        return true
    }
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  getPending<TRequest extends RemoteAcpxEvent = RemoteAcpxEvent>(
    requestId: string,
  ): PendingRequestSnapshot<TRequest> | undefined {
    const entry = this.pending.get(requestId)
    return entry ? (this.cloneSnapshot(entry.snapshot) as PendingRequestSnapshot<TRequest>) : undefined
  }

  clear(reason = 'Request correlation cleared'): void {
    for (const requestId of this.pending.keys()) {
      this.rejectRequest(requestId, new RemoteAcpxError(reason, { requestId }))
    }
  }

  private resolveRequest(requestId: string, finalEvent: SessionOutputEvent | SessionEndEvent): void {
    const entry = this.pending.get(requestId)
    if (!entry) {
      return
    }

    this.pending.delete(requestId)
    if (entry.timer) {
      clearTimeout(entry.timer)
    }

    entry.snapshot.settled = true
    entry.snapshot.lastEventAt = this.now()

    entry.resolve({
      ...this.cloneSnapshot(entry.snapshot),
      settled: true,
      finalEvent,
    })
  }

  private rejectRequest(requestId: string, reason: unknown): void {
    const entry = this.pending.get(requestId)
    if (!entry) {
      return
    }

    this.pending.delete(requestId)
    if (entry.timer) {
      clearTimeout(entry.timer)
    }

    entry.snapshot.settled = true
    entry.snapshot.lastEventAt = this.now()
    entry.reject(reason)
  }

  private cloneSnapshot<TRequest extends RemoteAcpxEvent>(
    snapshot: PendingRequestSnapshot<TRequest>,
  ): PendingRequestSnapshot<TRequest> {
    return {
      ...snapshot,
      request: { ...snapshot.request },
      outputs: [...snapshot.outputs],
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
