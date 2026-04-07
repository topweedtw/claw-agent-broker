const test = require('node:test')
const assert = require('node:assert/strict')

const {
  RemoteAcpxClient,
  createSessionEndEvent,
  createSessionNewEvent,
  createSessionPromptEvent,
} = require('../dist/index.js')

class MockSocket {
  constructor() {
    this.sent = []
    this.onopen = undefined
    this.onmessage = undefined
    this.onerror = undefined
    this.onclose = undefined
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {}
}

test('smoke flow covers new -> prompt -> output -> end', async () => {
  const socket = new MockSocket()
  const client = new RemoteAcpxClient({
    url: 'ws://example.test',
    createSocket: () => socket,
  })

  const received = []
  client.on('message', (event) => {
    received.push(event)
  })

  const connectPromise = client.connect()
  socket.onopen()
  await connectPromise

  client.send(
    createSessionNewEvent({
      sessionId: 'session-1',
      nodeId: 'node-a',
      cli: 'claude-code',
      workdir: '/tmp/project',
      initialPrompt: 'start work',
    }),
  )

  client.send(
    createSessionPromptEvent({
      sessionId: 'session-1',
      nodeId: 'node-a',
      prompt: 'continue',
    }),
  )

  socket.onmessage({
    data: JSON.stringify({
      type: 'session/output',
      sessionId: 'session-1',
      nodeId: 'node-a',
      chunk: 'partial result',
      done: false,
      stream: 'stdout',
    }),
  })

  socket.onmessage({
    data: JSON.stringify({
      type: 'session/output',
      sessionId: 'session-1',
      nodeId: 'node-a',
      chunk: 'final result',
      done: true,
      stream: 'stdout',
    }),
  })

  client.send(
    createSessionEndEvent({
      sessionId: 'session-1',
      nodeId: 'node-a',
      exitCode: 0,
      reason: 'completed',
    }),
  )

  assert.equal(socket.sent.length, 3)
  assert.equal(socket.sent[0].type, 'session/new')
  assert.equal(socket.sent[1].type, 'session/prompt')
  assert.equal(socket.sent[2].type, 'session/end')

  assert.equal(received.length, 2)
  assert.equal(received[0].type, 'session/output')
  assert.equal(received[0].done, false)
  assert.equal(received[1].type, 'session/output')
  assert.equal(received[1].done, true)
  assert.equal(received[1].chunk, 'final result')
})