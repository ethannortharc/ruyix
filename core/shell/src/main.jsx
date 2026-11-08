// Ruyix: the shell over dsh's web client. It owns the brand (the sidebar's mark and name, the conversation hero, the
// browser title and icon) and the sidebar's shape: the plugins' entries grouped as Workbench / Apps / Agents / System /
// Sandbox (nav.js), without dsh's New Session and session list — talking to an agent is the pages' assistant. It opens on
// its home page (src/start.jsx: the setup while it is not done, then what needs you and how the agents do). The entries
// themselves stay with their plugins. The Ruyix's teal identifies the mark and the welcome action; the frame shares a
// restrained palette with the plugins' panels.
import './renamed.js'
import { GalleryVerticalEnd, House, ListChecks, Settings } from 'lucide-react'
import css from './shell.css'
import deskCss from './desktop/desktop.css'
import tasksCss from './tasks/tasks.css'
import { TaskCenter } from './tasks/tasks.jsx'
import { Portfolio } from './tasks/works.jsx'
import { NEW_SLOT, PART_SLOT, TAB_SLOT as TASK_TAB_SLOT, TASKS, WORKS, catchLanding } from './tasks/data.js'
import { textOf as tasksText } from './tasks/text.js'
import tokens from '../tokens.css'
import { intoOf, navCss, navEntries } from './nav.js'
import { NOTICE_CSS, noticeHideCss, noticePrefix } from './notice.js'
import { MARK_SVG } from '../mark.js'
import { START, StartPage, textOf } from './start.jsx'
import { SETTINGS, SettingsPage, TAB_SLOT, TEXT as SETTINGS_TEXT } from './settings.jsx'
import { Mark } from './mark.jsx'
import { Foot, lookStore } from './foot.jsx'
import { Pending } from './pending.jsx'
import { CHAT_SLOT, Desktop } from './desktop/desktop.jsx'
import { textOf as deskText } from './desktop/text.js'
import { THEMES } from '../desktop.js'
import { createDesk } from './desktop/store.js'
import { workRegistry } from './work.js'
import { answersRegistry } from './answers.js'
import { ABOUT_EVENT, openAbout } from './about.js'
import { openRegistry } from './open.js'

export { Mark }

const NAME = 'Ruyix'
// the home page's way in to the work: the inbox of the workbench that is here (each registers in window.__ruyixWorkbenches)
const inbox = () => Object.values(window.__ruyixWorkbenches || {})[0]?.inbox


function Name() {
  return <span className="ruyix-name"><b>Ruyix</b></span>
}

export const inject = ['slots', 'locale', 'layout']

