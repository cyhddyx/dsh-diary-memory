import { setTimeout as delay } from 'node:timers/promises'
import type { ResolvedConfig } from './config.js'
import { stableParameters } from './model-parameters.js'

interface BailianFailure {
  status?: number
  requestId?: string
  retryable?: boolean
}
export interface RerankResult { index: number; relevance_score: number }

export class BailianError extends Error {
  readonly status?: number
  readonly requestId?: string
  readonly retryable: boolean
  constructor(message: string, { status, requestId, retryable = false }: BailianFailure = {}) {
    super(message)
    this.name = 'BailianError'
    this.status = status
    this.requestId = requestId
    this.retryable = retryable
  }
}

export function validateVector(vector: unknown, dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(n => typeof n === 'number' && Number.isFinite(n))) throw new BailianError('百炼返回的向量维度或数值无效')
  if (!vector.some(n => n !== 0)) throw new BailianError('百炼返回了零向量')
  return vector
}

/** Native DashScope APIs; no OpenAI SDK or compatibility endpoint is involved. */
export class BailianClient {
  readonly config: ResolvedConfig
  readonly fetch: typeof globalThis.fetch
  readonly signal?: AbortSignal
  readonly embeddingKey: string
  constructor(config: ResolvedConfig, { fetch: fetchImpl = globalThis.fetch, signal }: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {}) {
    this.config = config
    this.fetch = fetchImpl
    this.signal = signal
    // Model names alone do not identify the vector space across endpoints/dimensions.
    const space: unknown[] = [config.baseUrl, config.embeddingModel, config.embeddingDimensions]
    // Keep the original vector-space key when no extra parameters were chosen.
    if (Object.keys(config.embeddingParameters).length) space.push(stableParameters(config.embeddingParameters))
    this.embeddingKey = JSON.stringify(space)
  }

  async request(path: string, body: unknown, callerSignal?: AbortSignal): Promise<unknown> {
    const { config } = this
    if (!config.apiKey) throw new BailianError('请先配置百炼 apiKey 或 DSH_DIARY_BAILIAN_API_KEY')
    const signals = [this.signal, callerSignal].filter((item): item is AbortSignal => item !== undefined)
    const parent = signals.length ? AbortSignal.any(signals) : undefined
    for (let attempt = 0; ; attempt++) {
      parent?.throwIfAborted()
      const signal = AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(config.timeoutMs)])
      let backoff = Math.min(500 * 2 ** attempt, 10000)
      try {
        const response = await this.fetch(new URL(path, config.baseUrl), {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
          redirect: 'error',
        })
        // Keep the timeout active while the body is being read, too.
        if (!response.ok) {
          const retryAfter = response.headers.get('retry-after')
          if (retryAfter) {
            const ms = /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()
            if (Number.isFinite(ms)) backoff = Math.min(30000, Math.max(backoff, ms))
          }
          await response.body?.cancel()
          throw new BailianError(`百炼请求失败（HTTP ${response.status}）`, {
            status: response.status,
            requestId: response.headers.get('x-request-id') ?? undefined,
            retryable: response.status === 429 || response.status >= 500,
          })
        }
        const data: unknown = await response.json()
        if (typeof data !== 'object' || data === null || !('output' in data) || !data.output || ('code' in data && data.code)) throw new BailianError('百炼返回了 API 错误或缺少 output')
        parent?.throwIfAborted()
        return data.output
      } catch (error) {
        parent?.throwIfAborted()
        const failure = error instanceof BailianError ? error : new BailianError(
          signal.aborted ? '百炼请求超时' : '百炼网络请求失败或响应不是有效 JSON',
          { retryable: error instanceof TypeError || signal.aborted },
        )
        if (!failure.retryable || attempt >= config.retries) throw failure
      }
      await delay(backoff, undefined, parent ? { signal: parent } : {})
    }
  }

  async embed(text: string, { textType = 'document', signal }: { textType?: 'document' | 'query'; signal?: AbortSignal } = {}): Promise<number[]> {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('embedding 文本不能为空')
    if (!['document', 'query'].includes(textType)) throw new TypeError('无效的 embedding textType')
    const { embeddingModel, embeddingDimensions } = this.config
    const output = await this.request('/api/v1/services/embeddings/text-embedding/text-embedding', {
      model: embeddingModel,
      input: { texts: [text] },
      parameters: { ...this.config.embeddingParameters, text_type: textType, dimension: embeddingDimensions },
    }, signal) as { embeddings?: { text_index?: unknown; embedding?: unknown }[] }
    if (output.embeddings?.length !== 1 || output.embeddings[0].text_index !== 0) throw new BailianError('百炼 embedding 的 text_index 无效')
    return validateVector(output.embeddings[0].embedding, embeddingDimensions)
  }

  async rerank(query: string, documents: string[], { topN = documents.length, signal }: { topN?: number; signal?: AbortSignal } = {}): Promise<RerankResult[]> {
    if (!documents.length) return []
    if (typeof query !== 'string' || !query.trim() || documents.some(text => typeof text !== 'string' || !text.trim())) throw new TypeError('rerank 的查询和文档不能为空')
    if (!Number.isInteger(topN) || topN < 1 || topN > documents.length) throw new TypeError('无效的 rerank topN')
    const output = await this.request('/api/v1/services/rerank/text-rerank/text-rerank', {
      model: this.config.rerankModel,
      input: { query, documents },
      parameters: { return_documents: false, ...this.config.rerankParameters, top_n: topN },
    }, signal) as { results?: RerankResult[] }
    if (!Array.isArray(output.results) || output.results.length !== topN) throw new BailianError('百炼 rerank 结果数量无效')
    const seen = new Set()
    for (const result of output.results) {
      if (!Number.isInteger(result.index) || result.index < 0 || result.index >= documents.length || seen.has(result.index) || !Number.isFinite(result.relevance_score) || result.relevance_score < 0 || result.relevance_score > 1) throw new BailianError('百炼 rerank 返回了无效或重复的文档索引/分数')
      seen.add(result.index)
    }
    return [...output.results].sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
  }
}
