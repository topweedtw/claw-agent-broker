const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assertRemoteAcpxEvent,
  createSessionNewEvent,
  isSessionEndEvent,
  isSessionErrorEvent,
  isSessionNewEvent,
  isSessionOutputEvent,
  parseEvent,
  ProtocolError,
  serializeEvent,
  ValidationError,
} = require('../dist/index.js')

test('serializeEvent and parseEvent round-trip a session/new event', () => {
  const event = createSessionNewEvent({
    sessionId: 'session-1',
    nodeId: 'node-a',
    cli: 'claude-code',
    workdir: '/tmp/project',
    initialPrompt: 'hello',
  })

  const raw = serializeEvent(event)
  const parsed = parseEvent(raw)

  assert.deepStrictEqual(parsed, event)
  assert.equal(isSessionNewEvent(parsed), true)
})

test('parseEvent rejects invalid payloads', () => {
  assert.throws(
    () => parseEvent(JSON.stringify({ type: 'session/new', sessionId: 'missing-node' })),
    ValidationError,
  )
})

test('assertRemoteAcpxEvent throws ProtocolError for unknown event types', () => {
  assert.throws(
    () =>
      assertRemoteAcpxEvent({
        type: 'session/unknown',
        sessionId: 'session-1',
        nodeId: 'node-a',
      }),
    ProtocolError,
  )
})

test('isSessionEndEvent rejects invalid reason field types', () => {
  assert.equal(
    isSessionEndEvent({
      type: 'session/end',
      sessionId: 'session-1',
      nodeId: 'node-a',
      reason: 404,
    }),
    false,
  )
})

test('isSessionErrorEvent rejects invalid retryable field types', () => {
  assert.equal(
    isSessionErrorEvent({
      type: 'session/error',
      sessionId: 'session-1',
      nodeId: 'node-a',
      code: 'bad_request',
      message: 'Nope',
      retryable: 'yes',
    }),
    false,
  )
})

test('isSessionOutputEvent rejects unknown stream values', () => {
  assert.equal(
    isSessionOutputEvent({
      type: 'session/output',
      sessionId: 'session-1',
      nodeId: 'node-a',
      chunk: 'partial',
      done: false,
      stream: 'console',
    }),
    false,
  )
})