export function apply(ctx) {
  workRegistry() // the work going on, for every desk (src/work.js): the producers publish into it
  answersRegistry() // the questions asked and their answers (src/answers.js): the conversation publishes, the desk draws
  // About Ruyix (src/about.js): any desk opens it with 'ruyix:about' — the desktop's mark menu, Settings, a map's right-click
  ctx.effect(() => {
    const on = () => openAbout({ commit: __RUYIX_COMMIT__, built: __RUYIX_BUILT__, lang: String(ctx.locale.getSnapshot().active || 'zh').startsWith('zh') ? 'zh' : 'en' })
    window.addEventListener(ABOUT_EVENT, on)
    return () => window.removeEventListener(ABOUT_EVENT, on)
  }, 'ruyix: about')
  // the things open on the desk (src/open.js): another page's changes come on a look — at focus, and every 20 s in view
  ctx.effect(() => {
    const reg = openRegistry(), look = () => { if (!document.hidden) reg.load() }
    const timer = setInterval(look, 20000)
    window.addEventListener('focus', look)
    return () => { clearInterval(timer); window.removeEventListener('focus', look) }
  }, 'ruyix: the open things')
  // ── brand ──
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', function* () {
    yield ctx.slots.register({ name: 'sidebar.brand.mark' }, Mark)
    yield ctx.slots.register({ name: 'sidebar.brand.name' }, Name)
  }))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, ({ size }) => <Mark size={size || 56} />))
  // the foot (src/foot.jsx): Settings, the language and the appearance, the versions (dsh's own Settings and Plugins
  // pages are not offered: Settings is the product's, below)
  const look = lookStore()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'ruyix-foot' },
    ({ wide }) => <Foot wide={wide} layout={ctx.layout} locale={ctx.locale} look={look} />))

  // ── the desktop (src/desktop/): the wallpaper, the window, the top bar, the dock, the palette, the conversation's sheet —
  // from dsh's overlay layer, drawn into the page's body. It declares the slot the conversation is drawn in (the workbench's).
  const desk = createDesk()
  const hostedTabs = () => new Set(ctx.slots.entries(TAB_SLOT).map(e => e.options?.id))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'ruyix-desktop', children: { [CHAT_SLOT]: { kind: 'single', scope: 'root' } } },
    ({ renderSlot }) => <Desktop slots={ctx.slots} locale={ctx.locale} layout={ctx.layout} look={look} desk={desk} hosted={hostedTabs} renderSlot={renderSlot} />))

  // the changes an agent proposed, waiting for the person: a card on every page (src/pending.jsx)
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'ruyix-pending', order: -2 }, () => <Pending locale={ctx.locale} />))

  // ── Appearance: dsh keeps it on the Host only for a loopback browser — through a box's port or Tailscale a change
  // lasts until the page reloads, then the Host's comes back. This browser remembers its own and puts it back. ──
  ctx.inject?.(['theme'], inner => {
    const KEY = 'ruyix.theme', at = Date.now()
    let mine = null
    try { mine = localStorage.getItem(KEY) } catch { /* private window */ }
    const put = () => { try { if (['light', 'dark', 'system'].includes(mine) && inner.theme.getTheme().preference !== mine) inner.theme.setTheme(mine) } catch { /* not ready */ } }
    put()
    look.attach(inner.theme) // the foot's picker
    inner.effect(() => () => look.detach(), 'ruyix: the foot\'s appearance')
    inner.on('theme/change', snap => {
      // ponytail: the first seconds' changes are the Host's own coming in (its settings load): ours is put back over
      // them; a change after that is the person's. A theme/change that said where it came from would make this exact.
      if (mine && snap.preference !== mine && Date.now() - at < 6000) return put()
      mine = snap.preference
      look.changed(mine)
      try { localStorage.setItem(KEY, mine) } catch { /* private window */ }
    })
  })

  // ── Home: the first Workbench entry, and the page ruyix opens on ──
  const lang = () => (String(ctx.locale.getSnapshot().active || 'en').startsWith('zh') ? 'zh' : 'en')
  // a page wherever it lives now: a Settings tab, else its own panel. Other
  // plugins ask with window event 'ruyix:open' { panel } (window.__ruyixSettings says the shell is here to answer).
  const openAnywhere = id => {
    const into = intoOf({ panel: id })
    if (into) return window.dispatchEvent(new CustomEvent('ruyix:open', { detail: into }))
    const has = (slot, x) => ctx.slots.entries(slot).some(e => e.options?.id === x)
    if (has(TAB_SLOT, id)) return window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab: id } }))
    try { ctx.layout.selectPanel(id) } catch { /* that plugin is off */ }
  }
  ctx.effect(() => {
    const on = e => {
      if (!e.detail?.panel) return
      // a page folded into another: that page's open, with what this one was asked (a run: its task on 「任务」)
      const into = intoOf(e.detail)
      if (into) return window.dispatchEvent(new CustomEvent('ruyix:open', { detail: into }))
      openAnywhere(String(e.detail.panel))
    }
    window.addEventListener('ruyix:open', on)
    // and one selected anyhow (a remembered window, a plugin's own selectPanel): the page it went into instead
    const folded = () => {
      const id = ctx.layout.panelInfo.getSnapshot()?.activePanelId, into = id && intoOf({ panel: id })
      if (into) try { ctx.layout.selectPanel(into.panel) } catch { /* not there yet */ }
    }
    const off = ctx.layout.panelInfo.subscribe(folded)
    window.addEventListener('ruyix:nav', folded)
    folded()
    return () => { window.removeEventListener('ruyix:open', on); off?.(); window.removeEventListener('ruyix:nav', folded) }
  }, 'ruyix: open a page where it lives')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: START }, () => <StartPage locale={ctx.locale} layout={ctx.layout} home={inbox} open={openAnywhere} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: START, order: 10, label: () => textOf(lang()).nav }, ({ size }) => <House size={size || 16} strokeWidth={1.6} />))

  // ── the tasks (docs/design/agent-tasks.md, work-in-one-place.md): 「任务」 and the portfolio (src/tasks/), in the
  // Workbench group; an open that names a task (a task card) lands on it. 「任务」 hosts the other plugins' parts (a run's
  // steps in its task, a tab such as 定时, the 新建任务 form: src/tasks/data.js) ──
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: TASKS, children: { [PART_SLOT]: { kind: 'list', scope: 'root' }, [TASK_TAB_SLOT]: { kind: 'list', scope: 'root' }, [NEW_SLOT]: { kind: 'single', scope: 'root' } } },
    ({ renderSlot }) => <TaskCenter locale={ctx.locale} slots={ctx.slots} renderSlot={renderSlot} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: TASKS, order: 16, label: () => tasksText(lang()).tasks }, ({ size }) => <ListChecks size={size || 16} strokeWidth={1.6} />))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: WORKS }, () => <Portfolio locale={ctx.locale} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: WORKS, order: 17, label: () => tasksText(lang()).works }, ({ size }) => <GalleryVerticalEnd size={size || 16} strokeWidth={1.6} />))
  ctx.effect(() => catchLanding(), 'ruyix: landing on a task')

  // ── Settings: the one page (src/settings.jsx); each product puts its workbench's settings in as a tab ──
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: SETTINGS, children: { [TAB_SLOT]: { kind: 'list', scope: 'root' } } },
    ({ renderSlot }) => <SettingsPage locale={ctx.locale} slots={ctx.slots} renderSlot={renderSlot} layout={ctx.layout} />))
  // an entry (selectPanel needs one) the list leaves out (order outside every group: nav.js): the foot opens it
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: SETTINGS, order: 90, label: () => SETTINGS_TEXT[lang()].nav }, ({ size }) => <Settings size={size || 16} strokeWidth={1.6} />))
  // another panel opens a tab: dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab } })) — 'models', a product's…
  ctx.effect(() => {
    const open = e => {
      try { localStorage.setItem('ruyix.settings.tab', JSON.stringify(e.detail?.tab || 'general')) } catch { /* private window */ }
      try { ctx.layout.selectPanel(SETTINGS) } catch { /* layout not ready */ }
      window.dispatchEvent(new CustomEvent('ruyix-settings:show', { detail: e.detail || {} }))
    }
    window.addEventListener('ruyix-settings:open', open)
    window.__ruyixSettings = true // a product's settings links come here (its own entry gives way to its tab: nav.js)
    return () => { window.removeEventListener('ruyix-settings:open', open); delete window.__ruyixSettings }
  }, 'ruyix: settings')

  // ── the page: title, icon, the shell's stylesheets, the sidebar's groups ──
  // Kept in place, not just set once: dsh's live reload (the plugin manager turning a plugin off or on) takes the
  // head's added elements away and rebuilds the sidebar while the shell keeps running. A watcher puts them back and
  // regroups whenever the head or the page changes (once per frame at most; nothing is written when nothing changed).
  ctx.effect(() => {
    const style = Object.assign(document.createElement('style'), { textContent: tokens + css + deskCss + tasksCss })
    style.dataset.ruyix = ''
    const nav = document.createElement('style')
    nav.dataset.ruyixNav = ''
    // this Ruyix's own theme (surfaces.js: theme.json as CSS) — not in safe mode (?ruyix-safe=1 for this tab: no own theme,
    // no own sidebar order — the way back when a change left the page hard to use; ?ruyix-safe=0 ends it)
    const theme = document.createElement('style')
    theme.dataset.ruyixTheme = ''
    // the address decides first; the tab's storage only remembers it (it may not be there: a locked-down browser)
    const safe = (() => {
      const q = new URLSearchParams(location.search).get('ruyix-safe')
      try { if (q !== null) sessionStorage.setItem('ruyix.safe', q === '0' ? '' : '1') } catch { /* no storage */ }
      if (q !== null) return q !== '0'
      try { return sessionStorage.getItem('ruyix.safe') === '1' } catch { return false }
    })()
    window.__ruyixSafe = safe // the Boards page leaves personal boards out too
    const notice = document.createElement('style') // dsh's preview notice, hidden (src/notice.js)
    notice.dataset.ruyixNotice = ''
    const icon = Object.assign(document.createElement('link'), { rel: 'icon', href: `data:image/svg+xml,${encodeURIComponent(MARK_SVG)}` })
    // Ruyix as an app of its own (app.js): Chrome's "Install", Safari's "Add to Dock" — the manifest is behind the sign-in, so
    // it is fetched with the cookie
    const app = [
      Object.assign(document.createElement('link'), { rel: 'manifest', href: 'api/ruyix/app.webmanifest', crossOrigin: 'use-credentials' }),
      Object.assign(document.createElement('link'), { rel: 'apple-touch-icon', href: 'api/ruyix/apple-touch-icon.png' }),
      Object.assign(document.createElement('meta'), { name: 'apple-mobile-web-app-title', content: 'Ruyix' }),
    ]
    // the pages another page hosts leave the sidebar (the same id): a Settings tab (an app's settings, the connections)
    const hosted = () => new Set(ctx.slots.entries(TAB_SLOT).map(e => e.options?.id))
    // what this Ruyix is for (the shell's /api/ruyix/layout; window.__ruyixLayout for the plugins' pages): entries for other
    // presets leave the sidebar. Read again each minute and when Settings says 'ruyix:layout'.
    // Who it is (identity's name, or the preset's) marks the tab: its name before the product's
    let preset = null, seen = '', said = '', told = '', version = null, stale = true // stale until a read comes back (the first one too)
    const identLabel = l => l.identity?.name || l.presets?.find(p => p.id === l.preset)?.title?.[lang()] || ''
    // one read at a time: asked again while one is on its way, it reads once more after it (a slow answer still lands)
    let reading = false, again = false
    let lastTheme, saidProblem = ''
    const readLayout = ({ follow = true } = {}) => {
      if (reading) { again ||= follow; return Promise.resolve() } // a retry waits for the read on its way; a new change follows it
      reading = true
      return fetch('api/ruyix/layout').then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(l => {
      if (!again) stale = false // a read that came back, none asked since: the page has the layout as it is now
      if (!l?.preset || JSON.stringify(l) === seen) return
      seen = JSON.stringify(l); preset = l.preset; window.__ruyixLayout = l
      theme.textContent = safe ? '' : l.themeCss || ''
      // a theme chosen since the last read (here, in another browser, an agent's change applied): this browser takes its
      // light or dark (desktop.js THEMES); the first read is what was there already, and leaves this browser's own
      const th = l.desktop?.theme || null
      if (lastTheme !== undefined && th !== lastTheme) { const a = THEMES.find(x => x.id === th)?.appearance; if (a) look.set(a) }
      lastTheme = th
      // desktop.json edited by hand into something wrong: said once per mistake (the desktop stays as it was)
      if (l.desktopProblem && l.desktopProblem !== saidProblem) {
        const T = deskText(lang())
        window.dispatchEvent(new CustomEvent('ruyix:notify', { detail: { title: T.deskProblem, text: T.deskProblemText(l.desktopProblem) } }))
      }
      saidProblem = l.desktopProblem || ''
      window.dispatchEvent(new CustomEvent('ruyix:layout-changed', { detail: l }))
      soon()
    }, () => {}).finally(() => { reading = false; if (again) { again = false; readLayout() } }) }
    const keep = () => {
      for (const el of [style, theme, nav, icon, ...app]) if (!el.isConnected) document.head.append(el)
      for (const old of document.querySelectorAll('link[rel~="icon"]')) if (old !== icon) { old.dataset.ruyixHidden = old.rel; old.rel = 'ruyix-hidden-icon' }
      // dsh's own manifest ("DeepSeek Harness") too: a browser reads the first one
      for (const old of document.querySelectorAll('link[rel="manifest"]')) if (!app.includes(old)) { old.dataset.ruyixHidden = old.rel; old.rel = 'ruyix-hidden-manifest' }
      // dsh writes "DeepSeek Harness" (or "<session> · DeepSeek Harness"): the product's name, after this Ruyix's own
      let title = document.title
      if (said && title.startsWith(said)) title = title.slice(said.length)
      if (/DeepSeek Harness/.test(title) || title.includes(NAME)) {
        title = title.replace(/DeepSeek Harness/g, NAME)
        const ident = window.__ruyixLayout ? identLabel(window.__ruyixLayout) : '' // in the page's language
        said = ident ? `${ident} · ` : ''
        if (document.title !== said + title) document.title = said + title
      }
      // the groups from the entries as they are now (a plugin on or off, the language)
      const own = safe ? {} : window.__ruyixLayout?.nav || {}, list = ctx.slots.entries('sidebar.panellist')
      const next = navCss(list, lang(), hosted(), preset, window.__ruyixNav || {}, own)
      if (nav.textContent !== next) nav.textContent = next
      // the entries as they are now, for an agent that orders or hides them (ruyix_surfaces): said when they change
      // (with Settings' tabs: its own and the products', for an agent that opens one)
      const st = SETTINGS_TEXT[lang()].tab, label = o => String((typeof o?.label === 'function' ? o.label() : o?.label) || o?.id || '').slice(0, 80)
      const tabs = [{ id: 'general', label: st.general }, { id: 'models', label: st.models }, ...ctx.slots.entries(TAB_SLOT).map(e => e.options).filter(o => o?.id).map(o => ({ id: o.id, label: label(o) })),
        { id: 'plugins', label: st.plugins }, { id: 'changes', label: st.changes }, { id: 'advanced', label: st.advanced }]
      const entries = `{"entries":${JSON.stringify(navEntries(list, lang(), hosted(), preset, window.__ruyixNav || {}, own))},"tabs":${JSON.stringify(tabs)}}`
      if (entries !== told && list.length) { told = entries; fetch('api/ruyix/surfaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: entries }).catch(() => { told = '' }) }
      // dsh's preview notice: hidden, and acknowledged when it shows
      const p = noticePrefix(document.querySelector(`style[data-plugin-css="${NOTICE_CSS}"]`)?.textContent)
      if (p) {
        if (notice.textContent !== noticeHideCss(p)) notice.textContent = noticeHideCss(p)
        if (!notice.isConnected) document.head.append(notice)
        document.querySelector(`.${p}_actions button:not([disabled])`)?.click()
      }
    }
    let queued = 0
    const soon = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; keep() }) }
    keep()
    readLayout()
    window.addEventListener('ruyix:layout', readLayout)
    window.addEventListener('ruyix:nav', soon) // a plugin's window.__ruyixNav changed
    const layoutTimer = setInterval(readLayout, 60e3)
    // a change to this Ruyix's surfaces (an agent's, the person's, a hand edit) shows within seconds: the page asks whether
    // they moved while it is in view (ponytail: a poll; a push from the host would do without one)
    // and what a system tool asked of the page (the main agent opened an app's window): each once, those after the last taken,
    // by the page the person is at (the focused one: another tab lets them go by). The first poll — and the first after the
    // host restarted (another boot) — only learns where the list stands: an action from before is not done again.
    let lastAction = null, boot = null
    const surfaces = () => document.hidden || fetch(`api/ruyix/surfaces${lastAction !== null ? `?after=${lastAction}` : ''}`).then(r => r.json()).then(({ v, pending, actions, lastAction: newest, boot: now }) => {
      if (now !== boot) { boot = now; lastAction = null }
      if (lastAction !== null && document.hasFocus()) for (const a of actions || []) { try { window.dispatchEvent(new CustomEvent(a.event, { detail: a.detail })) } catch { /* a listener's own */ } }
      if (typeof newest === 'number') lastAction = newest
      if (version !== null && v !== version) { stale = true; readLayout(); window.dispatchEvent(new CustomEvent('ruyix:surfaces')) }
      else if (stale) readLayout({ follow: false }) // until a read comes back (one that failed is asked again; one on its way is let finish)
      version = v
      window.dispatchEvent(new CustomEvent('ruyix:pending', { detail: { pending: pending || [] } })) // every poll: the card is never left behind
    }, () => {})
    const surfaceTimer = setInterval(surfaces, 3000)
    surfaces()
    const watch = new MutationObserver(soon)
    watch.observe(document.head, { subtree: true, childList: true, characterData: true })
    watch.observe(document.body, { subtree: true, childList: true })
    const offEntries = ctx.slots.subscribe('sidebar.panellist', soon), offTabs = ctx.slots.subscribe(TAB_SLOT, soon)
    const offLang = ctx.locale.subscribe(soon)
    return () => {
      offEntries?.(); offTabs?.(); offLang?.(); watch.disconnect(); cancelAnimationFrame(queued)
      window.removeEventListener('ruyix:layout', readLayout); window.removeEventListener('ruyix:nav', soon); clearInterval(layoutTimer); clearInterval(surfaceTimer); delete window.__ruyixLayout
      style.remove(); theme.remove(); nav.remove(); notice.remove(); icon.remove(); for (const el of app) el.remove()
      for (const old of document.querySelectorAll('link[rel="ruyix-hidden-icon"], link[rel="ruyix-hidden-manifest"]')) old.rel = old.dataset.ruyixHidden || (old.rel === 'ruyix-hidden-icon' ? 'icon' : 'manifest')
      document.title = (said && document.title.startsWith(said) ? document.title.slice(said.length) : document.title).replaceAll(NAME, 'DeepSeek Harness')
    }
  }, 'ruyix: page')

  // ── opening (once, at load; a session opened from a link stays) — not an empty conversation: the home page while a
  // required setup step is open (it is listed only then: window.__ruyixNav), else what waits on you (the inbox) ──
  ctx.effect(() => {
    // what the last load found (this browser): the sidebar and the landing need not wait for the setup check — nor show
    // Home for a moment when it is done; the check runs anyway and corrects both
    const KEY = 'ruyix.landing'
    let seen = null
    try { seen = JSON.parse(localStorage.getItem(KEY)) } catch { /* private window */ }
    // (a remembered "setup open" waits for the check: the setup may have been done since)
    let done = false, known = !!seen && !seen.pending, pending = seen ? !!seen.pending : true
    ;(window.__ruyixNav ||= {})[START] = { shown: () => pending }
    window.dispatchEvent(new CustomEvent('ruyix:nav')) // the sidebar as remembered, from the first frame
    // where to land, once that page is there (a plugin registers its page a moment after the shell): null — not yet
    const target = () => (!known ? null : pending ? START : inbox() || null)
    const land = (...to) => {
      if (done) return
      if (ctx.layout.panelInfo.getSnapshot().activePanelId !== null) { done = true; return }
      for (const id of (to.length ? to : [target()]).filter(Boolean)) {
        try { ctx.layout.selectPanel(id); done = true; return } catch { /* that page is not registered yet */ }
      }
    }
    fetch('api/ruyix/setup').then(r => r.json()).then(s => {
      pending = !Array.isArray(s?.steps) || s.steps.some(x => x.required && !x.ready)
      try { localStorage.setItem(KEY, JSON.stringify({ pending })) } catch { /* private window */ }
    }).catch(() => {}).finally(() => { known = true; window.dispatchEvent(new CustomEvent('ruyix:nav')); land() }) // the sidebar again: Home listed or not
    land() // what the last load found: at once
    const off = ctx.slots.subscribe('main', () => land())
    const offList = ctx.slots.subscribe('sidebar.panellist', () => land())
    // a page that registers itself a moment later (the workbench's inbox, after its entries) is asked for a while; nothing
    // after that (no workbench here): the inbox or the home page
    const poll = setInterval(() => { land(); if (done) clearInterval(poll) }, 400)
    const stop = setTimeout(() => { clearInterval(poll); land(target(), known ? inbox() : START, START); done = true }, 12000)
    return () => { off?.(); offList?.(); clearInterval(poll); clearTimeout(stop); delete window.__ruyixNav?.[START] }
  }, 'ruyix: landing')
}
