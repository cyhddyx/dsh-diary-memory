import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, createAssistantMessage, createSystemMessage, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { randomUUID } from 'node:crypto'
import { resolveConfig } from '../lib/config.js'
import { BailianClient } from '../lib/bailian-client.js'
import { RetrievalService } from '../lib/retrieval-service.js'
import DiaryOrchestrator from '../lib/orchestrator.js'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { createScope } from '@deepseek-ai/dsh-scope'
import ToolsService from '@deepseek-ai/dsh-tools'
import { SessionMemory } from '../lib/session-memory.js'

export function diaryBody(seq = 0, overrides = {}) {
  return {
    title: '雨声里的相处',
    narrative: '今天我们聊起下雨的傍晚。我记住了这段平静的相处，也想在下一次聊天时留意对方是否愿意继续这个话题。',
    emotions: [{ name: '温柔', reason: '对方分享了一件生活小事，我愿意认真听。' }],
    facts: [{ text: '这次聊天提到了雨天。', sourceSeqs: [seq] }],
    relationship: '更了解了一点彼此，不急着替对方定义感受。',
    selfEvolution: { insight: '倾听不一定要立即给建议。', nextPractice: '先听对方说完，再确认是否需要建议。', continuingValues: ['尊重边界', '坦诚'] },
    openThreads: ['下次可以继续聊雨天。'],
    uncertainties: ['我还不知道对方是否喜欢雨天。'],
    ...overrides,
  }
}

export function fullDiary(seq = 0, overrides = {}) {
  return { ...diaryBody(seq, overrides), recordedAt: '2026-10-27T12:00:00.000Z', author: { provider: 'test', model: 'diary-test' } }
}

export async function fixture(t, { config: overrides = {}, controls = {}, filename = ':memory:', flush = true, nativeEngine = false, existingSession = false, driver } = {}) {
  const ctx = new Context()
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new LlmRuntime(ctx)
  new TokenMeter(ctx)
  const calls = { model: [], http: [], flush: 0, durable: [] }
  class DiaryAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 1000000 } }
    }
    async *stream(options) {
      calls.model.push(options)
      await controls.beforeModel?.(options)
      if (controls.modelError) throw controls.modelError
      const input = JSON.parse(options.messages.at(-1).content[0].text)
      const body = controls.body?.(input) ?? diaryBody(input.transcript[0].seq)
      yield { type: 'text-delta', index: 0, text: controls.invalidJson ? 'not JSON' : JSON.stringify(body) }
      yield { type: 'finish', reason: { kind: controls.finish ?? 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test', 'writer'], new DiaryAdapter())
  let config = resolveConfig({
    apiKey: 'unit-test-only-key', databasePath: filename, embeddingDimensions: 3,
    compressionRounds: 3, retainRounds: 1, retries: 0, autoRecall: false, ...overrides,
  }, {})
  const client = new BailianClient(config, { fetch: async (url, options) => {
    const body = JSON.parse(options.body)
    calls.http.push({ url: String(url), body })
    await controls.beforeHttp?.(url, options)
    if (controls.embeddingFailure) return new Response('{}', { status: 503 })
    if (String(url).includes('text-embedding')) return Response.json({ output: { embeddings: [{ text_index: 0, embedding: [1, 0, 0] }] } })
    return Response.json({ output: { results: body.input.documents.slice(0, body.parameters.top_n).map((_, index) => ({ index, relevance_score: 0.9 - index * 0.1 })) } })
  } })
  if (flush) ctx.on('session/flush', session => {
    calls.flush++
    if (controls.flushFailureAfter !== undefined && calls.flush > controls.flushFailureAfter) throw new Error('simulated disk full')
    calls.durable = structuredClone(session.snapshotEvents())
  })
  const { MemoryStore } = await import('../lib/memory-store.js')
  const memory = new RetrievalService(ctx, () => config, { client, ...(driver ? { store: new MemoryStore(filename, { driver }) } : {}) })
  await memory.initialize()
  const engine = nativeEngine || existingSession ? new BasicCompactionEngine(ctx, { headroomTokens: 8192, maxTokens: 3000 }) : new DiaryOrchestrator(ctx)
  if (controls.nativeSummarize) engine.summarize = controls.nativeSummarize
  const nativeMethods = Object.fromEntries(['summarize', 'compactIfNeeded', 'compactRegion', 'compactNow'].map(key => [key, engine[key]]))
  const session = ctx.sessions.create(`test-${randomUUID()}`)
  const agent = {
    id: session.id, session, ctx, options: { provider: 'test', model: 'diary-test' },
    runMaintenance(job) {
      if (this.maintenance) throw new Error('busy')
      this.maintenance = true
      return job(new AbortController().signal).finally(() => { this.maintenance = false })
    },
  }
  let bridge, scope
  if (existingSession) {
    scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    ctx.provide('systemPrompt', { tools: () => {} })
    new ToolsService(ctx)
    ctx.provide('agents', { list: () => [agent] })
    ctx.provide('agentPresets', { serviceFor: () => engine })
    config = resolveConfig({ ...config, sessionIds: [session.id] }, {})
    bridge = new SessionMemory(ctx, memory)
  }
  t.after(async () => { await bridge?.dispose(); await scope?.dispose(); await memory.dispose() })
  return { ctx, config, client, memory, engine, session, agent, calls, controls, bridge, nativeMethods, updateConfig: patch => { config = resolveConfig({ ...config, ...patch }, {}) } }
}

export function appendRound(session, turn, { tool = false, open = false, prompt = '雨天一起喝茶。'.repeat(400) } = {}) {
  session.append('turn/start', { turn })
  if (turn === 1) session.append('system/message', { turn, step: 1, message: createSystemMessage('你是一个温暖、坦诚的 AI 伙伴。') }, { surfaceOp: 'append' })
  const user = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `${prompt} ${turn}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) session.append('request/header', { header: { config: { provider: 'test', model: 'diary-test' } }, reason: 'initial' })
  const content = [{ type: 'text', text: '我记得那天的雨声，也愿意听你慢慢说。'.repeat(300) }]
  if (tool) content.push({ type: 'tool-call', id: `call-${turn}`, name: 'weather', arguments: '{}' })
  const assistant = session.append('assistant/message', { stream: [], turn, step: 1, message: createAssistantMessage({ content, source: { provider: 'test', model: 'diary-test' } }) }, { surfaceOp: 'append' })
  let result
  if (tool) {
    session.append('tool/call', { turn, step: 1, callId: `call-${turn}`, name: 'weather', arguments: '{}' })
    if (!open) result = session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: `call-${turn}`, content: [{ type: 'text', text: '小雨。'.repeat(100) }], isError: false }) }, { surfaceOp: 'append' })
  }
  if (!open) {
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { user, assistant, result }
}

export function conversation(session, rounds = 4, options = {}) {
  const entries = []
  for (let turn = 1; turn <= rounds; turn++) entries.push(appendRound(session, turn, options))
  session.append('turn/start', { turn: rounds + 1 })
  return entries
}
