export class RemoteAcpxError extends Error {
  readonly details?: unknown

  constructor(message: string, details?: unknown) {
    super(message)
    this.name = new.target.name
    this.details = details
  }
}

export class ConnectionError extends RemoteAcpxError {}

export class TimeoutError extends RemoteAcpxError {}

export class NodeOfflineError extends RemoteAcpxError {}

export class ProtocolError extends RemoteAcpxError {}

export class ValidationError extends RemoteAcpxError {}