// The changes an agent proposed for this Ruyix, waiting for the person (../surfaces.js): a card on every page — wherever the
// agent was asked (the assistant, the Chat page, a dsh session, a CLI agent) — with the newest one, what it changes, and
// Apply / Discard. Applying is the person's click; the page then reads the layout again, so the change shows at once.
// The list comes with the shell's poll of /api/ruyix/surfaces (window event 'ruyix:pending', main.jsx).
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronUp, Loader2, WandSparkles } from 'lucide-react'
import { TEXT } from './settings-text.js'

const cx = (...c) => c.filter(Boolean).join(' ')

/** A theme's colours (a change's `colours`: [token, light, dark]) as swatches — each half the colour in that mode. */
export const Swatches = ({ colours }) => (colours?.length ? (
  <div className="ruyix-swatches">{colours.map(([n, l, d]) => <span key={n} className="ruyix-swatch" title={`${n}: ${l} · ${d}`}><i style={{ background: l }} /><i style={{ background: d }} /><em>{n.replace('--ruyix-', '')}</em></span>)}</div>
) : null)

export function Pending({ locale }) {
  const lang = String(useSyncExternalStore(f => locale.subscribe(f), () => locale.getSnapshot().active) || 'en').startsWith('zh') ? 'zh' : 'en'
  const t = TEXT[lang].changes, err = TEXT[lang].err
  const [list, setList] = useState([]), [busy, setBusy] = useState(''), [open, setOpen] = useState(true), [said, setSaid] = useState(''), [problem, setProblem] = useState('')
  // Settings → Changes lists them already: the card steps aside while it is open (window.__ruyixChangesList, settings.jsx)
  const [listed, setListed] = useState(!!window.__ruyixChangesList)
  useEffect(() => { const on = () => setListed(!!window.__ruyixChangesList); window.addEventListener('ruyix:changes-list', on); return () => window.removeEventListener('ruyix:changes-list', on) }, [])
  // the shell's poll says what waits (ruyix:pending); a read of its own (at first, after a click) counts only if no newer word came
  const said0 = useState({ n: 0 })[0]
  const read = () => { const n = ++said0.n; fetch('api/ruyix/surfaces').then(r => r.json()).then(d => { if (n === said0.n) setList(d.pending || []) }, () => {}) }
  useEffect(() => {
    const on = e => { said0.n++; setList(e.detail?.pending || []) }
    window.addEventListener('ruyix:pending', on)
    read()
    return () => window.removeEventListener('ruyix:pending', on)
  }, [])
  useEffect(() => { if (!said) return; const id = setTimeout(() => setSaid(''), 2600); return () => clearTimeout(id) }, [said])
  // the one the person is looking at stays put while others come in (they queue behind it); its buttons are its own
  const [cur, setCur] = useState('')
  const x = list.find(p => p.id === cur) || list[0]
  useEffect(() => { if (x && x.id !== cur) setCur(x.id) }, [x?.id])
  // the poll carries no diffs: the one on the card is fetched whole (by its id)
  const [detail, setDetail] = useState(null), [tries, setTries] = useState(0), [failed, setFailed] = useState('')
  const d = detail?.id === x?.id ? detail : null
  useEffect(() => {
    if (!x?.id) return
    let live = true
    fetch(`api/ruyix/changes?id=${encodeURIComponent(x.id)}`).then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(v => { if (live && v?.id === x.id) { setDetail(v); setProblem(''); setFailed('') } }, e => { if (live) { setProblem(e.message); setFailed(x.id) } })
    return () => { live = false }
  }, [x?.id, tries])
  // a request that failed is asked again with the next poll (one still on its way is left to finish)
  useEffect(() => { if (!failed) return; const on = () => { setFailed(''); setTries(n => n + 1) }; window.addEventListener('ruyix:pending', on); return () => window.removeEventListener('ruyix:pending', on) }, [failed])
  // what the person applies is all of it, seen: a long change opens whole before its Apply shows
  const [full, setFull] = useState('')
  const long = !!d && d.diff.length > 6, seen = !!d && (!long || full === x?.id)
  const act = async (op, id, digest) => {
    setBusy(op); setProblem('')
    try {
      const res = await fetch('api/ruyix/changes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, id, ...(digest && { digest }) }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.error) throw Object.assign(new Error(d.params?.message || d.error || `HTTP ${res.status}`), { code: d.error })
      setSaid(t.done[op])
      window.dispatchEvent(new CustomEvent('ruyix:layout')) // the theme and the sidebar as they are now
    } catch (e) { setProblem(err[e.code] || e.message) }
    setBusy('')
    read()
  }
  const all = () => window.dispatchEvent(new CustomEvent('ruyix-settings:open', { detail: { tab: 'changes' } }))
  if ((!x && !said) || listed) return null
  return createPortal(
    <aside className="ruyix-pending" aria-label={x ? t.card.title(list.length) : said}>
      {!x ? <div className="ruyix-pending-said" role="status"><Check size={14} />{said}</div> : <>
        <button type="button" className="ruyix-pending-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <WandSparkles size={15} /><b>{t.card.title(list.length)}</b><span className="ruyix-pending-grow" />{open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        {open && <>
          <p className="ruyix-pending-sum" key={x.id}>{x.summary}</p>
          {d && <Swatches colours={d.colours} />}
          {d ? d.diff.length > 0 && <pre className={cx('ruyix-pending-diff', seen && long && 'ruyix-pending-full')}>{(seen ? d.diff : d.diff.slice(0, 6)).join('\n')}{seen ? '' : `\n… ${t.card.lines(d.diff.length - 6)}`}</pre>
            : <pre className="ruyix-pending-diff">…</pre>}
          {problem && <p className="ruyix-pending-problem" role="alert">{problem}</p>}
          <div className="ruyix-pending-actions" key={x.id}>
            {seen || !d
              ? <button type="button" className="ruyix-pending-btn ruyix-pending-primary" disabled={!!busy || !seen} onClick={() => act('apply', x.id, d?.digest)}>{busy === 'apply' && <Loader2 size={13} className="ruyix-pending-spin" />}{t.apply}</button>
              : <button type="button" className="ruyix-pending-btn ruyix-pending-primary" onClick={() => setFull(x.id)}>{t.card.review(d.diff.length)}</button>}
            <button type="button" className="ruyix-pending-btn" disabled={!!busy} onClick={() => act('discard', x.id)}>{t.discard}</button>
            <span className="ruyix-pending-grow" />
            <button type="button" className="ruyix-pending-link" onClick={all}>{list.length > 1 ? t.card.more(list.length - 1) : t.card.all}</button>
          </div>
        </>}
      </>}
    </aside>,
    document.body,
  )
}
