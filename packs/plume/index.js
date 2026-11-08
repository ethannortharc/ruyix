// @ruyix/plume: the Plume pack — one piece of content to 小红书, X and 公众号 as a workbench workflow (plume.post). A dsh
// plugin of its own: it joins the workbench with ruyixWorkbench.registerPack, and the connectors plugin with the
// 小红书 creator connection type (a QR sign-in in the workbench's visible browser). Its panels — each platform's
// preview and editor on the review card, the publish cards — are src/ → client.js (window.__ruyixWorkbenchExt.plume).
import { createPack } from './pack.js'
import { xhsType } from './lib/xhs.js'
import { studio } from './studio.js'

export const inject = ['ruyixWorkbench']
export { createPack }

export function apply(ctx) {
  ctx.inject(['ruyixWorkbench'], inner => inner.effect(() => inner.ruyixWorkbench.registerPack(createPack()), 'plume: workbench pack'))
  ctx.inject(['connectors'], inner => inner.effect(() => inner.connectors.registerType('xhs', xhsType), 'plume: 小红书 connection type'))
  // Plume 工作室 (studio.js; docs/design/studio.md): its ideas, accounts, posts and materials — when the studio plugin is on
  ctx.inject(['ruyixStudio'], inner => inner.effect(() => inner.ruyixStudio.register(studio), 'plume: studio'))
}
