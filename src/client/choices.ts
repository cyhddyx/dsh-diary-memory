import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

export interface SessionChoice { id: string; title: string }
export interface WriterChoice { provider: string; model: string; label: string }
export interface ChoicesState {
  sessions: SessionChoice[]
  sessionsReady: boolean
  writers: WriterChoice[]
  modelsStatus: 'loading' | 'ready' | 'error'
}
export interface SessionCatalog {
  phase: string
  ids: readonly string[]
  byId: Record<string, { id: string; displayTitle: string; origin?: string }>
}
export interface ModelCatalogResult {
  ok: boolean
  value?: { groups: readonly { id: string; name: string; models: readonly { id: string; name: string }[] }[] }
}

/** Read only the native metadata catalog; never open or upload conversation bodies. */
export class DiaryChoices {
  readonly store = createSnapshotStore<ChoicesState>({ sessions: [], sessionsReady: false, writers: [], modelsStatus: 'loading' })
  private readonly unsubscribe?: () => void
  private generation = 0
  private disposed = false

  constructor(private readonly catalog?: ObservableSnapshot<SessionCatalog>, private readonly loadModels?: () => Promise<ModelCatalogResult>, private readonly refreshSessions?: () => Promise<void>) {
    this.unsubscribe = catalog?.subscribe(() => this.readSessions())
    this.readSessions()
    void this.refreshModels()
  }

  private readSessions(): void {
    const value = this.catalog?.getSnapshot()
    this.store.update(state => {
      state.sessionsReady = value?.phase === 'ready'
      state.sessions = value ? value.ids.flatMap(id => {
        const row = value.byId[id]
        return row && row.origin !== 'subagent' ? [{ id, title: row.displayTitle }] : []
      }) : []
    })
  }

  async refreshModels(): Promise<void> {
    const generation = ++this.generation
    this.store.update(state => { state.modelsStatus = 'loading' })
    try {
      const response = await this.loadModels?.()
      if (this.disposed || generation !== this.generation) return
      this.store.update(state => {
        state.writers = response?.ok && response.value ? response.value.groups.flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id, label: `${group.name} / ${model.name}` }))) : []
        state.modelsStatus = response?.ok ? 'ready' : 'error'
      })
    } catch {
      if (!this.disposed && generation === this.generation) this.store.update(state => { state.modelsStatus = 'error' })
    }
  }

  async refresh(): Promise<void> {
    await Promise.allSettled([this.refreshSessions?.(), this.refreshModels()])
  }

  dispose(): void { this.disposed = true; this.generation++; this.unsubscribe?.() }
}
