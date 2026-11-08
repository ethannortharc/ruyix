// The person's own apps (docs/design/agent-control.md): small web pages an agent made from what they asked, kept by the
// host (lib/made.js; ops madeList, madeGet). Each opens in a window of the desk as a frame with scripts only — no same
// origin, no popups, no forms: it has an origin of its own and never reaches this page, its sign-in or its storage. They
// are listed in the App Center under 「我做的」 and each can sit on the desk as a widget (made:<id>). The main agent's tools
// say when one comes, changes or goes (page actions ruyix-apps:made / made-close / made-gone / made-back). No permanent
// dock tile each: an open one has its window's tile; the App Center holds the rest.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { AppWindow, ArrowLeft, Calendar, CheckSquare, Clock, Cloud, Gamepad2, Heart, ListTodo, Map, Music, NotebookPen, Sparkles, Star, Sun, Timer, Wallet } from 'lucide-react'
import { openRegistry } from '@ruyix/shell/open'

const W = {
  zh: { title: '我做的', sub: '智能体按你说的做的小应用，在 Ruyix 里打开', none: '还没有。跟主智能体说「做一个……」，做好就在这里。', open: '打开', updated: '改于', back: '回到列表', failed: '没能打开' },
  en: { title: 'Made for you', sub: 'Small apps your agents made from what you asked; they open inside Ruyix', none: 'None yet. Tell the main agent "make a …" and it shows up here.', open: 'Open', updated: 'Changed', back: 'Back to the list', failed: 'Could not open it' },
}

// the list, shared by the App Center, the widgets and the windows (one fetch at a time)
let state = { apps: [], ready: false }
const subs = new Set()
const set = next => { state = next; subs.forEach(f => f()) }
const subscribe = f => { subs.add(f); return () => subs.delete(f) }
export const useMade = () => useSyncExternalStore(subscribe, () => state, () => state)
/** The made apps as last listed (the palette's). */
export const madeNow = () => state.apps
// a few more icons an agent is likely to name for a small app (beyond the App Center's own)
const MORE = { Calendar, CheckSquare, Clock, Cloud, Gamepad2, Heart, ListTodo, Map, Music, NotebookPen, Star, Sun, Timer, Wallet }

/** The frame a made app runs in: scripts only, an origin of its own; `nonce` changed = loaded again. */
function Frame({ html, title, nonce = 0 }) {
  return <iframe key={nonce} className="ap-made-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} />
}
function MadeWindow({ html, title, nonce }) {
  return <div className="ap-made-win"><Frame html={html} title={title} nonce={nonce} /></div>
}

/**
 * The made apps' part of the plugin, given its call (op, args) and icons (a lucide name → a component): the list, the
 * windows, the widgets and the page actions. → stop()
 */
