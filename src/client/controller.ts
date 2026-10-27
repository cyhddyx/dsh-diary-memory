import { SettingsFormModel, settingsTextField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFieldSpec, SettingsFieldState, SettingsFormScope, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DiaryConfig } from '../config.js'
import { validateModelParameters } from '../model-parameters.js'
import { validateSessionIds } from '../session-selection.js'
import { DiaryChoices } from './choices.js'
import type { ChoicesState } from './choices.js'

export const editableFields = ['apiKey', 'baseUrl', 'embeddingModel', 'embeddingDimensions', 'embeddingParameters', 'rerankModel', 'rerankParameters', 'candidateCount', 'recallCount', 'compressionRounds', 'retainRounds', 'autoRecall', 'sessionIds', 'diaryProvider', 'diaryModel'] as const
export type EditableField = typeof editableFields[number]
export type FormValues = Partial<Pick<DiaryConfig, EditableField>>
export interface DiarySettingsState extends SettingsFormShell, ChoicesState {
  fields: Record<EditableField, SettingsFieldState>
  keyConfigured: boolean
  error: string | null
  selectedSessions: string[]
}

function numberField(field: string, min: number, max: number): SettingsFieldSpec {
  return {
    field, format: value => typeof value === 'number' ? String(value) : '',
    parse: text => !text.trim() ? { kind: 'clear' }
      : Number.isSafeInteger(Number(text)) && Number(text) >= min && Number(text) <= max ? { kind: 'set', value: Number(text) } : undefined,
  }
}
function parametersField(field: string, kind: 'embedding' | 'rerank'): SettingsFieldSpec {
  return {
    field, format: value => value && typeof value === 'object' ? JSON.stringify(value, null, 2) : '{}',
    parse: text => {
      if (!text.trim()) return { kind: 'clear' }
      try { return { kind: 'set', value: validateModelParameters(JSON.parse(text), kind) } } catch { return undefined }
    },
  }
}
const specs: SettingsFieldSpec[] = [
  ...['apiKey', 'baseUrl', 'embeddingModel', 'rerankModel', 'diaryProvider', 'diaryModel'].map(settingsTextField),
  { field: 'sessionIds', format: value => JSON.stringify(value ?? []), parse: text => {
    try { return { kind: 'set', value: validateSessionIds(JSON.parse(text || '[]')) } } catch { return undefined }
  } },
  numberField('embeddingDimensions', 1, 4096), numberField('candidateCount', 1, 100), numberField('recallCount', 1, 100),
  numberField('compressionRounds', 2, 1000000), numberField('retainRounds', 1, 1000000),
  parametersField('embeddingParameters', 'embedding'), parametersField('rerankParameters', 'rerank'),
  { field: 'autoRecall', format: value => String(value ?? true), parse: text => text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined },
]

/** Native staged form: only edited paths are sent, preserving undisclosed secrets. */
export class DiarySettingsController {
  readonly form: SettingsFormModel<FormValues>
  readonly store: SnapshotStore<DiarySettingsState>
  private readonly unsubscribeChoices: () => void

  constructor(private readonly scope: SettingsFormScope<FormValues>, private readonly keyConfigured: () => boolean = () => false, readonly choices = new DiaryChoices()) {
    this.form = new SettingsFormModel(scope, specs)
    this.store = this.form.bind(() => this.projection())
    this.unsubscribeChoices = choices.store.subscribe(() => this.store.set(this.projection()))
  }

  private projection(): DiarySettingsState {
    const fields = Object.fromEntries(editableFields.map(field => [field, this.form.field(field)])) as DiarySettingsState['fields']
    const base = this.scope.getSnapshot().base as FormValues | undefined
    const number = (field: 'compressionRounds' | 'retainRounds' | 'recallCount' | 'candidateCount', fallback: number) => fields[field].text.trim() ? Number(fields[field].text) : base?.[field] ?? fallback
    let error: string | null = null
    let selectedSessions: string[] = []
    try { selectedSessions = validateSessionIds(JSON.parse(fields.sessionIds.text || '[]')) } catch (failure) { error = (failure as Error).message }
    const writerProvider = fields.diaryProvider.text.trim()
    const writerModel = fields.diaryModel.text.trim()
    if (Boolean(writerProvider) !== Boolean(writerModel)) error = '写日记的模型提供方与模型名必须同时填写，或同时留空跟随聊天模型。'
    if (writerProvider.length > 200 || writerModel.length > 200) error = '写日记的提供方与模型名不能超过 200 字符。'
    if (number('compressionRounds', 20) <= number('retainRounds', 2)) error = '压缩轮次必须大于保留轮次。'
    if (number('recallCount', 6) > number('candidateCount', 30)) error = '召回条数不能大于候选数量。'
    for (const kind of ['embedding', 'rerank'] as const) {
      const text = fields[`${kind}Parameters`].text.trim()
      try { validateModelParameters(JSON.parse(text || '{}'), kind) }
      catch (failure) { error = failure instanceof SyntaxError ? `${kind} 参数需要合法的 JSON 对象。` : (failure as Error).message }
    }
    const endpoint = fields.baseUrl.text.trim()
    try {
      if (endpoint) {
        const url = new URL(endpoint)
        if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error()
      }
    } catch { fields.baseUrl.invalid = true; error = '百炼端点需要 HTTPS origin，例如 https://dashscope.aliyuncs.com。' }
    for (const field of ['embeddingModel', 'rerankModel'] as const) {
      if (fields[field].text.trim().length > 200) { fields[field].invalid = true; error = '模型名不能超过 200 字符。' }
    }
    const shell = this.form.shell()
    return { ...shell, ...this.choices.store.getSnapshot(), selectedSessions, invalid: shell.invalid || Boolean(error) || !shell.writable, fields, keyConfigured: this.keyConfigured(), error }
  }

  async save(): Promise<void> { if (!this.projection().invalid) await this.form.save() }
  inject() {
    return {
      hooks: { diarySettings: this.store }, ...this.form.actions(), save: () => { void this.save() },
      toggleSession: (id: string, enabled: boolean) => {
        const ids = this.projection().selectedSessions
        this.form.actions().edit('sessionIds', JSON.stringify(enabled ? validateSessionIds([...ids, id]) : ids.filter(item => item !== id)))
      },
      chooseWriter: (selection: string) => {
        const [provider, model] = selection ? JSON.parse(selection) as [string, string] : ['', '']
        this.form.actions().edit('diaryProvider', provider)
        this.form.actions().edit('diaryModel', model)
      },
      refreshChoices: () => { void this.choices.refresh() },
    }
  }
  dispose(): void { this.unsubscribeChoices(); this.choices.dispose(); this.form.dispose() }
}
