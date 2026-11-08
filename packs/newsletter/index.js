import { createPack } from './pack.js'
import { studio } from './studio.js'
export const inject = ['ruyixWorkbench']
export { createPack, studio }
export function apply(ctx) {
  ctx.inject(['ruyixWorkbench'], inner => inner.effect(() => inner.ruyixWorkbench.registerPack(createPack()), 'newsletter: workflow pack'))
  ctx.inject(['ruyixStudio'], inner => inner.effect(() => inner.ruyixStudio.register(studio), 'newsletter: studio'))
}
