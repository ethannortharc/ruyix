import { useCallback, useEffect, useRef, useState } from 'react'
import { Star } from 'lucide-react'
import { useFeedback } from './data.js'
import { say } from './text.js'
import { Block } from './views.jsx'
import { Failed, Loading, RemoveButton, useNote, whenText } from './ui.jsx'

export function FeedbackBlock({ studio, lang, W }) {
  const zh = lang === 'zh', note = useNote()
  const [runId, setRun] = useState(''), [stage, setStage] = useState(''), [busy, setBusy] = useState(false)
  const [formState, setFormState] = useState({ dirty: false, busy: false }), previousTarget = useRef(null)
  const onDraftState = useCallback(state => setFormState(state), [])
  const api = useFeedback(studio, runId), data = api.value
  const current = stage ? data?.targets.find(t => t.stage === stage) : data?.targets[0]
  if (current) previousTarget.current = { studio, runId, target: current }
  const target = current || (previousTarget.current?.studio === studio && previousTarget.current?.runId === runId && previousTarget.current?.target.stage === stage ? previousTarget.current.target : null)
  useEffect(() => { if (!stage && current) setStage(current.stage) }, [stage, current?.stage])
  const selected = data?.feedback.find(f => f.run === runId && f.stage === target?.stage)
  const navigate = change => {
    if (formState.busy || (formState.dirty && !window.confirm(zh ? '放弃尚未保存的评分草稿？' : 'Discard this unsaved rating draft?'))) return
    setFormState({ dirty: false, busy: false }); change()
  }
  const setLearning = async () => {
    setBusy(true)
    try { await api.learning(!data.profile.enabled) } catch (err) { note(err.message, 'error') }
    setBusy(false)
  }
  return <Block size="full" icon={Star} title={zh ? '评分与创作偏好' : 'Feedback and creative preferences'} actions={<button type="button" className="st-btn st-btn-quiet st-btn-sm" onClick={api.reload}>{zh ? '刷新' : 'Refresh'}</button>}>
    {api.error && <Failed W={W} error={api.error} retry={api.reload} />}
    {!data ? <Loading W={W} /> : <div className="st-feedback-layout">
      <div>
        <p className="st-quiet">{zh ? '给成品或中间步骤打分，再选择下次希望的方向。相同偏好在两个不同项目得到确认后，会用于之后对应的智能体创作步骤。' : 'Rate a finished result or an intermediate step, then choose what you want next time. A preference confirmed on two different projects informs the corresponding agent-assisted creative steps in future runs.'}</p>
        {(data.options.pacing || data.options.captions) && <p className="st-quiet">{zh ? '视频需开启「智能体辅助剪辑方案」来应用偏好和历史反馈。手动初稿保留你选择的设置，不会自动改剪辑或生成字幕。' : 'For video, enable “Agent-assisted edit plan” to apply preferences and earlier feedback. Manual assembly keeps your chosen settings; it does not automatically change cuts or generate captions.'}</p>}
        <div className="st-feedback-selects">
          <label className="st-feedback-label">{zh ? '运行' : 'Run'}<select className="st-in" aria-label={zh ? '运行' : 'Run'} value={runId} disabled={formState.busy} onChange={e => navigate(() => { setRun(e.target.value); setStage('') })}>
            <option value="">{zh ? '选择要评价的运行' : 'Choose a run to review'}</option>
            {data.runs.map(r => <option key={r.id} value={r.id}>{r.title || r.id} · {r.status}</option>)}
          </select></label>
          {runId && <label className="st-feedback-label">{zh ? '评价对象' : 'Review target'}<select className="st-in" aria-label={zh ? '评价对象' : 'Review target'} value={target?.stage || ''} disabled={formState.busy} onChange={e => navigate(() => setStage(e.target.value))}>
            {target && !current && <option value={target.stage}>{say(target.title, lang)} · {zh ? '暂不可评价' : 'Not currently reviewable'}</option>}
            {!data.targets.length && <option value="">{zh ? '等待可评价的结果' : 'Waiting for a reviewable result'}</option>}
            {data.targets.map(t => <option key={t.stage} value={t.stage}>{say(t.title, lang)}</option>)}
          </select></label>}
        </div>
        {runId && <button type="button" className="st-link" onClick={() => window.dispatchEvent(new CustomEvent('ruyix-workbench:open', { detail: { run: runId } }))}>{zh ? '打开运行，查看文件和证据' : 'Open run, files and evidence'}</button>}
        {target && <FeedbackForm key={`${studio}:${runId}:${target.stage}`} {...{ lang, runId, target, selected, api, onDraftState }} options={data.options} available={!!current} feedbackRevision={data.profile.revision} />}
        {!data.runs.length && <p className="st-quiet">{zh ? '从这个工作室开始第一次创作后，就可以在这里评价。' : 'Start your first project in this studio to leave feedback here.'}</p>}
      </div>
      <aside className="st-preferences">
        <div className="st-feedback-heading"><h3>{zh ? '已学习的偏好' : 'Learned preferences'}</h3><button type="button" className="st-btn st-btn-sm" role="switch" aria-checked={data.profile.enabled} disabled={busy} onClick={setLearning}>{data.profile.enabled ? (zh ? '已开启' : 'On') : (zh ? '已暂停' : 'Paused')}</button></div>
        <p className="st-quiet">{zh ? `${data.profile.sampleCount} 条评分 · 新运行会保存当时的偏好版本。当前请求优先。` : `${data.profile.sampleCount} ratings · Each new run saves its preference version. Current instructions take priority.`}</p>
        {data.profile.workflow ? <p className="st-quiet">{zh ? '仅应用于工作流：' : 'Scoped to workflow: '}{data.profile.workflow}</p> : !runId && data.profile.sampleCount > 0 && <p className="st-quiet">{zh ? '选择一次运行查看对应工作流的偏好；不同工作流的意见不会混合。' : 'Choose a run to view its workflow’s preferences; feedback from different workflows is kept separate.'}</p>}
        {data.profile.profile && <p className="st-quiet">{zh ? '仅应用于当前运行使用的编辑设定 / 账号。' : 'Scoped to this run’s editorial profile / account.'}</p>}
        {data.profile.rules.length ? <ul className="st-preference-rules">{data.profile.rules.map(r => <li key={`${r.scope}:${r.key}`}><b>{say(data.options[r.key]?.label, lang)}: {data.options[r.key]?.values[r.value]}</b><small>{r.scope === '*' ? (zh ? '全部步骤' : 'All stages') : r.scope} · {r.support} {zh ? '个项目确认' : 'project confirmations'}</small></li>)}</ul> : <p className="st-quiet">{zh ? '还没有足够一致的确认。星级会被保存；不会仅凭分数猜测你的风格。' : 'No consistent preference yet. Scores are saved; style is never guessed from stars alone.'}</p>}
        {!!data.profile.candidates.length && <p className="st-quiet">{zh ? `${data.profile.candidates.length} 个方向还在观察中。` : `${data.profile.candidates.length} preferences are still gathering evidence.`}</p>}
        <details className="st-feedback-history"><summary>{zh ? '评分记录（可撤回）' : 'Rating history (retractable)'}</summary>
          {data.feedback.slice(0, 30).map(f => <div className="st-feedback-event" key={f.id}><b>{f.score}/5 · {f.title}</b><small>{f.stage} · {whenText(f.at, lang)}</small>{f.note && <p>{f.note}</p>}<RemoveButton W={W} small onRemove={() => api.remove(f.id).catch(e => note(e.message, 'error'))} /></div>)}
        </details>
      </aside>
    </div>}
  </Block>
}

