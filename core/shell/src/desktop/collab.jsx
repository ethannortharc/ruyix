// Who is talking to whom in one piece of work (docs/design/agent-work.md §6), for whoever shows the work (exported as
// @ruyix/shell/collab; React stays the caller's):
//   <CollabGraph agents={[{ id, kind, name }]} links={[{ from, to, at, text }]} lang />
// Each agent a point in its colour (./agents.js), on a ring; each pair that has messages a line between them, the more
// messages the stronger; each new message a light flying along the line to whom it went, and the one it reached
// pings. A click on a line lists that pair's messages. The data is the messages and hand-offs there are (core/messages).
// It brings its own look (a plugin does not have the desk's stylesheet) and follows the theme: glowing on dark, ink on
// light. Reduced motion: no flying lights.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { agentColor } from './agents.js'

const WORDS = {
  zh: { none: '还没有消息', count: n => `${n} 条消息，点一下看`, title: '协作', close: '收起' },
  en: { none: 'No messages yet', count: n => `${n} messages — click to read`, title: 'Collaboration', close: 'Close' },
}
const keyOf = l => `${l.at}:${l.from}:${l.to}`
const pairOf = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const hhmm = at => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

/**
 * Where each agent sits, in pixels of a graph `W` wide: one in the middle, two side by side, more on a ring from the top,
 * clockwise — then as high as the points need (room for a name over the top one and under the lowest), not a set box.
 * → { at: { id: { x, y } }, H, mid } (mid: the middle the lines bow toward)
 */
export function layout(ids, W = 320) {
  const n = ids.length, at = {}, top = 26, under = 30
  if (n === 1) at[ids[0]] = { x: W / 2, y: top }
  else if (n === 2) { at[ids[0]] = { x: W * 0.2, y: top + 14 }; at[ids[1]] = { x: W * 0.8, y: top + 14 } }
  else {
    const rx = Math.max(40, W / 2 - 46), ry = Math.min(90, Math.max(44, rx * 0.6))
    ids.forEach((id, i) => { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; at[id] = { x: W / 2 + Math.cos(a) * rx, y: Math.sin(a) * ry } })
    const minY = Math.min(...ids.map(id => at[id].y))
    for (const id of ids) at[id].y += top - minY
  }
  const ys = ids.map(id => at[id].y), lo = ys.length ? Math.min(...ys) : top, hi = ys.length ? Math.max(...ys) : top
  return { at, H: hi + under, mid: { x: W / 2, y: (lo + hi) / 2 } }
}
/** The line from one point to another, bowed a little toward the middle (through it: upward), the same curve either way. */
export function curve(p, q, mid) {
  const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, cx = mid.x, cy = mid.y
  const toMid = Math.hypot(cx - mx, cy - my) > 4
  const c = toMid ? { x: mx + (cx - mx) * 0.3, y: my + (cy - my) * 0.3 } : { x: mx, y: my - 22 }
  return `M${p.x.toFixed(1)},${p.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${q.x.toFixed(1)},${q.y.toFixed(1)}`
}

/** A light flying along a line once (SMIL, started when it is drawn). */
function Flight({ d, color }) {
  const m = useRef(null)
  useEffect(() => { try { m.current?.beginElement() } catch { /* no SMIL: it just isn't seen */ } }, [])
  return (
    <circle r="3.4" className="rx-collab-dot" style={{ fill: color, '--c': color }} cx="0" cy="0">
      <animateMotion ref={m} dur="0.9s" begin="indefinite" fill="freeze" path={d} calcMode="spline" keyTimes="0;1" keySplines=".3 .1 .3 1" />
    </circle>
  )
}

