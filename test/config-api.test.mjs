import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolveConfig, Config } from '../lib/config.js'
import { BailianClient, BailianError } from '../lib/bailian-client.js'

test('configuration validates thresholds, model pairs, secrets and local paths', () => {
  const config = resolveConfig({ apiKey: '', compressionRounds: 10, retainRounds: 2 }, { DSH_DIARY_BAILIAN_API_KEY: 'example-key', DSH_PROFILE_DIR: 'E:/isolated-profile' })
  assert.equal(config.apiKey, 'example-key')
  assert.equal(resolveConfig({ apiKey: ' ', diaryProvider: ' ', diaryModel: ' ' }, { DASHSCOPE_API_KEY: 'fallback-key' }).apiKey, 'fallback-key')
  assert.match(config.databasePath, /isolated-profile/)
  assert.equal(Config.dict.apiKey.meta.role, 'secret')
  assert.throws(() => resolveConfig({ compressionRounds: 2, retainRounds: 2 }), /compressionRounds/)
  assert.throws(() => resolveConfig({ diaryProvider: 'test' }), /同时/)
  assert.throws(() => resolveConfig({ candidateCount: 3, recallCount: 4 }), /candidateCount/)
  assert.throws(() => resolveConfig({ embeddingDimensions: 1.5 }))
  assert.throws(() => resolveConfig({ baseUrl: 'http://example.com' }), /HTTPS/)
  assert.throws(() => resolveConfig({ baseUrl: 'https://example.com?key=x' }), /origin/)
  assert.throws(() => resolveConfig({ unknownSetting: 3 }), /未知/)
})

test('fetch sends native Bailian embedding and rerank requests through a real local HTTP server', async t => {
  const received = []
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    received.push({ path: request.url, authorization: request.headers.authorization, body })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url.includes('text-embedding')
      ? { output: { embeddings: [{ text_index: 0, embedding: [1, 0, 0] }] } }
      : { output: { results: [{ index: 1, relevance_score: 0.99 }, { index: 0, relevance_score: 0.42 }] } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const client = new BailianClient(resolveConfig({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'local-test-key', embeddingDimensions: 3 }))
  assert.deepEqual(await client.embed('雨天的共同回忆', { textType: 'query' }), [1, 0, 0])
  assert.deepEqual((await client.rerank('雨', ['晴天', '雨天'], { topN: 2 })).map(item => item.index), [1, 0])
  assert.equal(received[0].authorization, 'Bearer local-test-key')
  assert.equal(received[0].path, '/api/v1/services/embeddings/text-embedding/text-embedding')
  assert.deepEqual(received[0].body.parameters, { text_type: 'query', dimension: 3 })
  assert.equal(received[1].path, '/api/v1/services/rerank/text-rerank/text-rerank')
  assert.deepEqual(received[1].body.parameters, { top_n: 2, return_documents: false })
})

test('Bailian rejects malformed vectors and rerank indexes', async () => {
  const config = resolveConfig({ apiKey: 'test-key', embeddingDimensions: 3, retries: 0 })
  for (const embedding of [[0, 0, 0], [1, 0], [1, Infinity, 0]]) {
    const client = new BailianClient(config, { fetch: async () => Response.json({ output: { embeddings: [{ text_index: 0, embedding }] } }) })
    await assert.rejects(client.embed('test'), BailianError)
  }
  const client = new BailianClient(config, { fetch: async () => Response.json({ output: { results: [{ index: 0, relevance_score: 0.8 }, { index: 0, relevance_score: 0.6 }] } }) })
  await assert.rejects(client.rerank('query', ['one', 'two']), /无效或重复/)
})

test('only transient failures retry; API key and response body stay out of errors', async () => {
  let attempts = 0
  const config = resolveConfig({ apiKey: 'do-not-print-me', embeddingDimensions: 3, retries: 1 })
  const client = new BailianClient(config, { fetch: async () => ++attempts === 1 ? new Response('private user content', { status: 429, headers: { 'retry-after': '0' } }) : Response.json({ output: { embeddings: [{ text_index: 0, embedding: [1, 0, 0] }] } }) })
  await client.embed('query')
  assert.equal(attempts, 2)
  attempts = 0
  const denied = new BailianClient(config, { fetch: async () => { attempts++; return new Response('do-not-print-me private user content', { status: 401 }) } })
  await assert.rejects(denied.embed('query'), error => error.status === 401 && !/do-not-print|private/.test(error.message))
  assert.equal(attempts, 1)
})

test('cancellation reaches fetch, and a missing API key fails before fetch', async () => {
  let called = false
  const controller = new AbortController()
  const client = new BailianClient(resolveConfig({ apiKey: 'test-key', retries: 0 }), { fetch: async (_url, { signal }) => {
    called = true
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const pending = client.embed('query', { signal: controller.signal })
  controller.abort(new Error('cancelled by caller'))
  await assert.rejects(pending, /cancelled by caller/)
  assert.equal(called, true)
  const missing = new BailianClient(resolveConfig({}, {}), { fetch: async () => { throw new Error('must not call fetch') } })
  await assert.rejects(missing.embed('query'), /apiKey/)
})
