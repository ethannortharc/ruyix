// Approval cards (a person's go-ahead before anything leaves the machine) and the inbox's list of them. A pack that
// registered a review card for an action (window.__ruyixWorkbenchExt[pack].approvals[action].Body) gets it in the card;
// any other action gets the generic card: title, note, the payload to edit, approve / reject. A decision card
// (`decision`, asked by an agent, an approval step or a person step's review / choice) lists its options; a person
// step's ask (`help`: an answer it needs, something to do outside) takes the answer, or a note that it is done. A step
// that asked on its own (its agent, a low confidence, stuck) also takes "run it again with this", and the person may ask
// its agent about it first.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bot, CheckCircle2, ClipboardCheck, Clock, ExternalLink, Globe, Hand, Info, LifeBuoy, Loader2, MessageSquare, MessagesSquare, Play, RotateCcw, Scale, Send, Stamp, Undo2, XCircle, X } from 'lucide-react'
import { approvalExt, call, decisionEditor, useExtVersion } from './data.js'
import { ReviewEditor } from './review.jsx'
import { LiveBrowser } from './browser.jsx'
import { RichText, Structured } from './rich.jsx'
import { overdue } from './inbox.js'
import { Pill, cx, dur, errorText, runTitle, useT, useWorkflowData, word, optionLabel, optionDoes } from './ui.jsx'

export const isOpenApproval = a => a.status === 'pending' || a.status === 'failed'
/** Approvals of archived runs leave the inbox (and the badge) until the run is restored. */
export const liveApprovals = (approvals, runs) => approvals.filter(a => !runs.get(a.runId)?.archivedAt)
/** The approvals that still need a person: open, on a run that is not archived. */
export const awaiting = (approvals, runs) => liveApprovals(approvals, runs).filter(isOpenApproval)

const AP_TONE = { pending: 'amber', running: 'blue', done: 'green', failed: 'red', rejected: 'muted', superseded: 'muted' }
const str = v => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

/** A decision's options: what each does, the recommended one marked; one is picked (and shown once decided). */
export function DecisionPicker({ options, recommended, value, onChange, disabled }) {
  const t = useT()
  return (
    <div className="wb-decide">
      {options.map((o, i) => (
        <label key={i} className={cx('wb-decide-opt', value === i && 'wb-on', disabled && 'wb-off')}>
          <input type="radio" checked={value === i} disabled={disabled} onChange={() => onChange?.(i)} />
          <span>
            <b>{optionLabel(t, o.label)}</b>{i === recommended && <span className="wb-tag wb-t-green">{t('dec.recommended')}</span>}
            <span className="wb-tag">{t(`dec.act.${o.action}`, { step: o.from ? t(`stage.${o.from}`) : '' })}</span>
            {o.does && <span className="wb-sub wb-block">{optionDoes(t, o)}</span>}
          </span>
        </label>
      ))}
    </div>
  )
}

/**
 * The generic card's form: every field of the payload, a string in a text box, a boolean a tick, a number a number
 * box, anything else (an object, a list) as JSON. → what to send: only the fields the person changed (parsed), or
 * an error text while a JSON field does not parse.
 */
