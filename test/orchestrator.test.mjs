import test from 'node:test'
import assert from 'node:assert/strict'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { captureSpan, selectRoundRange } from '../lib/diary.js'
import { fixture, conversation, appendRound, diaryBody } from './helpers.mjs'

const signal = () => new AbortController().signal

test('round threshold writes the diary, embeds, then commits through native compaction', async t => {
  const f = await fixture(t)
  conversation(f.session, 4, { tool: true })
  const result = await f.engine.compactIfNeeded(f.agent, 'pressure', signal())
  assert.ok(result)
  const events = f.session.snapshotEvents()
  assert.equal(events.filter(event => event.type === 'compaction/start').length, 1)
  assert.equal(events.filter(event => event.type === 'compaction/summary').length, 1)
  assert.equal(f.memory.store.count('companion'), 1)
  const row = f.memory.store.recent('companion', 1)[0]
  assert.equal(row.compaction_id, result.compactionId)
  assert.deepEqual(row.sourceSeqs, result.shadowedSeqs)
  assert.ok(f.calls.flush >= 2)
  assert.equal(f.calls.model[0].purpose, 'compaction')
  assert.equal(f.calls.model[0].tools, undefined)
  assert.equal(f.calls.http[0].body.parameters.text_type, 'document')
  assert.equal(f.session.surface.nodes.length, 5) // system, checkpoint, retained user's call and result
  assert.equal(f.memory.stateOf(f.session).completedRounds, 0)
  assert.match(row.diary.selfEvolution.nextPractice, /听/)
  assert.ok(f.calls.durable.some(event => event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint'))
})

test('the native engine rejects cuts inside tool pairs before calling the model', async t => {
  const f = await fixture(t)
  const entries = conversation(f.session, 3, { tool: true })
  const target = entries[0]
  const nodes = [...f.session.surface.nodes]
  assert.equal(toolPairingBalancedAfter(f.session, target.assistant.seq), false)
  assert.equal(toolPairingBalancedBefore(f.session, target.result.seq), false)
  await assert.rejects(f.engine.compactRegion(target.user.seq, target.assistant.seq, f.agent, signal()), /balanced boundary/)
  assert.deepEqual(f.session.surface.nodes, nodes)
  assert.equal(f.calls.model.length, 0)
})

test('a pending tool call is not chopped by a round boundary', async t => {
  const f = await fixture(t)
  appendRound(f.session, 1, { tool: true, open: true })
  const nodes = [...f.session.surface.nodes]
  assert.equal(selectRoundRange(f.session, 1), null)
  await assert.rejects(f.engine.compactRegion(nodes[1], nodes.at(-1), f.agent, signal()), /balanced boundary/)
  assert.equal(f.memory.store.count('companion'), 0)
})

test('parallel tool calls stay together even when results arrive out of order', async t => {
  const f = await fixture(t)
  const session = f.session
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '雨天聊了许多生活小事。'.repeat(1000) }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'test', model: 'diary-test' } }, reason: 'initial' })
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'test', model: 'diary-test' }, content: ['a', 'b'].map(id => ({ type: 'tool-call', id, name: 'weather', arguments: '{}' })) }) }, { surfaceOp: 'append' })
  for (const callId of ['a', 'b']) session.append('tool/call', { turn: 1, step: 1, callId, name: 'weather', arguments: '{}' })
  const resultB = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'b', content: [{ type: 'text', text: '小雨' }], isError: false }) }, { surfaceOp: 'append' })
  assert.equal(toolPairingBalancedAfter(session, resultB.seq), false)
  await assert.rejects(f.engine.compactRegion(user.seq, resultB.seq, f.agent, signal()), /balanced boundary/)
  const resultA = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'a', content: [{ type: 'text', text: '微风' }], isError: false }) }, { surfaceOp: 'append' })
  assert.equal(toolPairingBalancedAfter(session, resultA.seq), true)
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  await f.engine.compactRegion(user.seq, resultA.seq, f.agent, signal())
  assert.equal(f.memory.store.count('companion'), 1)
  assert.equal(f.calls.model.length, 1)
})

for (const [name, controls] of [
  ['embedding failure', { embeddingFailure: true }],
  ['truncated diary', { finish: 'max-tokens' }],
  ['invalid JSON', { invalidJson: true }],
  ['invented source seq', { body: input => diaryBody(input.transcript[0].seq, { facts: [{ text: 'invented', sourceSeqs: [999999] }] }) }],
]) {
  test(`${name} leaves the surface intact and publishes no diary`, async t => {
    const f = await fixture(t, { controls })
    conversation(f.session)
    const nodes = [...f.session.surface.nodes]
    const range = selectRoundRange(f.session, 1)
    await assert.rejects(f.engine.compactRegion(range.start, range.end, f.agent, signal()))
    assert.deepEqual(f.session.surface.nodes, nodes)
    assert.equal(f.memory.store.count('companion'), 0)
    assert.equal(f.session.snapshotEvents().at(-1).type, 'compaction/end')
    assert.ok(f.session.snapshotEvents().at(-1).data.error)
  })
}

