// The agents' messages of a run (core/messages, docs/design/agent-messages.md): a workflow that lets its agents message
// each other (`messages: true` in its definition, or a pack's workflow saying so) gives every agent step three tools and
// the skill that says how to use them; each run has a space of its own, runs/<id>/messages.db — beside the run's folder,
// so never in its versions. Not the ledger: a message is no evidence and leaves no entry; the run page reads the space as
// it is. An agent posts under the name the run gives it (its role at its step): it cannot speak for another.
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSpace } from '@ruyix/messages'
import { TOOLS, TOOL_NAMES, callTool } from '@ruyix/messages/tools'
import { dirOf } from './subject.js'

export const MESSAGE_TOOLS = TOOL_NAMES
/** The skill pack the workbench registers for it (Agent Hub), and the skill a step's agent is given. */
export const SKILL_PACK = { id: 'messages', title: 'Messages between agents', dir: fileURLToPath(new URL('./skills', import.meta.resolve('@ruyix/messages'))) }
export const SKILL_REF = 'messages/agent-messages'

/** Whether a workflow's agents may message each other (a person's definition says so, or a pack's workflow). */
export const messagesOn = wf => !!(wf?.def?.messages ?? wf?.messages)
/** The name an agent posts under: its role at its step (`writer@draft`); a step that is its own role (a person's agent step): the step. */
export const posterOf = (actor, stage) => (!actor || actor === stage || actor === 'agent' ? stage : `${actor}@${stage}`)

/** A file a message names, as the run page opens it: a path in the run's folder, not the folder's full path (else as it was). */
export function inFolder(run, file) {
  const f = String(file)
  if (!isAbsolute(f)) return f
  const rel = relative(dirOf(run), f)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : f
}

/** The spaces of a store's runs (root: the store's folder). → { of(runId), tools, log(runId, opts), close() } */
export function createRunMessages(root) {
  const open = new Map()
  const fileOf = id => join(root, 'runs', String(id), 'messages.db')
  const of = id => {
    if (!open.has(id)) open.set(id, openSpace(fileOf(id)))
    return open.get(id)
  }
  return {
    of,
    /** The three tools, for the workbench's tool table: a call is the agent's step's (c.actor at c.stage) in its run's space. */
    tools: TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.parameters,
      run: (c, args) => callTool(of(c.run.id), posterOf(c.actor, c.stage), t.name, Array.isArray(args?.files) ? { ...args, files: args.files.map(f => inFolder(c.run, f)) } : args, { signal: c.signal }) })),
    /** What the run page shows: the messages (oldest first; before: older than that number, after: newer) and who used the space — no file made for a run that has none. */
    log(id, { before = null, after = null, limit = 200 } = {}) {
      if (!open.has(id) && !existsSync(fileOf(id))) return { messages: [], members: [] }
      const s = of(id)
      return { messages: s.log({ before, after, limit }), members: s.members() }
    },
    close(id) {
      if (id !== undefined) { open.get(id)?.close(); open.delete(id); return }
      for (const s of open.values()) s.close(); open.clear()
    },
  }
}
