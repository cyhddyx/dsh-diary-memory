import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateVector } from './bailian-client.js'
import type { Diary } from './diary.js'

interface RawDiary {
  id: string
  namespace: string
  session_id: string
  source_hash: string
  source_seqs_json: string
  compaction_id: string
  state: 'prepared' | 'committed' | 'aborted'
  diary_json: string
  search_text: string
  embedding_key: string
  dimensions: number
  vector: Buffer
  vector_norm: number
  created_at: number
  committed_at: number | null
  checkpoint_seq: number | null
}
export interface DiaryRecord extends Omit<RawDiary, 'diary_json' | 'source_seqs_json'> {
  diary: Diary
  sourceSeqs: number[]
}
export interface PreparedDiary {
  namespace: string
  sessionId: string
  sourceHash: string
  sourceSeqs: number[]
  compactionId: string
  diary: Diary
  searchText: string
  embeddingKey: string
  vector: number[]
}
export interface SearchOptions { namespace: string; embeddingKey: string; limit?: number; sessionId?: string }
export type SearchHit = Omit<DiaryRecord, 'vector' | 'vector_norm'> & { similarity: number }

function encodeVector(vector: number[], dimensions: number) {
  validateVector(vector, dimensions)
  const buffer = Buffer.alloc(dimensions * 4)
  let squares = 0
  vector.forEach((value, index) => {
    buffer.writeFloatLE(value, index * 4)
    const stored = buffer.readFloatLE(index * 4)
    if (!Number.isFinite(stored)) throw new TypeError('向量不能表示为 Float32')
    squares += stored ** 2
  })
  const norm = Math.sqrt(squares)
  if (!Number.isFinite(norm) || norm === 0) throw new TypeError('无效的向量范数')
  return { buffer, norm }
}

function decodeRow(row: RawDiary): DiaryRecord
function decodeRow(row: RawDiary | undefined): DiaryRecord | null
function decodeRow(row: RawDiary | undefined): DiaryRecord | null {
  if (!row) return null
  const { diary_json, source_seqs_json, ...rest } = row
  return { ...rest, diary: JSON.parse(diary_json), sourceSeqs: JSON.parse(source_seqs_json) }
}

