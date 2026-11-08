// Who does each step — the engine and the UI read the same definitions and settings.

/** A role that is one model call (no tools, no agent of the pool): `{ kind: 'model', model: '<source>:<model>', text }`. */
export const isModelRole = def => def?.kind === 'model'

/**
 * A model step's model: the person's choice for it (settings.steps[workflow][step].model), else its role's, else the
 * workbench's default model (settings.model) — and the role's text, its system prompt. null when the role is no model.
 */
export function stepModel(workflow, key, settings, role) {
  const stage = workflow.stages.find(s => s.key === key)
  const owner = role || stage?.owner
  const def = workflow.roles?.[owner]
  if (!isModelRole(def)) return null
  const at = stage?.owner === owner ? key : workflow.stages.find(s => s.owner === owner)?.key || key
  const pick = workflow.stages.find(s => s.key === at)?.pick || settings.steps?.[workflow.id]?.[at] || {}
  return { role: owner, step: at, kind: 'model', model: pick.model || def.model || settings.model || '', text: def.text || '', defaults: { model: def.model || settings.model || '' } }
}
/** The model steps a run of this workflow takes (those turned off left out), each with its model. */
export const modelSteps = (workflow, settings) => workflow.stages.filter(s => s.owner !== 'system' && isModelRole(workflow.roles?.[s.owner]) && !(s.optional && settings.stages?.[s.key] === false))
  .map(s => stepModel(workflow, s.key, settings))

/**
 * A step's agent: the person's choice for it (settings.steps[workflow][step]) or its role's default — the agent, its
 * fallback, the access the role needs, the role's text, extra skills. A step that calls another role takes what that
 * role's own step was given.
 */
export function stepAgent(workflow, key, settings, role) {
  const stage = workflow.stages.find(s => s.key === key)
  const owner = role || stage?.owner
  const def = workflow.roles?.[owner]
  if (!def || isModelRole(def)) return null
  const at = stage?.owner === owner ? key : workflow.stages.find(s => s.owner === owner)?.key || key
  // a person's workflow carries its picks in its steps; a built-in one takes them from the settings
  const pick = workflow.stages.find(s => s.key === at)?.pick || settings.steps?.[workflow.id]?.[at] || {}
  return {
    role: owner, step: at, agent: pick.agent || def.agent, fallback: pick.fallback === undefined ? def.fallback || null : pick.fallback || null,
    access: def.access || 'read', text: def.text, skills: Array.isArray(pick.skills) ? pick.skills : [], defaults: { agent: def.agent, fallback: def.fallback || null },
  }
}
const agentSteps = workflow => workflow.stages.filter(s => s.owner !== 'system' && workflow.roles?.[s.owner] && !isModelRole(workflow.roles[s.owner]))
// The agents a script step asks, by role (roles["<step>.<role>"], lib/workflows.js compose): [{ key (the step), role }]
const flowRoles = workflow => workflow.stages.filter(s => s.generic === 'flow').flatMap(s => (s.flowRoles || []).map(r => ({ key: s.key, role: `${s.key}.${r}` })))
/** The agents a run of this workflow uses — each step's that is on, and its fallback: what is checked before it starts. */
export const workflowAgents = (workflow, settings) => [...new Set([
  ...agentSteps(workflow).filter(s => !(s.optional && settings.stages?.[s.key] === false)).map(s => stepAgent(workflow, s.key, settings)),
  ...flowRoles(workflow).map(r => stepAgent(workflow, r.key, settings, r.role)),
].flatMap(a => [a.agent, a.fallback]).filter(Boolean))]
/**
 * Each workflow's steps that someone does, as the settings show them: an agent step — the role, the agent and fallback in
 * use, the defaults; a model step (`kind: 'model'`) — the role, the model in use, its default.
 */
export const stepAgents = (workflows, settings) => workflows.map(wf => ({ id: wf.id, title: wf.title, steps: wf.stages.filter(s => s.owner !== 'system' && wf.roles?.[s.owner])
  .map(s => ({ key: s.key, optional: !!s.optional, ...(isModelRole(wf.roles[s.owner]) ? stepModel(wf, s.key, settings) : { kind: 'agent', ...stepAgent(wf, s.key, settings) }) })) }))

