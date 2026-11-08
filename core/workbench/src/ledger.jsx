// The evidence ledger of a run: the proof first (claims and what they cite), then step by step, then every entry; and the
// drawer that opens one entry — what was asked, what came back, the file itself, and the hashes that chain it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bot, CheckCircle2, ChevronDown, ChevronRight, Circle, Download, FileText, Flag, Languages, Loader2, ScrollText, Stamp, Terminal, X, XCircle, Zap } from 'lucide-react'
import { call, fileUrl, local } from './data.js'
import { fileOf } from './gallery.jsx'
import { Md, RichText, Structured } from './rich.jsx'
import { targetFor } from './tr.js'
import { dateLoc, Copyable, Pill, STAGE_ICON, cx, errorText, useT, word } from './ui.jsx'

const KIND_ICON = { command: Terminal, file: FileText, snapshot: ScrollText, agent: Bot, model: Zap, gate: Flag, approval: Stamp }
const kindName = (t, k) => word(t, `kind.${k}`, k)
const stageName = (t, k) => word(t, `stage.${k}`, k)

/** What cites each evidence entry: the run's claims. */
const citations = run => {
  const by = new Map()
  for (const c of run.claims || []) for (const n of c.evidence || []) by.set(Number(n), [...(by.get(Number(n)) || []), { kind: c.type, text: c.text, actor: c.actor }])
  return by
}

function EvRow({ e, onOpen }) {
  const t = useT()
  const Icon = KIND_ICON[e.kind] || FileText
  return (
    <button className={cx('wb-evrow', e.ok === false && 'wb-bad')} onClick={() => onOpen(e.seq)}>
      <span className="wb-mono wb-dim">#{e.seq}</span>
      <span className="wb-kind"><Icon size={12} />{kindName(t, e.kind)}</span>
      <span className="wb-ev-title">{e.title}</span>
      {e.ok === false ? <XCircle size={13} className="wb-c-red" /> : e.ok ? <CheckCircle2 size={13} className="wb-c-green" /> : null}
    </button>
  )
}
const EvRows = ({ seqs, byseq, onOpen }) => <div className="wb-evrows">{[...new Set(seqs.map(Number))].map(n => byseq.get(n)).filter(Boolean).map(e => <EvRow key={e.seq} e={e} onOpen={onOpen} />)}</div>

/** The claims, by type, each with the entries it cites. */
function KeyEvidence({ run, evidence, byseq, onOpen, showAll }) {
  const t = useT()
  const claims = run.claims || []
  const types = [...new Set(claims.map(c => c.type))]
  const cited = citations(run)
  const uncited = evidence.filter(e => !cited.has(e.seq)).length
  if (!claims.length) return <p className="wb-sub">{t('kev.none')} <button className="wb-linkbtn" onClick={showAll}>{t('kev.showAll')}</button></p>
  return (
    <div className="wb-keyev">
      {types.map(type => {
        const list = claims.filter(c => c.type === type)
        return (
          <section key={type} className="wb-card">
            <h3><Flag size={14} />{word(t, `claim.${type}`, type)}<span className="wb-count">{list.length}</span></h3>
            <ul className="wb-proofs">{list.map(c => (
              <li key={c.id} className="wb-proof">
                <div><span className="wb-tag">{c.actor}</span> <span><RichText text={c.text} /></span></div>
                <EvRows seqs={c.evidence || []} byseq={byseq} onOpen={onOpen} />
              </li>
            ))}</ul>
          </section>
        )
      })}
      {uncited > 0 && <p className="wb-sub">{t('kev.uncited', { n: uncited })} <button className="wb-linkbtn" onClick={showAll}>{t('kev.showAll')}</button></p>}
    </div>
  )
}

/** Step by step: each step's entries, folded. */
function StageEvidence({ run, evidence, byseq, onOpen }) {
  const t = useT()
  const [open, setOpen] = useState(() => new Set())
  const order = [...run.stages.map(s => s.key), ...new Set(evidence.map(e => e.stage).filter(k => k && !run.stages.some(s => s.key === k)))]
  return (
    <div className="wb-stage-ev">
      {order.map(key => {
        const list = evidence.filter(e => e.stage === key)
        if (!list.length) return null
        const s = run.stages.find(x => x.key === key)
        const kinds = Object.entries(list.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] || 0) + 1 }), {}))
        const bad = list.filter(e => e.ok === false).length
        const on = open.has(key)
        const Icon = STAGE_ICON[key] || Circle
        return (
          <section key={key} className={cx('wb-card wb-stage-ev-card', s && `wb-s-${s.status}`)}>
            <button className="wb-stage-ev-head" onClick={() => setOpen(x => { const n = new Set(x); n.has(key) ? n.delete(key) : n.add(key); return n })}>
              {on ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <Icon size={14} /><b>{stageName(t, key)}</b>
              {s && <span className="wb-owner">{s.owner === 'system' ? t('owner.system') : <><Bot size={11} />{s.owner}</>}</span>}
              <span className="wb-count">{list.length}</span>
              <span className="wb-chips">{kinds.map(([k, n]) => <span key={k} className="wb-tag">{kindName(t, k)} {n}</span>)}{bad > 0 && <Pill tone="red">{t('ev.failedN', { n: bad })}</Pill>}</span>
            </button>
            {on && <EvRows seqs={list.map(e => e.seq)} byseq={byseq} onOpen={onOpen} />}
          </section>
        )
      })}
    </div>
  )
}

