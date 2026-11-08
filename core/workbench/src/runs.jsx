// The runs: the list (rail) and one run — header, overview (the request, each step's result, the products), the steps
// (flow), the ledger, the report and the run's approvals.
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Archive, ArchiveRestore, Bot, ChevronDown, ChevronRight, Circle, Download, Flag, Languages, LifeBuoy, Loader2, Play, Scale, ShieldCheck, Square } from 'lucide-react'
import { baseId, call, exts, packOfRun, useEvidence, useExtVersion, useFullRun } from './data.js'
import { ApprovalCard, isOpenApproval } from './approvals.jsx'
import { Gallery, FileCard } from './gallery.jsx'
import { EvidenceDrawer, Ledger } from './ledger.jsx'
import { Process, outputOf } from './process.jsx'
import { ContinueDialog, FilesTab, RewindDialog, VersionChip } from './versions.jsx'
import { MessagesPanel, MessagesTab, useRunMessages } from './messages.jsx'
import { ResultsTab, useResults } from './results.jsx'
import { openedRun } from './open-things.js'
import { EvCtx, Md, RichText, StepOutput } from './rich.jsx'
import { TrCtx, targetFor, useTranslated, useTx } from './tr.js'
import { ACTIVE, Copyable, SST_ICON, T, StatusPill, TONE, VerdictPill, cx, dur, errorText, fileKind, mimeOfName, runTitle, stageIcon, runT, useT, useWorkflowData, verdictText, verdictTone, when, word, workflowName, optionLabel, optionDoes } from './ui.jsx'

// ── the list ────────────────────────────────────────────────────────────────
export const RAIL_SCOPES = ['active', 'all', 'archived']
export const inScope = (r, scope) => (scope === 'archived' ? !!r.archivedAt : scope === 'active' ? ACTIVE.has(r.status) && !r.archivedAt : !r.archivedAt)
const matches = (r, q, data) => `${runTitle(r, data)} ${r.id} ${r.subject?.text || ''} ${r.template}`.toLowerCase().includes(q)
// A list dot: blue (breathing) only while a run is going; a finished one by its verdict.
const railTone = (r, data) => (ACTIVE.has(r.status) ? TONE[r.status] : verdictTone(r, data))

