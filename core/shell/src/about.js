// About Ruyix (docs/design/desk-answers.md「版本号」): this system's versions in one small window — Ruyix, the build it
// runs (commit and when it was built), dsh, and in a box nookbox and the box's name. Plain DOM, so every desk has it (the
// desktop, the classic one, an interactive map): any of them opens it with the window event 'ruyix:about'.
export const ABOUT_EVENT = 'ruyix:about'

/** A moment as the person's clock says it (2026-10-18 22:34). */
const local = iso => { const d = new Date(iso); if (!Number.isFinite(d.getTime())) return ''; const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }
/** The lines a person reads, from /api/ruyix/version and the build's own stamp (`built`: ISO). */
export function aboutLines(v, { commit = '', built = '', lang = 'zh' } = {}) {
  const zh = lang !== 'en'
  return [
    [zh ? 'Ruyix' : 'Ruyix', v?.ruyix || '—'],
    [zh ? '这份程序' : 'This build', [commit && (zh ? `提交 ${commit}` : `commit ${commit}`), local(built) && (zh ? `编译于 ${local(built)}` : `built ${local(built)}`)].filter(Boolean).join(' · ') || '—'],
    ['dsh', v?.dsh || '—'],
    ...(v?.box ? [['nookbox', `${v.box}${v.boxName ? (zh ? `（盒子：${v.boxName}）` : ` (box: ${v.boxName})`) : ''}`]] : []),
  ]
}

const CSS = `
.rx-about-back { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; background: rgba(0, 0, 0, .28); }
.rx-about { min-width: 300px; max-width: 92vw; padding: 18px 20px 16px; border-radius: 14px; background: var(--ruyix-surface, #fff); color: var(--ruyix-text, #1d2430);
  border: 1px solid var(--ruyix-line, rgba(0,0,0,.1)); box-shadow: 0 18px 48px rgba(0, 0, 0, .28); font: 13px/1.5 var(--ruyix-font, system-ui, sans-serif); }
.rx-about h3 { margin: 0 0 10px; font-size: 16px; display: flex; align-items: center; gap: 8px; }
.rx-about dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; }
.rx-about dt { color: var(--ruyix-text-muted, #6b7380); }
.rx-about dd { margin: 0; font-family: var(--ruyix-font-mono, ui-monospace, monospace); font-size: 12px; overflow-wrap: anywhere; }
.rx-about button { margin-top: 14px; float: right; padding: 5px 14px; border-radius: 8px; border: 1px solid var(--ruyix-line, rgba(0,0,0,.15)); background: transparent; color: inherit; cursor: pointer; }
`

/** Open the window (one at a time); Escape, the button or a click outside closes it. */
export async function openAbout({ commit = '', built = '', lang = 'zh', fetchFn = (...a) => fetch(...a) } = {}) {
  if (document.querySelector('.rx-about-back')) return
  let v = null
  try { v = await (await fetchFn('api/ruyix/version')).json() } catch { /* shown as unknown */ }
  if (!document.getElementById('rx-about-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'rx-about-css', textContent: CSS }))
  const back = Object.assign(document.createElement('div'), { className: 'rx-about-back' })
  const box = Object.assign(document.createElement('div'), { className: 'rx-about' })
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', lang === 'en' ? 'About Ruyix' : '关于 Ruyix')
  const h = Object.assign(document.createElement('h3'), { textContent: lang === 'en' ? 'About Ruyix' : '关于 Ruyix' })
  const dl = document.createElement('dl')
  for (const [k, val] of aboutLines(v, { commit, built, lang })) dl.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: val }))
  const close = () => { back.remove(); document.removeEventListener('keydown', esc) }
  const esc = e => { if (e.key === 'Escape') close() }
  const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: lang === 'en' ? 'Close' : '关闭', onclick: close })
  box.append(h, dl, btn)
  back.append(box)
  back.addEventListener('click', e => { if (e.target === back) close() })
  document.addEventListener('keydown', esc)
  document.body.append(back)
  btn.focus()
}
