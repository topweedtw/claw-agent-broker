# `@claw-agent-broker/remote-acpx-sdk`

Shared protocol and transport helpers for remote ACP session events.

## Scope

This package provides:

- shared event types
- JSON serialize/parse helpers
- runtime validation and type guards
- a thin client wrapper for event transport

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
