import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { defaults } from '../lib/config.js'

const output = resolve('.local/settings-tests/client.mjs')
mkdirSync(resolve('.local/settings-tests'), { recursive: true })
await build({
  stdin: { resolveDir: process.cwd(), contents: `export * from './src/client/index.ts';
    import { SettingsForm, SettingsSecretField, SettingsValueField, SettingsFormModel, settingsTextField, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
    export const primitives = { SettingsForm, SettingsSecretField, SettingsValueField, SettingsFormModel, settingsTextField, Switch };` },
  outfile: output, bundle: true, format: 'esm', platform: 'node', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty' }, logLevel: 'silent',
  // The SDK publishes the shared primitives as one static module. Unused visual
  // subsystems are supplied by DSH and do not belong in these form tests.
  plugins: [{ name: 'shared-runtime', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-store'].includes(args.path)
      ? undefined : { path: args.path, external: true, sideEffects: false })
  } }],
})
const { DiarySettingsController, DiarySettingsPage, primitives } = await import(pathToFileURL(output).href)

function formFixture({ writable = true, configured = true } = {}) {
  let secret = configured ? 'existing-test-secret' : undefined
  let values = { ...defaults }; delete values.apiKey
  let revision = 1
  const listeners = new Set()
  const calls = []
  const scope = {
    fail: false,
    getSnapshot: () => ({ status: 'ready', value: values, base: { ...defaults, apiKey: undefined }, user: {}, revision, writable }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(ops, expected) {
      calls.push({ ops: structuredClone(ops), expected })
      if (scope.fail || expected !== revision) return false
      for (const op of ops) {
        const key = op.path[0]
        if (key === 'apiKey') { secret = op.op === 'set' ? op.value : undefined; continue }
        values = { ...values, [key]: op.op === 'set' ? op.value : defaults[key] }
      }
      revision++
      for (const notify of listeners) notify()
      return true
    },
  }
  const controller = new DiarySettingsController(scope, () => secret !== undefined)
  return { controller, scope, calls, get secret() { return secret }, externalChange() { revision++; for (const notify of listeners) notify() } }
}

test('native settings form saves credentials, both model names and parameter objects in one revision-fenced write', async () => {
  const f = formFixture({ configured: false })
  const actions = f.controller.inject()
  for (const [field, text] of Object.entries({ apiKey: ' new-test-key ', embeddingModel: 'custom-embedding', embeddingDimensions: '1536', embeddingParameters: '{"output_type":"dense"}', rerankModel: 'custom-rerank', rerankParameters: '{"return_documents":true}', candidateCount: '15', recallCount: '4' })) actions.edit(field, text)
  await f.controller.save()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].expected, 1)
  const fields = Object.fromEntries(f.calls[0].ops.map(op => [op.path[0], op.value]))
  assert.equal(fields.apiKey, 'new-test-key')
  assert.equal(fields.embeddingModel, 'custom-embedding')
  assert.deepEqual(fields.embeddingParameters, { output_type: 'dense' })
  assert.deepEqual(fields.rerankParameters, { return_documents: true })
  assert.equal(Object.hasOwn(fields, 'diaryModel'), false)
  assert.equal(f.controller.store.getSnapshot().fields.apiKey.text, '')
  assert.equal(f.controller.store.getSnapshot().keyConfigured, true)
  assert.equal(f.controller.store.getSnapshot().dirty, false)
  actions.edit('compressionRounds', '10')
  await f.controller.save()
  assert.deepEqual(f.calls[1].ops, [{ op: 'set', path: ['compressionRounds'], value: 10 }])
  assert.equal(f.secret, 'new-test-key')
  f.controller.dispose()
})

