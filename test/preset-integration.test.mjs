import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolsService from '@deepseek-ai/dsh-tools'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import PresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as plugin from '../lib/index.js'
import { conversation, diaryBody } from './helpers.mjs'

test('native preset registry routes a selected existing chat through its original isolated compaction service', async t => {
  const base = resolve('.local/preset-integration-tests')
  mkdirSync(base, { recursive: true })
  const home = realpathSync(mkdtempSync(join(base, 'profile-')))
  let ctx
  t.after(async () => {
    await ctx?.fiber.dispose()
    assert.equal(dirname(home).toLowerCase(), realpathSync(base).toLowerCase())
    rmSync(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"diary-preset-test"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    ...['sessions', 'projections', 'editor', 'settings', 'llm', 'meter', 'prompt', 'tools', 'agents'].map(id => ({ id, name: `cordis:${id}` })),
    { id: 'presets', name: 'cordis:presets', config: { default: 'original' } },
    { id: 'original', name: 'cordis:preset', config: { id: 'original', name: '原来的预设', plugins: [{ name: 'cordis:group', group: true, isolate: { compaction: true }, config: [{ name: 'cordis:basic' }] }] } },
    { id: 'diary-memory', name: 'cordis:diary', config: { databasePath: ':memory:', apiKey: 'test-only', embeddingDimensions: 3, compressionRounds: 3, retainRounds: 1, autoRecall: false } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const agents = []
  ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), root => {
    root.provide('profileContext', profile)
    root.provide('appReady', { onReady: listener => { listener(); return () => {} } })
    Object.assign(root.loader.builtins, {
      sessions: SessionStore, projections: SessionProjectionRegistry, editor: ConfigEditor, settings: Settings,
      llm: LlmRuntime, meter: TokenMeter, tools: ToolsService, presets: PresetRegistry, preset: AgentPreset, basic: BasicCompactionEngine, diary: plugin,
      prompt: { apply: context => { context.provide('systemPrompt', { tools: () => {} }) } },
      agents: { apply: context => { context.provide('agents', { list: () => agents }) } },
    })
  })
  const calls = []
  class Writer extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 1000000 } } }
    async *stream(options) {
      calls.push(options)
      const input = JSON.parse(options.messages.at(-1).content[0].text)
      yield { type: 'text-delta', index: 0, text: JSON.stringify(diaryBody(input.transcript[0].seq)) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test', 'writer'], new Writer())
  ctx.on('session/flush', () => {})
  const session = ctx.sessions.create('original-chat')
  const agent = { id: session.id, session, options: { provider: 'test', model: 'diary-test' } }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  await ctx.agentPresets.mount(agent.ctx, 'original')
  session.append('agent-preset/selected', { agentPreset: 'original' })
  agents.push(agent)
  await agentEvents(ctx, agent).serial('agent/created', { agent })
  conversation(session)
  const settings = ctx.settings.describe().find(row => row.ns === 'diary-memory')
  await ctx.settings.mutate('diary-memory', [
    { op: 'set', path: ['sessionIds'], value: [session.id] },
    { op: 'set', path: ['diaryProvider'], value: 'writer' },
    { op: 'set', path: ['diaryModel'], value: 'dedicated-diary' },
  ], settings.revision)
  ctx.diaryMemory.client.embed = async () => [1, 0, 0]
  const prompt = createUserMessage({ content: [{ type: 'text', text: '接着聊聊吧。' }], source: { kind: 'user' } })
  const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', { agent, messages: [prompt], turn: 5, step: 1, signal: new AbortController().signal, modelSelection: {} }, async () => ({ kind: 'enter', messages: [prompt], startsRequestSeries: true }))
  assert.equal(decision.kind, 'enter')
  assert.equal(ctx.agentPresets.composedPreset(agent.ctx), 'original')
  assert.equal(ctx.get('compaction'), undefined)
  assert.ok(ctx.agentPresets.serviceFor(agent, 'compaction'))
  assert.equal(ctx.diaryMemory.store.count('companion'), 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'dedicated-diary')
  assert.equal(agent.options.model, 'diary-test')
})