function PayloadForm({ payload, disabled, onChange }) {
  const t = useT()
  const keys = Object.keys(payload || {})
  const [vals, setVals] = useState(() => Object.fromEntries(keys.map(k => [k, typeof payload[k] === 'string' ? payload[k] : typeof payload[k] === 'object' && payload[k] !== null ? JSON.stringify(payload[k], null, 2) : payload[k]])))
  const [bad, setBad] = useState({})
  useEffect(() => {
    const out = {}, errs = {}
    for (const k of keys) {
      const was = payload[k], v = vals[k]
      if (typeof was === 'string') { if (v !== was) out[k] = v } else if (typeof was === 'boolean' || typeof was === 'number') { if (v !== was) out[k] = v } else if (v !== (was !== null && typeof was === 'object' ? JSON.stringify(was, null, 2) : was)) {
        try { out[k] = JSON.parse(v) } catch { errs[k] = true }
      }
    }
    setBad(errs)
    onChange(Object.keys(errs).length ? null : out)
  }, [vals])
  if (!keys.length) return null
  const set = (k, v) => setVals(x => ({ ...x, [k]: v }))
  return (
    <div className="wb-payload">
      {keys.map(k => {
        const was = payload[k]
        return (
          <div key={k} className="wb-payload-field">
            <label className="wb-label">{word(t, `key.${k}`, k)}</label>
            {typeof was === 'boolean' ? <label className="wb-check"><input type="checkbox" checked={!!vals[k]} disabled={disabled} onChange={e => set(k, e.target.checked)} />{t(vals[k] ? 'yes' : 'no')}</label>
              : typeof was === 'number' ? <input className="wb-input" type="number" value={vals[k] ?? ''} disabled={disabled} onChange={e => set(k, e.target.value === '' ? '' : Number(e.target.value))} />
                : typeof was === 'string' && !was.includes('\n') && was.length <= 90 ? <input className="wb-input" value={vals[k]} disabled={disabled} onChange={e => set(k, e.target.value)} />
                  : <textarea className={cx('wb-input', typeof was !== 'string' && 'wb-mono', bad[k] && 'wb-bad-input')} rows={Math.min(18, Math.max(3, String(vals[k] ?? '').split('\n').length + 1))} value={vals[k] ?? ''} disabled={disabled} onChange={e => set(k, e.target.value)} />}
            {bad[k] && <p className="wb-sub wb-c-red">{t('ap.badJson')}</p>}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A discussion's thread (docs/design/agent-work.md §7: a chat step, or a talk its step's agent asked for): what the person
 * said and the agent's replies, newest at the foot, and the box to write in (Enter sends; Shift+Enter a new line).
 */
function TalkThread({ a, open, busy, text, setText, onSend, withName }) {
  const t = useT()
  const end = useRef(null)
  const chat = a.chat || []
  const thinking = chat.some(x => !x.answer && !x.error)
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }) }, [chat.length, chat.at(-1)?.answer])
  return (
    <div className="wb-talk">
      {!chat.length && open && <p className="wb-sub wb-talk-hint">{t(withName ? 'talk.hintWith' : 'talk.hint', { step: withName })}</p>}
      {chat.map(q => (
        <div key={q.n} className="wb-talk-turn">
          <div className="wb-talk-me">{q.q}</div>
          {q.answer ? <div className="wb-talk-it"><Bot size={14} /><div><RichText text={q.answer} /></div></div>
            : q.error ? <div className="wb-talk-it wb-t-red"><XCircle size={14} /><span>{t('help.agentFailed', { error: q.error })}</span></div>
              : <div className="wb-talk-it wb-talk-wait"><Loader2 size={14} className="wb-spin" /><span>{t('talk.thinking')}</span></div>}
        </div>
      ))}
      <div ref={end} />
      {open && <div className="wb-talk-ask">
        <textarea className="wb-input" rows={2} value={text} placeholder={t('talk.ph')} disabled={busy} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && text.trim() && !thinking) { e.preventDefault(); onSend() } }} />
        <button className="wb-btn wb-primary" disabled={busy || thinking || !text.trim()} onClick={onSend} title={t('talk.sendHint')}><Send size={13} />{t('talk.send')}</button>
      </div>}
    </div>
  )
}