/** SQLite-backed exact cosine index. Prepared diaries never enter the recall index. */
export class MemoryStore {
  readonly db: Database.Database
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true })
    this.db = new Database(filename)
    try {
      this.db.pragma('busy_timeout = 5000')
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = FULL')
      const version = this.db.pragma('user_version', { simple: true })
      if (typeof version !== 'number' || version > 1) throw new Error('日记数据库来自更新版本的插件，拒绝降级打开')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS diaries (
          id TEXT PRIMARY KEY,
          namespace TEXT NOT NULL,
          session_id TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          source_seqs_json TEXT NOT NULL,
          compaction_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','committed','aborted')),
          diary_json TEXT NOT NULL,
          search_text TEXT NOT NULL,
          embedding_key TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          vector BLOB NOT NULL,
          vector_norm REAL NOT NULL CHECK(vector_norm > 0),
          created_at INTEGER NOT NULL,
          committed_at INTEGER,
          checkpoint_seq INTEGER,
          UNIQUE(namespace, session_id, source_hash, embedding_key)
        );
        CREATE INDEX IF NOT EXISTS diary_vector_space ON diaries(namespace, embedding_key, dimensions, state);
        CREATE INDEX IF NOT EXISTS diary_pending_session ON diaries(session_id, state);
        CREATE INDEX IF NOT EXISTS diary_timeline ON diaries(namespace, state, committed_at);
        PRAGMA user_version = 1;
      `)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  findSource(namespace: string, sessionId: string, sourceHash: string, embeddingKey: string): DiaryRecord | null {
    return decodeRow(this.db.prepare('SELECT * FROM diaries WHERE namespace=? AND session_id=? AND source_hash=? AND embedding_key=?').get(namespace, sessionId, sourceHash, embeddingKey) as RawDiary | undefined)
  }

  prepare({ namespace, sessionId, sourceHash, sourceSeqs, compactionId, diary, searchText, embeddingKey, vector }: PreparedDiary): DiaryRecord {
    const { buffer, norm } = encodeVector(vector, vector.length)
    return this.db.transaction(() => {
      const existing = this.findSource(namespace, sessionId, sourceHash, embeddingKey)
      if (existing?.state === 'committed') throw new Error('该会话片段已经入库；拒绝重复压缩')
      const id = existing?.id ?? randomUUID()
      this.db.prepare(`INSERT INTO diaries (
        id,namespace,session_id,source_hash,source_seqs_json,compaction_id,state,
        diary_json,search_text,embedding_key,dimensions,vector,vector_norm,created_at
      ) VALUES (?,?,?,?,?,?,'prepared',?,?,?,?,?,?,?)
      ON CONFLICT(namespace,session_id,source_hash,embedding_key) DO UPDATE SET
        compaction_id=excluded.compaction_id, source_seqs_json=excluded.source_seqs_json, state='prepared',
        diary_json=excluded.diary_json, search_text=excluded.search_text,
        dimensions=excluded.dimensions, vector=excluded.vector, vector_norm=excluded.vector_norm,
        checkpoint_seq=NULL, committed_at=NULL`).run(
        id, namespace, sessionId, sourceHash, JSON.stringify(sourceSeqs), compactionId,
        JSON.stringify(diary), searchText, embeddingKey, vector.length, buffer, norm, Date.now(),
      )
      return this.findSource(namespace, sessionId, sourceHash, embeddingKey)!
    })()
  }

  rebind(id: string, compactionId: string): void {
    this.db.prepare("UPDATE diaries SET compaction_id=?, state='prepared' WHERE id=? AND state IN ('prepared','aborted')").run(compactionId, id)
  }

  pending(sessionId: string): DiaryRecord[] {
    return (this.db.prepare("SELECT * FROM diaries WHERE session_id=? AND state='prepared' ORDER BY created_at,id").all(sessionId) as RawDiary[]).map(row => decodeRow(row))
  }

  commit(id: string, checkpointSeq: number): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE diaries SET state='committed', committed_at=?, checkpoint_seq=? WHERE id=? AND state='prepared'").run(Date.now(), checkpointSeq, id)
    })()
  }

  abort(id: string): void {
    this.db.prepare("UPDATE diaries SET state='aborted' WHERE id=? AND state='prepared'").run(id)
  }

  recent(namespace: string, limit = 3): DiaryRecord[] {
    return (this.db.prepare("SELECT * FROM diaries WHERE namespace=? AND state='committed' ORDER BY committed_at DESC, rowid DESC LIMIT ?").all(namespace, limit) as RawDiary[]).map(row => decodeRow(row))
  }

  count(namespace: string, embeddingKey?: string): number {
    const filter = embeddingKey === undefined ? '' : ' AND embedding_key=?'
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM diaries WHERE namespace=? AND state='committed'${filter}`).get(...[namespace, ...(embeddingKey === undefined ? [] : [embeddingKey])]) as { count: number }).count
  }

  search(vector: number[], { namespace, embeddingKey, limit = 30, sessionId }: SearchOptions): SearchHit[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('search limit 必须为 1–100')
    const query = encodeVector(vector, vector.length)
    const rows = this.db.prepare(`SELECT * FROM diaries
      WHERE namespace=? AND embedding_key=? AND dimensions=? AND state='committed'
      ${sessionId === undefined ? '' : 'AND session_id=?'}`).iterate(namespace, embeddingKey, vector.length, ...(sessionId === undefined ? [] : [sessionId])) as IterableIterator<RawDiary>
    const top: (DiaryRecord & { similarity: number })[] = []
    for (const row of rows) {
      if (row.vector.length !== vector.length * 4) throw new Error('日记向量索引损坏：BLOB 长度错误')
      let dot = 0
      for (let index = 0; index < vector.length; index++) dot += query.buffer.readFloatLE(index * 4) * row.vector.readFloatLE(index * 4)
      const similarity = dot / (query.norm * row.vector_norm)
      if (!Number.isFinite(similarity)) throw new Error('日记向量索引损坏：余弦分数无效')
      top.push({ ...decodeRow(row), similarity: Math.max(-1, Math.min(1, similarity)) })
      top.sort((a, b) => b.similarity - a.similarity || b.created_at - a.created_at || a.id.localeCompare(b.id))
      if (top.length > limit) top.pop()
    }
    return top.map(({ vector: _vector, vector_norm: _norm, ...row }) => row)
  }

  close() { if (this.db.open) this.db.close() }
}
