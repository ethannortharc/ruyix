// The studio pages' small parts: a dialog, the page's note at the bottom (with an undo), a delete that asks for a second
// click, times in words.
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

export const cx = (...c) => c.filter(Boolean).join(' ')

/** A dialog over the page: Esc or a click outside closes it; it stays solid however glassy the windows are. */
export function Dialog({ title, onClose, children, foot, wide = false }) {
  const box = useRef(null)
  useEffect(() => {
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', key, true)
    box.current?.querySelector('input, textarea, select, button:not(.st-dlg-x)')?.focus()
    return () => window.removeEventListener('keydown', key, true)
  }, [])
  return (
    <div className="st-scrim" onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={box} className={cx('st-dlg', wide && 'st-dlg-wide')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="st-dlg-head"><h2>{title}</h2><button type="button" className="st-dlg-x st-icon-btn" onClick={onClose} aria-label="×"><X size={15} /></button></div>
        <div className="st-dlg-body">{children}</div>
        {foot && <div className="st-dlg-foot">{foot}</div>}
      </div>
    </div>
  )
}

/** The page's note: one at a time, gone after a while; `action` (e.g. undo) a button in it. */
const NoteCtx = createContext(() => {})
export const useNote = () => useContext(NoteCtx)
export function NoteHost({ children }) {
  const [note, setNote] = useState(null)
  useEffect(() => { if (!note) return; const h = setTimeout(() => setNote(null), note.kind === 'error' ? 9000 : 5000); return () => clearTimeout(h) }, [note])
  return (
    <NoteCtx.Provider value={(text, kind = 'ok', action = null) => setNote({ text, kind, action, at: Date.now() })}>
      {children}
      {note && (
        <div key={note.at} className={cx('st-note', `st-note-${note.kind}`)} role="status">
          <span>{note.text}</span>
          {note.action && <button type="button" onClick={() => { note.action.run(); setNote(null) }}>{note.action.label}</button>}
        </div>
      )}
    </NoteCtx.Provider>
  )
}

/** Delete, on a second click within a few seconds. */
export function RemoveButton({ W, onRemove, small = false }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => { if (!armed) return; const h = setTimeout(() => setArmed(false), 3500); return () => clearTimeout(h) }, [armed])
  return (
    <button type="button" className={cx('st-btn', 'st-btn-quiet', armed && 'st-btn-danger', small && 'st-btn-sm')} onClick={() => (armed ? (setArmed(false), onRemove()) : setArmed(true))}>
      {armed ? W.removeAgain : W.remove}
    </button>
  )
}

export function Loading({ W }) { return <div className="st-quiet">{W.loading}</div> }
export function Failed({ W, error, retry }) {
  return <div className="st-quiet st-bad">{W.failed}{error?.message || String(error)}{retry && <button type="button" className="st-link" onClick={retry}>{W.retry}</button>}</div>
}

const pad = n => String(n).padStart(2, '0')
/** A time (ms) as the page shows it: 10月18日 14:30 (this year), 2025年10月18日 (another). */
export function whenText(ms, lang, withTime = true) {
  if (!ms) return ''
  const d = new Date(ms), same = d.getFullYear() === new Date().getFullYear()
  if (lang === 'zh') return `${same ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日${withTime ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''}`
  return d.toLocaleString('en', { month: 'short', day: 'numeric', ...(same ? {} : { year: 'numeric' }), ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) })
}
/** A date for <input type="date"> and the 'date' field: YYYY-MM-DD in local time. */
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
/** A time for <input type="datetime-local">, and back. */
export const localInput = ms => { if (!ms) return ''; const d = new Date(ms); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
export const fromLocalInput = s => (s ? new Date(s).getTime() : null)
