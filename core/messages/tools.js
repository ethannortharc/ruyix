// The three tools an agent uses on a space — the same for the MCP server (bin/agent-msg.mjs mcp) and for Ruyix's
// workbench, which gives them to a run's agents through its own MCP with the name filled in by the run (an agent there
// cannot post as another). Answers are plain text: an agent reads them, nothing parses them.
import { LIMITS } from './index.js'

export const TOOLS = [
  {
    name: 'messages_post',
    description: 'Leave a message for the other agents working with you: a hand-off (what you made, where it is, what is left), a decision that changes their part, or a question for one of them. One point per message, a few lines; put results in files and name the files here. Not seen by the person as a request — ask the person the usual way.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: `The message (at most ${LIMITS.text} characters).` },
        to: { type: 'string', description: 'One agent\'s name (see messages_read for the names); leave out to tell everyone.' },
        topic: { type: 'string', description: 'A short label to group messages (default: general).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Paths of files the message is about.' },
        reply_to: { type: 'integer', description: 'The number (#) of the message this answers.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'messages_read',
    description: 'Read the messages left for you (or for everyone) since you last read, oldest first. Read when you start, before you finish, and before you decide something another agent may already have decided.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'At most this many (default 50).' } } },
  },
  {
    name: 'messages_wait',
    description: `Wait until a message comes for you (from one agent, if named), then read it. Waits at most timeout_s seconds (default 120, at most ${LIMITS.waitS}); if nothing comes, go on with your own best judgment and say so in a message.`,
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Only a message from this agent ends the wait.' },
        timeout_s: { type: 'integer', description: `Seconds to wait (1–${LIMITS.waitS}).` },
      },
    },
  },
]
export const TOOL_NAMES = TOOLS.map(t => t.name)

const clock = at => new Date(at).toTimeString().slice(0, 5)
/** Messages as an agent reads them: `#12 10:31 adapter@adapt → you [general]: …`, the files and what it answers under it. */
export function messagesText(messages, me) {
  return messages.map(m => [
    `#${m.id} ${clock(m.at)} ${m.from} → ${m.to ? (m.to === me ? 'you' : m.to) : 'everyone'}${m.topic !== 'general' ? ` [${m.topic}]` : ''}${m.replyTo ? ` (re #${m.replyTo})` : ''}: ${m.text}`,
    ...(m.files.length ? [`   files: ${m.files.join(', ')}`] : []),
  ].join('\n')).join('\n')
}

/** Run one of the tools for `as` on `space`. → the answer's text (a refusal throws, with what to do instead). */
export async function callTool(space, as, name, args = {}, { signal } = {}) {
  const others = () => space.members().map(m => m.name).filter(n => n !== as)
  const who = () => { const o = others(); return o.length ? ` Others here: ${o.join(', ')}.` : ' No one else has used this space yet.' }
  if (name === 'messages_post') {
    const m = space.post({ from: as, to: args.to, topic: args.topic, text: args.text, files: args.files || [], replyTo: args.reply_to })
    return `Posted #${m.id} as ${as} to ${m.to || 'everyone'}.`
  }
  if (name === 'messages_read') {
    const r = space.read({ as, limit: args.limit })
    if (!r.messages.length) return `Nothing new for ${as}.${who()}`
    return `You are ${as}. ${r.messages.length} new message(s):\n${messagesText(r.messages, as)}${r.more ? '\n(more: read again)' : ''}`
  }
  if (name === 'messages_wait') {
    const r = await space.wait({ as, from: args.from, timeoutS: args.timeout_s, signal })
    if (r.timedOut) return `Nothing came for ${as}${args.from ? ` from ${args.from}` : ''} in time. Go on with your own best judgment, and say what you assumed in a message.${who()}`
    return `You are ${as}. ${r.messages.length} new message(s):\n${messagesText(r.messages, as)}${r.more ? '\n(more: read again)' : ''}`
  }
  throw Object.assign(new Error(`no such tool: ${name} (there are ${TOOL_NAMES.join(', ')})`), { code: 'noTool' })
}
