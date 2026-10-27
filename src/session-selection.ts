export function validateSessionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !id.length || id.length > 256 || /[\r\n\0]/.test(id))) throw new Error('指定会话必须是至多 1000 个有效会话 ID 的数组')
  return [...new Set(value as string[])]
}
