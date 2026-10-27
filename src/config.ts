import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateModelParameters } from './model-parameters.js'
import type { ModelParameters } from './model-parameters.js'

export interface DiaryConfig {
  apiKey: string
  baseUrl: string
  embeddingModel: string
  embeddingDimensions: number
  embeddingParameters: ModelParameters
  rerankModel: string
  rerankParameters: ModelParameters
  compressionRounds: number
  retainRounds: number
  namespace: string
  databasePath: string
  candidateCount: number
  recallCount: number
  timeoutMs: number
  retries: number
  diaryProvider: string
  diaryModel: string
  diaryMaxTokens: number
  diaryInputMaxChars: number
  recentDiaryCount: number
  autoRecall: boolean
}
export type ResolvedConfig = Readonly<DiaryConfig>

export const defaults = Object.freeze({
  apiKey: '',
  baseUrl: 'https://dashscope.aliyuncs.com',
  embeddingModel: 'text-embedding-v4',
  embeddingDimensions: 1024,
  embeddingParameters: Object.freeze({}),
  rerankModel: 'gte-rerank-v2',
  rerankParameters: Object.freeze({}),
  compressionRounds: 20,
  retainRounds: 2,
  namespace: 'companion',
  databasePath: '',
  candidateCount: 30,
  recallCount: 6,
  timeoutMs: 30000,
  retries: 2,
  diaryProvider: '',
  diaryModel: '',
  diaryMaxTokens: 3000,
  diaryInputMaxChars: 200000,
  recentDiaryCount: 3,
  autoRecall: true,
})

const fields = {
  apiKey: z.string().role('secret').default('').description('百炼 API Key；留空读取 DSH_DIARY_BAILIAN_API_KEY 或 DASHSCOPE_API_KEY。'),
  baseUrl: z.string().default(defaults.baseUrl).description('百炼地域端点；须与 API Key 的地域一致。'),
  embeddingModel: z.string().default(defaults.embeddingModel),
  embeddingDimensions: z.number().step(1).min(1).max(4096).default(defaults.embeddingDimensions),
  embeddingParameters: z.dict(z.any()).default({}).description('Embedding API 的额外 parameters JSON；dimension 和 text_type 由插件设置。'),
  rerankModel: z.string().default(defaults.rerankModel),
  rerankParameters: z.dict(z.any()).default({}).description('Rerank API 的额外 parameters JSON；top_n 由召回条数设置。'),
  compressionRounds: z.number().step(1).min(2).default(defaults.compressionRounds).description('累计完成多少个会话轮次后，在下一次安全的 pre-step 压缩。工具调用不额外计轮次。'),
  retainRounds: z.number().step(1).min(1).default(defaults.retainRounds).description('至少保留最近多少个用户输入及其后续消息。'),
  namespace: z.string().default(defaults.namespace).description('数字分身的记忆空间。只有使用同一空间的会话共享日记与自我演化。'),
  databasePath: z.string().default('').description('SQLite 文件；默认位于当前 DSH profile 的 diary-memory/ 中。'),
  candidateCount: z.number().step(1).min(1).max(100).default(defaults.candidateCount),
  recallCount: z.number().step(1).min(1).max(100).default(defaults.recallCount),
  timeoutMs: z.number().step(1).min(100).max(300000).default(defaults.timeoutMs),
  retries: z.number().step(1).min(0).max(5).default(defaults.retries),
  diaryProvider: z.string().default('').description('日记生成使用 DSH 的 LLM 路由；两个字段均留空则继承会话模型。'),
  diaryModel: z.string().default(''),
  diaryMaxTokens: z.number().step(1).min(256).max(16000).default(defaults.diaryMaxTokens),
  diaryInputMaxChars: z.number().step(1).min(1000).default(defaults.diaryInputMaxChars),
  recentDiaryCount: z.number().step(1).min(0).max(10).default(defaults.recentDiaryCount),
  autoRecall: z.boolean().default(true).description('每个新用户输入自动检索日记，接纳到当前步骤并写入可重放的上下文。'),
}

