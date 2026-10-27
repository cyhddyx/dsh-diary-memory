import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { boot, initProfile, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import semver from 'semver'
import * as plugin from '../lib/index.js'
import { Config, resolveConfig, resolvePluginConfig, liveConfigFields } from '../lib/config.js'
import { BailianClient } from '../lib/bailian-client.js'
import { RetrievalService } from '../lib/retrieval-service.js'

test('volatile references update the next operation while an existing operation keeps its route and vector space', async t => {
  const ctx = new Context()
  const raw = { apiKey: 'initial-test-key', databasePath: ':memory:', embeddingDimensions: 3 }
  const references = Config(raw)
  const memory = new RetrievalService(ctx, () => resolvePluginConfig(references, {}))
  t.after(() => memory.dispose())
  const first = memory.snapshot()
  const next = Config({ ...raw, apiKey: 'new-test-key', embeddingModel: 'new-embedding', embeddingParameters: { output_type: 'dense' }, rerankModel: 'new-rerank', compressionRounds: 8 })
  for (const field of liveConfigFields) updateVolatile(references[field], next[field])
  const second = memory.snapshot()
  assert.notEqual(first.client, second.client)
  assert.equal(first.config.embeddingModel, 'text-embedding-v4')
  assert.equal(first.client.config.apiKey, 'initial-test-key')
  assert.equal(second.client.config.apiKey, 'new-test-key')
  assert.equal(second.config.compressionRounds, 8)
  assert.notEqual(first.client.embeddingKey, second.client.embeddingKey)
})

test('manual model names and parameters reach native API bodies; canonical parameters identify the vector space', async () => {
  const requests = []
  const config = resolveConfig({ apiKey: 'test-key', embeddingModel: 'manual-embedding', embeddingDimensions: 2, embeddingParameters: { output_type: 'dense' }, rerankModel: 'manual-rerank', rerankParameters: { return_documents: true } }, {})
  const client = new BailianClient(config, { fetch: async (url, options) => {
    requests.push(JSON.parse(options.body))
    return Response.json({ output: String(url).includes('text-embedding')
      ? { embeddings: [{ text_index: 0, embedding: [1, 0] }] }
      : { results: [{ index: 0, relevance_score: 1, document: { text: '记忆' } }] } })
  } })
  await client.embed('记忆', { textType: 'query' })
  await client.rerank('记忆', ['记忆'], { topN: 1 })
  assert.equal(requests[0].model, 'manual-embedding')
  assert.deepEqual(requests[0].parameters, { output_type: 'dense', text_type: 'query', dimension: 2 })
  assert.equal(requests[1].model, 'manual-rerank')
  assert.deepEqual(requests[1].parameters, { return_documents: true, top_n: 1 })
  const key = parameters => new BailianClient(resolveConfig({ embeddingParameters: parameters }, {})).embeddingKey
  assert.equal(key({ first: 1, second: { a: true, b: 'ok' } }), key({ second: { b: 'ok', a: true }, first: 1 }))
  assert.notEqual(key({}), key({ output_type: 'dense' }))
  for (const invalid of [[], { dimension: 3 }, { text_type: 'query' }, { output_type: 'sparse' }, { bad: Infinity }]) assert.throws(() => resolveConfig({ embeddingParameters: invalid }, {}))
})

test('real DSH settings persist the key and model changes, redact responses and update the existing service without remounting', async t => {
  const base = resolve('.local/live-settings-tests')
  mkdirSync(base, { recursive: true })
  const home = realpathSync(mkdtempSync(join(base, 'profile-')))
  let ctx
  t.after(async () => {
    if (ctx) await ctx.fiber.dispose()
    assert.equal(dirname(home).toLowerCase(), realpathSync(base).toLowerCase())
    rmSync(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"diary-settings-test"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'sessions', name: 'cordis:sessions' }, { id: 'session-projections', name: 'cordis:projections' },
    { id: 'config-editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'diary-memory', name: 'cordis:diary', config: { databasePath: ':memory:', apiKey: 'initial-test-key' } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile = { name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: listener => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, { sessions: SessionStore, projections: SessionProjectionRegistry, editor: ConfigEditor, settings: Settings, diary: plugin })
  })
  const memory = ctx.diaryMemory
  const before = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === 'diary-memory')
  assert.ok(before)
  assert.equal(before.autoGenerate, false)
  assert.equal(JSON.stringify(before).includes('initial-test-key'), false)
  await ctx.settings.mutate('diary-memory', [
    { op: 'set', path: ['apiKey'], value: 'saved-test-key' },
    { op: 'set', path: ['embeddingModel'], value: 'manual-embedding' },
    { op: 'set', path: ['embeddingParameters'], value: { output_type: 'dense' } },
    { op: 'set', path: ['rerankModel'], value: 'manual-rerank' },
    { op: 'set', path: ['compressionRounds'], value: 10 },
  ], before.revision)
  assert.equal(ctx.diaryMemory.store, memory.store)
  assert.equal(memory.config.apiKey, 'saved-test-key')
  assert.equal(memory.client.config.embeddingModel, 'manual-embedding')
  assert.equal(memory.config.compressionRounds, 10)
  assert.ok(readFileSync(profile.patchPath, 'utf8').includes('saved-test-key'))
  const after = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === 'diary-memory')
  assert.equal(JSON.stringify(after).includes('saved-test-key'), false)
  assert.equal(after.secrets.find(item => item.path[0] === 'apiKey').set, true)
  await assert.rejects(ctx.settings.mutate('diary-memory', [{ op: 'set', path: ['rerankModel'], value: 'stale-change' }], before.revision), /changed since/)
  assert.equal(memory.config.rerankModel, 'manual-rerank')
})

test('runtime ranges allow rc.2, rc.3 and later 0.2 releases without exact-version locking', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const range = '>=0.2.1-rc.2 <0.3.0'
  assert.equal(manifest.engines.dsh, range)
  for (const version of ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1', '0.2.2', '0.2.99']) assert.equal(semver.satisfies(version, range), true)
  for (const version of ['0.2.1-rc.1', '0.2.0', '0.3.0']) assert.equal(semver.satisfies(version, range), false)
  for (const [name, requirement] of Object.entries(manifest.peerDependencies)) if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(requirement, range)
})
