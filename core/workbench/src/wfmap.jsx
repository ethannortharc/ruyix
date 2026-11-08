// How a workflow does its work, before a run starts: its steps in order, who does each (an agent of the pool, a model,
// the person, the system), where it waits for the person, what may leave the machine (only once the person approves)
// and which steps may use the web — so the person knows what they are starting and where they come in.
import { Bot, Cog, Globe, Hand, Send, Stamp, Zap } from 'lucide-react'
import { cx, useT, word } from './ui.jsx'

/** One step as the map shows it: { key, who: agent | model | person | approval | system, name (the agent, the model), person?, sends?, web?, optional? }. */
export function stepsOf(wf) {
  const lib = new Map((wf?.library || []).map(x => [x.key, x]))
  return (wf?.steps || []).filter(s => !s.par).map(s => {
    const l = lib.get(s.key)
    const who = s.person || s.generic === 'person' ? 'person' : s.generic === 'approval' ? 'approval' : l?.model || s.generic === 'model' ? 'model' : l?.agent || (s.owner && s.owner !== 'system') ? 'agent' : 'system'
    return { key: s.key, who, name: l?.agent?.agent || l?.model?.model || '', person: s.person || (who === 'person' ? 'review' : null), sends: !!s.sends, web: !!s.web, optional: !!s.optional }
  })
}
const ICON = { agent: Bot, model: Zap, person: Hand, approval: Stamp, system: Cog }

export function WorkflowMap({ wf }) {
  const t = useT()
  const steps = stepsOf(wf)
  if (steps.length < 2) return null
  const yours = steps.filter(s => s.who === 'person' || s.who === 'approval')
  const agents = [...new Set(steps.filter(s => s.who === 'agent' && s.name).map(s => s.name))]
  const name = k => t(`stage.${k}`)
  return (
    <div className="wb-wfmap">
      <div className="wb-wfmap-title">{t('wfm.title')}</div>
      <ol className="wb-wfmap-line">
        {steps.map((s, i) => {
          const Icon = ICON[s.who]
          return (
            <li key={s.key} className={cx('wb-wfmap-step', `wb-wfmap-${s.who}`, s.optional && 'wb-wfmap-optional')} title={`${name(s.key)} · ${t(`wfm.who.${s.who}`)}${s.name ? ` (${s.name})` : ''}${s.optional ? ` · ${t('wfm.optional')}` : ''}`}>
              {i > 0 && <span className="wb-wfmap-arrow" aria-hidden="true" />}
              <span className="wb-wfmap-dot"><Icon size={12} /></span>
              <span className="wb-wfmap-name">{name(s.key)}</span>
              <span className="wb-wfmap-who">{s.who === 'person' ? word(t, `wfm.person.${s.person}`, t('wfm.who.person')) : s.name || t(`wfm.who.${s.who}`)}</span>
              {(s.sends || s.web) && <span className="wb-wfmap-marks">{s.web && <Globe size={10} title={t('wfm.web')} />}{s.sends && <Send size={10} title={t('wfm.sends')} />}</span>}
            </li>
          )
        })}
      </ol>
      <ul className="wb-wfmap-notes">
        {yours.length > 0 && <li><Hand size={12} />{t('wfm.yours', { steps: yours.map(s => name(s.key)).join(t('wfm.sep')) })}</li>}
        {steps.some(s => s.sends) && <li><Send size={12} />{t('wfm.sendsNote', { steps: steps.filter(s => s.sends).map(s => name(s.key)).join(t('wfm.sep')) })}</li>}
        {steps.some(s => s.web) && <li><Globe size={12} />{t('wfm.webNote', { steps: steps.filter(s => s.web).map(s => name(s.key)).join(t('wfm.sep')) })}</li>}
        {agents.length > 0 && <li><Bot size={12} />{t('wfm.agents', { agents: agents.join(t('wfm.sep')) })}</li>}
        <li className="wb-sub">{t('wfm.steer')}</li>
      </ul>
    </div>
  )
}
