// A run as it happens: the flow of its steps (where it is, what is done, what failed, what it went back over), what is
// going on right now, each step's own story — who worked on it, what it did (the ledger's entries as they come in), the
// files it changed (its version) and its result — and, on each step, the ways to steer: back to before it, on from it.
// A time chart beside: when each step ran, how long it waited for the person.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, ChevronRight, Circle, Clock, Cog, FileText, Flag, Folder, Hourglass, LifeBuoy, ListTree, MessagesSquare, Play, RotateCcw, Scale, Stamp, Terminal, Undo2, Wrench, Zap } from 'lucide-react'
import { VersionChip } from './versions.jsx'
import { RunBrowsers } from './browser.jsx'
import { RichText, StepOutput } from './rich.jsx'
import { useTx } from './tr.js'
import { dateLoc, ACTIVE, SST_ICON, cx, dur, modelText, stageIcon, useT, word, optionLabel } from './ui.jsx'

/** A step's result for the page: what a step of the person's own handed back, else the step's `stage_result`. */
export const outputOf = (run, s) => {
  const v = run.outputs?.[s.key] ?? s.result
  return v === true || v === undefined || v === null || v === '' ? null : v
}
const KIND_ICON = { command: Terminal, file: FileText, agent: Bot, model: Zap, gate: Flag, approval: Stamp, tool: Wrench, version: Undo2, snapshot: ListTree }
const kindName = (t, k) => word(t, `kind.${k}`, k)
/** The cards a step held the run for (a decision, a question for the person): each with when it was asked and answered. */
const waitsOf = (approvals, key) => (approvals || []).filter(a => a.payload?.stage === key && ['decision', 'help'].includes(a.action) && (a.payload?.blocking || a.action === 'help'))
const openCard = a => ['pending', 'failed'].includes(a.status)
/** Where a step stands, beyond its status: at work but waiting for the person (a card of its is open). */
const stateOf = (run, s, approvals) => (s.status === 'running' && (s.asking || waitsOf(approvals, s.key).some(openCard)) && run.status === 'waiting' ? 'waiting' : s.status)

/**
 * A script step's own steps, as its journal has them: each turn of a loop its own, its tries, the one that failed and why;
 * one a resumed run answered from the record says so. Its phases and log lines under them.
 */
export function FlowSteps({ flow, now }) {
  const t = useT()
  const [log, setLog] = useState(false)
  const lines = (flow.events || []).filter(e => e.type === 'log' || e.type === 'phase')
  return (
    <div className="wb-flow">
      <ol className="wb-flow-steps">
        {flow.steps.map(x => {
          const St = SST_ICON[x.status] || Circle
          return (
            <li key={x.key} className={cx('wb-flow-step', `wb-s-${x.status}`)} title={x.error || undefined}>
              <St size={11} className={x.status === 'running' ? 'wb-spin' : ''} />
              <span className="wb-flow-title">{x.title}</span>
              {x.branch && <span className="wb-tag wb-mono" title={t('flow.branchHint')}>{x.branch}</span>}
              {x.attempts > 1 && <span className="wb-tag" title={t('flow.tries', { n: x.attempts, max: x.retries + 1 })}>×{x.attempts}</span>}
              {x.replays > 0 && <span className="wb-tag" title={t('flow.replayedHint')}>{t('flow.replayed')}</span>}
              {x.calls?.length > 0 && <span className="wb-sub">{[...new Set(x.calls)].map(c => t(`flow.call.${c}`)).join(' · ')}</span>}
              {x.startedAt && <span className="wb-sub">{dur((x.endedAt || (x.status === 'running' ? now : x.startedAt)) - x.startedAt)}</span>}
              {x.error && x.status === 'failed' && <span className="wb-flow-error">{x.error}</span>}
            </li>
          )
        })}
      </ol>
      <div className="wb-sub">
        {flow.where && <span title={t(`flow.where.${flow.where}.hint`)}>{t(`flow.where.${flow.where}`)}</span>}
        {lines.length > 0 && <button className="wb-linkbtn" onClick={() => setLog(v => !v)}>{t('flow.log', { n: lines.length })}</button>}
      </div>
      {log && <ul className="wb-flow-log">{lines.map((e, i) => <li key={i} className={cx(e.type === 'phase' && 'wb-flow-phase')}>{e.type === 'phase' ? e.title : e.message}</li>)}</ul>}
    </div>
  )
}

