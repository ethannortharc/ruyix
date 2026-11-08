// The agents' desk (a data wallpaper): the tasks at work drawn into the wallpaper itself. `sky`, the star map: each task
// a ring of its steps (the ones done lit, the one at work glowing, amber while it waits for the person), its agents stars
// on it (a ring goes out of one at each thing it does; the star travels round to the next step), messages meteors from
// one star to another, a task just done flaring green, the scheduled ones faint rings with when they run next. `atlas`,
// the old map: each task an island, its steps stations on a road round it, its agents banners, messages couriers, a
// vermilion seal where it waits for the person, the scheduled ones islands in fog. This file places them on the free part
// of the desk (not under the widgets, the clock, the bar or the dock), gives the wallpaper what to draw each frame
// (wallpaper.js DATA, through `feed`) and lays the words and the places to click over it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useActivity } from './agents.jsx'

const KIND = { claude: 0, codex: 1, dsh: 2, model: 2, system: 3, person: 4 }
const MAX = { tasks: 8, stars: 16, links: 8 }
const MOVE_S = 1.4 // a star going round to the next step
const cx = (...c) => c.filter(Boolean).join(' ')
const hash = s => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296 }
const dur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(m / 1440)}d` }
// how each look sits: the road its agents are on (a share of the ring), how far below it the words go, its size
const LOOKS = { sky: { road: 1, below: 1, size: 1 }, atlas: { road: 0.62, below: 1.32, size: 0.78 } }
const ATLAS_WORDS = {
  zh: { idle: '地图上还没有在跑的任务', idleHint: '任务开始跑时，它会在这里成为一座岛，每一步是路上的一个驿站；智能体是路上的小旗', legend: '一座岛是一个任务，环路上的驿站是它的每一步 · 小旗是在干活的智能体 · 驿道上跑的朱点是消息 · 朱红方印是在等你' },
  en: { idle: 'No tasks running on the map yet', idleHint: 'When a task runs it becomes an island here, each step a station on its road; its agents are the banners on the road', legend: 'An island is a task, each station on its road a step · banners are agents at work · red dots on the dotted ways are messages · a vermilion seal waits for you' },
}
const WORDS = {
  zh: { waits: '等你：{what}', done: '做完了', failed: '没成功', next: '下次 {when} · 还有 {in}', idle: '星图上还没有在跑的任务', idleHint: '任务开始跑时，它会在这里成为一圈星轨；智能体是轨道上的星', newTask: '新建任务', legend: '一圈星轨是一个任务，每一段是一步 · 星是在干活的智能体 · 流星是它们之间的消息 · 琥珀色是在等你', working: '在做', waiting: '等你' },
  en: { waits: 'Waiting for you: {what}', done: 'Done', failed: 'Did not succeed', next: 'Next {when} · in {in}', idle: 'No tasks running in the sky yet', idleHint: 'When a task runs it becomes a ring here, one stretch a step; its agents are the stars on it', newTask: 'New task', legend: 'A ring is a task, each stretch a step · stars are agents at work · meteors are their messages · amber waits for you', working: 'working on', waiting: 'waiting for you' },
}
const fmt = (s, p) => s.replace(/\{(\w+)\}/g, (m, k) => p[k] ?? m)
const clock = (ms, lang) => new Date(ms).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** What goes in the sky: the runs going, the ones just over, the scheduled tasks coming up — at most eight rings. */
function itemsOf(act) {
  const runs = act?.runs || []
  return [
    ...runs.map(r => ({ key: r.id, kind: r.status === 'waiting' ? 2 : 1, title: r.title, run: r })),
    ...(act?.finished || []).filter(f => !runs.some(r => r.taskId && r.taskId === f.taskId)).map(f => ({ key: f.id, kind: 4, title: f.title, fin: f })),
    ...(act?.upcoming || []).map(u => ({ key: u.id, kind: 3, title: u.title, up: u })),
  ].slice(0, MAX.tasks)
}

/**
 * Where each ring goes on a desk of w × h: the free part of it, a grid as square as it allows, each ring a little off its
 * cell (the same each time: by its id) — the scheduled ones smaller. → [{ ...item, x, y, r }] in the desk's pixels.
 */
export function place(items, w, h, { right = 336, top = 92, bottom = 168, left = 64, clockBox = { x: 0, y: 0, w: 430, h: 240 }, size = 1 } = {}) {
  if (!items.length || !w || !h) return []
  const free = w - left - right > 360 ? { x: left, y: top, w: w - left - right, h: h - top - bottom } : { x: 24, y: top, w: w - 48, h: h - top - bottom }
  let cols = 1, best = Infinity
  for (let c = 1; c <= items.length; c++) {
    const rows = Math.ceil(items.length / c), a = (free.w / c) / (free.h / rows)
    const score = Math.abs(Math.log(a)) + (c * rows - items.length) * 0.15
    if (score < best) { best = score; cols = c }
  }
  const rows = Math.ceil(items.length / cols), cw = free.w / cols, ch = free.h / rows
  const base = Math.max(42, Math.min(h * 0.17, Math.min(cw, ch) * 0.3)) * size
  return items.map((it, i) => {
    const col = i % cols, row = Math.floor(i / cols), j = hash(it.key), k = hash(`${it.key}:y`)
    let x = free.x + cw * (col + 0.5) + (j - 0.5) * cw * 0.22, y = free.y + ch * (row + 0.5) + (k - 0.5) * ch * 0.18
    const r = base * (it.kind === 3 ? 0.62 : 1)
    // not on the clock
    if (x - r < clockBox.x + clockBox.w && y - r < clockBox.y + clockBox.h) y = Math.max(y, clockBox.y + clockBox.h + r + 8)
    return { ...it, x, y: Math.min(y, h - bottom - r * 0.4), r }
  })
}

/**
 * The sky's words and places to click, and its feed for the wallpaper. feed: a ref the desk's wallpaper reads each frame;
 * redraw(): draw once now (a wallpaper that does not move: no motion asked for). open(detail): the workbench open event.
 */
export function AgentSky({ feed, redraw, look = 'sky', lang = 'zh', open }) {
  const act = useActivity()
  const L = LOOKS[look] || LOOKS.sky
  const w = { ...(WORDS[lang] || WORDS.en), ...(look === 'atlas' ? ATLAS_WORDS[lang] || ATLAS_WORDS.en : {}) }
  const layer = useRef(null), starEls = useRef(new Map())
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState(-1)
  const [now, setNow] = useState(Date.now())
  const mem = useRef({ way: new Map(), meteors: new Map() }) // run → { from, to, at } (its star going round); link → when first seen
  useEffect(() => {
    const on = () => setBox({ w: layer.current?.clientWidth || 0, h: layer.current?.clientHeight || 0 })
    on(); window.addEventListener('resize', on)
    const tick = setInterval(() => setNow(Date.now()), 30000)
    return () => { window.removeEventListener('resize', on); clearInterval(tick) }
  }, [])
  const rings = useMemo(() => place(itemsOf(act), box.w, box.h, { size: L.size }), [act, box.w, box.h, look])
  // a run that moved on: its star goes round from where it was to the step at work now
  useEffect(() => {
    for (const g of rings) {
      if (!g.run) continue
      const n = Math.max(1, g.run.segs.length), to = (Math.max(0, g.run.cur) + 0.5) / n, was = mem.current.way.get(g.key)
      if (!was) mem.current.way.set(g.key, { from: to, to, at: 0 })
      else if (Math.abs(was.to - to) > 1e-6) mem.current.way.set(g.key, { from: wayAt(was, performance.now() / 1000), to, at: performance.now() / 1000 })
    }
  }, [rings])

  // what the wallpaper draws this frame (wallpaper.js DATA): positions in its space (centred, the height 1, y up)
  useEffect(() => {
    if (!feed) return
    feed.current = t => {
      const { w: W, h: H } = box
      if (!W || !H || !rings.length) return null
      const aspect = W / H, P = (x, y) => [(x / W - 0.5) * aspect, 0.5 - y / H]
      const wall = s => t - (performance.now() / 1000 - s) // a moment on this page's clock → the wallpaper's
      const fromDate = ms => t - (Date.now() - ms) / 1000
      const uTask = new Float32Array(32), uTaskB = new Float32Array(32), uStar = new Float32Array(64), uStarB = new Float32Array(64), uLink = new Float32Array(32), uLinkB = new Float32Array(32)
      const starAt = new Map() // agent id → [x, y] (p)
      let ns = 0
      rings.forEach((g, i) => {
        const [x, y] = P(g.x, g.y)
        uTask.set([x, y, g.r / H, g.kind], i * 4)
        if (g.run) {
          const n = Math.max(1, g.run.segs.length)
          uTaskB.set([n, g.run.segs.filter(s => s.st === 'done' || s.st === 'skip').length, g.run.cur, 0], i * 4)
          const way = mem.current.way.get(g.key), at = way ? wayAt(way, performance.now() / 1000) : (Math.max(0, g.run.cur) + 0.5) / n
          const mine = (act?.agents || []).filter(a => a.run === g.key)
          mine.forEach((a, j) => {
            if (ns >= MAX.stars) return
            const f = at + (mine.length > 1 ? (j - (mine.length - 1) / 2) * 0.28 / n : 0), th = (0.25 - f) * Math.PI * 2
            const sx = x + (g.r * L.road / H) * Math.cos(th), sy = y + (g.r * L.road / H) * Math.sin(th)
            starAt.set(a.id, [sx, sy])
            uStar.set([sx, sy, a.pulse?.at ? fromDate(a.pulse.at) : -99, KIND[a.kind] ?? 2], ns * 4)
            uStarB.set([a.state === 'waiting' ? 1.25 : 1, a.state === 'waiting' ? 1 : 0, 0, 0], ns * 4)
            // the button over it follows it
            const el = starEls.current.get(a.id)
            if (el) el.style.transform = `translate(${(sx / aspect + 0.5) * W - 13}px, ${(0.5 - sy) * H - 13}px)`
            ns++
          })
        } else if (g.fin) uTaskB.set([1, 1, -1, fromDate(g.fin.endedAt)], i * 4)
      })
      // messages between agents: a meteor each, from when it was first seen
      let nl = 0
      for (const l of act?.links || []) {
        if (l.kind !== 'message' || nl >= MAX.links) continue
        const a = starAt.get(l.from), b = starAt.get(l.to)
        if (!a || !b) continue
        const key = `${l.from}>${l.to}`
        if (!mem.current.meteors.has(key)) mem.current.meteors.set(key, performance.now() / 1000)
        uLink.set([...a, ...b], nl * 4)
        uLinkB.set([wall(mem.current.meteors.get(key)), 1, KIND[(act.agents || []).find(x => x.id === l.from)?.kind] ?? 2, 0], nl * 4)
        nl++
      }
      return { n: [rings.length, ns, hover], uTask, uTaskB, uStar, uStarB, uLink, uLinkB }
    }
    redraw?.()
    return () => { feed.current = null; redraw?.() }
  }, [rings, hover, act, box, look])

  const say = g => {
    if (g.up) return { line: fmt(w.next, { when: clock(g.up.nextAt, lang), in: dur(g.up.nextAt - now) }) }
    if (g.fin) return { line: g.fin.ok ? w.done : w.failed }
    const s = g.run.segs[g.run.cur] || g.run.segs.find(x => x.st === 'run' || x.st === 'wait')
    const name = s?.title || s?.key || ''
    return g.kind === 2 ? { line: fmt(w.waits, { what: name }), wait: true } : { line: `${name} · ${dur(now - g.run.createdAt)}` }
  }
  const go = g => open?.(g.up ? { task: g.up.id } : g.fin ? { run: g.fin.id, tab: 'overview' } : { run: g.key, tab: g.kind === 2 ? 'approvals' : 'pipeline' })
  return (
    <div ref={layer} className={cx('ad-sky', `ad-sky-${look}`)} aria-label={look === 'atlas' ? (lang === 'zh' ? '智能体地图' : 'Agent map') : (lang === 'zh' ? '智能体星图' : 'Agent sky')}>
      {rings.map((g, i) => {
        const s = say(g)
        return [
          <button key={`r${g.key}`} type="button" className="ad-sky-ring" style={{ left: g.x - g.r, top: g.y - g.r, width: g.r * 2, height: g.r * 2 }} aria-label={g.title}
            onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(-1)} onClick={() => go(g)} />,
          <button key={`l${g.key}`} type="button" className={cx('ad-sky-label', s.wait && 'ad-sky-wait', g.kind === 3 && 'ad-sky-up', i === hover && 'ad-sky-hot')} style={{ left: g.x, top: g.y + g.r * L.below + 16 }}
            onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(-1)} onClick={() => go(g)}>
            <b>{g.title}</b><span>{s.line}</span>
          </button>,
        ]
      })}
      {(act?.agents || []).filter(a => rings.some(g => g.key === a.run)).slice(0, MAX.stars).map(a => (
        <button key={a.id} type="button" className="ad-sky-star" ref={el => { if (el) starEls.current.set(a.id, el); else starEls.current.delete(a.id) }}
          onClick={() => open?.({ run: a.run, tab: a.state === 'waiting' ? 'approvals' : 'pipeline' })} aria-label={a.name || a.kind}>
          <span className="ad-agent-tip"><b>{a.name || a.kind}</b>{a.state === 'waiting' ? w.waiting : w.working} · {a.stepTitle || a.step}<em>{a.title}</em></span>
        </button>
      ))}
      {rings.length > 0
        ? <p className="ad-sky-legend">{w.legend}</p>
        : box.w > 0 && (
          <div className="ad-sky-idle">
            <b>{w.idle}</b><span>{w.idleHint}</span>
            <button type="button" onClick={() => open?.({ view: 'new' })}>{w.newTask}</button>
          </div>
        )}
    </div>
  )
}

/** Where a star is on its way round (a share of the ring), eased. */
function wayAt(way, s) {
  if (!way.at) return way.to
  const k = Math.min(1, (s - way.at) / MOVE_S), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
  return way.from + (way.to - way.from) * e
}