const ValueConfig: z<DiaryConfig> = z.object(fields)
export const liveConfigFields = ['apiKey', 'baseUrl', 'embeddingModel', 'embeddingDimensions', 'embeddingParameters', 'rerankModel', 'rerankParameters', 'compressionRounds', 'retainRounds', 'candidateCount', 'recallCount', 'autoRecall'] as const
export type LiveConfigField = typeof liveConfigFields[number]
export type PluginConfig = { [K in keyof DiaryConfig]: K extends LiveConfigField ? DiaryConfig[K] | { get(): DiaryConfig[K] | undefined } : DiaryConfig[K] }

/** DSH only exposes volatile fields to its settings transport. */
export const Config = z.object({
  ...fields,
  ...Object.fromEntries(liveConfigFields.map(key => [key, fields[key].volatile()])),
  // No empty default on the write-only credential: the secret sidecar can report absence.
  apiKey: z.string().role('secret').volatile().description('百炼 API Key；留空保留当前密钥。'),
})

export function resolvePluginConfig(input: Partial<PluginConfig> = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const values = Object.fromEntries(Object.entries(input).map(([key, value]) => [key,
    liveConfigFields.includes(key as LiveConfigField) && value !== null && typeof value === 'object' && 'get' in value && typeof value.get === 'function' ? value.get() : value,
  ]))
  // Missing optional volatile values inherit the ordinary defaults.
  return resolveConfig(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)), env)
}

export function resolveConfig(input: Partial<DiaryConfig> = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  for (const key of Object.keys(input)) {
    if (!(key in defaults)) throw new Error(`未知日记配置项：${key}`)
  }
  // Schemastery normalizes dictionaries in place; live references are immutable.
  const config = ValueConfig(structuredClone({ ...defaults, ...input }))
  const ranges: [keyof Pick<DiaryConfig, 'embeddingDimensions' | 'compressionRounds' | 'retainRounds' | 'candidateCount' | 'recallCount' | 'timeoutMs' | 'retries' | 'diaryMaxTokens' | 'diaryInputMaxChars' | 'recentDiaryCount'>, number, number][] = [
    ['embeddingDimensions', 1, 4096], ['compressionRounds', 2, 1000000],
    ['retainRounds', 1, 1000000], ['candidateCount', 1, 100], ['recallCount', 1, 100],
    ['timeoutMs', 100, 300000], ['retries', 0, 5], ['diaryMaxTokens', 256, 16000],
    ['diaryInputMaxChars', 1000, 10000000], ['recentDiaryCount', 0, 10],
  ]
  for (const [key, min, max] of ranges) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) {
      throw new Error(`${key} 必须为 ${min}–${max} 的整数`)
    }
  }
  if (config.compressionRounds <= config.retainRounds) throw new Error('compressionRounds 必须大于 retainRounds')
  if (config.recallCount > config.candidateCount) throw new Error('recallCount 不能大于 candidateCount')
  config.diaryProvider = config.diaryProvider.trim()
  config.diaryModel = config.diaryModel.trim()
  if (Boolean(config.diaryProvider) !== Boolean(config.diaryModel)) throw new Error('diaryProvider 和 diaryModel 必须同时设置')
  for (const key of ['namespace', 'embeddingModel', 'rerankModel'] as const) {
    config[key] = config[key].trim()
    if (!config[key] || config[key].length > 200) throw new Error(`${key} 不能为空且不能超过 200 字符`)
  }
  const endpoint = new URL(config.baseUrl)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('baseUrl 必须是无路径、凭据和查询参数的百炼 origin')
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname))) throw new Error('baseUrl 需要 HTTPS；本地测试可以使用 loopback HTTP')
  config.baseUrl = endpoint.origin
  config.embeddingParameters = validateModelParameters(config.embeddingParameters, 'embedding')
  config.rerankParameters = validateModelParameters(config.rerankParameters, 'rerank')
  config.apiKey = config.apiKey.trim() || env.DSH_DIARY_BAILIAN_API_KEY?.trim() || env.DASHSCOPE_API_KEY?.trim() || ''
  const profileDir = env.DSH_PROFILE_DIR?.trim() || join(env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'profiles', env.DSH_PROFILE?.trim() || 'default')
  config.databasePath = config.databasePath || join(profileDir, 'diary-memory', 'memories.sqlite3')
  if (config.databasePath !== ':memory:') config.databasePath = resolve(config.databasePath)
  return Object.freeze(config)
}
