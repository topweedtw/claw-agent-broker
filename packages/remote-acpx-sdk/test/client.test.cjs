const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ConnectionError,
  RemoteAcpxClient,
  createSessionPromptEvent,
} = require('../dist/index.js')

class MockSocket {
  constructor() {
    this.sent = []
    this.closed = []
    this.onopen = undefined
    this.onmessage = undefined
    this.onerror = undefined
    this.onclose = undefined
  }

  open() {
    this.onopen && this.onopen()
  }

  fail(error = new Error('socket error')) {
    this.onerror && this.onerror(error)
  }

  send(data) {
    this.sent.push(data)
  }

  close(code, reason) {
    this.closed.push({ code, reason })
  }
}

test('send throws before connect', () => {
  const client = new RemoteAcpxClient({
    url: 'ws://example.test',
    createSocket: () => new MockSocket(),
  })

  assert.throws(
    () =>
      client.send(
        createSessionPromptEvent({
          sessionId: 'session-1',
          nodeId: 'node-a',
          prompt: 'hello',
        }),
      ),
    ConnectionError,
  )
})

test('connect resolves only after the socket opens', async () => {
  const socket = new MockSocket()
  const client = new RemoteAcpxClient({
    url: 'ws://example.test',
    createSocket: () => socket,
  })

  let resolved = false
  const connectPromise = client.connect().then(() => {
    resolved = true
  })

  await Promise.resolve()
  assert.equal(resolved, false)

  socket.open()
  await connectPromise
  assert.equal(resolved, true)
})

test('connect rejects when the socket errors before opening', async () => {
  const socket = new MockSocket()
  const client = new RemoteAcpxClient({
    url: 'ws://example.test',
    createSocket: () => socket,
  })

  const connectPromise = client.connect()
  socket.fail(new Error('boom'))

  await assert.rejects(connectPromise, ConnectionError)
})

test('client sends serialized events and emits parsed messages', async () => {
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
  socket.open()
  await connectPromise

  const outbound = createSessionPromptEvent({
    sessionId: 'session-1',
    nodeId: 'node-a',
    prompt: 'ship it',
  })

  client.send(outbound)
  assert.equal(socket.sent.length, 1)
  assert.match(socket.sent[0], /"type":"session\/prompt"/)

  socket.onmessage({
    data: JSON.stringify({
      type: 'session/output',
      sessionId: 'session-1',
      nodeId: 'node-a',
      chunk: 'done',
      done: true,
    }),
  })

  assert.equal(received.length, 1)
  assert.equal(received[0].type, 'session/output')
  assert.equal(received[0].chunk, 'done')
})
