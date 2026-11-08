// The Plume pack's panels, as an extension of the workbench (core/workbench/README, "Pack extensions"): its words, the
// review card's editor of each platform's version, and the publish cards. Registered as window.__ruyixWorkbenchExt.plume
// when dsh loads the client (a client plugin exports apply: dsh refuses a bundle that does not).
import { Send } from 'lucide-react'
import css from './styles.css'
import { en, zh } from './locale.js'
import { PostsEditor } from './editor.jsx'
import { PublishBody } from './publish.jsx'
import { PlatformKnowledge } from './knowledge.jsx'

const card = { icon: Send, Body: PublishBody }
export const inject = []
export function apply(ctx) {
  window.__ruyixWorkbenchExt ??= {}
  window.__ruyixWorkbenchExt.plume = {
    locale: { zh, en },
    approvals: { plume_publish_xhs: card, plume_publish_x: card, plume_publish_wechat_mp: card },
    decisionEditors: { posts: PostsEditor },
    studioViews: { knowledge: PlatformKnowledge },
    css,
  }
  window.dispatchEvent(new Event('ruyix-workbench-ext'))
  ctx?.effect?.(() => () => { delete window.__ruyixWorkbenchExt?.plume; window.dispatchEvent(new Event('ruyix-workbench-ext')) })
}
