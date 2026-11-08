// registerWorld(def): a map for the interactive desk from its definition — the one thing a map's plugin calls. Its own
// module, so a map built on @ruyix/world/kit carries World and the shared styles, not this plugin's own maps.
import css from './styles.css'
import { World } from './world.jsx'

// the styles every map shares (the places, names, buttons), on the page once while any map is registered — whichever
// plugin's copy came first
function shareStyles() {
  const at = (window.__ruyixWorldStyle ||= { n: 0, el: null })
  if (!at.n++) {
    at.el = Object.assign(document.createElement('style'), { textContent: css })
    at.el.dataset.ruyix = 'world'
    document.head.appendChild(at.el)
  }
  let done = false
  return () => { if (done) return; done = true; if (!--at.n) { at.el?.remove(); at.el = null } }
}

/**
 * A map for the interactive desk, from its definition:
 *   { id, name: { zh, en }, blurb?: { zh, en } (a line saying what it is: Settings' card for it), tone: light | dark,
 *     scene: { fn, body, data: true, c: [4 colours], tone, fps } — its ground (the shell's wallpaper engine; scenes.js),
 *     icons: { capital, harbor, launch, post, library, guild, workshop, port, fort, archive, settings, gate, village } (SVG),
 *     words?: { zh, en } (over words.js), road?: where agents sit on a task's ring (share of its radius), below?: a task's
 *     words below it (radii), className?, css? (its own styles, `.wd-<id>` and `.ad-root[data-world="<id>"]` for windows),
 *     theme?: tokens the pages wear while it is the desk }
 * → unregister()
 */
export function registerWorld(def) {
  const shared = shareStyles()
  const style = def.css ? Object.assign(document.createElement('style'), { textContent: def.css }) : null
  if (style) { style.dataset.ruyix = `world-${def.id}`; document.head.appendChild(style) }
  const entry = { id: def.id, name: def.name, ...(def.blurb && { blurb: def.blurb }), tone: def.tone || def.scene?.tone || 'dark', ...(def.theme && { theme: def.theme }), render: ({ api }) => <World def={def} api={api} /> }
  window.__ruyixWorlds = [...(window.__ruyixWorlds || []).filter(w => w.id !== def.id), entry]
  window.dispatchEvent(new Event('ruyix:worlds'))
  return () => {
    shared()
    style?.remove()
    window.__ruyixWorlds = (window.__ruyixWorlds || []).filter(w => w !== entry)
    window.dispatchEvent(new Event('ruyix:worlds'))
  }
}
