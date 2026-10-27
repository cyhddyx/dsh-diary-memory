import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from '../lib/memory-store.js'
import { renderDiary } from '../lib/diary.js'
import { fixture, fullDiary } from './helpers.mjs'

function insert(store, name, vector, { namespace = 'companion', sessionId = 's1', embeddingKey = 'space', commit = true } = {}) {
  const diary = fullDiary(1, { title: name })
  const row = store.prepare({ namespace, sessionId, embeddingKey, sourceHash: name, sourceSeqs: [1], compactionId: name, diary, searchText: renderDiary(diary), vector })
  if (commit) store.commit(row.id, 100)
  return row
}

test('SQLite vector index persists; prepared, other namespaces, dimensions and models stay excluded', () => {
  const folder = mkdtempSync(join(tmpdir(), 'diary-store-'))
  const filename = join(folder, 'memories.sqlite3')
  let store = new MemoryStore(filename)
  try {
    const match = insert(store, 'closest', [1, 0, 0])
    insert(store, 'other', [0, 1, 0])
    insert(store, 'uncommitted', [1, 0, 0], { commit: false })
    insert(store, 'private namespace', [1, 0, 0], { namespace: 'another-person' })
    insert(store, 'different model', [1, 0, 0], { embeddingKey: 'new-model' })
    insert(store, 'different dimensions', [1, 0])
    store.close()
    store = new MemoryStore(filename)
    const hits = store.search([1, 0, 0], { namespace: 'companion', embeddingKey: 'space' })
    assert.equal(hits.length, 2)
    assert.equal(hits[0].id, match.id)
    assert.equal(hits[0].similarity, 1)
    assert.equal('vector' in hits[0], false)
    assert.throws(() => store.search([0, 0, 0], { namespace: 'companion', embeddingKey: 'space' }))
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('prepared retries are idempotent; committed source ranges cannot duplicate', () => {
  const store = new MemoryStore(':memory:')
  try {
    const first = insert(store, 'same source', [1, 0, 0], { commit: false })
    store.abort(first.id)
    const second = insert(store, 'same source', [1, 0, 0], { commit: false })
    assert.equal(first.id, second.id)
    store.commit(first.id, 99)
    assert.equal(store.count('companion'), 1)
    assert.throws(() => insert(store, 'same source', [1, 0, 0]), /已经入库/)
  } finally { store.close() }
})

test('recall uses embedding candidates then rerank order, with a session filter', async t => {
  const f = await fixture(t)
  insert(f.memory.store, 'one', [1, 0, 0], { embeddingKey: f.client.embeddingKey })
  insert(f.memory.store, 'two', [0, 1, 0], { embeddingKey: f.client.embeddingKey, sessionId: 's2' })
  f.client.rerank = async (_query, documents) => documents.map((_, index) => ({ index, relevance_score: 0.2 + index * 0.6 })).reverse()
  const result = await f.memory.recall('雨天', { limit: 2 })
  assert.equal(result[0].diary.title, 'two')
  assert.equal(result[0].score, 0.8)
  assert.equal(f.calls.http[0].body.parameters.text_type, 'query')
  assert.equal((await f.memory.recall('雨天', { sessionId: 's2' })).length, 1)
})

test('empty recall avoids network and incompatible vector spaces fail visibly', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.memory.recall('过去的回忆'), [])
  assert.equal(f.calls.http.length, 0)
  insert(f.memory.store, 'old-space', [1, 0, 0])
  await assert.rejects(f.memory.recall('过去的回忆'), /重新索引/)
  assert.equal(f.calls.http.length, 0)
})
