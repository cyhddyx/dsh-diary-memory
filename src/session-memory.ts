import { AsyncLocalStorage } from 'node:async_hooks'
import { symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { DiarySummary } from './diary.js'
import { selectRoundRange } from './diary.js'
import { appendRecalledContext, prepareDiarySummary } from './diary-runtime.js'
import { DiaryOrchestrator } from './orchestrator.js'
import type { RetrievalService } from './retrieval-service.js'
import { registerRecall } from './tools.js'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'

type NativeEngine = Pick<BasicCompactionEngine, 'compactIfNeeded' | 'compactRegion' | 'compactNow'> & {
  readonly ctx: Context
  summarize(input: { readonly messages: readonly Message[] }, agent: Agent, signal?: AbortSignal): Promise<DiarySummary>
}

/** Route the existing native engine by Session, without rebinding its preset. */
export class SessionMemory {
  private readonly restorers = new Map<object, () => void>()
  private readonly operations = new AsyncLocalStorage<{ agent: Agent; enabled: boolean }>()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private closed = false
  private readonly recallScopes = new Map<Agent, Scope>()

  constructor(private readonly ctx: Context, private readonly memory: RetrievalService) {
    ctx.effect(() => () => this.dispose(), 'diary-memory: existing sessions')
    ctx.on('agent/created', async ({ agent }) => { this.attach(agent) })
    ctx.on('agent/disposed', async ({ agent }) => {
      const scope = this.recallScopes.get(agent)
      this.recallScopes.delete(agent)
      await scope?.dispose()
    })
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const enabled = this.selected(agent)
      const engine = this.attach(agent)
      if (enabled && engine && !(engine instanceof DiaryOrchestrator) && !this.recallScopes.has(agent)) {
        const key = scopeOf(agent.ctx)
        if (!key) throw new Error('指定会话缺少原生 Agent scope')
        const scope = createScope(ctx, key)
        registerRecall(scope.ctx)
        this.recallScopes.set(agent, scope)
      }
      if (!enabled) {
        const scope = this.recallScopes.get(agent)
        this.recallScopes.delete(agent)
        await scope?.dispose()
      }
      const decision = await next()
      // The companion preset already owns its recall middleware.
      if (!enabled || engine instanceof DiaryOrchestrator) return decision
      return appendRecalledContext(ctx, memory, decision, messages, signal)
    }, { prepend: true })
    for (const agent of ctx.agents.list()) this.attach(agent)
  }

  private selected(agent: Agent): boolean { return !this.closed && this.memory.config.sessionIds.includes(agent.session.id) }

  attach(agent: Agent): BasicCompactionEngine | undefined {
    const provider = this.ctx.agentPresets.serviceFor(agent, 'compaction')
    if (!provider) {
      if (this.selected(agent)) throw new Error('指定会话的预设没有原生压缩器，无法接入日记记忆')
      return undefined
    }
    if (this.closed) return provider as BasicCompactionEngine
    // Cordis proxies expose their original instance through this public symbol.
    const engine = ((provider as unknown as Record<symbol, unknown>)[symbols.original] ?? provider) as NativeEngine
    if (engine instanceof DiaryOrchestrator || this.restorers.has(engine)) return provider as BasicCompactionEngine
    const descriptors = new Map<string, PropertyDescriptor | undefined>()
    const replacements = new Map<string, unknown>()
    const bridge = this
    const enabled = (owner: Agent) => {
      const operation = bridge.operations.getStore()
      return operation?.agent === owner ? operation.enabled : bridge.selected(owner)
    }
    const replace = <K extends 'compactIfNeeded' | 'compactRegion' | 'compactNow' | 'summarize'>(name: K, method: NativeEngine[K]) => {
      descriptors.set(name, Object.getOwnPropertyDescriptor(engine, name))
      replacements.set(name, method)
      Object.defineProperty(engine, name, { configurable: true, writable: true, value: method })
    }
    const summarize = engine.summarize
    replace('summarize', function (this: NativeEngine, input, owner, signal) {
      if (!enabled(owner)) return summarize.call(this, input, owner, signal)
      return prepareDiarySummary(this.ctx, bridge.memory, input, owner, AbortSignal.any([bridge.lifetime.signal, ...signal ? [signal] : []]))
    })
    const compactIfNeeded = engine.compactIfNeeded
    replace('compactIfNeeded', function (this: NativeEngine, owner, trigger, signal) {
      const selected = enabled(owner)
      return bridge.run(owner, selected, async () => {
        if (!selected) return compactIfNeeded.call(this, owner, trigger, signal)
        await bridge.memory.reconcile(owner.session)
        signal.throwIfAborted()
        const config = bridge.memory.config
        if (trigger === 'pressure' && bridge.memory.stateOf(owner.session).completedRounds >= config.compressionRounds) {
          const range = selectRoundRange(owner.session, config.retainRounds)
          if (range) return this.compactRegion(range.start, range.end, owner, signal)
        }
        return compactIfNeeded.call(this, owner, trigger, signal)
      })
    })
    const compactRegion = engine.compactRegion
    replace('compactRegion', function (this: NativeEngine, start, end, owner, signal) {
      const selected = enabled(owner)
      return bridge.run(owner, selected, async () => {
        if (!selected) return compactRegion.call(this, start, end, owner, signal)
        try { return await compactRegion.call(this, start, end, owner, signal) }
        finally { await bridge.memory.reconcile(owner.session) }
      })
    })
    const compactNow = engine.compactNow
    replace('compactNow', function (this: NativeEngine, owner, signal, sourceCommandId) {
      const selected = enabled(owner)
      return bridge.run(owner, selected, async () => {
        if (!selected) return compactNow.call(this, owner, signal, sourceCommandId)
        try { return await compactNow.call(this, owner, signal, sourceCommandId) }
        finally { await bridge.memory.reconcile(owner.session) }
      })
    })
    this.restorers.set(engine, () => {
      for (const [name, descriptor] of descriptors) {
        if (Object.getOwnPropertyDescriptor(engine, name)?.value !== replacements.get(name)) continue
        if (descriptor) Object.defineProperty(engine, name, descriptor)
        else Reflect.deleteProperty(engine, name)
      }
    })
    return provider as BasicCompactionEngine
  }

  private run<T>(agent: Agent, enabled: boolean, operation: () => Promise<T>): Promise<T> {
    const job = this.memory.track(() => this.operations.run({ agent, enabled }, operation))
    this.jobs.add(job)
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job))
    return job
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifetime.abort(new Error('指定会话的日记记忆已关闭'))
    await Promise.allSettled([...this.jobs])
    for (const restore of this.restorers.values()) restore()
    this.restorers.clear()
    await Promise.allSettled([...this.recallScopes.values()].map(scope => scope.dispose()))
    this.recallScopes.clear()
  }
}