export function Ledger({ run, evidence, focus, setFocus, onOpen }) {
  const t = useT()
  const [mode, setMode] = useState(() => (focus ? 'all' : local.get('ruyix-workbench.ledgerMode', 'key')))
  const [kind, setKind] = useState('all')
  useEffect(() => { if (focus) setMode('all') }, [focus])
  const pick = m => { setMode(m); local.set('ruyix-workbench.ledgerMode', m); if (m !== 'all') setFocus(null) }
  const byseq = useMemo(() => new Map(evidence.map(e => [e.seq, e])), [evidence])
  const kinds = [...new Set(evidence.map(e => e.kind))]
  const list = evidence.filter(e => (kind === 'all' || e.kind === kind) && (!focus || e.stage === focus))
  if (!evidence.length) return <div className="wb-empty-small">{t('ev.empty')}</div>
  return (
    <div className="wb-ledger">
      <div className="wb-ledger-top">
        <div className="wb-seg">{['key', 'stages', 'all'].map(m => <button key={m} className={cx(mode === m && 'wb-on')} onClick={() => pick(m)}>{t(`ev.mode.${m}`)}</button>)}</div>
        <span className="wb-sub">{t(`ev.mode.${mode}.hint`)}</span>
      </div>
      {mode === 'key' && <KeyEvidence run={run} evidence={evidence} byseq={byseq} onOpen={onOpen} showAll={() => pick('all')} />}
      {mode === 'stages' && <StageEvidence run={run} evidence={evidence} byseq={byseq} onOpen={onOpen} />}
      {mode === 'all' && (
        <>
          <div className="wb-filters">
            {['all', ...kinds].map(k => <button key={k} className={cx('wb-chip', kind === k && 'wb-on')} onClick={() => setKind(k)}>{k === 'all' ? t('ev.all') : kindName(t, k)}</button>)}
            {focus && <button className="wb-chip wb-on" onClick={() => setFocus(null)}>{stageName(t, focus)} <X size={11} /></button>}
          </div>
          <table className="wb-table wb-ledger-table">
            <tbody>
              {list.map(e => {
                const Icon = KIND_ICON[e.kind] || FileText
                return (
                  <tr key={e.seq} onClick={() => onOpen(e.seq)} className={cx(e.ok === false && 'wb-bad')}>
                    <td className="wb-mono wb-dim">{e.seq}</td>
                    <td className="wb-dim">{new Date(e.at).toLocaleTimeString(dateLoc(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                    <td><span className="wb-kind"><Icon size={12} />{kindName(t, e.kind)}</span></td>
                    <td className="wb-dim">{e.stage ? stageName(t, e.stage) : ''}</td>
                    <td className="wb-dim">{e.actor}</td>
                    <td className="wb-ev-title">{e.title}</td>
                    <td>{e.ok === false ? <XCircle size={13} className="wb-c-red" /> : e.ok ? <CheckCircle2 size={13} className="wb-c-green" /> : null}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

export function EvidenceDrawer({ run, evidence, seq, onOpen, onClose }) {
  const t = useT()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [shown, setShown] = useState(null)
  const [trBusy, setTrBusy] = useState(false)
  const translation = useRef(0)
  const [raw, setRaw] = useState(false)
  const at = evidence.findIndex(e => e.seq === seq)
  const prev = evidence[at - 1]?.seq, next = evidence[at + 1]?.seq
  const cites = useMemo(() => citations(run).get(seq) || [], [run, seq])
  const file = at >= 0 ? fileOf(evidence[at]) : null
  // a video or an audio file streams from the file route: its bytes are never read into the page
  const streamed = file && ['video', 'audio'].includes(file.kind)
  const translate = async () => {
    if (shown) { setShown(null); return }
    const request = ++translation.current
    setTrBusy(true)
    try { const r = await call('translate', { texts: [data.content], lang: targetFor(data.content) }); if (request === translation.current) setShown(r.texts[0]) } catch (err) { if (request === translation.current) setError(err.message) }
    if (request === translation.current) setTrBusy(false)
  }
  useEffect(() => {
    let off = false // paging fast: an older answer arriving late must not show under this number
    ++translation.current; setTrBusy(false)
    setData(null); setShown(null); setError('')
    if (streamed) setData({ evidence: evidence[at], content: '' })
    else call('artifact', { id: run.id, seq }).then(d => off || setData(d), err => off || setError(errorText(t, err)))
    return () => { off = true; ++translation.current }
  }, [run.id, seq, streamed])
  useEffect(() => {
    const k = e => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && prev && !/INPUT|TEXTAREA/.test(e.target.tagName)) onOpen(prev)
      else if (e.key === 'ArrowRight' && next && !/INPUT|TEXTAREA/.test(e.target.tagName)) onOpen(next)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose, onOpen, prev, next])
  const e = data?.evidence
  const text = shown || data?.content || ''
  return (
    <div className="wb-drawer-wrap" onClick={onClose}>
      <aside className="wb-drawer" onClick={ev => ev.stopPropagation()}>
        <div className="wb-drawer-head">
          <button className="wb-icon-btn" disabled={!prev} onClick={() => onOpen(prev)} title={t('ev.prevItem')}><ArrowLeft size={15} /></button>
          <span className="wb-mono wb-dim">#{seq}</span>
          <button className="wb-icon-btn" disabled={!next} onClick={() => onOpen(next)} title={t('ev.nextItem')}><ArrowRight size={15} /></button>
          <h3>{e?.title || t('loading')}</h3>
          <button className="wb-icon-btn" onClick={onClose} title={t('close')}><X size={16} /></button>
        </div>
        {error && <div className="wb-note wb-t-red">{error}</div>}
        {e && (
          <div className="wb-drawer-body">
            <div className="wb-chips">
              <span className="wb-kind">{kindName(t, e.kind)}</span>
              {e.stage && <span className="wb-tag">{stageName(t, e.stage)}</span>}
              <span className="wb-tag">{e.actor}</span>
              <span className="wb-tag">{new Date(e.at).toLocaleString(dateLoc())}</span>
              {e.code !== null && e.code !== undefined && <span className="wb-tag">code {e.code}</span>}
              {e.ok === false && <Pill tone="red">{t('ev.failed')}</Pill>}
            </div>
            {cites.length > 0 && (
              <section className="wb-cites">
                <h4>{t('ev.citedBy')}</h4>
                <ul className="wb-list">{cites.map((c, i) => <li key={i}><span className="wb-tag">{word(t, `claim.${c.kind}`, c.kind)}</span> <RichText text={c.text} /> <span className="wb-dim">— {c.actor}</span></li>)}</ul>
              </section>
            )}
            {e.input && <><h4>{t('ev.input')}</h4><Structured value={e.input} /></>}
            {file && <div className="wb-drawer-file">
              {file.kind === 'video' && <video className="wb-shot" controls preload="metadata" src={fileUrl(run.id, seq)} />}
              {file.kind === 'audio' && <audio className="wb-file-audio" controls preload="metadata" src={fileUrl(run.id, seq)} />}
              <a className="wb-btn wb-small" href={fileUrl(run.id, seq, true)}><Download size={12} />{t('gal.download')}</a>
            </div>}
            {data.image
              ? <img className="wb-shot" src={data.image} alt={e.title} />
              : streamed ? null : (
                <>
                  <h4>{e.artifact ? t('ev.artifact') : t('ev.output')} <span className="wb-actions">
                    {e.kind === 'agent' && <button className="wb-btn wb-small" onClick={() => setRaw(!raw)}><FileText size={12} />{raw ? t('fields.pretty') : t('ev.raw')}</button>}
                    {['agent', 'gate'].includes(e.kind) && <button className="wb-btn wb-small" disabled={trBusy} onClick={translate}>{trBusy ? <Loader2 size={12} className="wb-spin" /> : <Languages size={12} />}{shown ? t('tr.original') : t('tr.to', { lang: targetFor(data?.content) === 'zh' ? '中文' : 'English' })}</button>}
                    <Copyable text={text} />
                  </span></h4>
                  {(e.kind === 'agent' || file?.kind === 'markdown') && !raw ? <div className="wb-drawer-md"><Md text={text} /></div> : <pre className="wb-pre wb-pre-tall">{text || '—'}</pre>}
                </>
              )}
            <dl className="wb-hashes">
              {e.sha256 && <><dt>sha256</dt><dd className="wb-mono">{e.sha256}</dd></>}
              <dt>{t('ev.hash')}</dt><dd className="wb-mono">{e.hash}</dd>
              <dt>{t('ev.prev')}</dt><dd className="wb-mono">{e.prev || '—'}</dd>
            </dl>
          </div>
        )}
      </aside>
    </div>
  )
}
