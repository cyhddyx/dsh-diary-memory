import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { fixture, conversation } from './helpers.mjs'

const signal = () => new AbortController().signal
const nativeSummary = () => ({ summary: [{ type: 'text', text: '原预设的压缩摘要。' }], provider: 'test', model: 'original' })

test('an existing chat keeps its persona and model while its dedicated writer records memory', async t => {
  const f = await fixture(t, { existingSession: true })
  conversation(f.session, 4, { tool: true })
  const originalOptions = structuredClone(f.agent.options)
  const originalHeader = structuredClone(f.session.snapshotEvents().find(event => event.type === 'request/header'))
  const system = f.session.surface.nodes[0]
  f.updateConfig({ diaryProvider: 'writer', diaryModel: 'memory-author' })
  await f.engine.compactIfNeeded(f.agent, 'pressure', signal())
  assert.equal(f.calls.model[0].provider, 'writer')
  assert.equal(f.calls.model[0].model, 'memory-author')
  assert.equal(f.calls.model[0].tools, undefined)
  assert.deepEqual(f.agent.options, originalOptions)
  assert.deepEqual(f.session.eventAt(originalHeader.seq), originalHeader)
  assert.equal(f.session.surface.nodes[0], system)
  assert.equal(f.memory.store.recent('companion')[0].diary.author.model, 'memory-author')
})

test('sessions sharing a native engine retain separate selected and unselected compaction routes', async t => {
  let originals = 0
  const f = await fixture(t, { existingSession: true, controls: { nativeSummarize: async () => { originals++; return nativeSummary() } } })
  const other = f.ctx.sessions.create(`unselected-${randomUUID()}`)
  const owner = { ...f.agent, id: other.id, session: other }
  const scope = createScope(f.ctx, owner)
  owner.ctx = scope.ctx
  t.after(() => scope.dispose())
  await f.ctx.serial('agent/created', { agent: owner })
  conversation(f.session)
  conversation(other)
  const a = f.session.surface.nodes, b = other.surface.nodes
  await Promise.all([
    f.engine.compactRegion(a[1], a.at(-1), f.agent, signal()),
    f.engine.compactRegion(b[1], b.at(-1), owner, signal()),
  ])
  assert.equal(originals, 1)
  assert.equal(f.calls.model.length, 1)
  assert.equal(f.calls.http.length, 1)
  assert.equal(f.memory.store.count('companion'), 1)
  assert.equal(f.memory.store.recent('companion')[0].session_id, f.session.id)
  assert.deepEqual(other.snapshotEvents().find(event => event.type === 'compaction/summary').data.summary, nativeSummary().summary)
})

for (const initiallySelected of [true, false]) test(`selection remains pinned when ${initiallySelected ? 'disabling' : 'enabling'} memory during native maintenance admission`, async t => {
  const f = await fixture(t, { existingSession: true, controls: { nativeSummarize: async () => nativeSummary() } })
  f.updateConfig({ sessionIds: initiallySelected ? [f.session.id] : [] })
  conversation(f.session)
  f.session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.agent.runMaintenance = job => { entered.resolve(); return release.promise.then(() => job(signal())) }
  const pending = f.engine.compactNow(f.agent, signal(), 'pinned-route')
  await entered.promise
  f.updateConfig({ sessionIds: initiallySelected ? [] : [f.session.id] })
  release.resolve()
  assert.equal((await pending).sourceCommandId, 'pinned-route')
  assert.equal(f.calls.model.length, initiallySelected ? 1 : 0)
  assert.equal(f.memory.store.count('companion'), initiallySelected ? 1 : 0)
})

test('recall tools and automatic recall belong only to selected Agent scopes and are removed on deselection', async t => {
  const f = await fixture(t, { existingSession: true })
  const prompt = createUserMessage({ content: [{ type: 'text', text: '还记得雨天吗？' }], source: { kind: 'user' } })
  const step = () => agentEvents(f.ctx, f.agent).waterfall('agent/pre-step', { agent: f.agent, messages: [prompt], turn: 1, step: 1, signal: signal(), modelSelection: {} }, async () => ({ kind: 'enter', messages: [prompt] }))
  await step()
  assert.ok(f.ctx.tools.get('diary_recall', scopeOf(f.agent.ctx)))
  assert.equal(f.ctx.tools.get('diary_recall'), undefined)
  assert.equal(f.ctx.tools.get('diary_recall', {}), undefined)
  f.updateConfig({ sessionIds: [] })
  await step()
  assert.equal(f.ctx.tools.get('diary_recall', scopeOf(f.agent.ctx)), undefined)
  f.updateConfig({ sessionIds: [f.session.id] })
  await step()
  await f.bridge.dispose()
  assert.equal(f.ctx.tools.get('diary_recall', scopeOf(f.agent.ctx)), undefined)
  for (const [name, method] of Object.entries(f.nativeMethods)) assert.equal(f.engine[name], method)
})

test('unloading cancels and drains a diary operation before restoring the original native engine', async t => {
  const entered = Promise.withResolvers()
  const f = await fixture(t, { existingSession: true, controls: { beforeModel: async options => {
    entered.resolve()
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  } } })
  conversation(f.session)
  const nodes = [...f.session.surface.nodes]
  const pending = f.engine.compactRegion(nodes[1], nodes.at(-1), f.agent, signal())
  const rejected = assert.rejects(pending, /关闭/)
  await entered.promise
  await f.bridge.dispose()
  await rejected
  assert.deepEqual(f.session.surface.nodes, nodes)
  assert.equal(f.memory.store.count('companion'), 0)
  assert.equal(f.calls.http.length, 0)
  for (const [name, method] of Object.entries(f.nativeMethods)) assert.equal(f.engine[name], method)
})
