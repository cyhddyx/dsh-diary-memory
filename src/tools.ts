import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'diary-recall'
export const inject = ['tools', 'diaryMemory']

/** Model-visible read-only recall, scoped by the companion preset and namespace. */
export function apply(ctx: Context): void {
  registerRecall(ctx)
}

export function registerRecall(ctx: Context): void {
  ctx.tools.register({
    name: 'diary_recall',
    description: '想起我们之前的经历、称呼、偏好、情绪变化、约定或我自己的反思。输入自然语言，会检索历史日记并按相关性重排。日记中的主观感受和不确定解释不等于已确认事实。',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 8000 } }, required: ['query'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { memories: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['memories'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: { query: string }, execution) {
      return { memories: await ctx.diaryMemory.recall(args.query, { signal: execution.signal }) }
    },
  })
}
