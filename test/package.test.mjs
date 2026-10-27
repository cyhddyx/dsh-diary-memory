import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { parse } from 'yaml'

const read = filename => readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8')

test('bundle declares a companion preset with one isolated native compaction provider', () => {
  const patch = parse(read('cordis.patch.yml'))
  assert.equal(patch.length, 1)
  const [memory, preset] = patch[0].insert
  assert.equal(memory.name, 'dsh-diary-memory')
  assert.equal(Object.hasOwn(memory.config, 'apiKey'), false)
  assert.equal(preset.config.id, 'diary-companion')
  const group = preset.config.plugins.find(plugin => plugin.group)
  assert.deepEqual(group.isolate, { compaction: true })
  assert.equal(group.config[0].name, 'dsh-diary-memory/compaction')
  assert.equal(group.config[1].name, '@deepseek-ai/dsh-command-compact')
  assert.equal(group.config.some(plugin => plugin.name === '@deepseek-ai/dsh-compaction-basic'), false)
})

test('package exports compiled entries, native peer contracts, localized metadata and an original SVG', () => {
  const manifest = JSON.parse(read('package.json'))
  assert.equal(manifest.engines.dsh, '>=0.2.1-rc.2 <0.3.0')
  for (const specifier of ['.', './compaction', './tools', './client']) {
    const entry = manifest.exports[specifier]
    assert.ok(existsSync(new URL(`../${typeof entry === 'string' ? entry : entry.default}`, import.meta.url)))
  }
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  for (const native of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-llm']) {
    assert.ok(manifest.peerDependencies[native])
    assert.equal(manifest.peerDependenciesMeta[native].optional, true)
  }
  for (const part of ['', 'compaction/', 'tools/']) for (const language of ['en', 'zh']) {
    const { meta } = JSON.parse(read(`locale/${part}${language}.json`))
    assert.ok(meta.title && meta.description)
  }
  assert.match(read('icon.svg'), /^<svg /)
  assert.ok(Buffer.byteLength(read('icon.svg')) < 256 * 1024)
})
