#!/usr/bin/env node
// agent-msg: messages between agents, from a shell or as an MCP server (stdio). The same space file can be shared by
// any number of agents at once — Claude Code and Codex sessions on one Mac, the steps of a Ruyix run.
//   agent-msg post <text…> [--to NAME] [--topic T] [--file PATH]… [--reply N]
//   agent-msg read [--peek] [--limit N]          what is new for you, oldest first
//   agent-msg wait [--from NAME] [--timeout S]   until something comes (at most 10 min)
//   agent-msg log [--topic T] [--limit N]        everything (the newest N)
//   agent-msg who                                who has used the space
//   agent-msg mcp                                the MCP server: tools messages_post / messages_read / messages_wait
//   agent-msg setup                              how to add it to Claude Code and Codex (prints; changes nothing)
// Everywhere: --space NAME|PATH (AGENT_MSG_SPACE; default: default → ~/.agent-messages/default.db), --as NAME
// (AGENT_MSG_AS; the MCP server, without one, takes its client's name and a short random tail), --json.
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { openSpace, spacePath } from '../index.js'
import { TOOLS, callTool, messagesText } from '../tools.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL = join(HERE, '..', 'skills', 'agent-messages')
const MANY = new Set(['file'])
const FLAGS = new Set(['peek', 'json', 'help'])

function parse(argv) {
  const o = { _: [], file: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const [k, inline] = a.slice(2).split(/=(.*)/s)
    if (FLAGS.has(k)) { o[k] = true; continue }
    const v = inline ?? argv[++i]
    if (v === undefined) throw new Error(`--${k} needs a value`)
    if (MANY.has(k)) o[k].push(v); else o[k] = v
  }
  return o
}

const say = (o, data, text) => console.log(o.json ? JSON.stringify(data, null, 2) : text)
const asOf = o => o.as || process.env.AGENT_MSG_AS || null
const needAs = o => asOf(o) || (() => { throw new Error('say who you are: --as <name> (or AGENT_MSG_AS)') })()

async function mcp(space, given) {
  let as = given
  const running = new Map() // a call's id → its AbortController (notifications/cancelled stops a wait)
  const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)
  const handle = async (m, signal) => {
    switch (m.method) {
      case 'initialize': {
        const client = String(m.params?.clientInfo?.name || 'agent').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent'
        as ||= `${client}-${randomBytes(2).toString('hex')}`
        return { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-msg', version: '0.1.0' }, instructions: `Messages between the agents working together (space ${space.file}). You are ${as}.` }
      }
      case 'ping': return {}
      case 'tools/list': return { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) }
      case 'tools/call':
        try {
          return { content: [{ type: 'text', text: await callTool(space, as || 'agent', m.params?.name, m.params?.arguments || {}, { signal }) }] }
        } catch (err) {
          return { content: [{ type: 'text', text: err.message }], isError: true }
        }
      default: throw Object.assign(new Error(`method not found: ${m.method}`), { code: -32601 })
    }
  }
  const rl = createInterface({ input: process.stdin })
  rl.on('line', async line => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (m.method === 'notifications/cancelled') { running.get(m.params?.requestId)?.abort(); return }
    if (m.id === undefined || m.id === null) return
    const ac = new AbortController()
    running.set(m.id, ac)
    try {
      send({ jsonrpc: '2.0', id: m.id, result: await handle(m, ac.signal) })
    } catch (err) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: err.code || -32603, message: err.message } })
    } finally { running.delete(m.id) }
  })
  await new Promise(ok => rl.on('close', ok))
}

function setup(space) {
  const bin = fileURLToPath(import.meta.url)
  console.log(`agent-msg: messages between agents. Space: ${space}

Claude Code (every session; each one gets its own name, or start it with AGENT_MSG_AS=<name>):
  claude mcp add --scope user agent-msg -- node ${bin} mcp --space ${space}

Codex (~/.codex/config.toml):
  [mcp_servers.agent-msg]
  command = "node"
  args = ["${bin}", "mcp", "--space", "${space}"]
  default_tools_approval_mode = "approve"   # its three tools only touch this space
  tool_timeout_sec = 660                    # messages_wait may wait 10 min (Codex cuts a call at 60 s by default)

The skill that says when and how to use it (link it where each agent looks for skills):
  ln -s ${SKILL} ~/.claude/skills/agent-messages
  ln -s ${SKILL} ~/.codex/skills/agent-messages
  ln -s ${SKILL} ~/.agents/skills/agent-messages

Agents pointed at the same space read each other's messages. Nothing above was changed: run what you want.`)
}

async function main() {
  const o = parse(process.argv.slice(2))
  const [cmd = 'help', ...rest] = o._
  if (o.help || cmd === 'help') {
    console.log('usage: agent-msg post|read|wait|log|who|mcp|setup [--space NAME|PATH] [--as NAME] [--json] (see the top of bin/agent-msg.mjs)')
    return
  }
  const file = spacePath(o.space)
  if (cmd === 'setup') return setup(o.space || process.env.AGENT_MSG_SPACE || 'default')
  const space = openSpace(file)
  try {
    if (cmd === 'mcp') return await mcp(space, asOf(o))
    if (cmd === 'post') {
      const m = space.post({ from: needAs(o), to: o.to, topic: o.topic, text: rest.join(' '), files: o.file, replyTo: o.reply })
      return say(o, m, `posted #${m.id} to ${m.to || 'everyone'}`)
    }
    if (cmd === 'read' || cmd === 'wait') {
      const as = needAs(o)
      const r = cmd === 'read' ? space.read({ as, limit: o.limit, peek: o.peek }) : await space.wait({ as, from: o.from, timeoutS: o.timeout })
      return say(o, r, r.messages.length ? `${messagesText(r.messages, as)}${r.more ? '\n(more)' : ''}` : r.timedOut ? 'nothing came in time' : 'nothing new')
    }
    if (cmd === 'log') {
      const ms = space.log({ topic: o.topic ?? null, limit: o.limit })
      return say(o, ms, ms.length ? messagesText(ms, asOf(o)) : 'no messages yet')
    }
    if (cmd === 'who') {
      const ms = space.members()
      return say(o, ms, ms.length ? ms.map(m => `${m.name}  ${m.posted} posted  last seen ${new Date(m.seen).toLocaleString()}`).join('\n') : 'no one yet')
    }
    throw new Error(`unknown command: ${cmd} (post, read, wait, log, who, mcp, setup)`)
  } finally { space.close() }
}

main().catch(err => { console.error(`agent-msg: ${err.message}`); process.exit(1) })