function FeedbackForm({ lang, runId, target, selected, api, options, available, feedbackRevision, onDraftState }) {
  const zh = lang === 'zh'
  const from = row => ({ score: row?.score || 0, note: row?.note || '', revision: row?.revision || target.revision,
    choices: Object.fromEntries(Object.entries(row?.choices || {}).filter(([key, value]) => Object.hasOwn(options, key) && Object.hasOwn(options[key].values, value))) })
  const [draft, setDraft] = useState(() => from(selected)), [baseline, setBaseline] = useState(() => ({ ...from(selected), id: selected?.id, serverRevision: feedbackRevision }))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  const same = (a, b) => a.score === b.score && a.note === b.note && a.revision === b.revision && JSON.stringify(a.choices) === JSON.stringify(b.choices)
  const dirty = !same(draft, baseline), stale = draft.revision !== target.revision
  const latest = useRef(); latest.current = { draft, baseline, dirty, busy, target }
  const remoteChanged = feedbackRevision >= baseline.serverRevision && selected?.id !== baseline.id
  useEffect(() => { onDraftState({ dirty, busy }) }, [dirty, busy, onDraftState])
  useEffect(() => {
    // A poll/retraction may update a clean form. Neither it nor a save reply may overwrite input typed meanwhile.
    if (busy || !remoteChanged || latest.current.dirty) return
    const next = from(selected)
    setDraft(next); setBaseline({ ...next, id: selected?.id, serverRevision: feedbackRevision }); setSaved(false)
  }, [selected?.id, feedbackRevision, busy, dirty])
  const edit = patch => { setDraft(d => ({ ...d, ...patch })); setSaved(false) }
  const loadSaved = () => {
    if (dirty && !window.confirm(zh ? '用已保存评分替换当前草稿？' : 'Replace your draft with the saved rating?')) return
    const next = from(selected)
    setDraft(next); setBaseline({ ...next, id: selected?.id, serverRevision: feedbackRevision }); setSaved(false); setError('')
  }
  const submit = async e => {
    e.preventDefault()
    if (busy || stale || !available) return
    const submitted = draft
    setBusy(true); setError(''); setSaved(false)
    try {
      const result = await api.rate({ run: runId, stage: target.stage, ...submitted })
      setBaseline({ ...submitted, id: result.feedback.id, serverRevision: result.profile.revision }); setSaved(true)
    } catch (err) { setError(err.message); api.reload() }
    setBusy(false)
  }
  return <form className="st-feedback-form" onSubmit={submit}>
    {target.summary && <p className="st-feedback-summary">{target.summary}</p>}
    {selected && selected.revision !== target.revision && <p className="st-quiet">{zh ? '已保存的评分针对较早版本。' : 'The saved rating refers to an earlier version.'}</p>}
    {!available ? <p role="alert">{zh ? '该步骤暂时没有可评价结果；评分草稿已保留。' : 'This step is not currently reviewable; your rating draft is preserved.'}</p> : stale && <div role="alert"><p>{zh ? '结果版本已变化，评分草稿已保留。请查看当前文件和证据，再确认评价这一版。' : 'The result changed. Your rating draft is preserved. Inspect the current files and evidence before rating this version.'}</p><button type="button" className="st-btn st-btn-sm" disabled={busy} onClick={() => edit({ revision: target.revision })}>{zh ? '我已查看当前版本' : 'I reviewed this version'}</button></div>}
    {remoteChanged && dirty && <div role="alert">{zh ? '已保存评分在另一处发生变化；你的草稿已保留。' : 'The saved rating changed elsewhere; your draft is preserved.'} <button type="button" className="st-btn st-btn-sm" disabled={busy} onClick={loadSaved}>{zh ? '载入已保存评分' : 'Load saved rating'}</button></div>}
    <fieldset><legend>{zh ? '这版结果的质量' : 'Quality of this version'}</legend><div className="st-rating">
      {[1, 2, 3, 4, 5].map(n => <label key={n} className={draft.score >= n ? 'on' : ''}><input type="radio" name={`rating-${runId}-${target.stage}`} value={n} checked={draft.score === n} onChange={() => edit({ score: n })} required /><Star size={22} fill={draft.score >= n ? 'currentColor' : 'none'} aria-hidden="true" /><span>{n}</span></label>)}
    </div></fieldset>
    <label className="st-feedback-label">{zh ? '具体反馈（可选）' : 'Specific feedback (optional)'}<textarea className="st-in st-area" aria-label={zh ? '具体反馈（可选）' : 'Specific feedback (optional)'} rows={3} maxLength={2000} value={draft.note} onChange={e => edit({ note: e.target.value })} placeholder={zh ? '哪一部分有效，哪里需要修改？' : 'What worked, and what should change?'} /></label>
    <details><summary>{zh ? '希望下次采用的方向（可选）' : 'Preferences for next time (optional)'}</summary><div className="st-preference-choices">{Object.entries(options).map(([key, option]) => <label className="st-feedback-label" key={key}>{say(option.label, lang)}<select className="st-in" aria-label={say(option.label, lang)} value={draft.choices[key] || ''} onChange={e => { const choices = { ...draft.choices }; if (e.target.value) choices[key] = e.target.value; else delete choices[key]; edit({ choices }) }}><option value="">{zh ? '不指定' : 'No preference'}</option>{Object.entries(option.values).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>)}</div></details>
    <div className="st-feedback-submit"><button className="st-btn st-btn-primary" disabled={busy || !draft.score || stale || !available}>{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存评分' : 'Save rating')}</button><span role="status">{saved && !dirty && !stale ? (zh ? '已保存；偏好已重新计算。' : 'Saved; preferences recalculated.') : dirty ? (zh ? '草稿尚未保存' : 'Draft not saved') : ''}</span></div>
    {error && <p className="st-bad" role="alert">{error}</p>}
  </form>
}
