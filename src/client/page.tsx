import { SettingsForm, SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiarySettingsController, EditableField } from './controller.js'

type PageProps = InjectFace<ReturnType<DiarySettingsController['inject']>>
const card: CSSProperties = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 14, padding: '16px 20px', marginTop: 16, minWidth: 0 }
const hint: CSSProperties = { fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', margin: '8px 0 0' }
const textarea: CSSProperties = { display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 110, padding: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'var(--dsw-font-mono, monospace)', fontSize: 12, lineHeight: 1.6, resize: 'vertical' }

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} style={card}><h3 style={{ fontSize: 14, margin: '0 0 8px' }}>{title}</h3>{children}</section>
}

export function DiarySettingsPage(props: PageProps) {
  const state = props.useDiarySettings(value => value)
  const disabled = !state.writable || state.saving
  const valueField = (field: EditableField, label: string, description: string, numeric = false) => <SettingsValueField
    key={field} id={`diary-${field}`} label={label} hint={description} numeric={numeric}
    {...state.fields[field]} disabled={disabled} overriddenLabel="已自定义" resetLabel="恢复默认"
    invalidLabel={numeric ? '请填写范围内的整数。' : '请检查填写的内容。'}
    onEdit={text => props.edit(field, text)} onReset={() => props.resetField(field)}
  />
  const parameters = (field: 'embeddingParameters' | 'rerankParameters', description: string) => <div style={{ padding: '12px 0' }}>
    <label htmlFor={`diary-${field}`} style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 8 }}>额外参数（JSON）</label>
    <textarea id={`diary-${field}`} aria-describedby={`diary-${field}-hint`} aria-invalid={state.fields[field].invalid || undefined}
      value={state.fields[field].text} onChange={event => props.edit(field, event.target.value)} disabled={disabled}
      spellCheck={false} rows={5} style={textarea} />
    <p id={`diary-${field}-hint`} style={hint}>{description}</p>
  </div>
  return <div data-diary-settings style={{ color: 'var(--dsw-alias-label-primary)', paddingBottom: 16 }}>
    <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>陪伴日记</h2>
    <p style={hint}>设置百炼连接、回忆模型与日记压缩方式。填写后点击保存。</p>
    <SettingsForm state={state} onSave={props.save} onDiscard={props.discard} labels={{
      unavailable: '正在加载配置；若持续不可用，请检查陪伴日记插件是否已启用。', readOnly: '当前配置只读。',
      saveFailed: '保存失败或配置已在其他窗口修改。输入已保留，请检查后重试。', save: '保存配置', saving: '正在保存…',
    }}>
      <Group title="百炼连接">
        <SettingsSecretField id="diary-apiKey" label="百炼 API Key" hint="密钥不会回显；留空保留已保存的 Key。也可通过 DSH 的环境变量提供。"
          text={state.fields.apiKey.text} configured={state.keyConfigured} stateLabel={state.keyConfigured ? '已保存（不回显）' : '尚未保存'}
          disabled={disabled} onEdit={text => props.edit('apiKey', text)} />
        {valueField('baseUrl', '百炼 API 地址', '需要与 API Key 的地域一致，例如 https://dashscope.aliyuncs.com。')}
      </Group>
      <Group title="Embedding · 向量召回">
        {valueField('embeddingModel', 'Embedding 模型名', '可手动填写百炼支持的文本向量模型，例如 text-embedding-v4。')}
        {valueField('embeddingDimensions', '向量维度', '1–4096；请填写所选模型支持的维度。', true)}
        {parameters('embeddingParameters', '填写该模型支持的 parameters，例如 {"output_type":"dense"}。dimension 在上方填写，text_type 由入库与召回自动设置。')}
        <p style={hint}>更改 Embedding 模型、维度或参数后，旧向量不会参与新配置的检索。</p>
      </Group>
      <Group title="Rerank · 回忆排序">
        {valueField('rerankModel', 'Rerank 模型名', '可手动填写百炼支持的重排模型，例如 gte-rerank-v2。')}
        {valueField('candidateCount', '候选数量', '1–100；先由向量检索选出这些日记交给 Rerank。', true)}
        {valueField('recallCount', '召回条数（top_n）', '1–100，且不大于候选数量。', true)}
        {parameters('rerankParameters', '填写该模型支持的 parameters，例如 {"return_documents":false}。top_n 由上方的召回条数设置。')}
      </Group>
      <Group title="日记与陪伴">
        {valueField('compressionRounds', '触发压缩的轮次', '完成多少轮后保存日记并安全压缩；须大于保留轮次。', true)}
        {valueField('retainRounds', '保留最近轮次', '至少保留最近多少个用户输入及后续消息。', true)}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', fontSize: 13 }}>
          <span>自动回想相关日记</span>
          <Switch label="自动回想相关日记" checked={state.fields.autoRecall.text === 'true'} disabled={disabled}
            onChange={value => props.edit('autoRecall', String(value))} />
        </div>
      </Group>
      {state.error ? <p role="alert" style={{ ...hint, color: 'var(--dsw-alias-label-error)' }}>{state.error}</p> : null}
    </SettingsForm>
  </div>
}
