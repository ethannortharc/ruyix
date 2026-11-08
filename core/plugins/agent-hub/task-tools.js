// The main agent's tools for the person's tasks (docs/design/agent-tasks.md): every piece of agent work on this machine
// is a task — a request in the conversation, a session's work, a job, a workflow's runs, a studio's line — in the
// workbench's task center (its `tasks` service). Look at them; on the person's word: accept a result (好了), send it back
// with what to change (再改), put it away (归档, undone by taking it back out). Deleting stays the person's, on the page.

const said = (zh, en) => ({ zh, en })
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const when = t => (t ? `${new Date(t).toISOString().slice(0, 16)}Z` : '')
const STATE_WORDS = { queued: 'queued', working: 'at work', waiting: 'waiting for the person', 'to-confirm': 'done, waiting for the person to accept', done: 'done', failed: 'failed', stopped: 'stopped' }
const line = t => `- ${t.id} | ${STATE_WORDS[t.state] || t.state}${t.archived ? ' (archived)' : ''} | ${t.source} | ${t.title}${t.agents?.length ? ` | ${t.agents.map(a => a.id).join(', ')}` : ''}${t.outputs ? ` | ${t.outputs} made` : ''}${t.waitingFor?.title ? ` | waits: ${t.waitingFor.title}` : ''} | run: ${t.lastRunId || '(none)'} | resultVersion: ${t.resultVersion || 0} | ${when(t.updatedAt)}`

/** `tasks`: the workbench's service (list, view, confirm, revise?, archive?). */
export function taskTools({ tasks }) {
  const must = async id => { const v = await tasks.view(String(id)); if (!v?.task) throw new Error(`no task ${id} (task_list)`); return v }
  const out = [
    {
      name: 'task_list',
      title: said('看任务', 'Tasks'),
      effect: 'read',
      description: 'The person\'s tasks — everything agents do here (a request in the conversation, a session\'s work, a job, a workflow\'s runs, a studio\'s line): id | state | where it came from | title | agents | how much it made | when. The ones at work and waiting for the person first. For "我有什么事在做 / 等我确认的 / 做完了什么". state: working | waiting | to-confirm | done | failed | stopped; q: words of its title.',
      parameters: schema({ state: { type: 'string' }, q: { type: 'string' }, archived: { type: 'boolean' } }),
      async run({ state, q, archived }) {
        const { tasks: list = [], counts = {} } = await tasks.list({ ...(state && { state }), ...(q && { q }), ...(archived && { archived: 'only' }), limit: 60 })
        const order = ['waiting', 'to-confirm', 'working', 'queued', 'failed', 'stopped', 'done']
        const sorted = [...list].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || b.updatedAt - a.updatedAt)
        return { text: [`Tasks (${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}):`, ...sorted.map(line)].join('\n') }
      },
    },
    {
      name: 'task_look',
      title: said('看一个任务', 'A task'),
      effect: 'read',
      description: 'One task (task_list): what happened in it, in order (messages, steps, approvals, the person\'s 好了 / 再改), and what it made (files, drafts, reports, posts) with how to open each. To tell the person where it stands, or before accepting or changing it.',
      parameters: schema({ id: { type: 'string' } }, ['id']),
      async run({ id }) {
        const { task, timeline = [], outputs = [] } = await must(id)
        return { text: [line(task), 'What happened:', ...timeline.slice(-30).map(e => `- ${when(e.at)} ${e.kind}${e.who?.id ? ` (${e.who.id})` : e.who?.kind ? ` (${e.who.kind})` : ''}: ${String(e.text).slice(0, 200)}`),
          outputs.length ? 'What it made:' : 'It made nothing to keep.', ...outputs.slice(0, 30).map(o => `- ${o.kind}: ${o.title}${o.url ? ` ${o.url}` : ''}`)].join('\n') }
      },
    },
    {
      name: 'task_confirm',
      title: said('确认好了', 'Accept'),
      effect: 'direct',
      description: 'The person accepts a task\'s result (they said 好了 / 可以 / 没问题 about it): it is done. Only on their word, never because the work looks finished to you. Pass the resultVersion and run from the task_look/task_list result the person saw; do not fetch a new version to accept it.',
      parameters: schema({ id: { type: 'string' }, expect: { type: 'integer', minimum: 0 }, run: { type: 'string', description: 'lastRunId shown, or empty for a task without runs' } }, ['id', 'expect', 'run']),
      async run({ id, expect, run }) {
        if (!Number.isInteger(expect) || expect < 0 || typeof run !== 'string') throw Object.assign(new Error('use the resultVersion and run the person saw (task_look)'), { code: 'changedMeanwhile' })
        const { task } = await must(id)
        await tasks.confirm(task.id, run, expect)
        return { text: `${task.title}: accepted, done.`, summary: said(`确认好了：${task.title}`, `Accepted: ${task.title}`) }
      },
    },
  ]
  if (tasks.revise) out.push({
    name: 'task_revise',
    title: said('再改', 'Change it'),
    effect: 'direct',
    description: 'The person wants a task\'s result changed: their words (what to change), as they said them, go to the task\'s agent — the session, the job, the workflow — and the task is at work again. Pass the resultVersion and run the person saw (task_look/task_list), without replacing them with a freshly fetched result.',
    parameters: schema({ id: { type: 'string' }, text: { type: 'string', description: 'what to change, in the person\'s words' }, expect: { type: 'integer', minimum: 0 }, run: { type: 'string', description: 'lastRunId shown, or empty for a task without runs' } }, ['id', 'text', 'expect', 'run']),
    async run({ id, text, expect, run }) {
      if (!Number.isInteger(expect) || expect < 0 || typeof run !== 'string') throw Object.assign(new Error('use the resultVersion and run the person saw (task_look)'), { code: 'changedMeanwhile' })
      const { task } = await must(id)
      await tasks.revise(task.id, text, run, expect)
      return { text: `${task.title}: sent back to its agent with "${text}".`, summary: said(`再改：${task.title}`, `Sent back: ${task.title}`) }
    },
  })
  if (tasks.archive) out.push({
    name: 'task_archive',
    title: said('归档', 'Archive'),
    effect: 'direct',
    description: 'Put a task away (归档) when the person asks: out of the lists, kept in the record; its undo takes it back out. A task at work: stop it first (it is the person\'s to say).',
    parameters: schema({ id: { type: 'string' } }, ['id']),
    async run({ id }) {
      const { task } = await must(id)
      await tasks.archive(task.id, true)
      return { text: `${task.title}: archived.`, summary: said(`归档了：${task.title}`, `Archived: ${task.title}`), undo: { tool: 'task_unarchive', args: { id: task.id } } }
    },
  }, {
    name: 'task_unarchive',
    title: said('取回', 'Take back out'),
    effect: 'undo',
    description: 'Take an archived task back out (task_archive\'s undo).',
    parameters: schema({ id: { type: 'string' } }, ['id']),
    async run({ id }) { await tasks.archive(String(id), false); return { text: `${id} is back in the lists.` } },
  })
  return out
}