export function CollabGraph({ agents = [], links = [], lang = 'zh', className = '' }) {
  const T = WORDS[lang] || WORDS.en
  // its own ids for its glows (two graphs on a page must not share them)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  // the agents: those given, then any a message names that is not given
  const nodes = useMemo(() => {
    const list = [...agents]
    for (const l of links) for (const id of [l.from, l.to]) if (id && !list.some(a => a.id === id)) list.push({ id, kind: 'model' })
    return list
  }, [agents, links])
  // laid out in its own pixels (measured), so its names keep their size however wide it is put
  const box = useRef(null), [W, setW] = useState(320)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (el.clientWidth) setW(el.clientWidth)
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w > 0) setW(w) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const { at, H, mid } = useMemo(() => layout(nodes.map(a => a.id), W), [nodes, W])
  const pairs = useMemo(() => {
    const m = new Map()
    for (const l of links) {
      if (!l.from || !l.to || l.from === l.to || !at[l.from] || !at[l.to]) continue
      const k = pairOf(l.from, l.to)
      if (!m.has(k)) m.set(k, { key: k, a: l.from < l.to ? l.from : l.to, b: l.from < l.to ? l.to : l.from, list: [] })
      m.get(k).list.push(l)
    }
    for (const p of m.values()) p.list.sort((x, y) => x.at - y.at)
    return [...m.values()]
  }, [links, at])

  // the messages already there when it was first drawn fly nowhere; each new one flies once
  const timers = useRef(new Set())
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t) }, [])
  const seen = useRef(null), [flights, setFlights] = useState([]), [pings, setPings] = useState({})
  useEffect(() => {
    if (!seen.current) { seen.current = new Set(links.map(keyOf)); return }
    const fresh = links.filter(l => !seen.current.has(keyOf(l)) && at[l.from] && at[l.to] && l.from !== l.to)
    for (const l of links) seen.current.add(keyOf(l))
    if (!fresh.length || reduced()) return
    const add = fresh.slice(-6).map(l => ({ key: `${keyOf(l)}:${Math.random()}`, d: curve(at[l.from], at[l.to], mid), color: agentColor(nodes.find(a => a.id === l.from)?.kind), to: l.to }))
    setFlights(f => [...f, ...add])
    const later = (fn, ms) => { const t = setTimeout(() => { timers.current.delete(t); fn() }, ms); timers.current.add(t) }
    later(() => setPings(p => ({ ...p, ...Object.fromEntries(add.map(f => [f.to, Date.now()])) })), 880)
    later(() => setFlights(f => f.filter(x => !add.includes(x))), 1100)
  }, [links])

  const [pick, setPick] = useState(null)
  const picked = pairs.find(p => p.key === pick)
  const name = id => { const a = nodes.find(x => x.id === id); return a?.name || a?.kind || id }
  const most = Math.max(1, ...pairs.map(p => p.list.length))

  return (
    <div ref={box} className={`rx-collab ${className}`.trim()} aria-label={T.title}>
      <style>{CSS}</style>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={T.title}>
        <defs>
          {nodes.map(a => (
            <radialGradient key={a.id} id={`rx-collab-h-${uid}-${a.id}`}>
              {/* a glow on dark; none on light (ink needs none) */}
              <stop offset="0" style={{ stopColor: `light-dark(transparent, color-mix(in srgb, ${agentColor(a.kind)} 55%, transparent))` }} />
              <stop offset="1" style={{ stopColor: 'transparent' }} />
            </radialGradient>
          ))}
        </defs>
        {pairs.map(p => {
          const d = curve(at[p.a], at[p.b], mid), w = 1 + 2.4 * Math.log2(1 + p.list.length) / Math.log2(1 + most)
          return (
            <g key={p.key} className={`rx-collab-edge${pick === p.key ? ' rx-collab-on' : ''}`} onClick={() => setPick(k => (k === p.key ? null : p.key))}>
              <path d={d} className="rx-collab-line" style={{ strokeWidth: w }} />
              <path d={d} className="rx-collab-hit"><title>{`${name(p.a)} ↔ ${name(p.b)} · ${T.count(p.list.length)}`}</title></path>
            </g>
          )
        })}
        {flights.map(f => <Flight key={f.key} d={f.d} color={f.color} />)}
        {nodes.map(a => {
          const p = at[a.id], c = agentColor(a.kind)
          return (
            <g key={a.id} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} style={{ '--c': c }}>
              <circle r="20" fill={`url(#rx-collab-h-${uid}-${a.id})`} />
              {pings[a.id] && <circle key={pings[a.id]} r="8" className="rx-collab-ping" />}
              <circle r="7" className="rx-collab-node" />
              {/* the name away from its lines: above a point in the upper half, below the rest */}
              <text y={p.y < mid.y - 12 ? -15 : 24} className="rx-collab-name">{a.name || a.kind}</text>
            </g>
          )
        })}
      </svg>
      {!pairs.length && <p className="rx-collab-none">{T.none}</p>}
      {picked && (
        <ol className="rx-collab-msgs">
          {picked.list.slice(-8).map(l => (
            <li key={keyOf(l)}>
              <b style={{ color: agentColor(nodes.find(a => a.id === l.from)?.kind) }}>{name(l.from)}</b>
              <span className="rx-collab-to">→ {name(l.to)} · {hhmm(l.at)}</span>
              <span className="rx-collab-text">{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

const CSS = `
.rx-collab { display: flex; flex-direction: column; gap: 6px; color: var(--ruyix-text); font: var(--ruyix-text-sm) / 1.45 var(--ruyix-font); }
.rx-collab svg { display: block; width: 100%; height: auto; overflow: visible; }
.rx-collab-line { fill: none; stroke: var(--ruyix-line-strong); stroke-linecap: round; opacity: .9; transition: stroke .2s; }
.rx-collab-hit { fill: none; stroke: transparent; stroke-width: 14; cursor: pointer; }
.rx-collab-edge:hover .rx-collab-line, .rx-collab-on .rx-collab-line { stroke: var(--ruyix-accent); }
.rx-collab-node { fill: var(--c); stroke: light-dark(rgba(255, 255, 255, .9), rgba(10, 14, 22, .7)); stroke-width: 1.5; }
.rx-collab-name { text-anchor: middle; fill: var(--ruyix-text-muted); font-size: var(--ruyix-text-xs); font-weight: 600; }
.rx-collab-dot { filter: drop-shadow(0 0 4px var(--c)); }
.rx-collab-ping { fill: none; stroke: var(--c); stroke-width: 1.5; transform-box: fill-box; transform-origin: center; animation: rx-collab-ping .7s ease-out forwards; }
@keyframes rx-collab-ping { from { transform: scale(1); opacity: .9; } to { transform: scale(2.6); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .rx-collab-ping { animation: none; opacity: 0; } }
.rx-collab-none { margin: 0; text-align: center; color: var(--ruyix-text-dim); font-size: var(--ruyix-text-xs); }
.rx-collab-msgs { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; font-size: var(--ruyix-text-xs); }
.rx-collab-msgs li { display: grid; grid-template-columns: auto 1fr; column-gap: 6px; }
.rx-collab-msgs b { font-weight: 600; }
.rx-collab-to { color: var(--ruyix-text-dim); }
.rx-collab-text { grid-column: 1 / -1; color: var(--ruyix-text); overflow-wrap: anywhere; }
`