export function ApprovalCard({ a, run, toast, refresh, onRun }) {
  const t = useT()
  const data = useWorkflowData()
  const extVersion = useExtVersion()
  const found = useMemo(() => approvalExt(a.action, run), [a.action, run?.template, run?.workflowDef, extVersion])
  const ext = found?.ext
  // a decision may come with a pack's editor (payload.editor): the person changes what is decided on, then chooses
  // (a review's is the workbench's own: lib/review.js, src/review.jsx)
  const editor = useMemo(() => (a.action !== 'decision' ? null : a.payload?.editor === 'workbench.review' ? { packId: 'workbench', Editor: ReviewEditor } : decisionEditor(a.payload?.editor)), [a.payload?.editor, extVersion])
  const [editorPayload, setEditorPayload] = useState(undefined)
  const [editorBlocked, setEditorBlocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [choice, setChoice] = useState(a.payload?.recommended ?? null) // a decision card's option
  const [comment, setComment] = useState('') // what the person says with a choice that sends the run back
  const [edited, setEdited] = useState({}) // the generic card's changed fields (null: a field is not valid yet)
  const [extPayload, setExtPayload] = useState(undefined)
  const [extBlocked, setExtBlocked] = useState(false) // a card that must hold the approval back says so (onBlocked)
  // Executed and rejected cards fold to one line so the card waiting for you stays in view.
  const [expanded, setExpanded] = useState(false)
  const open = isOpenApproval(a)
  const folded = !open && a.status !== 'running' && !expanded
  const decision = a.action === 'decision'
  const help = a.action === 'help' && a.payload?.by === 'workflow' // a person step's ask: an answer, or "done"
  const [answer, keepAnswer] = useState('')
  const answerRev = useRef(a.payload?.rev || 0)
  const setAnswer = value => { if (!answer) answerRev.current = a.payload?.rev || 0; keepAnswer(value) }
  const asked = help && ['agent', 'low', 'stuck'].includes(a.payload?.kind) // a step that asked on its own: it may also run again
  const talking = help && (a.payload?.kind === 'chat' || !!a.payload?.talk) // a discussion: the person talks it through with an agent
  // a step by the name the workflow gives it (a built-in step's own word else)
  const stepName = key => { const x = run?.stages?.find(s => s.key === key); return typeof x?.title === 'string' && x.title ? x.title : word(t, `stage.${key}`, key || '') }
  const [question, setQuestion] = useState('')
  const payload = how => (decision ? { choice, ...(comment.trim() && { comment: comment.trim() }), ...(editor && editorPayload) } : help ? { answer: how || 'continue', input: answer.trim(), rev: answer.trim() ? answerRev.current : a.payload?.rev || 0 } : ext?.Body ? extPayload : edited && Object.keys(edited).length ? edited : undefined)
  const sendsBack = decision && ['revise', 'check'].includes(a.payload?.options?.[choice]?.action)
  const Icon = decision ? Scale : talking ? MessagesSquare : asked ? LifeBuoy : help ? Hand : ext?.icon || MessageSquare
  const late = overdue(a) // waited past its hours: its person was reminded
  const packCall = (op, args) => call(String(op).includes('.') ? op : `${found?.packId}.${op}`, args)
  const approve = async how => {
    setBusy(true)
    try {
      const r = await call('approve', { id: a.id, payload: payload(typeof how === 'string' ? how : undefined) })
      toast(r.approval.status === 'done' ? 'ok' : 'error', r.approval.status === 'done' ? `${a.title} · ${t('ap.done')}` : `${t('ap.failedTitle')}: ${r.approval.error}`)
    } catch (err) { toast('error', errorText(t, err)) }
    setBusy(false); refresh()
  }
  // a choice made in the editor itself (a review's page has the choices at its foot)
  const decideNow = async (i, extra) => {
    setChoice(i); setBusy(true)
    try {
      const r = await call('approve', { id: a.id, payload: { choice: i, ...(editor && editorPayload), ...(extra || {}) } })
      toast(r.approval.status === 'done' ? 'ok' : 'error', r.approval.status === 'done' ? `${a.title} · ${t('ap.done')}` : `${t('ap.failedTitle')}: ${r.approval.error}`)
    } catch (err) { toast('error', errorText(t, err)) }
    setBusy(false); refresh()
  }
  // the step's agent, asked about it while the run waits: it answers from the run's record
  const askAgent = async () => {
    setBusy(true)
    try { await call('askHelp', { id: a.id, text: question }); setQuestion('') } catch (err) { toast('error', errorText(t, err)) }
    setBusy(false); refresh()
  }
  const reject = async () => {
    const reason = window.prompt(t('ap.rejectPrompt'))
    if (reason === null) return
    try { await call('reject', { id: a.id, reason, rev: a.payload?.rev || 0 }) } catch (err) { toast('error', errorText(t, err)) }
    refresh()
  }
  const blocked = decision ? choice == null || (editor && editorBlocked) : help ? a.payload?.kind === 'input' && !answer.trim() : ext?.Body ? extBlocked : edited === null
  return (
    <section className={cx('wb-card wb-approval', `wb-ap-${a.status}`)}>
      <div className="wb-ap-head">
        <Icon size={15} />
        <b>{a.title}</b>
        <Pill tone={AP_TONE[a.status]} spin={a.status === 'running'}>{t(talking && ['pending', 'done'].includes(a.status) ? `talk.st.${a.status}` : `ap.st.${a.status}`)}</Pill>
        {(a.payload?.person || help) && open && <span className="wb-tag">{t(talking ? 'person.ask.chat' : `person.ask.${help ? a.payload.kind : a.payload.person}`)}</span>}
        {asked && a.payload.kind === 'low' && open && <span className="wb-tag wb-t-amber">{t('help.low', { score: a.payload.score, bar: a.payload.bar })}</span>}
        {asked && a.payload.round > 1 && open && <span className="wb-tag wb-t-muted">{t('help.round', { n: a.payload.round })}</span>}
        {late && <span className="wb-tag wb-t-amber" title={t('person.lateHint', { h: a.payload.wait })}><Clock size={10} /> {t('person.late', { t: dur(Date.now() - a.createdAt) })}</span>}
        {run && onRun && <button className="wb-linkbtn" onClick={() => onRun(run.id)}>{t('ap.run', { title: runTitle(run, data) })}</button>}
        {!open && a.status !== 'running' && <button className="wb-linkbtn wb-ap-toggle" onClick={() => setExpanded(x => !x)}>{expanded ? t('ap.less') : t('ap.more')}</button>}
      </div>
      {!folded && decision && (
        <>
          {a.payload?.why && <div className="wb-sub wb-block"><RichText text={a.payload.why} /></div>}
          {/* the pack's editor: { a, run, open, busy, choice, option, onPayload(extra fields of the answer), onBlocked(yes), call(op, args) } */}
          {editor && <editor.Editor a={a} run={run} open={open} busy={busy} choice={choice} option={a.payload?.options?.[choice] || null} lang={t('lang.code')}
            onPayload={setEditorPayload} onBlocked={setEditorBlocked} onDecide={decideNow} call={(op, args) => call(String(op).includes('.') ? op : `${editor.packId}.${op}`, args)} />}
          {a.payload?.blocking && open && run && !['done', 'failed', 'cancelled', 'interrupted'].includes(run.status) && <div className="wb-note wb-t-amber"><Info size={13} /> {t('dec.blocking', { stage: word(t, `stage.${a.payload.stage}`, a.payload.stage || '') })}</div>}
          <DecisionPicker options={a.payload?.options || []} recommended={a.payload?.recommended} value={open ? choice : a.result?.choice} onChange={setChoice} disabled={!open || busy} />
          {open && sendsBack && <textarea className="wb-input wb-decide-comment" rows={3} value={comment} disabled={busy} placeholder={t('dec.comment')} onChange={e => setComment(e.target.value)} />}
          {!open && a.payload?.comment && <p className="wb-sub wb-block">{t('dec.said')}{a.payload.comment}</p>}
        </>
      )}
      {!folded && a.note && <p className="wb-sub wb-block">{a.note}</p>}
      {/* the card's props: { a, run, open, busy, onPayload(next), onBlocked(yes), call(op, args) } — and the same under the names some packs use */}
      {!folded && help && <>
        {a.payload?.why && <div className="wb-sub wb-block"><RichText text={a.payload.why} /></div>}
        {open && run && !['done', 'failed', 'cancelled', 'interrupted'].includes(run.status) && <div className="wb-note wb-t-amber"><Info size={13} /> {t(talking ? 'talk.blocking' : 'dec.blocking', { stage: talking ? stepName(a.payload.stage) : word(t, `stage.${a.payload.stage}`, a.payload.stage || '') })}</div>}
        {talking && <TalkThread a={a} open={open} busy={busy} text={question} setText={setQuestion} onSend={askAgent} withName={a.payload?.with ? stepName(a.payload.with) : ''} />}
        {talking && !open && (a.settled || a.result?.input) && <div className="wb-talk-settled">
          {a.settled && <><b>{t('talk.settled')}</b><RichText text={a.settled} /></>}
          {a.result?.input && <p className="wb-sub">{t('talk.added')}{a.result.input}</p>}
        </div>}
        {!talking && asked && (open || (a.chat || []).length > 0) && <div className="wb-help-chat">
          {(a.chat || []).map(q => (
            <div key={q.n} className="wb-help-q">
              <div className="wb-help-said"><MessageSquare size={12} /><span><b>{t('help.you')}</b> {q.q}</span></div>
              {q.answer ? <div className="wb-help-reply"><Bot size={12} /><div><RichText text={q.answer} /></div></div>
                : q.error ? <div className="wb-help-reply wb-t-red"><XCircle size={12} />{t('help.agentFailed', { error: q.error })}</div>
                  : <div className="wb-help-reply wb-dim"><Loader2 size={12} className="wb-spin" />{t('help.agentAnswering')}</div>}
            </div>
          ))}
          {open && <div className="wb-help-ask">
            <input className="wb-input" value={question} placeholder={t('help.askPh')} disabled={busy} onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && question.trim()) askAgent() }} />
            <button className="wb-btn" disabled={busy || !question.trim()} onClick={askAgent} title={t('help.askHint')}><Bot size={13} />{t('help.ask')}</button>
          </div>}
        </div>}
        {open && talking && <input className="wb-input wb-talk-note" value={answer} disabled={busy} placeholder={t('talk.notePh')} onChange={e => setAnswer(e.target.value)} />}
        {open && !talking && <textarea className="wb-input wb-decide-comment" rows={3} value={answer} disabled={busy} placeholder={t(asked ? 'help.inputPh' : a.payload?.kind === 'input' ? 'person.answerPh' : 'person.notePh')} onChange={e => setAnswer(e.target.value)} />}
        {!open && !talking && a.result?.input && <p className="wb-sub wb-block">{t('person.said')}{a.result.input}</p>}
        {!open && asked && a.result?.answer && <div className="wb-note wb-t-muted"><Info size={13} /> {t(`help.answered.${a.result.answer}`)}</div>}
      </>}
      {!folded && !decision && !help && ext?.Body && <ext.Body a={a} approval={a} run={run} open={open} readOnly={!open} busy={busy} payload={extPayload ?? a.payload} lang={t('lang.code')} onPayload={setExtPayload} onBlocked={setExtBlocked} call={packCall} />}
      {!folded && !decision && !help && !ext?.Body && <PayloadForm key={a.id} payload={a.payload} disabled={!open || busy} onChange={setEdited} />}
      {/* an action that opened a browser (lib/browser.js): it is live here — the person checks it and does the last click */}
      {!folded && (a.payload?.browser === 'shared' || a.result?.browser === 'shared') && (
        // the agents' browser: the person takes the last step there (its window on the desk)
        <button className="wb-btn" onClick={() => window.dispatchEvent(new CustomEvent('ruyix-apps:open', { detail: { appId: 'agent-browser' } }))}><Globe size={13} />{t('ap.openAgentBrowser')}</button>
      )}
      {!folded && (a.result?.browser || a.payload?.browser) && a.payload?.browser !== 'shared' && a.result?.browser !== 'shared' && <LiveBrowser session={a.result?.browser || a.payload?.browser} run={a.runId || null} runTitle={run?.subject?.title || run?.template || null} />}
      {!folded && !open && a.result && !decision && !help && <details className="wb-details"><summary className="wb-sub">{t('ap.result')}</summary><Structured value={a.result} /></details>}
      {a.error && <div className="wb-note wb-t-red"><AlertTriangle size={13} /> {a.error}</div>}
      {a.reason && <div className="wb-sub">{a.reason}</div>}
      {open && (
        <div className="wb-actions">
          {talking && a.status !== 'failed'
            ? <>
              <button className="wb-btn wb-primary" disabled={busy || (a.chat || []).some(x => !x.answer && !x.error)} onClick={() => approve(a.payload.kind === 'chat' ? 'continue' : 'settle')} title={t('talk.settleHint')}>{busy ? <Loader2 size={13} className="wb-spin" /> : <CheckCircle2 size={13} />}{t('talk.settle')}</button>
              {a.payload?.back && <button className="wb-btn" disabled={busy} onClick={() => approve('back')}><Undo2 size={13} />{t('talk.back', { step: stepName(a.payload.back) })}</button>}
              {a.payload?.talk && <button className="wb-btn" disabled={busy} onClick={() => approve('continue')} title={t('help.continueHint')}><Play size={13} />{t('talk.asIs')}</button>}
            </>
            : asked && a.status !== 'failed'
            ? <>
              <button className="wb-btn wb-primary" disabled={busy || !answer.trim()} onClick={() => approve('retry')}>{busy ? <Loader2 size={13} className="wb-spin" /> : <RotateCcw size={13} />}{t('help.retry')}</button>
              <button className="wb-btn" disabled={busy} onClick={() => approve('continue')} title={t('help.continueHint')}><Play size={13} />{t('help.continue')}</button>
            </>
            : <button className="wb-btn wb-primary" disabled={busy || blocked} onClick={() => approve()}>{busy ? <Loader2 size={13} className="wb-spin" /> : help ? (a.payload?.kind === 'input' ? <Send size={13} /> : <CheckCircle2 size={13} />) : <Stamp size={13} />}{a.status === 'failed' ? t('ap.retry') : help ? t(a.payload?.kind === 'input' ? 'person.send' : 'person.done') : t('ap.approve')}</button>}
          {/* a blocking decision rejected stops the run there (the engine reads it so): the button says it */}
          <button className="wb-btn" disabled={busy} onClick={reject}><X size={13} />{t(a.payload?.blocking ? 'ap.rejectStop' : 'ap.reject')}</button>
        </div>
      )}
    </section>
  )
}