export function RunRail({ runs, selected, onSelect, now, filter, query, onArchive }) {
  const t = useT()
  const data = useWorkflowData()
  const q = query.trim().toLowerCase()
  const list = runs.filter(r => inScope(r, filter) && (!q || matches(r, q, data)))
  if (!runs.length) return <div className="wb-empty-small">{t('run.empty')}</div>
  if (!list.length) return <div className="wb-empty-small">{t(filter === 'archived' ? 'run.noArchived' : filter === 'active' ? 'run.noActive' : 'run.noMatch')}</div>
  return (
    <div className="wb-runs">
      {list.map(r => {
        const stage = r.stages.find(s => s.key === r.stage)
        return (
          <div key={r.id} role="button" tabIndex={0} className={cx('wb-run-item', selected === r.id && 'wb-on', ACTIVE.has(r.status) && 'wb-run-live', `wb-t-${railTone(r, data)}`)}
            onClick={() => onSelect(r.id)} onKeyDown={e => e.key === 'Enter' && onSelect(r.id)}>
            <span className="wb-run-dot" />
            <span className="wb-run-main">
              <span className="wb-run-title">{runTitle(r, data)}</span>
              <span className="wb-run-meta">
                {ACTIVE.has(r.status)
                  ? <>{r.waiting === 'decision' ? <Scale size={11} /> : r.waiting === 'person' ? <LifeBuoy size={11} /> : <Loader2 size={11} className="wb-spin" />}{stage ? t(`stage.${stage.key}`) : t(`status.${r.status}`)} · {dur(now - r.createdAt)}</>
                  : <>{r.verdict?.level ? verdictText(t, r.verdict.level) : t(`status.${r.status}`)} · {t('ago', { t: dur(now - (r.endedAt || r.updatedAt)) })}</>}
                <span className="wb-tag">{workflowName(r, data)}</span>
              </span>
            </span>
            {!ACTIVE.has(r.status) && onArchive && (
              <button className="wb-icon-btn wb-run-archive" title={t(r.archivedAt ? 'run.unarchive' : 'run.archive')} onClick={e => { e.stopPropagation(); onArchive(r, !r.archivedAt) }}>
                {r.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── one run ─────────────────────────────────────────────────────────────────
export function RunView({ run, approvals, rev, now, toast, refresh, initialTab, initialFile, chosen = true, onArchive }) {
  const tAll = useT()
  const t = useMemo(() => runT(tAll, run), [tAll, run])
  const data = useWorkflowData()
  useExtVersion()
  // Agent-written text on this page, translated as one batch only when the user asks (the original shows meanwhile).
  const [trOn, setTrOn] = useState(false)
  const aiTexts = useMemo(() => [...run.stages.map(s => s.note || ''), ...(run.claims || []).map(c => c.text), run.error || '', run.verdict?.reason || ''], [run])
  const trTo = useMemo(() => targetFor(aiTexts.join(' ')), [aiTexts])
  const trLang = trOn ? trTo : 'off'
  const tr = useTranslated(aiTexts, trLang)
  // a finished run opens on its overview; a running one on its steps
  const [tab, setTab] = useState(initialTab || (ACTIVE.has(run.status) ? 'pipeline' : 'overview'))
  useEffect(() => { if (initialTab) setTab(initialTab) }, [initialTab])
  // shown: one of the things open (the desk keeps a run's things together)
  useEffect(() => { openedRun(run, tab) }, [run.id, tab])
  // a finished run the person opened has been seen (the desks' done place counts what has not) — one they picked or came
  // to by a link, not the one the page shows first by itself (`chosen`: false)
  useEffect(() => { if (chosen && !ACTIVE.has(run.status) && !run.seenAt) call('markSeen', { ids: [run.id] }).catch(() => {}) }, [run.id, run.status, run.seenAt, chosen])
  const [focus, setFocus] = useState(null) // evidence filter from a step
  const [open, setOpen] = useState(null) // evidence seq in the drawer
  const [files, setFiles] = useState(null) // the files tab's focus: { commit } or { path }
  const [steer, setSteer] = useState(null) // { kind: rewind | continue, step }: the dialog to steer the run from a step
  const [chain, setChain] = useState(null)
  const evidence = useEvidence(run.id, rev)
  const full = useFullRun(run)
  // what the agents said to each other (a workflow that lets them): a tab of its own once it says something, or may
  const said = useRunMessages(run.id, ACTIVE.has(run.status) || tab === 'messages')
  // what it made (its 结果 steps' files, else what it changed): a tab of its own once there is something
  const [results, reloadResults] = useResults(full)
  // Cards still waiting for you first, then running, then the history, newest first.
  const apRank = a => ({ pending: 0, failed: 0, running: 1 })[a.status] ?? 2
  const mine = approvals.filter(a => a.runId === run.id).sort((x, y) => apRank(x) - apRank(y) || (y.createdAt || 0) - (x.createdAt || 0))
  const openDecisions = mine.filter(a => a.action === 'decision' && isOpenApproval(a))
  const openHelp = mine.find(a => a.action === 'help' && isOpenApproval(a))
  const pending = run.archivedAt ? 0 : mine.filter(isOpenApproval).length
  useEffect(() => { setChain(null) }, [run.id, evidence.length])
  const act = async (op, after) => {
    try { const r = await call(op, { id: run.id }); after?.(r); refresh() } catch (err) { toast('error', errorText(t, err)) }
  }
  const verify = async () => { setChain('checking'); try { setChain(await call('verify', { id: run.id })) } catch (err) { setChain(null); toast('error', errorText(t, err)) } }
  const showStage = key => { setFocus(key); setTab('evidence') }
  const showFiles = f => { setFiles(f); setTab('files') }
  const ev = useMemo(() => { const seqs = new Set(evidence.map(e => e.seq)); return { has: n => seqs.has(n), open: setOpen } }, [evidence])
  const boxes = exts()[packOfRun(run)]?.runBoxes || []
  const from = run.stages.find(st => st.status !== 'passed' && st.status !== 'skipped')
  return (
    <T.Provider value={t}>
    <TrCtx.Provider value={tr}>
    <EvCtx.Provider value={ev}>
    <div className="wb-view">
      <div className="wb-run-head">
        <div className="wb-run-head-main">
          <div className="wb-chips">
            <span className="wb-tag">{workflowName(run, data)}</span>
            <StatusPill status={run.status} />
            {run.verdict?.level !== run.status && <VerdictPill run={run} />}
          </div>
          <h2>{runTitle(run, data)}</h2>
          <div className="wb-sub">
            <span className="wb-mono">{run.id}</span>
            <span>· {when(run.createdAt)}</span>
            <span>· {t('run.elapsed', { t: dur((run.endedAt || now) - run.createdAt) })}</span>
            {run.jobId && <span>· {t('run.job', { id: run.jobId })}</span>}
            <button className="wb-tr-btn" onClick={() => setTrOn(v => !v)} title={t('tr.hint')}>
              {tr.busy ? <Loader2 size={11} className="wb-spin" /> : <Languages size={11} />}{trOn ? t('tr.original') : t('tr.to', { lang: trTo === 'zh' ? '中文' : 'English' })}
            </button>
          </div>
          {/* a decision only the person can make: said where they look first, until it is made */}
          {openDecisions.length > 0 && (
            <div className={cx('wb-note', run.waiting === 'decision' ? 'wb-t-amber' : 'wb-t-muted')}>
              <Scale size={13} /> {t(run.waiting === 'decision' ? 'dec.waiting' : 'dec.open', { n: openDecisions.length, q: openDecisions[0].title })}
              <button className="wb-btn wb-small" onClick={() => setTab('approvals')}>{t('dec.decide')}</button>
            </div>
          )}
          {/* a step that asks the person (a person step, or one that asked on its own): the run waits at it — said first, until it is answered */}
          {openHelp && (
            <div className="wb-note wb-t-amber">
              <LifeBuoy size={13} /> {t('help.waiting', { step: word(t, `stage.${openHelp.payload?.stage}`, openHelp.payload?.stage || ''), q: openHelp.title })}
              <button className="wb-btn wb-small" onClick={() => setTab('approvals')}>{t('help.answer')}</button>
            </div>
          )}
          {run.archivedAt && <div className="wb-note wb-t-muted"><Archive size={13} /> {t('run.archivedNote', { t: when(run.archivedAt) })}</div>}
          {run.error && <div className="wb-note wb-t-red"><AlertTriangle size={13} /> {run.interruptedBy === 'restart' && run.status === 'interrupted' ? t('run.restarted') : tr.tx(run.error)}</div>}
          {trOn && tr.error && <div className="wb-note wb-t-red"><Languages size={13} /> {t('tr.failed', { error: tr.error })}</div>}
          <div className="wb-actions wb-run-actions">
            {ACTIVE.has(run.status) && <button className="wb-btn wb-danger" onClick={() => window.confirm(t('run.stopConfirm')) && act('stopRun')}><Square size={13} />{t('run.stop')}</button>}
            {['interrupted', 'failed', 'cancelled'].includes(run.status) && (
              <button className="wb-btn wb-primary" title={t('run.resumeHint')} onClick={() => act('resumeRun', r => toast('ok', t('run.resumed', { stage: t(`stage.${r.from}`) })))}><Play size={13} />{from ? t('run.resumeFrom', { stage: t(`stage.${from.key}`) }) : t('run.resume')}</button>
            )}
            <button className="wb-btn" onClick={verify}><ShieldCheck size={13} />{t('run.verify')}</button>
            {!ACTIVE.has(run.status) && onArchive && <button className="wb-btn" title={t(run.archivedAt ? 'run.unarchiveHint' : 'run.archiveHint')} onClick={() => onArchive(run, !run.archivedAt)}>{run.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}{t(run.archivedAt ? 'run.unarchive' : 'run.archive')}</button>}
          </div>
          {chain && (chain === 'checking'
            ? <span className="wb-sub">{t('chain.checking')}</span>
            : <span className={cx('wb-chain', chain.ok ? 'wb-t-green' : 'wb-t-red')}>{chain.ok ? t('chain.ok', { n: chain.count, head: chain.head.slice(0, 12) }) : t('chain.broken', chain)}</span>)}
        </div>
      </div>
      {boxes.length > 0 && <div className="wb-run-info"><div className="wb-run-facts">{boxes.map((Box, i) => <Box key={i} run={run} approvals={mine} />)}</div></div>}
      <div className="wb-tabs">
        {['overview', 'pipeline', ...(results?.files.length || results?.declared ? ['results'] : []), 'files', 'evidence', ...(said?.on || said?.messages.length ? ['messages'] : []), 'report', 'approvals'].map(k => (
          <button key={k} className={cx(tab === k && 'wb-on')} onClick={() => { setTab(k); if (k !== 'evidence') setFocus(null) }}>
            {t(`tab.${k}`)}
            {k === 'evidence' && <span className="wb-count">{evidence.length}</span>}
            {k === 'messages' && said.messages.length > 0 && <span className="wb-count">{said.messages.length}</span>}
            {k === 'results' && results.files.length > 0 && <span className="wb-count">{results.files.length}</span>}
            {k === 'approvals' && pending > 0 && <span className="wb-badge">{pending}</span>}
          </button>
        ))}
      </div>
      <div className="wb-tab-body">
        {tab === 'overview' && <Overview run={full} evidence={evidence} onEvidence={setOpen} onTab={setTab} onFiles={showFiles} />}
        {tab === 'pipeline' && <Process run={full} evidence={evidence} now={now} onStage={showStage} onEvidence={setOpen} onFiles={showFiles} onApprovals={() => setTab('approvals')}
          onRewind={step => setSteer({ kind: 'rewind', step })} onContinue={step => setSteer({ kind: 'continue', step })} claims={<Claims run={run} onEvidence={setOpen} />} talk={<MessagesPanel data={said} onFiles={showFiles} />} approvals={mine} />}
        {tab === 'results' && <ResultsTab run={full} data={results} reload={reloadResults} toast={toast} initialFile={initialFile} />}
        {tab === 'files' && <FilesTab run={full} focus={files} toast={toast} onContinue={step => setSteer({ kind: 'continue', step })} />}
        {tab === 'messages' && <MessagesTab data={said} onFiles={showFiles} />}
        {tab === 'evidence' && <Ledger run={run} evidence={evidence} focus={focus} setFocus={setFocus} onOpen={setOpen} />}
        {tab === 'report' && <Report run={run} rev={run.updatedAt} trLang={trLang} />}
        {tab === 'approvals' && (mine.length ? <div className="wb-cards">{mine.map(a => <ApprovalCard key={a.id} a={a} run={run} toast={toast} refresh={refresh} />)}</div> : <div className="wb-empty-small">{t('ap.none')}</div>)}
      </div>
      {open && <EvidenceDrawer run={run} evidence={evidence} seq={open} onOpen={setOpen} onClose={() => setOpen(null)} />}
      {steer?.kind === 'rewind' && <RewindDialog run={run} step={steer.step} toast={toast} onClose={() => setSteer(null)} onDone={() => { refresh(); setTab('pipeline') }} />}
      {steer?.kind === 'continue' && <ContinueDialog run={run} step={steer.step} steps={run.stages.map(s => s.key)} toast={toast} onClose={() => setSteer(null)} onDone={() => { refresh(); setTab('pipeline') }} />}
    </div>
    </EvCtx.Provider>
    </TrCtx.Provider>
    </T.Provider>
  )
}

// ── overview: the request, what each step handed back, the products ──
/** A field's value in words: a boolean yes / no, a choice by its label. */
const fieldText = (t, v, f) => {
  const label = x => { const o = (f?.options || []).find(o => String(o && typeof o === 'object' ? o.value : o) === String(x)); return o && typeof o === 'object' ? o.label ?? o.value : x }
  return Array.isArray(v) ? v.map(label).join(', ') : typeof v === 'boolean' ? t(v ? 'yes' : 'no') : String(label(v))
}

function Overview({ run, evidence, onEvidence, onTab, onFiles }) {
  const t = useT()
  const { tx } = useTx()
  const data = useWorkflowData()
  const subject = run.subject || {}
  const input = data?.builtIn?.find(b => b.id === baseId(run))?.input || []
  const fields = Object.entries(subject.fields || {}).filter(([, v]) => v !== '' && v !== undefined && !(Array.isArray(v) && !v.length))
  const attachments = (subject.attachments || []).map(a => ({ seq: a.evidence, name: a.name, mime: a.mime, kind: fileKind(a.name, a.mime || mimeOfName(a.name)), size: a.size }))
  const steps = run.stages.filter(s => !['pending', 'skipped'].includes(s.status) || run.stage === s.key)
  const tone = verdictTone(run, data)
  const lead = run.verdict?.reason || (run.verdict?.level ? '' : ACTIVE.has(run.status) ? t(`status.${run.status}`) : '')
  return (
    <div className="wb-ov">
      <section className={cx('wb-ov-tldr', `wb-t-${tone}`)}>
        {run.verdict?.level ? <VerdictPill run={run} /> : <StatusPill status={run.status} />}
        <span> <RichText text={tx(lead)} /></span>
      </section>

      <section className="wb-card">
        <h3><Flag size={14} />{t('ov.request')}</h3>
        <p className="wb-ov-title">{subject.title || '—'}</p>
        {subject.text && <Md text={subject.text} />}
        {fields.length > 0 && (
          <dl className="wb-fields">
            {fields.map(([k, v]) => <div key={k}><dt>{input.find(f => f.name === k)?.label || k}</dt><dd>{fieldText(t, v, input.find(f => f.name === k))}</dd></div>)}
          </dl>
        )}
        {run.note && <p className="wb-sub wb-block"><b>{t('run.note')}</b> {run.note}</p>}
        {attachments.length > 0 && (
          <>
            <h4 className="wb-sub">{t('ov.attachments', { n: attachments.length })}</h4>
            <div className="wb-gallery-grid">{attachments.map(f => <FileCard key={f.seq || f.name} run={run} f={f} onOpen={f.seq ? onEvidence : undefined} />)}</div>
          </>
        )}
      </section>

      <section className="wb-card">
        <h3><Bot size={14} />{t('ov.steps')}<button className="wb-linkbtn wb-push" onClick={() => onTab('pipeline')}>{t('ov.allSteps')}</button></h3>
        <ol className="wb-ov-steps">
          {steps.map(s => {
            const Icon = SST_ICON[s.status] || Circle, out = outputOf(run, s)
            return (
              <li key={s.key} className={cx('wb-ov-step', `wb-s-${s.status}`)}>
                <div className="wb-ov-step-top">
                  <Icon size={14} className={cx('wb-ov-step-icon', s.status === 'running' && 'wb-spin')} />
                  <b>{t(`stage.${s.key}`)}</b>
                  <span className="wb-owner">{s.owner === 'system' ? t('owner.system') : <><Bot size={11} />{s.owner}</>}</span>
                  <span className={cx('wb-sst', `wb-s-${s.status}`)}>{t(`sst.${s.status}`)}</span>
                  {s.startedAt && <span className="wb-sub">{dur((s.endedAt || Date.now()) - s.startedAt)}</span>}
                  <VersionChip version={s.version} onOpen={() => onFiles({ commit: s.version.commit })} />
                </div>
                {s.note && <div className="wb-step-hint"><RichText text={tx(s.note)} /></div>}
                {out && <div className="wb-ov-step-out"><StepOutput value={out} /></div>}
              </li>
            )
          })}
        </ol>
      </section>

      <Gallery run={run} evidence={evidence} onOpen={onEvidence} />

      {run.decisions?.length > 0 && (
        <section className="wb-card">
          <h3><Scale size={14} />{t('ov.decisions')}</h3>
          <ul className="wb-list">{run.decisions.map((d, i) => <li key={i}>{d.question} → <b>{optionLabel(t, d.label)}</b>{d.does && <span className="wb-sub"> — {optionDoes(t, d)}</span>}</li>)}</ul>
        </section>
      )}
    </div>
  )
}

/** What the agents claimed, each with the ledger entries that back it. */
function Claims({ run, onEvidence }) {
  const t = useT()
  const { tx } = useTx()
  if (!run.claims?.length) return null
  return (
    <section className="wb-card">
      <h3><Flag size={14} />{t('claims')}</h3>
      <ul className="wb-claims">
        {run.claims.map(c => (
          <li key={c.id}>
            <span className="wb-tag">{word(t, `claim.${c.type}`, c.type)}</span> <RichText text={tx(c.text)} />
            <span className="wb-sub"> — {c.actor} · {c.evidence.map(n => <button key={n} className="wb-linkbtn" onClick={() => onEvidence(n)}>#{n}</button>)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ── report ──
const reportMemo = new Map() // run + language + report hash → translated Markdown
function Report({ run, rev, trLang }) {
  const t = useT()
  const [orig, setOrig] = useState(null)
  const [translated, setTranslated] = useState(null)
  const [trBusy, setTrBusy] = useState(false)
  const [trError, setTrError] = useState('')
  useEffect(() => { if (run.report) call('report', { id: run.id }).then(r => setOrig(r.markdown), () => setOrig('')) }, [run.id, rev, run.report])
  // The translation loads beside the original, which stays readable until it arrives.
  useEffect(() => {
    setTranslated(null); setTrError('')
    if (!run.report || trLang === 'off') return
    const key = `${run.id}|${trLang}|${run.reportSha256}`
    if (reportMemo.has(key)) { setTranslated(reportMemo.get(key)); return }
    let alive = true
    setTrBusy(true)
    call('translateReport', { id: run.id, lang: trLang })
      .then(r => { reportMemo.set(key, r.markdown); if (alive) setTranslated(r.markdown) }, err => alive && setTrError(err.message))
      .finally(() => alive && setTrBusy(false))
    return () => { alive = false; setTrBusy(false) }
  }, [run.id, rev, run.report, trLang])
  if (!run.report) return <div className="wb-empty-small">{t('report.empty')}</div>
  const md = translated ?? orig
  if (md === null) return <div className="wb-empty-small">{t('loading')}</div>
  const download = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
    a.download = `${run.id}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  return (
    <div className="wb-report">
      <div className="wb-actions">
        {trBusy && <span className="wb-sub"><Loader2 size={12} className="wb-spin" /> {t('tr.working')}</span>}
        {trError && <span className="wb-sub wb-t-red">{t('tr.failed', { error: trError })}</span>}
        <Copyable text={md} label={t('report.copy')} />
        <button className="wb-btn wb-small" onClick={download}><Download size={13} />{t('report.download')}</button>
      </div>
      <Md text={md} />
    </div>
  )
}
