import { SettingsForm, SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'
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
  const [sessionFilter, setSessionFilter] = useState('')
  const sessions = [...state.sessions, ...state.selectedSessions.filter(id => !state.sessions.some(item => item.id === id)).map(id => ({ id, title: '已选会话（不在当前列表）' }))]
    .filter(item => `${item.title}\n${item.id}`.toLowerCase().includes(sessionFilter.toLowerCase()))
  const writer = state.fields.diaryProvider.text && state.fields.diaryModel.text ? JSON.stringify([state.fields.diaryProvider.text, state.fields.diaryModel.text]) : ''
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
      <Group title="指定已有会话">
        <p style={hint}>勾选后保存，在原会话继续聊天即可。保留原人设、模型与工具；未选会话保持原来的压缩方式。“陪伴日记”预设本身已启用记忆。</p>
        <label htmlFor="diary-session-filter" style={{ display: 'block', fontSize: 13, marginTop: 12 }}>查找会话</label>
        <input id="diary-session-filter" type="search" value={sessionFilter} onChange={event => setSessionFilter(event.target.value)}
          placeholder="按会话标题或 ID 搜索" style={{ ...textarea, minHeight: 0, height: 36, marginTop: 6 }} />
        <div aria-label="已有会话列表" style={{ maxHeight: 300, overflowY: 'auto', marginTop: 10 }}>
          {sessions.map(item => <div key={item.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' }}>
            <div style={{ minWidth: 0, flex: 1 }}><div style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{item.title}</div><div style={{ ...hint, margin: 0, overflowWrap: 'anywhere' }}>{item.id}</div></div>
            <Switch label={`为 ${item.title} 启用记忆`} checked={state.selectedSessions.includes(item.id)} disabled={disabled} onChange={value => props.toggleSession(item.id, value)} />
          </div>)}
          {!sessions.length ? <p style={hint}>{state.sessionsReady ? '没有匹配的会话。' : '正在读取会话列表…'}</p> : null}
        </div>
        <p style={hint}>已选 {state.selectedSessions.length} 个会话。同一记忆空间中的已选会话共享日记；取消勾选不会删除已保存的记忆。</p>
        <button type="button" onClick={props.refreshChoices} disabled={state.saving} style={{ marginTop: 10 }}>刷新会话与模型列表</button>
      </Group>
      <Group title="专用写日记模型">
        <label htmlFor="diary-writer" style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>选择已配置的 DSH 模型</label>
        <select id="diary-writer" value={writer} disabled={disabled} onChange={event => props.chooseWriter(event.target.value)} style={{ ...textarea, minHeight: 0, height: 40, padding: '0 10px', fontFamily: 'inherit' }}>
          <option value="">跟随当前会话的聊天模型</option>
          {writer && !state.writers.some(item => JSON.stringify([item.provider, item.model]) === writer) ? <option value={writer}>当前手填模型：{state.fields.diaryProvider.text} / {state.fields.diaryModel.text}</option> : null}
          {state.writers.map(item => <option key={JSON.stringify([item.provider, item.model])} value={JSON.stringify([item.provider, item.model])}>{item.label}</option>)}
        </select>
        <p style={hint}>专用模型只负责写日记，不改变聊天模型。先在 DSH 的模型设置里配置提供方，也可以在下面手填其路由名与模型名。</p>
        {state.modelsStatus === 'error' ? <p style={hint}>模型列表暂不可用，已保存的模型仍保留，可手填或刷新重试。</p> : null}
        {valueField('diaryProvider', '写日记的模型提供方', '填写 DSH 已注册的 provider 路由名；与模型名同时留空则跟随聊天模型。')}
        {valueField('diaryModel', '写日记的模型名', '填写该提供方支持的生成模型。这里只设置模型，不增加生成参数。')}
      </Group>
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