test('no persistence provider prevents replacement', async t => {
  const f = await fixture(t, { flush: false })
  conversation(f.session)
  const nodes = [...f.session.surface.nodes]
  const range = selectRoundRange(f.session, 1)
  await assert.rejects(f.engine.compactRegion(range.start, range.end, f.agent, signal()), /持久化/)
  assert.deepEqual(f.session.surface.nodes, nodes)
  assert.equal(f.calls.model.length, 0)
})

test('failed shrink leaves an invisible diary that is reused safely on retry', async t => {
  const f = await fixture(t)
  conversation(f.session)
  const originalEstimate = f.ctx.tokenMeter.estimateMessage.bind(f.ctx.tokenMeter)
  f.ctx.tokenMeter.estimateMessage = () => 100000000
  const range = selectRoundRange(f.session, 1)
  await assert.rejects(f.engine.compactRegion(range.start, range.end, f.agent, signal()), /not smaller/)
  assert.equal(f.memory.store.count('companion'), 0)
  assert.equal(f.memory.store.db.prepare('SELECT state FROM diaries').get().state, 'aborted')
  const modelCalls = f.calls.model.length
  const httpCalls = f.calls.http.length
  f.ctx.tokenMeter.estimateMessage = originalEstimate
  await f.engine.compactRegion(range.start, range.end, f.agent, signal())
  assert.equal(f.memory.store.count('companion'), 1)
  assert.equal(f.calls.model.length, modelCalls)
  assert.equal(f.calls.http.length, httpCalls)
})

test('flush failure after replacement remains prepared and recovers without API calls', async t => {
  const f = await fixture(t, { controls: { flushFailureAfter: 1 } })
  conversation(f.session)
  const range = selectRoundRange(f.session, 1)
  await assert.rejects(f.engine.compactRegion(range.start, range.end, f.agent, signal()), /disk full/)
  assert.equal(f.memory.store.count('companion'), 0)
  assert.equal(f.memory.store.pending(f.session.id).length, 1)
  assert.ok(f.session.deriveMessages().some(message => message.source.kind === 'compact-checkpoint'))
  const calls = [f.calls.http.length, f.calls.model.length]
  delete f.controls.flushFailureAfter
  await f.memory.reconcile(f.session)
  await f.memory.reconcile(f.session)
  assert.equal(f.memory.store.count('companion'), 1)
  assert.deepEqual([f.calls.http.length, f.calls.model.length], calls)
})

test('a changed surface fails the native stability check and leaves memory unpublished', async t => {
  const f = await fixture(t)
  conversation(f.session)
  f.controls.beforeModel = () => f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '新消息' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const range = selectRoundRange(f.session, 1)
  await assert.rejects(f.engine.compactRegion(range.start, range.end, f.agent, signal()), /surface changed/)
  assert.equal(f.memory.store.count('companion'), 0)
  assert.equal(f.session.deriveMessages().some(message => message.source.kind === 'compact-checkpoint'), false)
})

test('same-session concurrent compaction uses the native durable lock', async t => {
  let started
  let release
  const reached = new Promise(resolve => { started = resolve })
  const gated = new Promise(resolve => { release = resolve })
  const f = await fixture(t, { controls: { beforeModel: async () => { started(); await gated } } })
  conversation(f.session)
  const range = selectRoundRange(f.session, 1)
  const first = f.engine.compactRegion(range.start, range.end, f.agent, signal())
  await reached
  await assert.rejects(f.engine.compactRegion(range.start, range.end, f.agent, signal()), /already in progress/)
  release()
  await first
  assert.equal(f.calls.model.length, 1)
  assert.equal(f.memory.store.count('companion'), 1)
})

test('second compaction follows surface positions even when start seq is greater than end seq', async t => {
  const f = await fixture(t)
  conversation(f.session)
  await f.engine.compactIfNeeded(f.agent, 'pressure', signal())
  // Close the still-open fifth turn, then add a sixth turn to preserve as the tail.
  f.session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
  appendRound(f.session, 6)
  f.session.append('turn/start', { turn: 7 })
  const range = selectRoundRange(f.session, 1)
  assert.ok(range.start > range.end)
  await f.engine.compactRegion(range.start, range.end, f.agent, signal())
  assert.equal(f.memory.store.count('companion'), 2)
  const request = JSON.parse(f.calls.model.at(-1).messages.at(-1).content[0].text)
  assert.equal(request.previousDiaries.length, 1)
  assert.match(request.previousDiaries[0].diary.selfEvolution.insight, /倾听/)
})

