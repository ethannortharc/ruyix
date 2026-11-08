// Agents at work, on the desk (window.__ruyixActivity, which the workbench feeds — src/activity.js there): each one a
// light, gathered by the task it works on; it flashes at each thing it does (a tool, a command, a model call), the
// lights of one task are linked, a light travels from one step's agent to the next's, messages run between them; one
// waiting for the person glows amber. A chip at each light shows what it is (an icon, a simple face — desktop.json
// `agents`) and opens its task. One canvas, glows drawn from sprites made once; about 30 frames a second only while
// something is at work, none while the page is hidden; with less motion asked for, a still picture.
import { useEffect, useRef, useState } from 'react'

const COLOR = { claude: '#ff9f6b', codex: '#5ec8ff', dsh: '#a493ff', model: '#a493ff', system: '#9fb0c2', person: '#f5b335' }
const FRAME_MS = 33
const cx = (...c) => c.filter(Boolean).join(' ')

/** The icon of an agent's kind: simple shapes of its own (no maker's mark). */
export function AgentIcon({ kind, size = 16 }) {
  const s = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (kind === 'claude') return <svg {...s}><path d="M12 3v5M12 16v5M3 12h5M16 12h5M5.6 5.6l3.5 3.5M14.9 14.9l3.5 3.5M5.6 18.4l3.5-3.5M14.9 9.1l3.5-3.5" /></svg>
  if (kind === 'codex') return <svg {...s}><path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" /><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" /></svg>
  if (kind === 'person') return <svg {...s}><path d="M12 7v6" /><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="9" /></svg>
  if (kind === 'system') return <svg {...s}><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></svg>
  return <svg {...s}><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" /><ellipse cx="12" cy="12" rx="9" ry="4" /><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)" /></svg>
}
/** A simple face: eyes that look about while it works, up while it waits for the person, a blink at each thing it does. */
function Face({ state, blink }) {
  const up = state === 'waiting'
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <g className={cx('ad-face-eyes', !up && 'ad-face-look', blink && 'ad-face-blink')} fill="currentColor">
        <ellipse cx="8.5" cy={up ? 9 : 10.5} rx="1.7" ry="2.2" /><ellipse cx="15.5" cy={up ? 9 : 10.5} rx="1.7" ry="2.2" />
      </g>
      <path d={up ? 'M9 16.5h6' : 'M8.5 15.5q3.5 2.5 7 0'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** A soft round light of a colour, drawn once into its own small canvas (the frame only copies it). */
const sprites = new Map()
function sprite(color, r) {
  const k = `${color}:${r}`
  if (sprites.has(k)) return sprites.get(k)
  const c = document.createElement('canvas'), n = r * 2
  c.width = c.height = n
  const g = c.getContext('2d'), grd = g.createRadialGradient(r, r, 0, r, r, r)
  grd.addColorStop(0, `${color}ff`); grd.addColorStop(0.18, `${color}cc`); grd.addColorStop(0.45, `${color}44`); grd.addColorStop(1, `${color}00`)
  g.fillStyle = grd; g.fillRect(0, 0, n, n)
  sprites.set(k, c)
  return c
}
const hash = s => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296 }

/** The snapshot as it comes ('ruyix:activity'). */
export function useActivity() {
  const [a, setA] = useState(() => window.__ruyixActivity || null)
  useEffect(() => { const on = () => setA(window.__ruyixActivity ? { ...window.__ruyixActivity } : null); window.addEventListener('ruyix:activity', on); on(); return () => window.removeEventListener('ruyix:activity', on) }, [])
  return a
}

/**
 * The lights, on the part of the desk the widgets leave free. look: icon | light | face | off; motion: whether things
 * move; tone: the wallpaper's (on a light one, lights are laid on it rather than added to it, or they would wash out);
 * lang: the chips' words; open(run): what a click does.
 */
export function AgentLights({ look = 'icon', motion = true, tone = 'dark', lang = 'zh', open }) {
  const act = useActivity()
  const canvas = useRef(null), layer = useRef(null), chips = useRef(new Map())
  const state = useRef({ seen: new Map(), rings: [], flights: [], pos: new Map(), last: 0 })
  const agents = act?.agents || []
  const light = useRef(false)
  light.current = tone === 'light' || (tone === 'auto' && !window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  const still = !motion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const show = look !== 'off' && agents.length > 0

  // where each light rests: the tasks around a ring in the free part of the desk (the widgets' column left free), a
  // task's agents close together
  const homeOf = (a, w, h, live) => {
    const area = { x: 40, y: 80, w: Math.max(200, w - 360), h: Math.max(200, h - 200) }
    const cxp = area.x + area.w * 0.5, cyp = area.y + area.h * 0.55, rx = area.w * 0.32, ry = area.h * 0.26
    const order = [...new Set(live.map(x => x.run))]
    const i = order.indexOf(a.run), n = Math.max(order.length, 1)
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2 + (n === 1 ? Math.PI / 2.6 : 0)
    const mine = live.filter(x => x.run === a.run), j = mine.findIndex(x => x.id === a.id)
    const off = mine.length > 1 ? (j - (mine.length - 1) / 2) * 72 : 0
    return { x: cxp + Math.cos(ang) * rx + off, y: cyp + Math.sin(ang) * ry + (mine.length > 1 ? (j % 2 ? 22 : -10) : 0) }
  }

  // the frame: lights, their pulses, the links between them, a light travelling from one step to the next
  useEffect(() => {
    const c = canvas.current
    if (!c || !show) return
    const g = c.getContext('2d'), dpr = Math.min(window.devicePixelRatio || 1, 2)
    let raf = 0, alive = true
    // (the desktop is zoomed by the interface size: the layer's own box is the space everything is laid out in)
    let W = 0, H = 0
    const size = () => { W = layer.current?.clientWidth || innerWidth; H = layer.current?.clientHeight || innerHeight; c.width = Math.round(W * dpr); c.height = Math.round(H * dpr) }
    size()
    const st = state.current
    const draw = now => {
      if (!alive) return
      if (!still && !document.hidden) raf = requestAnimationFrame(draw)
      if (!still && now - st.last < FRAME_MS) return
      st.last = now
      const t = now / 1000, w = W, h = H
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      g.globalCompositeOperation = light.current ? 'source-over' : 'lighter'
      const live = window.__ruyixActivity?.agents || []
      // where each is now: its rest, drifting a little
      for (const a of live) {
        const home = homeOf(a, w, h, live), ph = hash(a.id) * 6.28
        const p = still ? home : { x: home.x + Math.sin(t * 0.35 + ph) * 12, y: home.y + Math.cos(t * 0.28 + ph * 1.3) * 9 }
        st.pos.set(a.id, p)
        // a new thing it did: a ring going out
        const seen = st.seen.get(a.id)
        if (a.pulse?.at && a.pulse.at !== seen) { if (seen !== undefined) st.rings.push({ id: a.id, at: now, ok: a.pulse.ok !== false }); st.seen.set(a.id, a.pulse.at) }
      }
      // links: one task's agents together (a slow current), messages (beads running), a step handing over (a comet)
      for (const l of window.__ruyixActivity?.links || []) {
        const p = st.pos.get(l.from), q = st.pos.get(l.to)
        if (l.kind === 'handoff') { if (!st.flights.some(f => f.key === `${l.from}>${l.to}@${l.at}`)) st.flights.push({ key: `${l.from}>${l.to}@${l.at}`, from: p ? { ...p } : null, to: l.to, at: now }); continue }
        if (!p || !q) continue
        const col = COLOR[live.find(a => a.id === l.from)?.kind] || '#9fb0c2'
        g.strokeStyle = `${col}55`; g.lineWidth = 1.2
        g.setLineDash(l.kind === 'message' ? [2, 10] : [6, 8]); g.lineDashOffset = still ? 0 : -t * (l.kind === 'message' ? 40 : 14)
        g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke()
        g.setLineDash([])
        if (l.kind === 'message' && !still) {
          const f = (t * 0.6 + hash(l.from + l.to)) % 1
          g.drawImage(sprite(col, 10), p.x + (q.x - p.x) * f - 10, p.y + (q.y - p.y) * f - 10)
        }
      }
      // the lights
      for (const a of live) {
        const p = st.pos.get(a.id), col = COLOR[a.kind] || COLOR.system
        const waits = a.state === 'waiting'
        const breathe = still ? 1 : 1 + (waits ? 0.18 : 0.1) * Math.sin(t * (waits ? 2.2 : 3.1) + hash(a.id) * 9)
        const recent = a.pulse?.at ? Math.max(0, 1 - (Date.now() - a.pulse.at) / 1500) : 0
        const r = Math.round((waits ? 34 : 26) * breathe * (1 + 0.35 * recent))
        g.drawImage(sprite(col, 48), p.x - r * 1.85, p.y - r * 1.85, r * 3.7, r * 3.7)
        if (waits) { g.strokeStyle = `${col}aa`; g.lineWidth = 1.5; g.beginPath(); g.arc(p.x, p.y, 22 + (still ? 0 : 4 * Math.sin(t * 2.2)), 0, Math.PI * 2); g.stroke() }
      }
      // rings going out (a thing done), comets (a step handing over to the next)
      st.rings = st.rings.filter(rg => now - rg.at < 1100)
      for (const rg of st.rings) {
        const p = st.pos.get(rg.id)
        if (!p) continue
        const k = (now - rg.at) / 1100, col = rg.ok ? (COLOR[live.find(a => a.id === rg.id)?.kind] || '#ffffff') : '#ff6b6b'
        g.strokeStyle = `${col}${Math.round((1 - k) * 200).toString(16).padStart(2, '0')}`; g.lineWidth = 2 * (1 - k) + 0.5
        g.beginPath(); g.arc(p.x, p.y, 16 + k * 46, 0, Math.PI * 2); g.stroke()
      }
      st.flights = st.flights.filter(f => now - f.at < 1400)
      for (const f of st.flights) {
        const q = st.pos.get(f.to)
        if (!f.from || !q) continue
        const k = Math.min(1, (now - f.at) / 1200), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
        const x = f.from.x + (q.x - f.from.x) * e, y = f.from.y + (q.y - f.from.y) * e - Math.sin(e * Math.PI) * 60
        const col = COLOR[live.find(a => a.id === f.to)?.kind] || '#ffffff'
        for (let i = 0; i < 6; i++) { const b = Math.max(0, e - i * 0.03); g.globalAlpha = 1 - i / 6; g.drawImage(sprite(col, 14), f.from.x + (q.x - f.from.x) * b - 14, f.from.y + (q.y - f.from.y) * b - Math.sin(b * Math.PI) * 60 - 14) }
        g.globalAlpha = 1
        g.drawImage(sprite('#ffffff', 10), x - 10, y - 10)
      }
      g.globalCompositeOperation = 'source-over'
      // the chips follow their lights
      for (const [id, el] of chips.current) { const p = st.pos.get(id); if (p && el) el.style.transform = `translate(${p.x - 15}px, ${p.y - 15}px)` }
    }
    raf = requestAnimationFrame(draw)
    const onVis = () => { if (!document.hidden && !still) { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw) } }
    const onAct = () => { if (still) requestAnimationFrame(draw) }
    window.addEventListener('resize', size)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('ruyix:activity', onAct)
    return () => { alive = false; cancelAnimationFrame(raf); window.removeEventListener('resize', size); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('ruyix:activity', onAct) }
  }, [show, still])

  if (!show) return null
  const words = lang === 'zh'
    ? { waiting: '等你', working: '在做', kinds: { claude: 'Claude', codex: 'Codex', dsh: '智能体', model: '模型', system: '系统', person: '你来定' } }
    : { waiting: 'waiting for you', working: 'working on', kinds: { claude: 'Claude', codex: 'Codex', dsh: 'Agent', model: 'Model', system: 'System', person: 'Your turn' } }
  return (
    <div ref={layer} className="ad-agents" aria-label={lang === 'zh' ? '在干活的智能体' : 'Agents at work'}>
      <canvas ref={canvas} className="ad-agents-sky" aria-hidden="true" />
      {look !== 'light' && agents.map(a => (
        <button key={a.id} type="button" ref={el => { if (el) chips.current.set(a.id, el); else chips.current.delete(a.id) }}
          className={cx('ad-agent', `ad-agent-${a.kind}`, a.state === 'waiting' && 'ad-agent-wait')} style={{ '--ad-agent-c': COLOR[a.kind] || COLOR.system }}
          onClick={() => open?.(a.run, a.state === 'waiting' ? 'approvals' : 'pipeline')}>
          {look === 'face' ? <Face state={a.state} blink={a.pulse && Date.now() - a.pulse.at < 600} /> : <AgentIcon kind={a.kind} size={15} />}
          <span className="ad-agent-tip"><b>{a.kind === 'person' ? words.kinds.person : a.name || words.kinds[a.kind] || a.kind}</b>{a.state === 'waiting' ? words.waiting : words.working} · {a.stepTitle || a.step}<em>{a.title}</em></span>
        </button>
      ))}
    </div>
  )
}