/**
 * The inbox's 已处理 (Ethan 2026-10-19, the Aviary prototype's inbox): the cards that no longer wait — approved and done,
 * turned down, answered, replaced by a newer one — the latest decided first, each with its run (a click opens it) and,
 * when one was given, why it was closed. At most the last hundred.
 */
export function HandledView({ approvals, runs, onRun }) {
  const t = useT()
  const data = useWorkflowData()
  const now = Date.now()
  const done = approvals.filter(a => !isOpenApproval(a) && a.status !== 'running').sort((a, b) => (b.decidedAt || b.createdAt || 0) - (a.decidedAt || a.createdAt || 0)).slice(0, 100)
  return (
    <div className="wb-view wb-pad">
      <h2 className="wb-h">{t('sec.handled')}</h2>
      <p className="wb-sub">{t('hd.explain')}</p>
      {done.length ? (
        <div className="wb-handled">
          {done.map(a => {
            const run = runs.get(a.runId), talking = a.payload?.kind === 'chat' || a.payload?.talk
            return (
              <button key={a.id} type="button" className="wb-handled-row" onClick={() => run && onRun(a.runId)} disabled={!run}>
                <Pill tone={AP_TONE[a.status]}>{t(talking && a.status === 'done' ? 'talk.st.done' : `ap.st.${a.status}`)}</Pill>
                <span className="wb-handled-main"><b>{a.title || a.action}</b><small>{[run ? runTitle(run, data) : a.runId, a.reason].filter(Boolean).join(' · ')}</small></span>
                <span className="wb-handled-when">{t('ago', { t: dur(now - (a.decidedAt || a.createdAt || now)) })}</span>
              </button>
            )
          })}
        </div>
      ) : <div className="wb-empty-small">{t('hd.empty')}</div>}
    </div>
  )
}

