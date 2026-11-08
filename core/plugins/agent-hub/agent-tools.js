// The agent pool as system tools (docs/design/agent-control.md): see the agents, add or change one ("建一个专门写周报的
// 智能体"), take one out, choose the default — each undoable, as the Agents page does it. Giving an agent full access stays
// the person's, on the Agents page: an agent does not hand out more power than it was given.

const said = (zh, en) => ({ zh, en })
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const FIELDS = ['id', 'name', 'runtime', 'model', 'effort', 'access', 'skills', 'notes', 'endpoint', 'browser']
const defOf = a => Object.fromEntries(FIELDS.filter(k => a[k] !== undefined && a[k] !== null).map(k => [k, a[k]]))

/** `ops`: Agent Hub's (saveAgent, deleteAgent, setDefaultAgent); `agent(id)`, `agents()`, `config()`; `store` (its docs). */
export function agentTools({ ops, agent, agents, config, store }) {
  const line = a => `- ${a.id} | ${a.name}${a.id === config().defaultAgent ? ' (default)' : ''}${a.id === config().mainAgent ? ' (main)' : ''} | ${a.runtime || 'dsh'}${a.model ? ` · ${a.model}` : ''}${a.effort ? ` · ${a.effort}` : ''}${a.access ? ` · access ${a.access}` : ''}${a.skills?.length ? ` | skills: ${a.skills.join(', ')}` : ''}${a.notes ? ` | ${a.notes}` : ''}`
  return [
    {
      name: 'agent_list',
      title: said('看智能体', 'The agents'),
      effect: 'read',
      description: 'The agents of the pool: id | name (default / main) | runtime · model · effort · access | skills | notes. Runtimes: dsh (inside Ruyix), claude (Claude Code), codex, pi.',
      parameters: schema({}),
      async run() { const list = agents(); return { text: list.length ? list.map(line).join('\n') : 'The pool has no agents yet.' } },
    },
    {
      name: 'agent_save',
      title: said('加一个智能体 / 改智能体', 'Add or change an agent'),
      effect: 'direct',
      description: 'Add an agent to the pool, or change one (by its id, which never changes) — when the person asks for one ("一个专门写周报的智能体"). '
        + 'runtime: dsh | claude | codex | pi; model: the runtime\'s model id (dsh: "provider/model"); effort: low | medium | high (where the runtime has it); skills: up to 10 "pack/skill"; notes: what it is for, in a line (it is told so). '
        + 'Full access (anything on this machine without asking) is set by the person on the Agents page, not here. Undoable.',
      parameters: schema({ id: { type: 'string', description: 'lowercase letters, digits, dashes' }, name: { type: 'string' }, runtime: { type: 'string', enum: ['dsh', 'claude', 'codex', 'pi'] }, model: { type: 'string' }, effort: { type: 'string' }, skills: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' }, endpoint: { type: 'string' } }, ['id']),
      async run(args) {
        if ('access' in args) throw new Error('an agent\'s access is the person\'s to set, on the Agents page')
        const old = agent(String(args.id || '').trim().toLowerCase())
        const def = old ? { ...defOf(old), ...args } : { runtime: 'dsh', ...args }
        const { agent: a } = await ops.saveAgent({ ...(old && { prev: old.id, expect: old.revision || 0 }), ...def })
        const changed = old ? FIELDS.filter(k => !['id', 'access'].includes(k) && JSON.stringify(old[k] ?? null) !== JSON.stringify(a[k] ?? null)) : []
        const pick = (v, keys = changed) => Object.fromEntries(keys.map(k => [k, v[k] ?? null]))
        const guard = changed.some(k => ['runtime', 'model', 'endpoint', 'effort'].includes(k)) ? pick(a, ['runtime', 'model', 'endpoint', 'effort']) : {}
        return old
          ? { text: `Changed the agent ${a.id}.`, summary: said(`改了智能体：${a.name}`, `Changed the agent ${a.name}`), undo: { tool: 'agent_put_back', args: { id: old.id, before: pick(old), after: { ...guard, ...pick(a) } } } }
          : { text: `Added the agent ${a.id} (${a.runtime || 'dsh'}${a.model ? ` · ${a.model}` : ''}). Start work with it: session_start { agent: "${a.id}" }.`, summary: said(`加了智能体：${a.name}`, `Added the agent ${a.name}`), undo: { tool: 'agent_unadd', args: { id: a.id, after: a.revision || 0 } } }
      },
    },
    {
      name: 'agent_remove',
      title: said('拿掉一个智能体', 'Take an agent out'),
      effect: 'direct',
      description: 'Take an agent out of the pool — when the person says so. Refused while a workflow names it or it has work under way. Undoable (it comes back as it was).',
      parameters: schema({ id: { type: 'string' } }, ['id']),
      async run({ id }) {
        const a = agent(String(id || ''))
        if (!a) throw new Error(`no agent "${id}" (agent_list)`)
        const was = { default: config().defaultAgent === a.id, main: config().mainAgent === a.id }
        await ops.deleteAgent({ id: a.id })
        return { text: `Took ${a.id} out of the pool.${was.default || was.main ? ' It was the default / main agent: those now fall back.' : ''}`, summary: said(`拿掉了智能体：${a.name}`, `Took out the agent ${a.name}`), undo: { tool: 'agent_unremove', args: { id: a.id, ...was } } }
      },
    },
    {
      name: 'agent_default',
      title: said('设默认智能体', 'Set the default agent'),
      effect: 'direct',
      description: 'Choose the default agent (a dsh one): it leads jobs and is Ruyix\'s helpers\' model. Not the main agent (the one the person talks to): that is the person\'s to change, in Settings → General. Undoable.',
      parameters: schema({ id: { type: 'string' } }, ['id']),
      async run({ id }) {
        const before = config().defaultAgent || null
        await ops.setDefaultAgent({ id: String(id || '') })
        return { text: `The default agent is now ${id}.`, summary: said(`默认智能体换成了 ${id}`, `The default agent is now ${id}`), undo: { tool: 'agent_default_back', args: { id: before, after: String(id || '') || null } } }
      },
    },
    // the undo ones (offered to no agent)
    {
      name: 'agent_put_back', effect: 'undo', description: 'Undo only the fields agent_save changed, if they still match.',
      parameters: schema({ id: { type: 'string' }, before: { type: 'object' }, after: { type: 'object' } }, ['id', 'before', 'after']),
      async run({ id, before, after }) {
        const current = agent(id), keys = before && Object.keys(before)
        if (!current || !after || !keys || keys.some(k => !FIELDS.includes(k) || ['id', 'access'].includes(k)) || Object.keys(after || {}).some(k => JSON.stringify(current?.[k] ?? null) !== JSON.stringify(after[k] ?? null)))
          throw Object.assign(new Error('this agent changed elsewhere: look at its current settings'), { code: 'agentChanged' })
        await ops.saveAgent({ ...defOf(current), ...before, prev: id, expect: current.revision || 0 })
        return { text: `${id}: the changed fields are as they were.` }
      },
    },
    { name: 'agent_unadd', effect: 'undo', description: 'Undo agent_save of a new one.', parameters: schema({ id: { type: 'string' }, after: { type: 'integer' } }, ['id', 'after']), async run({ id, after }) { if (after === undefined || (agent(id)?.revision || 0) !== after) throw Object.assign(new Error('this agent changed since: look at it before undoing its creation'), { code: 'agentChanged' }); await ops.deleteAgent({ id, expect: after, unused: true }); return { text: `${id} is out again.` } } },
    {
      name: 'agent_unremove', effect: 'undo', description: 'Undo agent_remove.', parameters: schema({ id: { type: 'string' }, default: { type: 'boolean' }, main: { type: 'boolean' } }, ['id']),
      async run({ id, default: wasDefault, main }) {
        const d = store.getDoc('agent', String(id))
        if (!d?.deleted) throw new Error(`${id} is not out of the pool`)
        store.putDoc('agent', { ...d, deleted: false })
        if (wasDefault && !config().defaultAgent) await ops.setDefaultAgent({ id })
        if (main && !config().mainAgent) await ops.mainSet?.({ agent: id })
        return { text: `${id} is back in the pool.` }
      },
    },
    { name: 'agent_default_back', effect: 'undo', description: 'Undo agent_default.', parameters: schema({ id: { type: ['string', 'null'] }, after: { type: ['string', 'null'] } }, ['after']), async run({ id, after }) { if (after === undefined || (config().defaultAgent || null) !== after) throw Object.assign(new Error('the default agent changed since'), { code: 'agentChanged' }); await ops.setDefaultAgent({ id: id || null }); return { text: `The default agent is ${id || 'dsh\'s own'} again.` } } },
  ]
}