test('invalid JSON, reserved API parameters, invalid ranges and endpoints never cross the wire', async () => {
  const f = formFixture()
  const actions = f.controller.inject()
  for (const [field, text] of [
    ['embeddingParameters', '{'], ['embeddingParameters', '[]'], ['embeddingParameters', '{"dimension":123}'],
    ['embeddingParameters', '{"text_type":"query"}'], ['embeddingParameters', '{"output_type":"sparse"}'],
    ['rerankParameters', '{"top_n":3}'], ['rerankParameters', '{"return_documents":"yes"}'],
    ['compressionRounds', '2'], ['embeddingDimensions', '1.5'], ['recallCount', '31'], ['baseUrl', 'http://example.com'],
  ]) {
    actions.edit(field, text)
    assert.equal(f.controller.store.getSnapshot().invalid, true, `${field}: ${text}`)
    await f.controller.save()
    assert.equal(f.calls.length, 0)
    assert.equal(f.controller.store.getSnapshot().fields[field].text, text)
    actions.discard()
  }
  f.controller.dispose()
})

test('a rejected or stale save retains every draft and never replaces a newer configuration', async () => {
  const f = formFixture()
  const actions = f.controller.inject()
  actions.edit('apiKey', 'replacement-test-key')
  f.scope.fail = true
  await f.controller.save()
  assert.equal(f.controller.store.getSnapshot().failed, true)
  assert.equal(f.controller.store.getSnapshot().fields.apiKey.text, 'replacement-test-key')
  assert.equal(f.secret, 'existing-test-secret')
  f.scope.fail = false
  f.externalChange()
  await f.controller.save()
  assert.equal(f.calls[1].expected, 1)
  assert.equal(f.secret, 'existing-test-secret')
  actions.discard()
  actions.edit('apiKey', 'latest-test-key')
  await f.controller.save()
  assert.equal(f.secret, 'latest-test-key')
  f.controller.dispose()
})

test('settings page renders native password and manual model/JSON controls without diary model parameters or existing credentials', () => {
  const f = formFixture()
  const face = f.controller.inject()
  const html = renderToStaticMarkup(createElement(DiarySettingsPage, { ...face, useDiarySettings: select => select(f.controller.store.getSnapshot()) }))
  assert.match(html, /type="password"/)
  for (const id of ['embeddingModel', 'embeddingDimensions', 'rerankModel', 'embeddingParameters', 'rerankParameters']) assert.ok(html.includes(`id="diary-${id}"`))
  assert.equal(html.includes('existing-test-secret'), false)
  assert.equal(html.includes('diaryModel'), false)
  assert.equal(html.includes('temperature'), false)
  assert.ok(html.includes('保存配置'))
  f.controller.dispose()
})

test('read-only forms refuse writes, and the browser artifact uses the real DSH module-factory registration', async () => {
  const f = formFixture({ writable: false })
  f.controller.inject().edit('embeddingModel', 'cannot-save')
  await f.controller.save()
  assert.equal(f.calls.length, 0)
  let registration
  runInNewContext(readFileSync('lib/client.js', 'utf8'), { window: { __ModuleLoader__: { load: value => { registration = value } } } })
  assert.equal(registration.id, 'dsh-diary-memory')
  const require = createRequire(import.meta.url)
  const client = registration.factory(name => name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : require(name))
  assert.deepEqual([...client.inject], ['slots', 'configForms'])
  const disposers = []
  const pages = []
  client.apply({
    effect: create => { disposers.push(create()) },
    configForms: { get: () => f.scope, describe: () => ({ getSnapshot: () => ({ view: { namespaces: [] } }) }), whileServed: (_names, register) => register(new Set(['diary-memory'])) },
    slots: { inject: (_name, register) => register(), register: (options, component) => { pages.push({ options, component }); return () => {} } },
  })
  assert.equal(pages[0].options.name, 'settings.section')
  assert.equal(pages[0].options.id, 'diary-memory')
  assert.equal(pages[0].options.label, '陪伴日记')
  for (const dispose of disposers.reverse()) dispose()
  f.controller.dispose()
})
