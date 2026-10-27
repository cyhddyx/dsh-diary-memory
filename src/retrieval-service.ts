import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { isDeepStrictEqual } from 'node:util'
import { BailianClient } from './bailian-client.js'
import { MemoryStore } from './memory-store.js'
import { renderDiary } from './diary.js'
import type { Diary } from './diary.js'
import type { ResolvedConfig } from './config.js'
import { diaryProjection } from './projection.js'
import type { DiaryProjectionState } from './projection.js'

declare module '@deepseek-ai/cordis' {
  interface Context { diaryMemory: RetrievalService }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'diary-memory': { kind: 'diary-memory'; form: 'recall' } }
}

export interface RecallOptions { limit?: number; sessionId?: string; signal?: AbortSignal }
export interface RecallHit {
  id: string
  sessionId: string
  recordedAt: string
  diary: Diary
  similarity: number
  score: number
}

export class RetrievalService extends Service {
  readonly store: MemoryStore
  readonly lifetime = new AbortController()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly recovery = new WeakMap<Session, Promise<void>>()
  private readonly configuration: () => ResolvedConfig
  private readonly fixedClient?: BailianClient
  private cachedClient?: { key: string; client: BailianClient }

  constructor(ctx: Context, config: ResolvedConfig | (() => ResolvedConfig), dependencies: { store?: MemoryStore; client?: BailianClient } = {}) {
    super(ctx, 'diaryMemory')
    this.configuration = typeof config === 'function' ? config : () => config
    this.store = dependencies.store ?? new MemoryStore(this.config.databasePath)
    this.fixedClient = dependencies.client
    ctx.effect(() => () => this.dispose(), 'diaryMemory.lifecycle()')
  }

  get config(): ResolvedConfig { return this.configuration() }
  get client(): BailianClient { return this.snapshot().client }

  /** One operation keeps its route and vector space even if settings change in flight. */
  snapshot(): { config: ResolvedConfig; client: BailianClient; store: MemoryStore } {
    const config = this.config
    const key = JSON.stringify([config.apiKey, config.baseUrl, config.embeddingModel, config.embeddingDimensions, config.embeddingParameters, config.rerankModel, config.rerankParameters, config.timeoutMs, config.retries])
    if (!this.fixedClient && this.cachedClient?.key !== key) this.cachedClient = { key, client: new BailianClient(config, { signal: this.lifetime.signal }) }
    return { config, client: this.fixedClient ?? this.cachedClient!.client, store: this.store }
  }

  async initialize(): Promise<void> {
    await this.ctx.sessionProjections.register(diaryProjection)
    this.ctx.on('session/created', session => {
      void this.track(() => this.reconcile(session)).catch(() => this.ctx.logger.warn('日记恢复未完成；保留待提交记录，下次使用时重试'))
    })
    for (const session of this.ctx.sessions.list()) await this.track(() => this.reconcile(session))
  }

  stateOf(session: Session): DiaryProjectionState {
    const state = this.ctx.sessionProjections.stateOf(session, diaryProjection.key)
    if (!state) throw new Error('日记轮次 projection 未注册')
    return state
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    this.lifetime.signal.throwIfAborted()
    // Preserve native synchronous lock/maintenance admission before the first await.
    let promise: Promise<T>
    try { promise = operation() } catch (error) { promise = Promise.reject(error) }
    this.jobs.add(promise)
    void promise.then(() => this.jobs.delete(promise), () => this.jobs.delete(promise))
    return promise
  }

  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('日记记忆插件已卸载'))
    await Promise.allSettled([...this.jobs])
    this.store.close()
  }

  recall(query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
    return this.track(async () => {
      const { config, client } = this.snapshot()
      const text = query.trim()
      if (!text || text.length > 8000) throw new TypeError('recall query 必须为 1–8000 字符')
      const limit = options.limit ?? config.recallCount
      if (!Number.isInteger(limit) || limit < 1 || limit > config.candidateCount) throw new TypeError('recall limit 超出候选数量')
      const signal = AbortSignal.any([this.lifetime.signal, ...options.signal ? [options.signal] : []])
      signal.throwIfAborted()
      const namespace = config.namespace
      if (!this.store.count(namespace, client.embeddingKey)) {
        if (this.store.count(namespace)) throw new Error('已有日记使用不同的 embedding 模型、维度或端点，请使用原向量配置或重新索引')
        return []
      }
      const vector = await client.embed(text, { textType: 'query', signal })
      const candidates = this.store.search(vector, { namespace, embeddingKey: client.embeddingKey, limit: config.candidateCount, sessionId: options.sessionId })
      if (!candidates.length) return []
      const ranking = await client.rerank(text, candidates.map(item => item.search_text), { topN: Math.min(limit, candidates.length), signal })
      signal.throwIfAborted()
      return ranking.map(item => {
        const match = candidates[item.index]
        return { id: match.id, sessionId: match.session_id, recordedAt: match.diary.recordedAt, diary: match.diary, similarity: match.similarity, score: item.relevance_score }
      })
    })
  }

  /** Session log is authoritative. Only a matching flushed replacement can publish memory. */
  reconcile(session: Session): Promise<void> {
    const existing = this.recovery.get(session)
    if (existing) return existing
    const promise = this.reconcileOnce(session).finally(() => this.recovery.delete(session))
    this.recovery.set(session, promise)
    return promise
  }

  private async reconcileOnce(session: Session): Promise<void> {
    const pending = this.store.pending(session.id)
    if (!pending.length) return
    const events = session.snapshotEvents()
    const commits: { id: string; seq: number }[] = []
    for (const record of pending) {
      const checkpoint = events.find((event, index) => {
        if (event.type !== 'user/message' || event.data.source.kind !== 'compact-checkpoint' || event.data.source.compactionId !== record.compaction_id || typeof event.surfaceOp !== 'object' || event.surfaceOp.op !== 'replace') return false
        const summary = events[index - 1]
        return summary?.type === 'compaction/summary'
          && summary.data.compactionId === record.compaction_id
          && isDeepStrictEqual(summary.data.shadowedSeqs, record.sourceSeqs)
          && isDeepStrictEqual(summary.data.summary, [{ type: 'text', text: renderDiary(record.diary) }])
      })
      if (checkpoint) commits.push({ id: record.id, seq: checkpoint.seq })
      else if (events.some(event => event.type === 'compaction/end' && event.data.compactionId === record.compaction_id && event.data.error !== undefined)) this.store.abort(record.id)
    }
    if (!commits.length) return
    if (!await this.ctx.sessions.flush(session)) throw new Error('没有会话持久化提供方；日记仍为 prepared，不对检索可见')
    for (const item of commits) this.store.commit(item.id, item.seq)
  }

  continuityContext(): string {
    return this.store.recent(this.config.namespace, this.config.recentDiaryCount).reverse().map(record => renderDiary(record.diary)).join('\n\n---\n\n')
  }
}
