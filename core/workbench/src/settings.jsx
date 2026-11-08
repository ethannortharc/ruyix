// The workbench settings (a tab of the shell's Settings page): who does each step of each workflow, which optional steps
// run, the run limits (timeout, resuming after a restart, the folder script steps work in) and each pack's own settings —
// a form the pack brings (window.__ruyixWorkbenchExt[pack].settings), else the block as JSON.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bot, CheckCircle2, Loader2, MessagesSquare, Package, RotateCcw, Timer } from 'lucide-react'
import { call, exts, useExtVersion, useWorkflows } from './data.js'
import { AgentSelect, ModelPicker, SkillPicker, isModel } from './pickers.jsx'
import { cx, errorText, useT, word } from './ui.jsx'

export const SAVED = 'ruyix-workbench:settings-saved'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const CORE_KEYS = ['workspace', 'steps', 'stages', 'model', 'agentTimeoutMinutes', 'autoResume', 'chat']

const Field = ({ label, hint, children, changed, span3 }) => <label className={cx('wb-field', span3 && 'wb-span3')}><span>{label}{changed && <i className="wb-changed" />}</span>{children}{hint && <small className="wb-sub">{hint}</small>}</label>

/** A pack's block without a form of its own: JSON, applied when it parses. */
function JsonBlock({ value, onChange, onValid }) {
  const t = useT()
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const [bad, setBad] = useState(false)
  useEffect(() => { if (!bad && !same(JSON.parse(text || 'null'), value)) setText(JSON.stringify(value ?? {}, null, 2)) }, [value])
  return (
    <div>
      <textarea className={cx('wb-input wb-mono', bad && 'wb-bad-input')} rows={Math.min(24, Math.max(4, text.split('\n').length + 1))} spellCheck={false} value={text}
        onChange={e => {
          setText(e.target.value)
          try { const v = JSON.parse(e.target.value); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('object'); setBad(false); onValid(true); onChange(v) } catch { setBad(true); onValid(false) }
        }} />
      {bad && <p className="wb-field-error">{t('set.badJson')}</p>}
    </div>
  )
}