test('manual compactNow retains the native command correlation and publication barrier', async t => {
  const f = await fixture(t)
  conversation(f.session)
  f.session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
  const result = await f.engine.compactNow(f.agent, signal(), 'manual-test-command')
  assert.equal(result.sourceCommandId, 'manual-test-command')
  assert.equal(f.memory.store.count('companion'), 1)
  const start = f.session.eventAt(result.startSeq)
  assert.equal(start.data.turn, null)
})

test('context-overflow recovery also goes through diary publication', async t => {
  const f = await fixture(t)
  conversation(f.session, 2)
  const result = await f.engine.compactIfNeeded(f.agent, 'context-overflow', signal())
  assert.ok(result)
  assert.equal(f.memory.store.count('companion'), 1)
})

test('auto recall is admitted into the current step and preserves waterfall fields', async t => {
  const f = await fixture(t, { config: { autoRecall: true } })
  conversation(f.session)
  await f.engine.compactIfNeeded(f.agent, 'pressure', signal())
  const prompt = createUserMessage({ content: [{ type: 'text', text: '还记得那个雨天吗？' }], source: { kind: 'user' } })
  const decision = await f.ctx.waterfall('agent/pre-step', { agent: f.agent, messages: [prompt], turn: 5, step: 1, signal: signal(), modelSelection: {} }, async () => ({ kind: 'enter', messages: [prompt], startsRequestSeries: true }))
  assert.equal(decision.startsRequestSeries, true)
  assert.equal(decision.messages[0].id, prompt.id)
  assert.equal(decision.messages.at(-1).source.kind, 'diary-memory')
  assert.match(decision.messages.at(-1).content[0].text, /自我反思/)
})

test('captureSpan rejects stale messages and cancellation preserves the original surface', async t => {
  const f = await fixture(t)
  conversation(f.session)
  assert.throws(() => captureSpan(f.session, [createUserMessage({ content: [{ type: 'text', text: 'not in session' }], source: { kind: 'user' } })]), /surface/)
  const nodes = [...f.session.surface.nodes]
  const controller = new AbortController()
  controller.abort(new Error('test cancellation'))
  const range = selectRoundRange(f.session, 1)
  await assert.rejects(f.engine.compactRegion(range.start, range.end, f.agent, controller.signal), /test cancellation/)
  assert.deepEqual(f.session.surface.nodes, nodes)
  assert.equal(f.calls.model.length, 0)
})

test('reopening SQLite and replaying the durable session log recovers a crash after native commit', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'diary-recovery-'))
  const filename = join(folder, 'memory.sqlite3')
  const first = await fixture(t, { filename })
  conversation(first.session)
  first.memory.store.commit = () => { throw new Error('simulated crash between DSH flush and SQLite commit') }
  const range = selectRoundRange(first.session, 1)
  await assert.rejects(first.engine.compactRegion(range.start, range.end, first.agent, signal()), /simulated crash/)
  assert.equal(first.memory.store.count('companion'), 0)
  const durableEvents = structuredClone(first.calls.durable)
  const id = first.session.id
  await first.memory.dispose()
  const second = await fixture(t, { filename })
  const restored = second.ctx.sessions.create(id, { seed: durableEvents })
  await second.memory.reconcile(restored)
  await second.memory.reconcile(restored)
  assert.equal(second.memory.store.count('companion'), 1)
  assert.equal(second.memory.store.pending(id).length, 0)
  assert.equal(second.calls.model.length, 0)
  assert.equal(second.calls.http.length, 0)
  t.after(() => rmSync(folder, { recursive: true, force: true }))
})

test('recalled context is not rewritten as a newly lived experience', async t => {
  const f = await fixture(t)
  const entries = conversation(f.session)
  const recalled = createUserMessage({ content: [{ type: 'text', text: '很久以前的回忆，只是检索资料。' }], source: { kind: 'diary-memory', form: 'recall' } })
  const recallEvent = f.session.append('user/message', recalled, { surfaceOp: 'append' })
  const span = captureSpan(f.session, f.session.surface.nodes.slice(1).map(seq => f.session.deriveEventMessage(f.session.eventAt(seq))))
  assert.ok(span.sourceSeqs.includes(recallEvent.seq))
  assert.equal(span.transcript.some(item => item.seq === recallEvent.seq), false)
  assert.ok(span.transcript.some(item => item.seq === entries[0].user.seq))
})

test('a missing Bailian key prevents a model call or context replacement', async t => {
  const f = await fixture(t, { config: { apiKey: '' } })
  conversation(f.session)
  const nodes = [...f.session.surface.nodes]
  const range = selectRoundRange(f.session, 1)
  await assert.rejects(f.engine.compactRegion(range.start, range.end, f.agent, signal()), /apiKey/)
  assert.deepEqual(f.session.surface.nodes, nodes)
  assert.equal(f.calls.model.length, 0)
})
