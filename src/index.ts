import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.js'
import type { DiaryConfig } from './config.js'
import { RetrievalService } from './retrieval-service.js'

export { Config, defaults, resolveConfig } from './config.js'
export type { DiaryConfig, ResolvedConfig } from './config.js'
export { BailianClient, BailianError } from './bailian-client.js'
export { MemoryStore } from './memory-store.js'
export { RetrievalService } from './retrieval-service.js'
export { DiaryOrchestrator } from './orchestrator.js'
export type { RecallHit, RecallOptions } from './retrieval-service.js'
export type { Diary } from './diary.js'

export const name = 'diary-memory'
export const inject = ['sessions', 'sessionProjections']

export async function apply(ctx: Context, input: Partial<DiaryConfig> = {}): Promise<void> {
  const memory = new RetrievalService(ctx, resolveConfig(input))
  await memory.initialize()
}