// ── the flow: every step a node, the one at work alive, what was done again marked ──
function FlowMap({ run, now, onPick, approvals }) {
  const t = useT()
  const done = run.stages.filter(s => ['passed', 'skipped'].includes(s.status)).length
  const total = run.stages.length
  const live = ACTIVE.has(run.status)
  return (
    <div className="wb-map">
      <div className={cx('wb-map-count', live && 'wb-map-live')}>
        <svg viewBox="0 0 36 36" aria-hidden="true"><circle className="wb-map-track" cx="18" cy="18" r="15.5" /><circle className="wb-map-fill" cx="18" cy="18" r="15.5" style={{ strokeDasharray: `${(done / Math.max(total, 1)) * 97.4} 97.4` }} /></svg>
        <span><b>{done}</b>/{total}</span>
      </div>
      <ol className="wb-map-line">
        {run.stages.map((s, i) => {
          const st = stateOf(run, s, approvals)
          const Icon = st === 'waiting' ? LifeBuoy : stageIcon(s.key, s.owner !== 'system')
          const rounds = (s.history || []).length
          const prev = run.stages[i - 1]
          // the line into a step: done when the step before it is; alive into the one at work
          const into = !prev ? null : st === 'running' || st === 'waiting' ? 'live' : ['passed', 'failed', 'skipped'].includes(s.status) ? 'done' : 'todo'
          const time = s.startedAt ? dur((s.endedAt || (s.status === 'running' ? now : s.startedAt)) - s.startedAt) : ''
          return (
            <li key={s.key} className={cx('wb-map-node', `wb-m-${st}`, into && `wb-into-${into}`)}>
              <button onClick={() => onPick(s.key)} title={`${t(`stage.${s.key}`)} · ${t(`sst.${st === 'waiting' ? 'waiting' : s.status}`)}${s.note ? `\n${String(s.note).slice(0, 200)}` : ''}`}>
                <span className="wb-map-dot"><Icon size={14} /></span>
                {rounds > 0 && <span className="wb-map-round" title={t('proc.rounds', { n: rounds + 1 })}><RotateCcw size={9} />{rounds + 1}</span>}
                <small className="wb-map-name">{t(`stage.${s.key}`)}</small>
                <small className="wb-map-time">{time || ' '}</small>
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ── now: what is going on this moment ──
function NowStrip({ run, evidence, now, onApprovals, onPick, approvals }) {
  const t = useT()
  const { tx } = useTx()
  const working = run.stages.filter(s => s.status === 'running')
  if (!ACTIVE.has(run.status)) return null
  if (!working.length) return <div className="wb-now wb-t-muted"><Hourglass size={14} /><span>{t(`status.${run.status}`)}</span></div>
  return (
    <div className="wb-now-list">
      {working.map(s => {
        const waits = stateOf(run, s, approvals) === 'waiting'
        const last = [...evidence].reverse().find(e => e.stage === s.key)
        const who = s.agent && s.owner !== 'system' ? [s.agent.id, modelText(s.agent)].filter(Boolean).join(' · ') : s.owner === 'system' ? t('owner.system') : s.owner
        return (
          <div key={s.key} className={cx('wb-now', waits ? 'wb-t-amber' : 'wb-t-blue')}>
            <span className="wb-now-pulse" />
            <button className="wb-now-step" onClick={() => onPick(s.key)}><b>{t(`stage.${s.key}`)}</b></button>
            <span className="wb-now-who">{s.owner !== 'system' ? <Bot size={12} /> : <Cog size={12} />}{who}</span>
            <span className="wb-now-time"><Clock size={12} />{dur(now - (s.startedAt || now))}</span>
            {waits
              ? <span className="wb-now-last"><LifeBuoy size={12} />{t(run.waiting === 'decision' ? 'proc.waitDecision' : 'proc.waitPerson')}<button className="wb-btn wb-small" onClick={onApprovals}>{t(run.waiting === 'decision' ? 'dec.decide' : 'help.answer')}</button></span>
              : last && <span className="wb-now-last" key={last.seq}>{(() => { const I = KIND_ICON[last.kind] || Circle; return <I size={12} /> })()}<RichText text={tx(String(last.title).slice(0, 160))} /><span className="wb-dim">{t('ago', { t: dur(now - last.at) })}</span></span>}
          </div>
        )
      })}
    </div>
  )
}

// ── a step's activity: the ledger's entries of the step, as they come in ──
function Activity({ list, live, onEvidence, now }) {
  const t = useT()
  const { tx } = useTx()
  const [all, setAll] = useState(false)
  const shown = all ? list : list.slice(-6)
  if (!list.length) return null
  return (
    <ol className={cx('wb-act', live && 'wb-act-live')}>
      {!all && list.length > shown.length && <li className="wb-act-more"><button className="wb-linkbtn" onClick={() => setAll(true)}>{t('proc.earlier', { n: list.length - shown.length })}</button></li>}
      {shown.map(e => {
        const Icon = KIND_ICON[e.kind] || Circle
        return (
          <li key={e.seq} className={cx('wb-act-item', e.ok === false && 'wb-act-bad', `wb-act-${e.kind}`)}>
            <button onClick={() => onEvidence(e.seq)}>
              <span className="wb-act-icon"><Icon size={11} /></span>
              <span className="wb-act-kind">{kindName(t, e.kind)}</span>
              <span className="wb-act-title"><RichText text={tx(String(e.title).slice(0, 220))} /></span>
              <span className="wb-act-at">{live ? t('ago', { t: dur(now - e.at) }) : new Date(e.at).toLocaleTimeString(dateLoc(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
/** A step's entries in a line: 3 commands · 1 agent · 2 tools. */
const tally = (t, list) => Object.entries(list.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] || 0) + 1 }), {})).map(([k, n]) => `${n} ${kindName(t, k)}`).join(' · ')

// ── one step ──
function StepCard({ run, s, n, evidence, now, open, onToggle, onEvidence, onStage, onFiles, onRewind, onContinue, approvals }) {
  const t = useT()
  const { tx } = useTx()
  const st = stateOf(run, s, approvals)
  const Icon = st === 'waiting' ? LifeBuoy : stageIcon(s.key, s.owner !== 'system')
  const St = SST_ICON[s.status] || Circle
  const out = outputOf(run, s)
  const mine = useMemo(() => evidence.filter(e => e.stage === s.key), [evidence, s.key])
  const ran = s.status !== 'pending' || (s.history || []).length > 0
  const base = s.version?.base || (s.history || []).findLast?.(h => h.version?.base)?.version?.base
  const live = s.status === 'running'
  const who = s.agent && s.owner !== 'system' ? [s.agent.id, modelText(s.agent)].filter(Boolean).join(' · ') : null
  return (
    <li id={`wb-step-${s.key}`} className={cx('wb-pstep', `wb-s-${s.status}`, st === 'waiting' && 'wb-s-waiting', open && 'wb-open')}>
      <span className="wb-pstep-rail"><span className="wb-pstep-icon"><Icon size={15} /></span></span>
      <div className="wb-pstep-body">
        <div className="wb-pstep-top">
          <button className="wb-pstep-title" onClick={onToggle} aria-expanded={open}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className="wb-pstep-n">{n}</span><b>{t(`stage.${s.key}`)}</b>
          </button>
          <span className="wb-owner">{s.owner === 'system' ? t('owner.system') : <><Bot size={11} />{s.owner}{who && <span className="wb-dim"> · {who}</span>}</>}</span>
          {s.session && (
            // the resident session it ran in (a workflow with sessions): its conversation on Agent Hub's 会话 page
            <button className="wb-tag wb-tag-btn" title={t('proc.inSessionHint', { id: s.session })} onClick={() => window.dispatchEvent(new CustomEvent('agent-hub:open', { detail: { tab: 'sessions', session: s.session } }))}>
              <MessagesSquare size={10} />{t('proc.inSession', { id: s.session })}
            </button>
          )}
          {(s.history || []).length > 0 && <span className="wb-tag" title={t('proc.rounds', { n: s.history.length + 1 })}><RotateCcw size={10} />{s.history.length + 1}</span>}
          <span className={cx('wb-sst', `wb-s-${st === 'waiting' ? 'waiting' : s.status}`)}>{st === 'waiting' ? <LifeBuoy size={12} /> : <St size={12} className={live ? 'wb-spin' : ''} />}{t(`sst.${st === 'waiting' ? 'waiting' : s.status}`)}</span>
          {s.startedAt && <span className="wb-sub">{dur((s.endedAt || (live ? now : s.startedAt)) - s.startedAt)}</span>}
          <VersionChip version={s.version} onOpen={() => onFiles({ commit: s.version.commit })} />
        </div>
        {s.note && <div className="wb-step-hint"><RichText text={tx(s.note)} /></div>}
        {s.flow?.steps?.length > 0 && <FlowSteps flow={s.flow} now={now} />}
        {(live || open) && <Activity list={mine} live={live} onEvidence={onEvidence} now={now} />}
        {!live && !open && mine.length > 0 && <button className="wb-linkbtn wb-pstep-tally" onClick={onToggle}>{tally(t, mine)}</button>}
        {open && (
          <div className="wb-pstep-detail">
            {s.version?.files?.length > 0 && (
              <div className="wb-pstep-files">
                <span className="wb-sub">{t('proc.changed')}</span>
                {s.version.files.slice(0, 12).map(f => <button key={f.path} className="wb-file-pill" onClick={() => onFiles({ path: f.path, commit: s.version.commit })}><span className={cx('wb-ver-st', `wb-ver-st-${f.status}`)}>{f.status}</span>{f.path}</button>)}
                {(s.version.files.length > 12 || s.version.more) && <button className="wb-linkbtn" onClick={() => onFiles({ commit: s.version.commit })}>{t('proc.moreFiles', { n: s.version.files.length - 12 + (s.version.more || 0) })}</button>}
              </div>
            )}
            {s.version?.big?.length > 0 && <div className="wb-sub">{t('ver.bigList', { files: s.version.big.join(', ') })}</div>}
            {out && <StepOutput value={out} />}
            {s.history?.length > 0 && (
              <ol className="wb-rounds">{s.history.map((h, i) => (
                <li key={i}>{t('stage.round', { n: (h.round || 0) + 1 })} · {t(`sst.${h.status}`)}{h.note && <small> — {String(h.note).slice(0, 200)}</small>}
                  {h.version?.commit && <> <VersionChip version={h.version} onOpen={() => onFiles({ commit: h.version.commit })} /></>}</li>
              ))}</ol>
            )}
            <div className="wb-pstep-actions">
              {ran && base && <button className="wb-btn wb-small" onClick={() => onRewind(s.key)} title={t('proc.rewindHint')}><Undo2 size={12} />{t('proc.rewind')}</button>}
              {(ran || !ACTIVE.has(run.status)) && <button className="wb-btn wb-small" onClick={() => onContinue(s.key)} title={t('proc.continueHint')}><Play size={12} />{t('proc.continue')}</button>}
              {s.version?.files?.length > 0 && <button className="wb-btn wb-small" onClick={() => onFiles({ path: s.version.files[0].path, commit: s.version.commit })} title={t('proc.editHint')}><Folder size={12} />{t('proc.edit')}</button>}
              {mine.length > 0 && <button className="wb-linkbtn" onClick={() => onStage(s.key)}>{t('stage.evidence', { n: mine.length })}</button>}
            </div>
          </div>
        )}
      </div>
    </li>
  )
}

// ── time: when each step ran, how long it waited for the person ──
function TimeChart({ run, now, onPick, approvals }) {
  const t = useT()
  const start = run.createdAt, end = Math.max(run.endedAt && !ACTIVE.has(run.status) ? run.endedAt : now, start + 1000)
  const span = end - start
  const pct = x => `${Math.max(0, Math.min(100, ((x - start) / span) * 100))}%`
  const width = (a, b) => `${Math.max(0.6, Math.min(100, ((b - a) / span) * 100))}%`
  const rows = run.stages.filter(s => s.startedAt || (s.history || []).some(h => h.startedAt))
  if (!rows.length) return null
  return (
    <section className="wb-card wb-time">
      <h3><Clock size={14} />{t('proc.time')}<span className="wb-push wb-sub">{dur(span)}</span></h3>
      <div className="wb-time-rows">
        {rows.map(s => (
          <button key={s.key} className="wb-time-row" onClick={() => onPick(s.key)}>
            <span className="wb-time-name">{t(`stage.${s.key}`)}</span>
            <span className="wb-time-track">
              {(s.history || []).filter(h => h.startedAt).map((h, i) => <span key={i} className={cx('wb-time-bar', 'wb-time-old', `wb-s-${h.status}`)} style={{ left: pct(h.startedAt), width: width(h.startedAt, h.endedAt || h.startedAt) }} />)}
              {s.startedAt && <span className={cx('wb-time-bar', `wb-s-${stateOf(run, s, approvals)}`)} style={{ left: pct(s.startedAt), width: width(s.startedAt, s.endedAt || (s.status === 'running' ? now : s.startedAt)) }} />}
              {waitsOf(approvals, s.key).map(w => { const until = openCard(w) ? now : w.decidedAt || w.doneAt || w.createdAt; return <span key={w.id} className="wb-time-wait" style={{ left: pct(w.createdAt), width: width(w.createdAt, until) }} title={`${w.title}\n${t('proc.waited', { t: dur(until - w.createdAt) })}`} /> })}
            </span>
          </button>
        ))}
      </div>
      <div className="wb-time-key"><span><i className="wb-time-bar wb-s-passed" />{t('proc.keyRan')}</span><span><i className="wb-time-wait" />{t('proc.keyWait')}</span><span><i className="wb-time-bar wb-time-old wb-s-passed" />{t('proc.keyEarlier')}</span></div>
    </section>
  )
}

/** The process tab. `onFiles(focus)`: to the files tab, on a version or a file. */
export function Process({ run, evidence, now, onStage, onEvidence, onFiles, onApprovals, onRewind, onContinue, claims, talk, approvals }) {
  const t = useT()
  const [open, setOpen] = useState(() => new Set(run.stages.filter(s => s.status === 'running' || s.status === 'failed').map(s => s.key)))
  // a step that starts working opens by itself (the one before it stays as the person left it)
  const seen = useRef(new Set())
  useEffect(() => {
    const running = run.stages.filter(s => s.status === 'running' && !seen.current.has(`${s.key}:${s.attempt}`))
    if (!running.length) return
    for (const s of running) seen.current.add(`${s.key}:${s.attempt}`)
    setOpen(o => new Set([...o, ...running.map(s => s.key)]))
  }, [run.stages])
  const toggle = key => setOpen(o => { const n = new Set(o); n.has(key) ? n.delete(key) : n.add(key); return n })
  const pick = key => { setOpen(o => new Set(o).add(key)); requestAnimationFrame(() => document.getElementById(`wb-step-${key}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })) }
  return (
    <div className="wb-process">
      <FlowMap run={run} now={now} onPick={pick} approvals={approvals} />
      <NowStrip run={run} evidence={evidence} now={now} onApprovals={onApprovals} onPick={pick} approvals={approvals} />
      <RunBrowsers run={run} />
      <div className="wb-pipeline">
        <ol className="wb-psteps">
          {run.stages.map((s, i) => (
            <StepCard key={s.key} run={run} s={s} n={i + 1} evidence={evidence} now={now} open={open.has(s.key)} onToggle={() => toggle(s.key)} approvals={approvals}
              onEvidence={onEvidence} onStage={onStage} onFiles={onFiles} onRewind={onRewind} onContinue={onContinue} />
          ))}
        </ol>
        <div className="wb-side">
          <TimeChart run={run} now={now} onPick={pick} approvals={approvals} />
          {run.decisions?.length > 0 && (
            <section className="wb-card">
              <h3><Scale size={14} />{t('ov.decisions')}</h3>
              <ul className="wb-list">{run.decisions.map((d, i) => <li key={i}>{d.question} → <b>{optionLabel(t, d.label)}</b></li>)}</ul>
            </section>
          )}
          {claims}
          {talk}
        </div>
      </div>
    </div>
  )
}
