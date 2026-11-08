// A browser a run opened (lib/browser.js), live on its page: the screen comes up a couple of times a second; clicks, the
// wheel and keys go down; Chinese (an input method) and pastes go through the line under it. The person checks what a
// step or a card filled in, and does the last click themselves.
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, Globe, Loader2, Maximize2, Minimize2, RotateCw, Send, X } from 'lucide-react'
import { call } from './data.js'
import { closedWeb, openedWeb } from './open-things.js'
import { cx, errorText, useT } from './ui.jsx'

const CONTROL_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

/** One browser, live. `onClosed()`: it is not open any more. */
export function LiveBrowser({ session, run = null, runTitle = null, onClosed }) {
  const t = useT()
  const [st, setSt] = useState(null)
  const [frame, setFrame] = useState('')
  const [error, setError] = useState('')
  const [big, setBig] = useState(false)
  const [line, setLine] = useState('')
  const seq = useRef(-1), img = useRef(null), pad = useRef(null)
  useEffect(() => {
    let alive = true, timer = null
    const poll = async () => {
      try {
        const r = await call('browserState', { session, since: seq.current })
        if (!alive) return
        if (r.frame) { setFrame(r.frame); seq.current = r.seq }
        setSt(r); setError('')
        if (r.status !== 'open' && r.status !== 'starting') { onClosed?.(r); return }
      } catch (err) { if (alive) { setError(errorText(t, err)); if (err.code === 'noBrowser') { onClosed?.(null); return } } }
      if (alive) timer = setTimeout(poll, document.hidden ? 2000 : 450)
    }
    poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [session])
  // one input at a time, in order; text typed meanwhile goes together in the next
  const queue = useRef([]), sending = useRef(false)
  const send = input => {
    const q = queue.current, last = q[q.length - 1]
    if (input.type === 'text' && last?.type === 'text') last.text += input.text
    else q.push({ ...input })
    if (sending.current) return
    sending.current = true
    ;(async () => {
      while (q.length) {
        try {
          const r = await call('browserInput', { session, ...q.shift() })
          if (r?.frame && r.seq > seq.current) { setFrame(r.frame); seq.current = r.seq }
        } catch (err) { setError(errorText(t, err)) }
      }
      sending.current = false
    })()
  }
  const at = e => {
    const r = img.current.getBoundingClientRect(), v = st?.view || { width: 1280, height: 860 }
    return { x: Math.round((e.clientX - r.left) * v.width / r.width), y: Math.round((e.clientY - r.top) * v.height / r.height) }
  }
  const onKey = e => {
    if (e.target !== pad.current || e.ctrlKey || e.metaKey || e.altKey || e.nativeEvent.isComposing) return
    if (e.key.length === 1) { e.preventDefault(); send({ type: 'text', text: e.key }) } else if (CONTROL_KEYS.has(e.key)) { e.preventDefault(); send({ type: 'key', key: e.key }) }
  }
  const open = st?.status === 'open'
  // while open, one of the things open (its site the hint; a run's under that run); closed, gone from them
  useEffect(() => { if (open) openedWeb(session, run, { title: st?.title, url: st?.url, runTitle }); else if (st) closedWeb(session) }, [open, st?.url, st?.title, session, run, runTitle])
  const sendLine = () => { if (line) { send({ type: 'text', text: line }); setLine('') } }
  const body = (
    <div className={cx('wb-live', big && 'wb-live-big', open && 'wb-live-on')}>
      <div className="wb-live-bar">
        <span className={cx('wb-live-dot', open ? 'wb-t-green' : 'wb-t-muted')} />
        <Globe size={13} />
        <b className="wb-live-title">{st?.title || t('br.browser')}</b>
        {st?.step && open && <span className="wb-live-step"><Loader2 size={11} className="wb-spin" />{st.step}</span>}
        <span className="wb-push" />
        <button className="wb-icon-btn" title={t('br.back')} disabled={!open} onClick={() => send({ type: 'back' })}><ArrowLeft size={14} /></button>
        <button className="wb-icon-btn" title={t('br.reload')} disabled={!open} onClick={() => send({ type: 'reload' })}><RotateCw size={14} /></button>
        <button className="wb-icon-btn" title={t(big ? 'br.small' : 'br.big')} onClick={() => setBig(v => !v)}>{big ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
        {open && <button className="wb-icon-btn" title={t('br.close')} onClick={() => call('browserClose', { session }).catch(err => setError(errorText(t, err)))}><X size={14} /></button>}
      </div>
      <div className="wb-live-url wb-mono">{st?.url || '…'}</div>
      {st?.done && <div className="wb-note wb-t-green"><CheckCircle2 size={13} /> {st.done.text || t('br.done')}</div>}
      {st?.note && !open && <div className="wb-note wb-t-muted">{st.note}</div>}
      {error && <div className="wb-note wb-t-red">{error}</div>}
      <div ref={pad} className="wb-live-screen" tabIndex={0} onKeyDown={onKey}
        onPaste={e => { const text = e.clipboardData.getData('text'); if (text && open) { e.preventDefault(); send({ type: 'text', text }) } }}>
        {frame ? <img ref={img} src={frame} alt="" draggable={false} className={cx(!open && 'wb-live-off')}
          onClick={e => { if (!open) return; pad.current?.focus(); send({ type: 'click', ...at(e) }) }}
          onWheel={e => open && send({ type: 'wheel', ...at(e), dy: e.deltaY })} />
          : <div className="wb-live-wait"><Loader2 size={18} className="wb-spin" /> {t('br.starting')}</div>}
      </div>
      {open && (
        <div className="wb-live-type">
          <input className="wb-input" value={line} placeholder={t('br.typeHint')} onChange={e => setLine(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); sendLine() } }} />
          <button className="wb-btn wb-small" disabled={!line} onClick={sendLine}><Send size={12} />{t('br.type')}</button>
          <button className="wb-btn wb-small" onClick={() => send({ type: 'key', key: 'Enter' })}>⏎</button>
        </div>
      )}
      <p className="wb-sub">{t(open ? 'br.hint' : 'br.closed')}</p>
    </div>
  )
  return big ? <div className="wb-modal-wrap wb-live-wrap" onClick={() => setBig(false)}><div onClick={e => e.stopPropagation()}>{body}</div></div> : body
}

/** The browsers a run has open, each live (the run's page shows them under "now"); `only`: just these sessions. */
export function RunBrowsers({ run, only }) {
  const [list, setList] = useState([])
  useEffect(() => {
    let alive = true, timer = null
    const poll = async () => {
      try { const r = await call('browsers', { id: run.id }); if (alive) setList(r.browsers || []) } catch { /* a page without the op */ }
      if (alive) timer = setTimeout(poll, 3000)
    }
    poll()
    return () => { alive = false; clearTimeout(timer) }
  }, [run.id])
  const shown = list.filter(b => (only ? only.includes(b.id) : b.status === 'open'))
  if (!shown.length) return null
  return <div className="wb-live-list">{shown.map(b => <LiveBrowser key={b.id} session={b.id} run={run.id} runTitle={run.subject?.title || run.template || null} />)}</div>
}
