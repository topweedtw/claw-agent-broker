const test = require('node:test')
const assert = require('node:assert/strict')

const {
  RequestCorrelationError,
  RequestCorrelator,
  TimeoutError,
  createRequestId,
  createSessionEndEvent,
  createSessionErrorEvent,
  createSessionOutputEvent,
  createSessionPromptEvent,
  ensureRequestId,
  getCorrelationKey,
  matchesRequest,
} = require('../dist/index.js')

test('createRequestId generates prefixed unique IDs', () => {
  const first = createRequestId('prompt')
  const second = createRequestId('prompt')

  assert.match(first, /^prompt-/)
  assert.match(second, /^prompt-/)
  assert.notEqual(first, second)
})

test('ensureRequestId preserves existing request IDs and adds missing ones', () => {
  const withExisting = ensureRequestId(
    createSessionPromptEvent({
      sessionId: 'session-1',
      nodeId: 'node-a',
      requestId: 'req-existing',
      prompt: 'hello',
    }),
  )

  const withoutExisting = ensureRequestId(
    createSessionPromptEvent({
      sessionId: 'session-1',
      nodeId: 'node-a',
      prompt: 'hello',
    }),
  )

  assert.equal(withExisting.requestId, 'req-existing')
  assert.match(withoutExisting.requestId, /^req-/)
})

test('matchesRequest and getCorrelationKey align events to the same scope', () => {
  const event = ensureRequestId(
    createSessionPromptEvent({
      sessionId: 'session-1',
      nodeId: 'node-a',
      prompt: 'ship it',
    }),
  )

  assert.equal(matchesRequest(event, { requestId: event.requestId }), true)
  assert.equal(matchesRequest(event, { requestId: event.requestId, nodeId: 'node-a' }), true)
  assert.equal(matchesRequest(event, { requestId: event.requestId, nodeId: 'node-b' }), false)
  assert.equal(getCorrelationKey(event), `node-a:session-1:${event.requestId}`)
})

test('RequestCorrelator resolves a streaming request and accumulates outputs', async () => {
  const correlator = new RequestCorrelator()
  const request = createSessionPromptEvent({
    sessionId: 'session-1',
    nodeId: 'node-a',
    prompt: 'continue',
  })

  const pending = correlator.track(request)

  correlator.handle(
    createSessionOutputEvent({
      sessionId: 'session-1',
      nodeId: 'node-a',
      requestId: pending.requestId,
      chunk: 'part-1',
      done: false,
      stream: 'stdout',
    }),
  )

  correlator.handle(
    createSessionOutputEvent({
      sessionId: 'session-1',
      nodeId: 'node-a',
      requestId: pending.requestId,
      chunk: 'part-2',
      done: true,
      stream: 'stdout',
    }),
  )

  const result = await pending.waitForCompletion()

  assert.equal(result.requestId, pending.requestId)
  assert.equal(result.outputs.length, 2)
  assert.equal(result.outputs[0].chunk, 'part-1')
  assert.equal(result.finalEvent.type, 'session/output')
  assert.equal(correlator.has(pending.requestId), false)
})

test('RequestCorrelator resolves on session/end and rejects on session/error', async () => {
  const successCorrelator = new RequestCorrelator()
  const successPending = successCorrelator.track(
    createSessionPromptEvent({
      sessionId: 'session-2',
      nodeId: 'node-a',
      prompt: 'finish',
    }),
  )

  successCorrelator.handle(
    createSessionEndEvent({
      sessionId: 'session-2',
      nodeId: 'node-a',
      requestId: successPending.requestId,
      exitCode: 0,
      reason: 'completed',
    }),
  )

  const successResult = await successPending.waitForCompletion()
  assert.equal(successResult.finalEvent.type, 'session/end')

  const errorCorrelator = new RequestCorrelator()
  const errorPending = errorCorrelator.track(
    createSessionPromptEvent({
      sessionId: 'session-3',
      nodeId: 'node-a',
      prompt: 'break it',
    }),
  )

  errorCorrelator.handle(
    createSessionErrorEvent({
      sessionId: 'session-3',
      nodeId: 'node-a',
      requestId: errorPending.requestId,
      code: 'bad_request',
      message: 'Nope',
      retryable: false,
    }),
  )

  await assert.rejects(errorPending.waitForCompletion(), RequestCorrelationError)
})

test('RequestCorrelator times out pending requests and ignores unrelated events', async () => {
  const correlator = new RequestCorrelator({ timeoutMs: 10 })
  const pending = correlator.track(
    createSessionPromptEvent({
      sessionId: 'session-timeout',
      nodeId: 'node-a',
      prompt: 'wait',
    }),
  )

  const handled = correlator.handle(
    createSessionOutputEvent({
      sessionId: 'session-timeout',
      nodeId: 'node-a',
      requestId: 'req-other',
      chunk: 'ignored',
      done: false,
    }),
  )

  assert.equal(handled, false)
  await assert.rejects(pending.waitForCompletion(), TimeoutError)
})

test('RequestCorrelator exposes snapshots and supports cancel / clear', async () => {
  const correlator = new RequestCorrelator({ now: () => 123 })
  const pending = correlator.track(
    createSessionPromptEvent({
      sessionId: 'session-cancel',
      nodeId: 'node-a',
      prompt: 'cancel me',
    }),
  )

  const snapshot = pending.getSnapshot()
  assert.equal(snapshot.createdAt, 123)
  assert.equal(snapshot.requestId, pending.requestId)
  assert.equal(correlator.getPending(pending.requestId)?.requestId, pending.requestId)

  pending.cancel('user aborted')
  await assert.rejects(pending.waitForCompletion(), /cancelled/i)
  assert.equal(correlator.has(pending.requestId), false)

  const second = correlator.track(
    createSessionPromptEvent({
      sessionId: 'session-clear',
      nodeId: 'node-a',
      prompt: 'clear me',
    }),
  )

  correlator.clear('shutdown')
  await assert.rejects(second.waitForCompletion(), /shutdown/i)
})