export function startMade({ call, iconOf, lang }) {
  const icon = name => iconOf(name) || MORE[name] || AppWindow
  let nonce = 0, refreshAgain = false, stopped = false, asking = null
  // (classic: no desk — the App Center shows the one asked for in its page)
  const inline = { id: null }
  const refresh = () => {
    if (stopped) return Promise.resolve()
    if (asking) { refreshAgain = true; return asking }
    asking = call('madeList', {}).then(r => { if (stopped) return; set({ ...state, apps: Array.isArray(r?.apps) ? r.apps : [], ready: true }); widgets() }, () => { if (!stopped) set({ ...state, ready: true }) }).finally(() => { asking = null; if (refreshAgain && !stopped) { refreshAgain = false; return refresh() } })
    return asking
  }
  const open = async id => {
    const { app, html } = await call('madeGet', { id })
    const win = `made:${id}`, desk = window.__ruyixDesk
    if (!desk) { inline.id = id; set({ ...state, inline: { id, html, name: app.name } }); window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: 'ruyix-apps' } })); return }
    desk.open({ id: win, openId: win, title: app.name, icon: icon(app.icon), Content: MadeWindow, props: { html, title: app.name, nonce: ++nonce }, size: { w: 960, h: 680 },
      kind: 'app', hint: app.summary || app.name, reopen: { event: 'ruyix-apps:made', detail: { id } } })
  }
  const fail = err => window.dispatchEvent(new CustomEvent('ruyix:notify', { detail: { title: W[lang()].failed, text: String(err?.message || err).slice(0, 200) } }))
  // one widget kind per made app: the same frame, at the desk's size (its page fetched when it is drawn)
  const widgets = () => {
    const mine = state.apps.map(a => ({ type: `made:${a.id}`, name: { zh: a.name, en: a.name }, sizes: ['md'], render: props => <MadeWidget {...props} app={a} call={call} icon={icon(a.icon)} /> }))
    window.__ruyixWidgetDefs = [...(window.__ruyixWidgetDefs || []).filter(d => !String(d.type).startsWith('made:')), ...mine]
    window.dispatchEvent(new CustomEvent('ruyix:widget'))
  }
  const idOf = e => String(e.detail?.id || '')
  const on = {
    'ruyix-apps:made': e => { const id = idOf(e); if (id) { open(id).catch(fail); refresh() } },
    'ruyix-apps:made-close': e => window.__ruyixDesk?.close(`made:${idOf(e)}`),
    // (put away: out of the open things first, so closing its window leaves nothing among the closed ones to bring back)
    'ruyix-apps:made-gone': e => {
      const id = idOf(e), key = `made:${id}`
      openRegistry().forget(key); window.__ruyixDesk?.close(key)
      if (state.inline?.id === id) set({ ...state, inline: null }); refresh() },
    'ruyix-apps:made-back': () => refresh(),
  }
  for (const [k, f] of Object.entries(on)) window.addEventListener(k, f)
  window.__ruyixMade = { open: id => open(id).catch(fail), refresh, close: () => set({ ...state, inline: null }) }
  refresh()
  return () => {
    stopped = true
    for (const [k, f] of Object.entries(on)) window.removeEventListener(k, f)
    delete window.__ruyixMade
    window.__ruyixWidgetDefs = (window.__ruyixWidgetDefs || []).filter(d => !String(d.type).startsWith('made:'))
    window.dispatchEvent(new CustomEvent('ruyix:widget'))
  }
}

function MadeWidget({ app, call, icon: Icon, preview = false }) {
  const [html, setHtml] = useState(null)
  useEffect(() => {
    if (preview) return
    let live = true
    call('madeGet', { id: app.id }).then(r => { if (live) setHtml(r.html) }, () => {})
    return () => { live = false }
  }, [app.id, app.updatedAt, preview])
  if (preview || html === null) return <div className="ap-made-wpic"><Icon size={26} /><b>{app.name}</b></div>
  return <div className="ap-made-widget"><Frame html={html} title={app.name} /></div>
}

const when = (at, lang) => { try { return new Date(at).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' }) } catch { return '' } }

/** The App Center's 「我做的」: the made apps (a search narrows them); classic mode shows the one opened here. */
export function MadeSection({ lang, needle = '', iconOf }) {
  const T = W[lang] || W.zh, s = useMade()
  useEffect(() => { window.__ruyixMade?.refresh() }, [])
  if (s.inline && !window.__ruyixDesk) {
    return (
      <section className="ap-sec ap-made-inline">
        <button type="button" className="ap-btn" onClick={() => window.__ruyixMade?.close()}><ArrowLeft size={14} />{T.back}</button>
        <h2>{s.inline.name}</h2>
        <div className="ap-made-win"><Frame html={s.inline.html} title={s.inline.name} /></div>
      </section>
    )
  }
  const shown = s.apps.filter(a => !needle || `${a.id} ${a.name} ${a.summary || ''}`.toLowerCase().includes(needle))
  if (needle && !shown.length) return null
  return (
    <section className="ap-sec ap-made">
      <h2>{T.title}</h2><p className="ap-sub">{T.sub}</p>
      {!shown.length ? (s.ready && <p className="ap-sub ap-made-none"><Sparkles size={14} />{T.none}</p>) : (
        <div className="ap-grid">
          {shown.map(a => {
            const Icon = iconOf(a.icon) || MORE[a.icon] || AppWindow
            return (
              <article key={a.id} className="ap-card ap-made-card">
                <span className="ap-card-icon"><Icon size={20} /></span>
                <div className="ap-card-text"><h3>{a.name}</h3>{a.summary && <p>{a.summary}</p>}<span className="ap-state">{T.updated} {when(a.updatedAt || a.createdAt, lang)}</span></div>
                <div className="ap-card-act"><button type="button" className="ap-btn ap-primary" onClick={() => window.__ruyixMade?.open(a.id)}>{T.open}</button></div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
