// The mark of a piece of work (docs/design/sessions.md §3), the same on every desk: a point of light and a ring of its
// steps. A step done lights its segment, the one at work has a light running along it, one waiting for the person is
// amber and blinks slowly, one gone wrong is red and broken; the point breathes while it works, flashes at each thing
// it does (its pulse) and grows a little with the work done (at most 1.3×); done, the ring closes and blooms once.
// Only the theme's colours (accent, amber, red, green), so it suits every theme and wallpaper. Read from the work list
// (../work.js); on the classic desk and the maps it heads each lane of the strip of the work going on (./strip.jsx).
import { useEffect, useState } from 'react'
import { workRegistry } from '../work.js'

const cx = (...c) => c.filter(Boolean).join(' ')
const TAU = Math.PI * 2
const arc = (a0, a1, r) => {
  const p = a => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`
  return `M${p(a0)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`
}
/** A step's state for a whole item with no steps of its own: one segment. */
const oneSeg = state => ({ st: state === 'done' ? 'done' : state === 'failed' ? 'fail' : state === 'waiting' ? 'wait' : state === 'working' ? 'run' : 'todo' })

/** The work list, as it changes (window.__ruyixWork: the most pressing first). */
export function useWork() {
  const [list, setList] = useState(() => workRegistry().get())
  useEffect(() => {
    const on = () => setList(workRegistry().get())
    window.addEventListener('ruyix:work', on); on()
    return () => window.removeEventListener('ruyix:work', on)
  }, [])
  return list
}
/** Open what a piece of work is (its own event: a run's process, a session's conversation…). */
export const openWork = w => { if (w?.open?.event) window.dispatchEvent(new CustomEvent(w.open.event, { detail: w.open.detail })) }

/** One piece of work's mark (an SVG `size` pixels across). */
export function WorkMark({ item, size = 36, label }) {
  const segs = item.segs?.length ? item.segs : [oneSeg(item.state)]
  const n = segs.length, gap = n > 1 ? Math.min(0.32, 1.4 / n) : 0
  const doneN = segs.filter(s => s.st === 'done' || s.st === 'skip').length
  const grow = 1 + 0.3 * Math.min(1, doneN / n) // it grows with the work done, at most 1.3×
  const fresh = item.state === 'done' && item.endedAt && Date.now() - item.endedAt < 6000
  return (
    <svg className={cx('wm', `wm-is-${item.state}`)} width={size} height={size} viewBox="-20 -20 40 40" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <g transform={`scale(${(grow * 0.86).toFixed(3)})`}>
        {fresh && <circle className="wm-bloom" r="15" />}
        {segs.map((s, i) => {
          const a0 = -TAU / 4 + (i / n) * TAU + gap / 2, a1 = a0 + TAU / n - gap, d = n === 1 ? null : arc(a0, a1, 15)
          const st = s.st === 'skip' ? 'done' : s.st || 'todo'
          return (
            <g key={i}>
              {d ? <path d={d} className={cx('wm-seg', `wm-${st}`)} /> : <circle r="15" className={cx('wm-seg', `wm-${st}`)} />}
              {st === 'run' && (d ? <path d={d} className="wm-light" pathLength="60" /> : <circle r="15" className="wm-light" pathLength="60" />)}
            </g>
          )
        })}
        {item.pulse?.at && <circle key={item.pulse.at} className="wm-pulse" r="6" />}
        <circle className="wm-dot" r={item.state === 'queued' ? 3 : 4.8} />
      </g>
      {/* waiting to talk it over with the person (a discussion step): a chat bubble pops up at its corner */}
      {item.state === 'waiting' && item.wait?.kind === 'chat' && (
        <g transform="translate(13 -13) scale(1.45)">
          <g className="wm-chat-pop"><g className="wm-chat-bob">
            <path className="wm-chat" d="M-3.5,-5.5 H3.5 A3.5,3.5 0 0 1 7,-2 V0.5 A3.5,3.5 0 0 1 3.5,4 H0 L-4.5,7.5 L-3,4 H-3.5 A3.5,3.5 0 0 1 -7,0.5 V-2 A3.5,3.5 0 0 1 -3.5,-5.5 Z" />
            {[-3, 0, 3].map(x => <circle key={x} className="wm-chat-dot" cx={x} cy="-0.75" r="0.95" />)}
          </g></g>
        </g>
      )}
    </svg>
  )
}