export function SettingsView({ toast }) {
  const t = useT()
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState(() => new Set())
  const current = useRef(null), loading = useRef(0)
  current.current = { data, draft }
  const [wfData] = useWorkflows()
  const version = useExtVersion()
  const load = (force = false) => {
    const seq = ++loading.current
    return call('settings').then(d => {
      if (seq !== loading.current) return
      const at = current.current
      if (force !== true && at.draft && !same(at.draft, at.data?.settings)) return // an external refresh cannot discard unsaved edits
      setData(d); setDraft(d.settings)
    }, err => { if (seq === loading.current) toast('error', errorText(t, err)) })
  }
  useEffect(() => { load(); window.addEventListener(SAVED, load); return () => window.removeEventListener(SAVED, load) }, [])
  const lang = t('lang.code')
  const flows = useMemo(() => (data?.stepAgents || []).filter(w => w.steps.length), [data])
  if (!draft) return <div className="wb-view wb-pad wb-empty-small">{t('loading')}</div>
  const set = (k, v) => setDraft(d => ({ ...d, [k]: v }))
  const setPick = (wf, key, patch) => setDraft(d => {
    const next = Object.fromEntries(Object.entries({ ...(d.steps?.[wf]?.[key] || {}), ...patch }).filter(([, v]) => v !== undefined))
    const steps = { ...(d.steps?.[wf] || {}) }
    if (Object.keys(next).length) steps[key] = next; else delete steps[key]
    const all = { ...d.steps, [wf]: steps }
    if (!Object.keys(steps).length) delete all[wf]
    return { ...d, steps: all }
  })
  const setPack = (id, v) => setDraft(d => ({ ...d, packs: { ...d.packs, [id]: v } }))
  const dirty = !same(draft, data.settings)
  const badModel = (draft.model && !isModel(draft.model)) || Object.values(draft.steps || {}).some(w => Object.values(w || {}).some(p => p?.model && !isModel(p.model)))
  const save = async () => {
    ++loading.current
    setBusy(true)
    try {
      const r = await call('saveSettings', { settings: draft, revision: data.revision })
      setDraft(d => ({ ...r.settings, ...Object.fromEntries(Object.entries(d).filter(([k, v]) => !same(v, draft[k]))) })); setData(d => ({ ...d, settings: r.settings, revision: r.revision })); toast('ok', t('set.saved'))
      window.dispatchEvent(new Event(SAVED))
    } catch (err) { toast('error', errorText(t, err)) }
    setBusy(false)
  }
  const reset = () => setDraft(d => ({ ...d, ...Object.fromEntries(CORE_KEYS.map(k => [k, data.defaults[k]])) }))
  // a pack's form: `settings: { [packId]: Component }` of any pack's extension (or `settings: { Body }` of the pack's own)
  const packExt = id => Object.values(exts()).map(e => e?.settings?.[id]).find(Boolean) || exts()[id]?.settings?.Body
  const packName = p => p.name?.[lang] || p.name?.en || p.id
  return (
    <div className="wb-view wb-pad wb-settings">
      <p className="wb-sub wb-block">{t('set.hint', { file: data.file })}</p>
      <div className={cx('wb-note', data.hub ? 'wb-t-green' : 'wb-t-red')}>{data.hub ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {t(data.hub ? 'set.hubOk' : 'set.hubMissing')}</div>

      <section className="wb-card">
        <h3><Bot size={14} />{t('set.g.steps')}</h3>
        <p className="wb-sub wb-block">{t('set.stepsHint')}</p>
        {flows.length === 0 && <p className="wb-sub">{t('set.noAgentSteps')}</p>}
        {flows.map(wf => (
          <div key={wf.id} className="wb-set-flow">
            <h4>{word(t, `workflow.${wf.id}`, wf.title)}</h4>
            {wf.steps.map(s => {
              const pick = draft.steps?.[wf.id]?.[s.key] || {}
              if (s.kind === 'model') return (
                <div key={s.key} className="wb-set-step">
                  <div className="wb-set-step-name"><b>{t(`stage.${s.key}`)}</b><small className="wb-sub wb-mono">{s.role} · {t('kind.model')}</small></div>
                  <Field label={t('set.stepModel')} span3><ModelPicker value={pick.model} def={s.defaults.model} models={data.models} connections={data.connections || []} onChange={v => setPick(wf.id, s.key, { model: v || undefined })} /></Field>
                </div>
              )
              return (
                <div key={s.key} className="wb-set-step">
                  <div className="wb-set-step-name"><b>{t(`stage.${s.key}`)}</b><small className="wb-sub wb-mono">{s.role}</small></div>
                  <Field label={t('set.stepAgent')}><AgentSelect value={pick.agent} agents={data.agents} def={s.defaults.agent} onChange={v => setPick(wf.id, s.key, { agent: v || undefined })} /></Field>
                  <Field label={t('set.stepFallback')}><AgentSelect value={pick.fallback === '' ? '-' : pick.fallback} agents={data.agents} def={s.defaults.fallback} none onChange={v => setPick(wf.id, s.key, { fallback: v === '-' ? '' : v || undefined })} /></Field>
                  <Field label={t('wfc.skills')}><SkillPicker value={pick.skills} skills={wfData?.skills || []} onChange={v => setPick(wf.id, s.key, { skills: v.length ? v : undefined })} /></Field>
                </div>
              )
            })}
          </div>
        ))}
      </section>

      {data.optionalStages.length > 0 && (
        <section className="wb-card">
          <h3>{t('set.g.optional')}</h3>
          <p className="wb-sub wb-block">{t('set.optionalHint')}</p>
          {data.optionalStages.map(key => (
            <label key={key} className="wb-check"><input type="checkbox" checked={draft.stages?.[key] !== false} onChange={e => { const stages = { ...draft.stages }; if (e.target.checked) delete stages[key]; else stages[key] = false; set('stages', stages) }} />{t(`stage.${key}`)}</label>
          ))}
        </section>
      )}

      <section className="wb-card">
        <h3><Timer size={14} />{t('set.g.runs')}</h3>
        <div className="wb-form">
          <Field label={t('set.agentTimeoutMinutes')} changed={draft.agentTimeoutMinutes !== data.defaults.agentTimeoutMinutes}><input className="wb-input" type="number" min={1} max={1440} value={draft.agentTimeoutMinutes} onChange={e => set('agentTimeoutMinutes', Number(e.target.value))} /></Field>
          <label className="wb-check wb-field"><input type="checkbox" checked={!!draft.autoResume?.enabled} onChange={e => set('autoResume', { ...draft.autoResume, enabled: e.target.checked })} />{t('set.autoResume.enabled')}</label>
          <Field label={t('set.autoResume.maxAgeHours')}><input className="wb-input" type="number" min={1} value={draft.autoResume?.maxAgeHours} onChange={e => set('autoResume', { ...draft.autoResume, maxAgeHours: Number(e.target.value) })} /></Field>
          <Field label={t('set.autoResume.maxPerRun')}><input className="wb-input" type="number" min={0} value={draft.autoResume?.maxPerRun} onChange={e => set('autoResume', { ...draft.autoResume, maxPerRun: Number(e.target.value) })} /></Field>
          <Field label={t('set.model')} hint={t('set.modelHint')} changed={(draft.model || '') !== (data.defaults.model || '')}><ModelPicker value={draft.model} models={data.models} connections={data.connections || []} onChange={v => set('model', v)} /></Field>
          <Field label={t('set.workspace')} hint={t('set.workspaceHint')}><input className="wb-input wb-mono" value={draft.workspace ?? ''} placeholder={t('set.workspacePh')} spellCheck={false} onChange={e => set('workspace', e.target.value)} /></Field>
        </div>
      </section>

      {/* the conversation: how an answer comes out on the desk (docs/design/desk-answers.md) */}
      <section className="wb-card">
        <h3><MessagesSquare size={14} />{t('set.g.chat')}</h3>
        <div className="wb-form">
          <Field label={t('set.answerOpen')} hint={t('set.answerOpenHint')} changed={(draft.chat?.answerOpen || 'leaf') !== (data.defaults.chat?.answerOpen || 'leaf')}>
            <select className="wb-input" value={draft.chat?.answerOpen || 'leaf'} onChange={e => set('chat', { ...draft.chat, answerOpen: e.target.value })}>
              {['leaf', 'drawer', 'window'].map(v => <option key={v} value={v}>{t(`set.answerOpen.${v}`)}</option>)}
            </select>
          </Field>
        </div>
      </section>

      {data.packs.map(p => {
        const Form = packExt(p.id)
        return (
          <section key={`${p.id}:${version}`} className="wb-card">
            <h3><Package size={14} />{packName(p)}</h3>
            {Form
              ? <Form value={draft.packs?.[p.id] ?? {}} defaults={data.defaults.packs?.[p.id] ?? {}} lang={lang} onChange={v => setPack(p.id, v)} settings={draft} call={(op, args) => call(String(op).includes('.') ? op : `${p.id}.${op}`, args)} toast={toast} />
              : <JsonBlock value={draft.packs?.[p.id] ?? {}} onChange={v => setPack(p.id, v)} onValid={ok => setInvalid(s => { const n = new Set(s); ok ? n.delete(p.id) : n.add(p.id); return n })} />}
          </section>
        )
      })}

      <div className="wb-actions">
        <button className="wb-btn wb-primary" disabled={busy || !dirty || invalid.size > 0 || badModel} onClick={save}>{busy ? <Loader2 size={13} className="wb-spin" /> : <CheckCircle2 size={13} />}{t('set.save')}</button>
        <button className="wb-btn" disabled={busy} onClick={reset}><RotateCcw size={13} />{t('set.reset')}</button>
        <button className="wb-btn" disabled={busy} onClick={() => { if (!dirty || window.confirm(t('set.reloadConfirm'))) load(true) }}>{t('set.reload')}</button>
        {dirty && <span className="wb-sub">{t('set.unsaved')}</span>}
      </div>
    </div>
  )
}
