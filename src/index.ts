import type { Context } from '@deepseek-ai/cordis'
import { resolvePluginConfig } from './config.js'
import type { PluginConfig } from './config.js'
import { RetrievalService } from './retrieval-service.js'
import type {} from '@deepseek-ai/dsh-settings'
import { SessionMemory } from './session-memory.js'

export { Config, defaults, resolveConfig } from './config.js'
export type { DiaryConfig, PluginConfig, ResolvedConfig } from './config.js'
export { BailianClient, BailianError } from './bailian-client.js'
export { MemoryStore } from './memory-store.js'
export { RetrievalService } from './retrieval-service.js'
export { DiaryOrchestrator } from './orchestrator.js'
export type { RecallHit, RecallOptions } from './retrieval-service.js'
export type { Diary } from './diary.js'

export const name = 'diary-memory'
export const inject = ['sessions', 'sessionProjections']

export async function apply(ctx: Context, input: Partial<PluginConfig> = {}): Promise<void> {
  const memory = new RetrievalService(ctx, () => resolvePluginConfig(input))
  await memory.initialize()
  ctx.inject(['agents', 'agentPresets', 'llm', 'tokenMeter', 'tools'], (sessionCtx) => { new SessionMemory(sessionCtx, memory) })
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber), 'diary-memory: custom settings page')
  })
}