/** The inbox's cards: what waits for a person, by run (what was decided is in 已处理, and in each task's story). */
export function ApprovalsView({ approvals, runs, toast, refresh, onRun }) {
  const t = useT()
  const data = useWorkflowData()
  const live = liveApprovals(approvals, runs)
  const open = live.filter(a => isOpenApproval(a) || a.status === 'running')
  const hidden = approvals.filter(a => isOpenApproval(a) && runs.get(a.runId)?.archivedAt).length
  const byRun = useMemo(() => {
    const m = new Map()
    for (const a of open) m.set(a.runId, [...(m.get(a.runId) || []), a])
    return [...m]
  }, [open.map(a => `${a.id}:${a.status}`).join()])
  return (
    <div className="wb-view wb-pad">
      <h2 className="wb-h">{t('nav.approvals')}</h2>
      <p className="wb-sub wb-ap-explain">{t('ap.explain')}</p>
      {byRun.length ? byRun.map(([runId, cards]) => {
        const run = runs.get(runId)
        return (
          <section key={runId} className="wb-ap-group">
            <h3 className="wb-ap-group-head">
              <ClipboardCheck size={14} />{run ? runTitle(run, data) : runId}
              {run && <button className="wb-linkbtn" onClick={() => onRun(runId)}>{t('ap.openRun')} <ExternalLink size={11} /></button>}
              <span className="wb-count wb-count-warn">{cards.length}</span>
            </h3>
            <div className="wb-cards">{cards.map(a => <ApprovalCard key={a.id} a={a} run={run} toast={toast} refresh={refresh} onRun={onRun} />)}</div>
          </section>
        )
      }) : <div className="wb-empty-small">{t('ap.empty')}</div>}
      {hidden > 0 && <p className="wb-sub">{t('ap.hiddenArchived', { n: hidden })}</p>}
    </div>
  )
}