// A step's skills: the pack's (pack.skills.uses) — a script it runs, or one it gives the step's agent (member: true) —
// those the person added to the step, and the agent's own.
const stageSkills = (key, step, agent, uses) => {
  const given = uses.filter(u => u.member && u.stages?.includes(key)).map(u => u.ref)
  return [
    ...uses.filter(u => u.stages?.includes(key)).map(u => ({ ref: u.ref, via: u.member ? 'step' : 'script', what: u.what })),
    ...(step?.skills || []).filter(ref => !given.includes(ref)).map(ref => ({ ref, via: 'step' })),
    ...(agent?.skills || []).filter(ref => !given.includes(ref) && !step?.skills?.includes(ref)).map(ref => ({ ref, via: 'agent' })),
  ]
}
export function workflowInfo(workflow, settings, hub, uses = []) {
  return { id: workflow.id, stages: workflow.stages.map(stage => {
    const model = stage.owner !== 'system' ? stepModel(workflow, stage.key, settings) : null
    if (model) return { key: stage.key, owner: stage.owner, member: model.role, kind: 'model', model: model.model, agent: null, disabled: !!stage.optional && settings.stages?.[stage.key] === false, skills: [] }
    const step = stage.owner !== 'system' ? stepAgent(workflow, stage.key, settings) : null
    const agent = step && hub?.agent?.(step.agent)
    const fb = step?.fallback && hub?.agent?.(step.fallback)
    return { key: stage.key, owner: stage.owner, member: step?.role || null, agent: step?.agent || null, disabled: !!stage.optional && settings.stages?.[stage.key] === false,
      runtime: agent?.runtime, model: agent?.model, effort: agent?.effort, fallback: step?.fallback ? { id: step.fallback, runtime: fb?.runtime, model: fb?.model } : null,
      skills: stageSkills(stage.key, step, agent, uses) }
  }) }
}

// a step's name for the Skills page: the pack's own wording (pack.text.stageNames: key → { en, zh }), else the step's title, else its key
const named = (workflow, pack, key, lang) => {
  const own = pack?.text?.stageNames?.[key]?.[lang]
  const title = workflow?.stages.find(s => s.key === key)?.title
  return own || (typeof title === 'string' ? title : title?.[lang]) || key
}
const byOf = (pack, workflow) => (pack ? `${pack.name?.en || pack.id}` : workflow.title || 'Workbench')

/**
 * What the workbench uses each skill for, for Agent Hub's Skills page: [{ ref, by, where: { en, zh } }] — the packs'
 * scripts (the steps that run them) and the skills given to a step (the pack's, and those a person added).
 * `packs`: the registered packs; `workflows`: [{ workflow, pack }].
 */
export function skillUses(workflows, settings, packs) {
  const out = []
  for (const pack of packs) {
    const wf = workflows.find(x => x.pack?.id === pack.id)?.workflow
    const step = k => ({ en: named(wf, pack, k, 'en'), zh: named(wf, pack, k, 'zh') })
    for (const u of pack.skills.uses || []) {
      out.push({ ref: u.ref, by: byOf(pack), kind: u.member ? 'step' : 'script', steps: u.stages.map(step), what: u.what,
        where: Object.fromEntries(['en', 'zh'].map(l => [l, `${u.stages.map(k => named(wf, pack, k, l)).join(' · ')}${u.what ? ` — ${u.what[l] || u.what.en}` : ''}`])) })
    }
  }
  for (const { workflow: wf, pack } of workflows) {
    for (const s of agentSteps(wf)) {
      for (const ref of stepAgent(wf, s.key, settings).skills) out.push({ ref, by: byOf(pack, wf), kind: 'step', steps: [{ en: named(wf, pack, s.key, 'en'), zh: named(wf, pack, s.key, 'zh') }], where: { en: `${wf.title || wf.id} › ${named(wf, pack, s.key, 'en')}`, zh: `${wf.title || wf.id} › ${named(wf, pack, s.key, 'zh')}` } })
    }
  }
  return out
}

/** Which agents the workbench uses, for what (Agent Hub shows it with each agent and keeps an agent in use from deletion). */
export function agentUses(workflows, settings) {
  return workflows.flatMap(({ workflow: wf, pack }) => [...agentSteps(wf).map(s => ({ s, a: stepAgent(wf, s.key, settings) })), ...flowRoles(wf).map(r => ({ s: { key: r.key }, a: stepAgent(wf, r.key, settings, r.role) }))].flatMap(({ s, a }) => {
    const where = l => `${wf.title || wf.id} › ${named(wf, pack, s.key, l)}`
    const by = byOf(pack, wf)
    return [{ agent: a.agent, by, where: { en: where('en'), zh: where('zh') } }, ...(a.fallback ? [{ agent: a.fallback, by, where: { en: `${where('en')} (fallback)`, zh: `${where('zh')}（备用）` } }] : [])]
  }))
}
