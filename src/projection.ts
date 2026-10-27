import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const stateSchema = z.object({
  completedRounds: z.number().int().nonnegative(),
  activeCompactionId: z.string().nullable(),
})
export type DiaryProjectionState = z.infer<typeof stateSchema>

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap { 'diary-memory:rounds': DiaryProjectionState }
}

/** The framework folds the log; there is no per-token full-history rescan. */
export const diaryProjection: ProjectionDefinition<'diary-memory:rounds', DiaryProjectionState> = {
  key: 'diary-memory:rounds',
  stateVersion: 1,
  stateSchema,
  init: () => ({ completedRounds: 0, activeCompactionId: null }),
  apply(state, event) {
    switch (event.type) {
      case 'turn/end': return event.data.reason.kind === 'completed' ? { ...state, completedRounds: state.completedRounds + 1 } : state
      case 'compaction/start': return { ...state, activeCompactionId: event.data.compactionId }
      case 'compaction/end': return { ...state, activeCompactionId: null }
      case 'session/end-seed': return state.activeCompactionId === null ? state : { ...state, activeCompactionId: null }
      case 'user/message': return event.data.source.kind === 'compact-checkpoint' ? { ...state, completedRounds: 0 } : state
      default: return state
    }
  },
}
