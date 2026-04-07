export type RemoteAcpxEventType =
  | 'session/new'
  | 'session/prompt'
  | 'session/output'
  | 'session/end'
  | 'session/error'

export type RemoteCliKind = 'claude-code' | 'kiro' | (string & {})

export interface BaseEvent {
  type: RemoteAcpxEventType
  sessionId: string
  nodeId: string
  requestId?: string
  ts?: string
  version?: number
}

export interface SessionNewEvent extends BaseEvent {
  type: 'session/new'
  cli: RemoteCliKind
  workdir: string
  env?: Record<string, string>
  initialPrompt?: string
}

export interface SessionPromptEvent extends BaseEvent {
  type: 'session/prompt'
  prompt: string
}

export interface SessionOutputEvent extends BaseEvent {
  type: 'session/output'
  chunk: string
  done: boolean
  stream?: 'stdout' | 'stderr'
}

export interface SessionEndEvent extends BaseEvent {
  type: 'session/end'
  exitCode?: number
  reason?: string
}

export interface SessionErrorEvent extends BaseEvent {
  type: 'session/error'
  code: string
  message: string
  retryable?: boolean
  details?: unknown
}

export type RemoteAcpxEvent =
  | SessionNewEvent
  | SessionPromptEvent
  | SessionOutputEvent
  | SessionEndEvent
  | SessionErrorEvent

export type RemoteAcpxEventHandler<TEvent extends RemoteAcpxEvent = RemoteAcpxEvent> = (
  event: TEvent,
) => void

export interface BaseEventFields {
  sessionId: string
  nodeId: string
  requestId?: string
  ts?: string
  version?: number
}

export function createSessionNewEvent(
  fields: BaseEventFields & Omit<SessionNewEvent, keyof BaseEvent>,
): SessionNewEvent {
  return {
    type: 'session/new',
    ...fields,
  }
}

export function createSessionPromptEvent(
  fields: BaseEventFields & Omit<SessionPromptEvent, keyof BaseEvent>,
): SessionPromptEvent {
  return {
    type: 'session/prompt',
    ...fields,
  }
}

export function createSessionOutputEvent(
  fields: BaseEventFields & Omit<SessionOutputEvent, keyof BaseEvent>,
): SessionOutputEvent {
  return {
    type: 'session/output',
    ...fields,
  }
}

export function createSessionEndEvent(
  fields: BaseEventFields & Omit<SessionEndEvent, keyof BaseEvent>,
): SessionEndEvent {
  return {
    type: 'session/end',
    ...fields,
  }
}

export function createSessionErrorEvent(
  fields: BaseEventFields & Omit<SessionErrorEvent, keyof BaseEvent>,
): SessionErrorEvent {
  return {
    type: 'session/error',
    ...fields,
  }
}
