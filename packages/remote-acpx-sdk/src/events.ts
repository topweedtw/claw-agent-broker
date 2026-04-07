import { ProtocolError, ValidationError } from './errors.js'
import type {
  RemoteAcpxEvent,
  SessionEndEvent,
  SessionErrorEvent,
  SessionNewEvent,
  SessionOutputEvent,
  SessionPromptEvent,
} from './types.js'

const EVENT_TYPES = new Set([
  'session/new',
  'session/prompt',
  'session/output',
  'session/end',
  'session/error',
] as const)

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === 'number'
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function hasBaseFields(value: unknown): value is UnknownRecord {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.nodeId === 'string' &&
    isOptionalString(value.requestId) &&
    isOptionalString(value.ts) &&
    isOptionalNumber(value.version)
  )
}

export function serializeEvent(event: RemoteAcpxEvent): string {
  return JSON.stringify(event)
}

export function parseEvent(raw: string | unknown): RemoteAcpxEvent {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw

  if (!isRemoteAcpxEvent(parsed)) {
    throw new ValidationError('Invalid remote ACPX event payload', parsed)
  }

  return parsed
}

export function assertRemoteAcpxEvent(value: unknown): asserts value is RemoteAcpxEvent {
  if (!isRemoteAcpxEvent(value)) {
    throw new ProtocolError('Expected a valid remote ACPX event', value)
  }
}

export function isRemoteAcpxEvent(value: unknown): value is RemoteAcpxEvent {
  if (!hasBaseFields(value) || !EVENT_TYPES.has(value.type as RemoteAcpxEvent['type'])) {
    return false
  }

  switch (value.type) {
    case 'session/new':
      return (
        typeof value.cli === 'string' &&
        typeof value.workdir === 'string' &&
        (value.env === undefined || isStringRecord(value.env)) &&
        isOptionalString(value.initialPrompt)
      )
    case 'session/prompt':
      return typeof value.prompt === 'string'
    case 'session/output':
      return (
        typeof value.chunk === 'string' &&
        typeof value.done === 'boolean' &&
        (value.stream === undefined || value.stream === 'stdout' || value.stream === 'stderr')
      )
    case 'session/end':
      return isOptionalNumber(value.exitCode) && isOptionalString(value.reason)
    case 'session/error':
      return (
        typeof value.code === 'string' &&
        typeof value.message === 'string' &&
        isOptionalBoolean(value.retryable)
      )
    default:
      return false
  }
}

export function isSessionNewEvent(value: unknown): value is SessionNewEvent {
  return isRemoteAcpxEvent(value) && value.type === 'session/new'
}

export function isSessionPromptEvent(value: unknown): value is SessionPromptEvent {
  return isRemoteAcpxEvent(value) && value.type === 'session/prompt'
}

export function isSessionOutputEvent(value: unknown): value is SessionOutputEvent {
  return isRemoteAcpxEvent(value) && value.type === 'session/output'
}

export function isSessionEndEvent(value: unknown): value is SessionEndEvent {
  return isRemoteAcpxEvent(value) && value.type === 'session/end'
}

export function isSessionErrorEvent(value: unknown): value is SessionErrorEvent {
  return isRemoteAcpxEvent(value) && value.type === 'session/error'
}