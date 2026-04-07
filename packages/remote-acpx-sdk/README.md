# `@claw-agent-broker/remote-acpx-sdk`

Shared protocol and transport helpers for remote ACP session events.

- Traditional Chinese README: [`README.zh-TW.md`](./README.zh-TW.md)

## Scope

This package provides:

- shared event types
- JSON serialize/parse helpers
- runtime validation and type guards
- a thin client wrapper for event transport
- request correlation helpers for pairing outbound requests with streamed responses

This package does **not** include:

- CLI adapters
- session management
- gateway routing logic
- auth / pairing policy

## Planned files

```text
src/
  index.ts
  types.ts
  events.ts
  errors.ts
  client.ts
  correlation.ts
```

## Request correlation example

```ts
import {
  RequestCorrelator,
  createSessionPromptEvent,
  ensureRequestId,
} from './src/index.js'

const correlator = new RequestCorrelator({ timeoutMs: 30_000 })

const request = ensureRequestId(
  createSessionPromptEvent({
    sessionId: 'session-1',
    nodeId: 'node-a',
    prompt: 'continue working',
  }),
)

const pending = correlator.track(request)

// Later, when a message arrives from the remote node:
correlator.handle({
  type: 'session/output',
  sessionId: 'session-1',
  nodeId: 'node-a',
  requestId: request.requestId,
  chunk: 'done',
  done: true,
})

const result = await pending.waitForCompletion()
console.log(result.finalEvent.type)
```

## Example

```ts
import { RemoteAcpxClient, createSessionNewEvent } from './src/index.js'

const client = new RemoteAcpxClient({
  url: 'ws://localhost:8080',
  createSocket: (url) => new WebSocket(url),
})

client.on('message', (event) => {
  console.log(event.type)
})

await client.connect()

client.send(
  createSessionNewEvent({
    sessionId: 'session-1',
    nodeId: 'node-a',
    cli: 'claude-code',
    workdir: '/tmp/project',
  }),
)
```
