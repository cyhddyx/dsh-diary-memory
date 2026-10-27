export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type ModelParameters = Readonly<Record<string, JsonValue>>

/** Shared by the native configuration reader and the browser parameter editors. */
export function validateModelParameters(value: unknown, kind: 'embedding' | 'rerank'): ModelParameters {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${kind} 参数必须为 JSON 对象`)
  const visit = (item: unknown, depth = 0): JsonValue => {
    if (depth > 16) throw new Error(`${kind} 参数嵌套过深`)
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return Object.freeze(item.map(child => visit(child, depth + 1))) as unknown as JsonValue[]
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      return Object.freeze(Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, depth + 1)])))
    }
    throw new Error(`${kind} 参数只能包含 JSON 值`)
  }
  const parameters = visit(value) as ModelParameters
  if (JSON.stringify(parameters).length > 16000) throw new Error(`${kind} 参数不能超过 16000 字符`)
  const reserved = kind === 'embedding' ? ['dimension', 'text_type'] : ['top_n']
  if (reserved.some(key => Object.hasOwn(parameters, key))) throw new Error(kind === 'embedding'
    ? 'dimension 请在向量维度中填写；text_type 由入库和召回自动设置'
    : 'top_n 请在召回条数中填写')
  if (kind === 'embedding' && parameters.output_type !== undefined && parameters.output_type !== 'dense') throw new Error('本地向量检索需要 dense 向量，output_type 仅支持 dense')
  if (kind === 'rerank' && parameters.return_documents !== undefined && typeof parameters.return_documents !== 'boolean') throw new Error('return_documents 必须是布尔值')
  return parameters
}

export function stableParameters(value: ModelParameters): string {
  const ordered = (item: JsonValue): JsonValue => Array.isArray(item) ? item.map(ordered)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item
  return JSON.stringify(ordered(value as JsonValue))
}
