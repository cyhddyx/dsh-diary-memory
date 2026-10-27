import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase } from '../lib/sqlite.js'
import { MemoryStore } from '../lib/memory-store.js'
import { fullDiary } from './helpers.mjs'

test('builtin SQLite rolls back failed and nested transactions and preserves Buffer blobs', () => {
  const { db, backend } = openDatabase(':memory:', 'builtin')
  try {
    assert.equal(backend, 'node:sqlite')
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, value BLOB NOT NULL)')
    const insert = db.prepare('INSERT INTO items VALUES (?, ?)')
    db.transaction(() => {
      insert.run(1, Buffer.from([1, 2]))
      assert.throws(db.transaction(() => { insert.run(2, Buffer.from([3])); throw new Error('rollback inner') }), /rollback inner/)
      insert.run(3, Buffer.from([4]))
    })()
    assert.deepEqual(db.prepare('SELECT * FROM items ORDER BY id').all(), [{ id: 1, value: Buffer.from([1, 2]) }, { id: 3, value: Buffer.from([4]) }])
    assert.throws(db.transaction(() => { insert.run(4, Buffer.from([5])); throw new Error('rollback outer') }), /rollback outer/)
    assert.throws(db.transaction(() => { insert.run(5, Buffer.from([6])); return Promise.resolve() }), /同步/)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2)
    assert.equal([...db.prepare('SELECT * FROM items').iterate()].length, 2)
  } finally { db.close() }
  assert.equal(db.open, false)
})

test('native and builtin SQLite reopen the same diaries and vector index without migration', () => {
  const folder = mkdtempSync(join(tmpdir(), 'diary-sqlite-'))
  const filename = join(folder, 'memories.sqlite3')
  let store
  try {
    store = new MemoryStore(filename, { driver: 'native' })
    const row = store.prepare({ namespace: 'companion', sessionId: 'existing', sourceHash: 'hash', sourceSeqs: [1, 3], compactionId: 'c1', diary: fullDiary(1), searchText: '雨天', embeddingKey: 'space', vector: [1, 0, 0] })
    store.close()
    store = new MemoryStore(filename, { driver: 'builtin' })
    assert.equal(store.backend, 'node:sqlite')
    assert.ok(Buffer.isBuffer(store.pending('existing')[0].vector))
    assert.equal(store.count('companion'), 0)
    store.commit(row.id, 10)
    assert.equal(store.search([1, 0, 0], { namespace: 'companion', embeddingKey: 'space' })[0].similarity, 1)
    store.close()
    store = new MemoryStore(filename, { driver: 'native' })
    assert.equal(store.backend, 'better-sqlite3')
    assert.deepEqual(store.recent('companion')[0].sourceSeqs, [1, 3])
    assert.equal(store.search([1, 0, 0], { namespace: 'companion', embeddingKey: 'space' })[0].id, row.id)
  } finally { store?.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('invalid SQLite files fail visibly without replacing or migrating the file', () => {
  const folder = mkdtempSync(join(tmpdir(), 'diary-corrupt-'))
  const filename = join(folder, 'invalid.sqlite3')
  writeFileSync(filename, 'this is not a SQLite database')
  try {
    for (const driver of ['auto', 'builtin']) assert.throws(() => new MemoryStore(filename, { driver }), /not a database/)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
