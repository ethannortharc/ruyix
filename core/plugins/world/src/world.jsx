// The interactive desk: one map (the old map or the star map) that is the whole desktop. Its places are the pages (the
// harbour is the runs page, the post station the inbox, the compass the settings…; layout.js), the capital the main agent
// (the conversation), the ship the new task; the tasks at work are islands (rings) with their agents on them, scheduled
// ones in the fog. Drag to look round, scroll (or pinch) to zoom, double-click to go nearer; a click on a place opens it.
// The ground is the shell's wallpaper engine with this plugin's scenes (scenes.js), fed every frame what is where; the
// places' pictures, names and counts are a layer of HTML over it that follows the view.
import { useEffect, useMemo, useRef, useState } from 'react'
import { KINDS, clampView, fit, islandsOf, placesOf, toScreen, toWorld, zoomAt } from './layout.js'
import { Icon } from './icons.jsx'
import { figureUniforms, figuresOf } from './constellations.js'
import { islesOf, onIsle } from './islands.js'
import { fmt, wordsFor } from './words.js'

const AGENT = { claude: 0, codex: 1, dsh: 2, model: 2, pi: 2, system: 3, person: 4 }
const cx = (...c) => c.filter(Boolean).join(' ')
const dur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(m / 1440)}d` }
const clock = (ms, lang) => new Date(ms).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** The agents at work (the workbench's window.__ruyixActivity), as it changes. */
function useActivity() {
  const [a, setA] = useState(() => window.__ruyixActivity || null)
  useEffect(() => { const on = () => setA(window.__ruyixActivity ? { ...window.__ruyixActivity } : null); window.addEventListener('ruyix:activity', on); on(); return () => window.removeEventListener('ruyix:activity', on) }, [])
  return a
}
/** The main agent's name and what it did last (the workbench's chatActions), now and then. */
function useMainAgent() {
  const [m, setM] = useState(null)
  useEffect(() => {
    let live = true, timer = 0
    const ask = () => fetch('api/ruyix-workbench', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'chatActions' }) })
      .then(r => (r.ok ? r.json() : null)).then(d => { if (live && d) setM(d) }, () => {}).finally(() => { if (live) timer = setTimeout(ask, document.hidden ? 30000 : 10000) })
    ask()
    const on = () => { clearTimeout(timer); ask() }
    window.addEventListener('ruyix:chat-state', on)
    return () => { live = false; clearTimeout(timer); window.removeEventListener('ruyix:chat-state', on) }
  }, [])
  return m
}

/** The work list (the shell's window.__ruyixWork, docs/design/sessions.md §3: the most pressing first), as it changes. */
function useWork() {
  const [list, setList] = useState(() => window.__ruyixWork?.get() || [])
  useEffect(() => { const on = () => setList(window.__ruyixWork?.get() || []); window.addEventListener('ruyix:work', on); on(); return () => window.removeEventListener('ruyix:work', on) }, [])
  return list
}
const openWork = w => { if (w?.open?.event) window.dispatchEvent(new CustomEvent(w.open.event, { detail: w.open.detail })) }

/**
 * What goes on the sea: the work going on (the work list: runs, the pool's tasks, sessions — waiting, at work, queued,
 * gone wrong and not looked at), what has just finished, the scheduled tasks coming up. The runs come from the activity
 * until the workbench puts them in the work list.
 */
function itemsOf(act, work) {
  const live = work.filter(w => ['queued', 'working', 'waiting'].includes(w.state) || (w.state === 'failed' && !w.seen))
  const asRun = w => ({ segs: w.segs || [], cur: w.cur ?? -1, createdAt: w.startedAt || Date.now() })
  const fromWork = [
    ...live.map(w => ({ key: w.id, kind: w.state === 'waiting' ? 2 : w.state === 'failed' ? 5 : 1, title: w.title, run: asRun(w), work: w })),
    ...work.filter(w => w.state === 'done' && w.endedAt && Date.now() - w.endedAt < 90000).map(w => ({ key: w.id, kind: 4, title: w.title, fin: { id: w.id, ok: w.ok !== false, endedAt: w.endedAt }, work: w })),
  ]
  const runs = work.some(w => w.kind === 'run') ? [] : act?.runs || []
  return [
    ...fromWork,
    ...runs.map(r => ({ key: r.id, kind: r.status === 'waiting' ? 2 : 1, title: r.title, run: r })),
    ...(work.some(w => w.kind === 'run') ? [] : act?.finished || []).filter(f => !runs.some(r => r.taskId && r.taskId === f.taskId)).map(f => ({ key: f.id, kind: 4, title: f.title, fin: f })),
    ...(act?.upcoming || []).map(u => ({ key: u.id, kind: 3, title: u.title, up: u })),
  ]
}
/** Who works on an island's task: a work item's own agents (its pulse theirs), else the activity's for that run. */
const agentsOf = (g, act) => (g.work
  ? (g.work.agents || []).filter(a => a.state !== 'done').map(a => ({ ...a, run: g.key, pulse: g.work.pulse, title: g.title, stepTitle: a.step, name: a.name || a.kind }))
  : (act?.agents || []).filter(a => a.run === g.key))

/** The voice key's words, as the desk publishes them (the shell's voice input: window.__ruyixVoiceKey). */
function useVoiceKey() {
  const [k, setK] = useState(() => window.__ruyixVoiceKey || null)
  useEffect(() => { const on = () => setK(window.__ruyixVoiceKey || null); window.addEventListener('ruyix:voice-key', on); on(); return () => window.removeEventListener('ruyix:voice-key', on) }, [])
  return k
}

/**
 * One map, as its definition says (`def`: { id, scene, icons, words, road, below, className } — main.jsx registerWorld);
 * `api` what the desk gives it (desktop.jsx).
 */
export function World({ def, api }) {
  const look = def.id
  const lang = api.lang === 'zh' ? 'zh' : 'en'
  const w = wordsFor(lang, def), voiceKey = useVoiceKey()
  const road = def.road ?? 1, below = def.below ?? 1.2
  const canvas = useRef(null), layer = useRef(null), engine = useRef(null)
  const act = useActivity(), main = useMainAgent(), work = useWork()
  const unseenDone = useMemo(() => work.filter(w => (w.state === 'done' || w.state === 'stopped') && !w.seen), [work]) // (as the desk's tray)
  const [doneOpen, setDoneOpen] = useState(false)
  const [box, setBox] = useState({ w: window.innerWidth, h: window.innerHeight })
  const aspect = box.w / Math.max(1, box.h)
  const [view, setView] = useState(() => fit(window.innerWidth / Math.max(1, window.innerHeight)))
  const target = useRef(view), shown = useRef(view) // where the view goes, where it is (eased towards it each frame)
  const [hover, setHover] = useState(null) // a place's id or a task's key
  const [now, setNow] = useState(Date.now())
  const places = useMemo(() => placesOf(api.pages), [api.pages.map(p => p.id).join()])
  const islands = useMemo(() => islandsOf(itemsOf(act, work)), [act, work])
  // what a map draws round its places, the same until the places change: the star map's constellations (def.figures),
  // the old map's real islands (def.isles) — how far each reaches (the scene brightens the one pointed at; a place's
  // button covers it: --fig), an island's size and cell in the picture of distances
  const figs = useMemo(() => (def.figures ? figuresOf(places, def.figures) : def.isles ? islesOf(places, def.land) : null), [places, def])
  const figures = useMemo(() => (def.figures && figs ? figureUniforms(figs) : null), [figs])
  const way = useRef(new Map()), meteors = useRef(new Map())
  const placeEls = useRef(new Map()), starEls = useRef(new Map())

  useEffect(() => {
    const on = () => setBox({ w: layer.current?.clientWidth || window.innerWidth, h: layer.current?.clientHeight || window.innerHeight })
    on(); window.addEventListener('resize', on)
    const tick = setInterval(() => setNow(Date.now()), 30000)
    return () => { window.removeEventListener('resize', on); clearInterval(tick) }
  }, [])
  useEffect(() => { const v = clampView(target.current, aspect); target.current = v }, [aspect])

  // a run that moved on: its banner (star) goes round from where it was to the step at work now
  useEffect(() => {
    const s = performance.now() / 1000
    for (const g of islands) {
      if (!g.run) continue
      const n = Math.max(1, g.run.segs?.length || 1), to = (Math.max(0, g.run.cur ?? 0) + 0.5) / n, was = way.current.get(g.key)
      if (!was) way.current.set(g.key, { from: to, to, at: 0 })
      else if (Math.abs(was.to - to) > 1e-6) way.current.set(g.key, { from: wayAt(was, s), to, at: s })
    }
  }, [islands])

  // the ground: the wallpaper engine with this map's scene; what it draws each frame comes from feed()
  const feed = useRef(null)
  useEffect(() => {
    if (!canvas.current) return
    const e = api.createWallpaper(canvas.current, { scenes: { [`world-${look}`]: def.scene } })
    e.set({ wallpaper: `world-${look}`, motion: api.motion, covered: false, data: (t, W, H) => feed.current?.(t, W, H) ?? null })
    engine.current = e
    return () => { e.destroy(); engine.current = null }
  }, [look])
  useEffect(() => { engine.current?.set({ motion: api.motion, covered: api.covered }) }, [api.motion, api.covered])

  // each frame: the view eases to where it is going; the places and the banners follow it; the scene gets it all
  useEffect(() => {
    feed.current = t => {
      const W = box.w, H = box.h
      // the view, eased
      const v = shown.current, g = target.current, k = 0.22
      shown.current = Math.abs(v.x - g.x) + Math.abs(v.y - g.y) + Math.abs(v.z - g.z) < 1e-5 ? g : { x: v.x + (g.x - v.x) * k, y: v.y + (g.y - v.y) * k, z: v.z + (g.z - v.z) * k }
      const view = shown.current
      const css = (x, y) => { const [sx, sy] = toScreen(view, x, y); return [sx * H + W / 2, H / 2 - sy * H] }
      const ps = placeScale(view.z, aspect)
      for (const pl of places) {
        const el = placeEls.current.get(pl.id)
        if (!el) continue
        const [x, y] = css(pl.x, pl.y)
        el.style.transform = `translate(${x}px, ${y}px) scale(${ps})`
        const reach = figs?.radius[pl.id]
        if (reach) { const fig = `${Math.round(reach / view.z * H / ps)}px`; if (el.dataset.fig !== fig) { el.dataset.fig = fig; el.style.setProperty('--fig', fig) } }
      }
      const uMark = new Float32Array(96), uMarkB = new Float32Array(96)
      places.slice(0, 24).forEach((pl, i) => {
        uMark.set([pl.x, pl.y, figs?.land?.[pl.id] ?? (def.land ? def.land[pl.kind] ?? def.land.default ?? pl.land : pl.land), pl.n], i * 4)
        // (y: 1 something waits for the person there — the inbox; 2 work done and not looked at — the records)
        const sign = pl.kind === 'post' && count(pl) > 0 ? 1 : pl.kind === 'archive' && unseenDone.length ? 2 : 0
        uMarkB.set([hover === pl.id ? 1 : 0, sign, figs?.z?.[pl.id] ?? figs?.radius[pl.id] ?? 0, 1], i * 4)
      })
      const uTask = new Float32Array(32), uTaskB = new Float32Array(32), uStar = new Float32Array(64), uStarB = new Float32Array(64), uLink = new Float32Array(32), uLinkB = new Float32Array(32)
      const starAt = new Map(), fromDate = ms => t - (Date.now() - ms) / 1000
      let ns = 0
      islands.slice(0, 8).forEach((gl, i) => {
        uTask.set([gl.x, gl.y, gl.r, gl.kind], i * 4)
        const el = placeEls.current.get(`t:${gl.key}`)
        // its words below it (an island's shore reaches out to about 1.5 of its radius)
        if (el) { const [x, y] = css(gl.x, gl.y - gl.r * below); el.style.transform = `translate(${x}px, ${y}px)` }
        if (gl.run) {
          const n = Math.max(1, gl.run.segs?.length || 1)
          uTaskB.set([n, (gl.run.segs || []).filter(s => s.st === 'done' || s.st === 'skip').length, gl.run.cur ?? -1, 0], i * 4)
          const wy = way.current.get(gl.key), at = wy ? wayAt(wy, performance.now() / 1000) : (Math.max(0, gl.run.cur ?? 0) + 0.5) / n
          const mine = agentsOf(gl, act)
          mine.forEach((a, j) => {
            if (ns >= 16) return
            const f = at + (mine.length > 1 ? (j - (mine.length - 1) / 2) * 0.28 / n : 0), th = (0.25 - f) * Math.PI * 2
            const sx = gl.x + gl.r * road * Math.cos(th), sy = gl.y + gl.r * road * Math.sin(th)
            starAt.set(a.id, [sx, sy])
            uStar.set([sx, sy, a.pulse?.at ? fromDate(a.pulse.at) : -99, AGENT[a.kind] ?? 2], ns * 4)
            uStarB.set([a.state === 'waiting' ? 1.25 : 1, a.state === 'waiting' ? 1 : 0, 0, 0], ns * 4)
            const se = starEls.current.get(a.id)
            if (se) { const [x, y] = css(sx, sy); se.style.transform = `translate(${x - 13}px, ${y - 13}px)` }
            ns++
          })
        } else if (gl.fin) uTaskB.set([1, 1, -1, fromDate(gl.fin.endedAt)], i * 4)
      })
      let nl = 0
      for (const l of act?.links || []) {
        if (l.kind !== 'message' || nl >= 8) continue
        const a = starAt.get(l.from), b = starAt.get(l.to)
        if (!a || !b) continue
        const key = `${l.from}>${l.to}`
        if (!meteors.current.has(key)) meteors.current.set(key, t)
        uLink.set([...a, ...b], nl * 4)
        uLinkB.set([meteors.current.get(key), 1, AGENT[(act.agents || []).find(x => x.id === l.from)?.kind] ?? 2, 0], nl * 4)
        nl++
      }
      const hoverTask = islands.findIndex(x => `t:${x.key}` === hover)
      return { n: [Math.min(8, islands.length), ns, hoverTask], uTask, uTaskB, uStar, uStarB, uLink, uLinkB, uMark, uMarkB, ...figures, uV: [view.x, view.y, view.z] }
    }
    engine.current?.redraw()
  }, [places, islands, act, hover, box, look, figs, figures, unseenDone])

  // ── looking round: drag, wheel, pinch, double-click, the keys ──
  const go = (v, fast = true) => { target.current = clampView(v, aspect); if (!fast) shown.current = target.current; engine.current?.set({ fast: true }); clearTimeout(go.t); go.t = setTimeout(() => engine.current?.set({ fast: false }), 700); engine.current?.redraw() }
  const screenOf = e => { const r = layer.current.getBoundingClientRect(); return [((e.clientX - r.left) / r.width - 0.5) * aspect, 0.5 - (e.clientY - r.top) / r.height] }
  const drag = useRef(null)
  const onDown = e => {
    if (!e.target.closest('.wd-done')) setDoneOpen(false)
    if (e.button !== 0 || e.target.closest('.wd-place, .wd-task, .wd-star, .wd-hud, .wd-done')) return
    drag.current = { x: e.clientX, y: e.clientY, v: target.current, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = e => {
    const d = drag.current
    if (!d) return
    const H = layer.current.clientHeight, dx = (e.clientX - d.x) / H, dy = (e.clientY - d.y) / H
    if (Math.abs(dx) + Math.abs(dy) > 0.003) d.moved = true
    go({ x: d.v.x - dx * d.v.z, y: d.v.y + dy * d.v.z, z: d.v.z }, false)
  }
  // a map of real islands (def.isles): the pointer is on a place when it is on its island — its shape, not a circle
  // round it (they overlap) — and a click there (not a drag) opens it
  const isleAt = e => {
    if (!figs?.isle) return null
    const [wx, wy] = toWorld(shown.current, ...screenOf(e))
    for (const pl of places) { const id = figs.isle[pl.id], R = figs.land[pl.id]; if (id && onIsle(id, (wx - pl.x) / R, (wy - pl.y) / R)) return pl }
    return null
  }
  const onHover = e => {
    if (!figs?.isle || drag.current?.moved) return
    const pl = isleAt(e), id = pl?.id ?? null
    setHover(h => (id ?? (h && figs.isle[h] ? null : h)))
  }
  const onUp = e => {
    const d = drag.current
    drag.current = null
    if (d && !d.moved && e?.type === 'pointerup') { const pl = isleAt(e); if (pl) open(pl) }
  }
  useEffect(() => {
    const el = layer.current
    const wheel = e => {
      if (e.target.closest?.('.ad-win, .ad-xwin, .ad-sheet')) return
      e.preventDefault()
      const [sx, sy] = screenOf(e)
      go(zoomAt(target.current, Math.exp((e.ctrlKey ? e.deltaY * 2.5 : e.deltaY) * 0.0016), sx, sy, aspect))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [aspect])
  const onDouble = e => { if (e.target.closest('.wd-place, .wd-task, .wd-star, .wd-hud')) return; const [sx, sy] = screenOf(e); go(zoomAt(target.current, 0.6, sx, sy, aspect)) }
  useEffect(() => {
    const key = e => {
      if (e.target.closest?.('input, textarea, [contenteditable], .ad-win, .ad-xwin, .ad-sheet') || e.metaKey || e.ctrlKey || e.altKey) return
      const v = target.current, step = v.z * 0.12
      const to = { ArrowLeft: { ...v, x: v.x - step }, ArrowRight: { ...v, x: v.x + step }, ArrowUp: { ...v, y: v.y + step }, ArrowDown: { ...v, y: v.y - step }, '=': { ...v, z: v.z * 0.8 }, '+': { ...v, z: v.z * 0.8 }, '-': { ...v, z: v.z * 1.25 }, '0': fit(aspect) }[e.key]
      if (to) { e.preventDefault(); go(to) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [aspect])

  // ── what each place says and does ──
  const pageOf = pl => pl.page || api.pages.find(p => p.id === pl.id)
  function count(pl) { const p = pageOf(pl); try { return Number((p?.count || p?.badge)?.()) || 0 } catch { return 0 } }
  const runs = act?.runs || []
  const mainName = main?.main?.name || ''
  const status = pl => {
    switch (pl.kind) {
      case 'capital': return api.voice?.phase === 'listening' ? w.listening : api.chat?.busy ? w.answering : mainName ? fmt(w.mainIs, { name: mainName }) : w.talk
      case 'harbor': return runs.length ? fmt(w.running, { n: runs.length }) : w.calm
      case 'post': { const n = count(pl); return n ? fmt(w.waits, { n }) : w.empty }
      case 'archive': return unseenDone.length ? fmt(w.doneN, { n: unseenDone.length }) : ''
      case 'launch': return w.launchHint
      case 'clock': return ''
      default: { const n = count(pl); return n ? String(n) : '' }
    }
  }
  const nameOf = pl => (pl.kind === 'launch' ? w.newTask : pl.kind === 'gate' ? w.leave : pl.kind === 'archive' ? w.archive : pl.kind === 'capital' ? w.capital : pageOf(pl)?.label || pl.id)
  const open = pl => {
    if (drag.current?.moved) return
    switch (pl.kind) {
      case 'capital': return api.talk()
      case 'launch': return api.workbench({ view: 'new' })
      case 'gate': return api.leave()
      case 'archive': return unseenDone.length ? setDoneOpen(o => !o) : window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: 'ruyix-tasks', tab: 'done' } })) // what is done and not looked at, else 「任务」's 完成
      case 'settings': return api.settings('general')
      case 'clock': return api.palette()
      default: return api.open(pl.id)
    }
  }
  const openTask = g => (g.work ? openWork(g.work) : api.workbench(g.up ? { task: g.up.id } : g.fin ? { run: g.fin.id, tab: 'overview' } : { run: g.key, tab: g.kind === 2 ? 'approvals' : 'pipeline' }))
  const taskLine = g => {
    if (g.up) return fmt(w.next, { when: clock(g.up.nextAt, lang), in: dur(g.up.nextAt - now) })
    if (g.fin) return g.fin.ok ? w.done : w.failed
    const s = g.run.segs?.[g.run.cur] || g.run.segs?.find(x => x.st === 'run' || x.st === 'wait')
    const name = s?.title || s?.key || ''
    return g.kind === 2 ? fmt(w.waitsYou, { what: name }) : g.kind === 5 ? `${w.failed}${name ? ` · ${name}` : ''}` : `${name} · ${dur(now - g.run.createdAt)}`
  }
  const date = new Date(now), listening = api.voice?.phase === 'listening'
  // the right-click menu: what the top bar and the dock otherwise reach (placed where the click was, in the map's own pixels)
  const [menu, setMenu] = useState(null), root = useRef(null), [version, setVersion] = useState(null)
  useEffect(() => { fetch('api/ruyix/version').then(r => r.json()).then(setVersion, () => {}) }, [])
  useEffect(() => {
    if (!menu) return
    const away = e => { if (!e.target.closest?.('.wd-menu')) setMenu(null) }, key = e => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', away, true); window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', key) }
  }, [menu])
  const onMenu = e => {
    e.preventDefault()
    const r = root.current.getBoundingClientRect(), k = root.current.offsetWidth / r.width
    const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k
    setMenu({ x: Math.min(x, root.current.offsetWidth - 260), y: Math.min(y, root.current.offsetHeight - 360) })
  }
  const pick = f => () => { setMenu(null); f() }
  // the next map, round the ones there are (the button low on the right)
  const at = api.worlds.findIndex(x => x.id === api.world), next = api.worlds.length > 1 ? api.worlds[(at + 1) % api.worlds.length] : null

  return (
    <div ref={root} className={cx('ad-world', `wd-${look}`, def.className)} data-look={look} onContextMenu={onMenu}>
      <canvas ref={canvas} className="wd-ground" aria-hidden="true" />
      <div ref={layer} className={cx('wd-layer', figs?.isle && hover && figs.isle[hover] && 'wd-pointing')} onPointerDown={onDown} onPointerMove={e => { onMove(e); onHover(e) }} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={onDouble}
        onPointerLeave={() => figs?.isle && setHover(h => (h && figs.isle[h] ? null : h))}
        role="application" aria-label={w.map} aria-roledescription={w.map}>
        {places.map(pl => (
          <button key={pl.id} type="button" ref={el => { if (el) placeEls.current.set(pl.id, el); else placeEls.current.delete(pl.id) }}
            className={cx('wd-place', `wd-k-${pl.kind}`, hover === pl.id && 'wd-hot')} onClick={() => open(pl)}
            onPointerEnter={() => setHover(pl.id)} onPointerLeave={() => setHover(h => (h === pl.id ? null : h))}
            aria-label={`${nameOf(pl)}${status(pl) ? ` · ${status(pl)}` : ''}`}>
            {pl.kind === 'clock'
              ? <span className="wd-cartouche"><b>{date.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', weekday: 'short' })}</b><span>{date.toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })}</span></span>
              : <>
                <span className="wd-pic"><Icon icons={def.icons} kind={pl.kind} page={pageOf(pl)} />{count(pl) > 0 && pl.kind !== 'post' && <i className="wd-count">{count(pl)}</i>}{pl.kind === 'post' && count(pl) > 0 && <i className="wd-count wd-count-wait">{count(pl)}</i>}</span>
                <span className="wd-name"><b>{nameOf(pl)}</b>{status(pl) && <span>{status(pl)}</span>}</span>
              </>}
          </button>
        ))}
        {islands.slice(0, 8).map(g => (
          <button key={g.key} type="button" ref={el => { if (el) placeEls.current.set(`t:${g.key}`, el); else placeEls.current.delete(`t:${g.key}`) }}
            className={cx('wd-task', g.kind === 2 && 'wd-wait', g.kind === 3 && 'wd-up', hover === `t:${g.key}` && 'wd-hot')} onClick={() => openTask(g)}
            onPointerEnter={() => setHover(`t:${g.key}`)} onPointerLeave={() => setHover(h => (h === `t:${g.key}` ? null : h))}>
            <b>{g.title}</b><span>{taskLine(g)}</span>
          </button>
        ))}
        {islands.slice(0, 8).flatMap(g => agentsOf(g, act).map(a => ({ a, g }))).slice(0, 16).map(({ a, g }) => (
          <button key={a.id} type="button" className="wd-star" ref={el => { if (el) starEls.current.set(a.id, el); else starEls.current.delete(a.id) }}
            onClick={() => (g.work ? openWork(g.work) : api.workbench({ run: a.run, tab: a.state === 'waiting' ? 'approvals' : 'pipeline' }))} aria-label={a.name || a.kind}>
            <span className="wd-tip"><b>{a.name || a.kind}</b>{a.state === 'waiting' ? w.waiting : w.working} · {a.stepTitle || a.step}<em>{a.title}</em></span>
          </button>
        ))}
      </div>
      {/* what is done and not looked at, beside the records' place (a click there) */}
      {doneOpen && unseenDone.length > 0 && (() => {
        const pl = places.find(p => p.kind === 'archive')
        if (!pl) return null
        const [sx, sy] = toScreen(shown.current, pl.x, pl.y)
        return (
          <div className="wd-done" role="menu" aria-label={w.doneList} style={{ left: sx * box.h + box.w / 2, top: box.h / 2 - sy * box.h }}>
            <b>{w.doneList}</b>
            {unseenDone.slice(0, 8).map(it => (
              <button key={it.id} type="button" role="menuitem" onClick={() => { setDoneOpen(false); openWork(it) }}>
                <i className={cx('wd-done-dot', it.ok === false && 'wd-done-bad')} /><span>{it.title}</span><small>{it.endedAt ? (now - it.endedAt < 60000 ? w.justNow : dur(now - it.endedAt)) : ''}</small>
              </button>
            ))}
          </div>
        )
      })()}
      {version?.ruyix && <div className="wd-version" title={[version.built && `${w.built} ${new Date(version.built).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}`, version.dsh && `dsh ${version.dsh}`, version.box && `nookbox ${version.box}`].filter(Boolean).join(' · ')}>Ruyix {version.ruyix}{version.commit ? ` · ${String(version.commit).slice(0, 7)}` : ''}</div>}
      {menu && (
        <div className="ad-menu wd-menu" role="menu" aria-label="Ruyix" style={{ left: menu.x, top: menu.y }}>
          {api.workbench && <button type="button" role="menuitem" className="ad-mi" onClick={pick(() => api.workbench({ view: 'new' }))}>{w.newTask}</button>}
          {api.open && <button type="button" role="menuitem" className="ad-mi" onClick={pick(() => api.open('ruyix-apps'))}>{w.menuApps}</button>}
          {api.open && <button type="button" role="menuitem" className="ad-mi" onClick={pick(() => api.open('ruyix-tasks'))}>{w.menuTasks}</button>}
          {api.palette && <button type="button" role="menuitem" className="ad-mi" onClick={pick(() => api.palette())}>{w.menuPalette}<small>⌘K</small></button>}
          {api.worlds.length > 1 && <><hr /><div className="wd-menu-cap">{w.menuMaps}</div>
            {api.worlds.map(x => <button key={x.id} type="button" role="menuitemradio" aria-checked={x.id === api.world} className="ad-mi" onClick={pick(() => api.pick(x.id))}>
              <span className="wd-menu-tick" aria-hidden="true">{x.id === api.world ? '✓' : ''}</span>{x.name?.[lang] || x.name?.en || x.id}</button>)}</>}
          <hr />
          {api.leave && <button type="button" role="menuitem" className="ad-mi" onClick={pick(() => api.leave())}>{w.leave}</button>}
          {api.fullscreen && <button type="button" role="menuitem" className="ad-mi" onClick={pick(() => api.fullscreen.toggle())}>{api.fullscreen.on ? w.fullOff : w.fullOn}</button>}
          <button type="button" role="menuitem" className="ad-mi" onClick={pick(() => window.dispatchEvent(new CustomEvent('ruyix:arrange')))}>{w.arrange}</button>
          <hr />
          {api.settings && <button type="button" role="menuitem" className="ad-mi" onClick={pick(() => api.settings('general'))}>{w.menuSettings}<small>⌘,</small></button>}
          <button type="button" role="menuitem" className="ad-mi" onClick={pick(() => window.dispatchEvent(new CustomEvent('ruyix:about')))}>{w.menuAbout}</button>
        </div>
      )}
      <div className="wd-hud">
        {/* what the top bar otherwise holds: speaking to the main agent, the whole screen */}
        {api.listen && <button type="button" className={cx('wd-hud-icon', listening && 'wd-on')} onPointerDown={e => e.preventDefault()} onClick={() => api.listen()}
          aria-label={listening ? w.voiceOn : w.voice} aria-pressed={listening} title={listening ? w.voiceOn : typeof w.voiceHint === 'function' ? w.voiceHint(voiceKey?.say?.[lang], voiceKey?.toggle) : w.voiceHint}>{MIC}</button>}
        {api.fullscreen && <button type="button" className="wd-hud-icon" onClick={() => api.fullscreen.toggle()} aria-pressed={api.fullscreen.on}
          aria-label={api.fullscreen.on ? w.fullOff : w.fullOn} title={api.fullscreen.on ? w.fullOff : w.fullOn}>{api.fullscreen.on ? SHRINK : GROW}</button>}
        {(api.listen || api.fullscreen) && <span className="wd-hud-gap" aria-hidden="true" />}
        <button type="button" onClick={() => go(zoomAt(target.current, 0.75, 0, 0, aspect))} aria-label={w.nearer} title={w.nearer}>+</button>
        <button type="button" onClick={() => go(zoomAt(target.current, 1.33, 0, 0, aspect))} aria-label={w.further} title={w.further}>−</button>
        <button type="button" onClick={() => go(fit(aspect))} aria-label={w.whole} title={`${w.whole} (0)`}>{w.wholeShort}</button>
        {next && <button type="button" onClick={() => api.pick(next.id)} title={w.other}>{next.name?.[lang] || next.name?.en || next.id}</button>}
      </div>
    </div>
  )
}

// the buttons' pictures (lines in the button's own colour)
const svg = d => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
const MIC = svg(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>)
const GROW = svg(<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />)
const SHRINK = svg(<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />)

/** A place's picture grows a little as one goes nearer (it is on the map) — less than the map does (it stays readable). */
const placeScale = (z, aspect) => Math.min(1.5, Math.max(0.75, Math.pow(fit(aspect).z / z, 0.45)))
function wayAt(way, s) {
  if (!way.at) return way.to
  const k = Math.min(1, (s - way.at) / 1.4), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
  return way.from + (way.to - way.from) * e
}
export { KINDS }
