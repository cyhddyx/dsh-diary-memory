import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { DiarySettingsController } from './controller.js'
import type { FormValues } from './controller.js'
import { DiarySettingsPage } from './page.js'

export { DiarySettingsController } from './controller.js'
export { DiarySettingsPage } from './page.js'
export const inject = ['slots', 'configForms']

export function apply(ctx: Context): void {
  const controller = new DiarySettingsController(ctx.configForms.get<FormValues>('diary-memory'), () => {
    const entry = ctx.configForms.describe().getSnapshot().view?.namespaces.find(item => item.ns === 'diary-memory')
    return entry?.secrets?.some(item => item.path.length === 1 && item.path[0] === 'apiKey' && item.set) ?? false
  })
  ctx.effect(() => () => controller.dispose(), 'diary-memory: settings form')
  ctx.effect(() => ctx.configForms.whileServed(['diary-memory'], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'diary-memory', order: 65, label: '陪伴日记', inject: () => controller.inject(),
  }, DiarySettingsPage))), 'diary-memory: settings page')
}
