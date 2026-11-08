// Pickers shared by the workflow editor and the settings: an agent of the pool, the skills of a step, a model.
import { useId } from 'react'
import { Wand2, X } from 'lucide-react'
import { cx, modelText, useT } from './ui.jsx'

/** An agent of the pool. `def`: the role's default agent (the empty choice then means "the default"); `none`: offers "no fallback". */
export function AgentSelect({ value, agents, onChange, def, none }) {
  const t = useT()
  return (
    <select className="wb-input" value={value ?? ''} onChange={e => onChange(e.target.value)}>
      {def !== undefined ? <option value="">{t('set.stepDefault', { id: def || t('set.fallbackNone') })}</option> : !none && <option value="">—</option>}
      {none && <option value="-">{t('set.fallbackNone')}</option>}
      {value && value !== '-' && !agents.some(a => a.id === value) && <option value={value}>{t('set.agentMissing', { id: value })}</option>}
      {agents.map(a => <option key={a.id} value={a.id}>{a.name && a.name !== a.id ? a.name : a.id}{a.model ? ` · ${modelText(a)}` : ''}</option>)}
    </select>
  )
}

/** The skills given to a step: chips, and a menu of the ones not given yet. */
export function SkillPicker({ value = [], skills, onChange }) {
  const t = useT()
  return (
    <div className="wf-chips">
      {value.map(ref => <span key={ref} className="wf-chip-on" title={skills.find(s => s.ref === ref)?.description}><Wand2 size={11} />{ref}<button aria-label={t('wfc.removeSkill')} onClick={() => onChange(value.filter(x => x !== ref))}><X size={11} /></button></span>)}
      {value.length < 10 && skills.some(s => !value.includes(s.ref)) && (
        <select className="wb-input wf-add" value="" onChange={e => e.target.value && onChange([...value, e.target.value])}>
          <option value="">{t('wfc.addSkill')}</option>
          {skills.filter(s => !value.includes(s.ref)).map(s => <option key={s.ref} value={s.ref}>{s.ref}</option>)}
        </select>
      )}
      {!skills.length && !value.length && <span className="wb-sub">{t('wfc.noSkills')}</span>}
    </div>
  )
}

const MODEL = /^[a-z][a-z0-9-]{0,40}:\S{1,200}$/
/** Is this a model a step can name: "<connection>:<model>" or "dsh:<provider>/<model>" (lib/models.js)? */
export const isModel = v => MODEL.test(v) && (!v.startsWith('dsh:') || /^dsh:[^/\s]+\/\S+$/.test(v))

/**
 * A model, typed: "<connection>:<model>" or "dsh:<provider>/<model>", with dsh's models and the connections offered.
 * `def`: the default (empty then means "the default"). `models`: dsh's ([{ id: provider/model }]); `connections`: the
 * Connectors page's ([{ id, type }]).
 */
export function ModelPicker({ value, onChange, def, models = [], connections = [] }) {
  const t = useT()
  const id = useId()
  const v = value ?? ''
  const ok = !v || isModel(v)
  const offers = [...new Set([def, ...connections.filter(c => c.type === 'http').map(c => `${c.id}:`), ...models.map(m => `dsh:${m.id}`)].filter(Boolean))]
  return (
    <>
      <input className={cx('wb-input wb-mono', !ok && 'wb-bad-input')} list={id} value={v} spellCheck={false} placeholder={def ? t('set.stepDefault', { id: def }) : 'openrouter:anthropic/claude-sonnet-5.5'} onChange={e => onChange(e.target.value.trim())} />
      <datalist id={id}>{offers.map(m => <option key={m} value={m} />)}</datalist>
      {!ok && <small className="wb-field-error">{t('set.modelBad')}</small>}
    </>
  )
}
