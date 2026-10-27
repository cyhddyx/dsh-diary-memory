import { createRequire } from 'node:module'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

export type SqliteDriver = 'auto' | 'builtin' | 'native'
export interface SqliteStatement {
  run(...parameters: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  get(...parameters: SQLInputValue[]): Record<string, unknown> | undefined
  all(...parameters: SQLInputValue[]): Record<string, unknown>[]
  iterate(...parameters: SQLInputValue[]): IterableIterator<Record<string, unknown>>
}
export interface SqliteConnection {
  readonly open: boolean
  exec(sql: string): unknown
  prepare(sql: string): SqliteStatement
  pragma(sql: string, options?: { simple: boolean }): unknown
  transaction<T>(operation: () => T): () => T
  close(): unknown
}

const require = createRequire(import.meta.url)

/** Use the same SQLite file format without requiring an Electron-specific addon. */
function builtinDatabase(filename: string): SqliteConnection {
  const { DatabaseSync: Database } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSync }
  const database = new Database(filename)
  let open = true
  let transactionId = 0
  const normalize = (row: Record<string, unknown> | undefined) => row === undefined ? undefined
    : Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? Buffer.from(value) : value]))
  return {
    get open() { return open },
    exec: sql => database.exec(sql),
    prepare(sql) {
      const statement = database.prepare(sql)
      return {
        run: (...parameters) => statement.run(...parameters),
        get: (...parameters) => normalize(statement.get(...parameters)),
        all: (...parameters) => statement.all(...parameters).map(row => normalize(row)!),
        *iterate(...parameters) { for (const row of statement.iterate(...parameters)) yield normalize(row)! },
      }
    },
    pragma(sql, options) {
      const rows = database.prepare(`PRAGMA ${sql}`).all()
      return options?.simple ? Object.values(rows[0] ?? {})[0] : rows
    },
    transaction: operation => () => {
      // Savepoints also give nested synchronous operations rollback isolation.
      const point = `diary_${++transactionId}`
      database.exec(`SAVEPOINT ${point}`)
      try {
        const result = operation()
        if (result instanceof Promise) throw new TypeError('SQLite 事务必须同步完成')
        database.exec(`RELEASE ${point}`)
        return result
      } catch (error) {
        database.exec(`ROLLBACK TO ${point}; RELEASE ${point}`)
        throw error
      }
    },
    close() { database.close(); open = false },
  }
}

export function openDatabase(filename: string, driver: SqliteDriver = 'auto'): { db: SqliteConnection; backend: 'better-sqlite3' | 'node:sqlite' } {
  if (driver !== 'builtin') {
    try {
      const Database = require('better-sqlite3') as typeof import('better-sqlite3')
      return { db: new Database(filename) as unknown as SqliteConnection, backend: 'better-sqlite3' }
    } catch (error) {
      const failure = error as NodeJS.ErrnoException
      const unavailable = failure.code === 'MODULE_NOT_FOUND' || failure.code === 'ERR_DLOPEN_FAILED'
        || failure.message.startsWith('Could not locate the bindings file.')
      // Disk, SQL, permission and corruption failures must never select another backend.
      if (driver === 'native' || !unavailable) throw error
    }
  }
  return { db: builtinDatabase(filename), backend: 'node:sqlite' }
}
