import type { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { selectRoundRange } from './diary.js'
import { appendRecalledContext, prepareDiarySummary } from './diary-runtime.js'
import type { DiarySummary } from './diary.js'
import type { RetrievalService } from './retrieval-service.js'

/** Reuses DSH's only supported subclass hook; native locks/validation/commit stay native. */
export class DiaryOrchestrator extends BasicCompactionEngine {
  static override inject = ['llm', 'tokenMeter', 'sessions', 'diaryMemory']
  readonly memory: RetrievalService

  constructor(ctx: Context, nativeConfig: BasicCompactionConfig = {}) {
    // Native pressure/overflow/manual policies remain active. A bounded diary replaces
    // the default engineering summary through the protected summarize() hook.
    super(ctx, { headroomTokens: 8192, maxTokens: 3000, ...nativeConfig })
    this.memory = ctx.diaryMemory
    ctx.on('agent/created', async ({ agent }) => {
      await this.memory.track(() => this.memory.reconcile(agent.session))
      return undefined
    })
    ctx.on('agent/pre-step', async ({ messages, signal }, next) => appendRecalledContext(ctx, this.memory, await next(), messages, signal), { prepend: true })
  }

  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    await this.memory.track(() => this.memory.reconcile(agent.session))
    signal.throwIfAborted()
    if (trigger === 'pressure' && this.memory.stateOf(agent.session).completedRounds >= this.memory.config.compressionRounds) {
      const range = selectRoundRange(agent.session, this.memory.config.retainRounds)
      if (range) return this.compactRegion(range.start, range.end, agent, signal)
    }
    return super.compactIfNeeded(agent, trigger, signal)
  }

  protected override async summarize(input: { readonly messages: readonly Message[] }, agent: Agent, signal?: AbortSignal): Promise<DiarySummary> {
    return prepareDiarySummary(this.ctx, this.memory, input, agent, signal)
  }

  override compactRegion(start: SessionSeq, end: SessionSeq, agent: Agent, signal?: AbortSignal): Promise<CompactionResult> {
    return this.memory.track(async () => {
      try {
        return await super.compactRegion(start, end, agent, signal)
      } finally {
        // Even a late native failure may have landed a replacement. Reconcile the
        // authoritative log rather than guessing success from a rejected promise.
        await this.memory.reconcile(agent.session)
      }
    })
  }

  override compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null> {
    return this.memory.track(async () => {
      try {
        return await super.compactNow(agent, signal, sourceCommandId)
      } finally {
        await this.memory.reconcile(agent.session)
      }
    })
  }
}

export default DiaryOrchestrator
