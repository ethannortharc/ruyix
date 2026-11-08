// The pool's sessions in a terminal (docs/design/agent-work.md §5) — a mirror: the session stays the structured process
// Agent Hub runs; this shows its conversation as it goes, and what you type is sent to it.
//   ruyix session list                       the sessions: id, state, agent, title
//   ruyix session attach <id | its title's start>   the conversation, live; type and press Enter to send it a message,
//                                            /stop stops its turn, Ctrl-D (or /quit) leaves the mirror (the session goes on)
// It asks Agent Hub over its socket (<hub's home>/sessions.sock, or the path in sessions.sock.path): the box user's only.
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface, clearLine, cursorTo } from 'node:readline'
import { sayText, toolText } from '../src/work-lines.js'

const hubHome = process.env.DSH_AGENT_HUB_HOME || join(homedir(), '.ruyix/agent-hub')
const lang = /^en/i.test(process.env.RUYIX_LANG || '') ? 'en' : 'zh'
const W = { zh: { none: '还没有会话', notFound: id => `没有会话「${id}」（ruyix session list）`, down: '连不上 Agent Hub（Ruyix 在跑吗？）', you: '你', turn: (n, ok, why) => (ok ? `—— 这一轮完了（${n} 次工具）` : `—— 这一轮没做成：${why}`), queued: '（它正在做，这条排在这一轮之后）', stopped: '（停下了这一轮）', gone: '这个会话已经删掉了', help: '在下面打字、回车就是发给它；/stop 停下这一轮；Ctrl-D 离开（会话照常）' },
  en: { none: 'No sessions yet', notFound: id => `No session "${id}" (ruyix session list)`, down: 'Agent Hub does not answer (is Ruyix running?)', you: 'you', turn: (n, ok, why) => (ok ? `— turn done (${n} tool calls)` : `— the turn did not finish: ${why}`), queued: '(it is at work: this comes after this turn)', stopped: '(its turn stopped)', gone: 'This session was removed', help: 'Type below and press Enter to send it; /stop stops its turn; Ctrl-D leaves (the session goes on)' } }[lang]
const tty = process.stdout.isTTY
/** How many columns a line takes (wide characters two). */
const width = s => [...s].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1), 0)
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)

function sockPath() {
  const own = join(hubHome, 'sessions.sock')
  if (existsSync(`${own}.path`)) return readFileSync(`${own}.path`, 'utf8').trim()
  return own
}
let conn = null, buf = '', n = 0
const waits = new Map()
function ask(op, args = {}) {
  if (!conn) {
    conn = createConnection(sockPath())
    conn.setEncoding('utf8')
    conn.on('data', ch => { buf += ch; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); const w = waits.get(m.id); if (w) { waits.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m) } } })
    conn.on('error', () => { for (const w of waits.values()) w.reject(new Error(W.down)); waits.clear(); conn = null })
  }
  const id = ++n
  return new Promise((resolve, reject) => { waits.set(id, { resolve, reject }); conn.write(`${JSON.stringify({ id, op, ...args })}\n`) })
}

const target = a => { let o = a; if (typeof o === 'string') { try { o = JSON.parse(o) } catch { return '' } } if (!o || typeof o !== 'object') return ''; return o.file_path || o.path || o.command || o.url || o.query || o.pattern || o.description || '' }
/** One event as lines a person reads. */
function show(e, said) {
  const d = e.data || {}
  switch (e.type) {
    case 'user/message': return [c('36', `› ${d.text}`)]
    case 'assistant/message': { const t = (d.message?.content || []).map(x => x.text || '').join('').trim(); said.last = t; return t ? [t] : [] }
    case 'tool/call': return [c('2', `  · ${toolText({ name: d.name, target: target(d.arguments) }, lang)}`)]
    case 'turn/end': {
      const out = []
      if (d.output && d.output.trim() !== said.last) out.push(d.output.trim()) // (an answer only its end carried)
      said.last = null
      out.push(c(d.ok ? '2' : '31', W.turn(d.tools || 0, d.ok, sayText(d.error || '', 120))), '')
      return out
    }
    case 'note': return [c('2;3', `(${d.text})`)]
    default: return []
  }
}

async function list() {
  const { sessions } = await ask('list')
  if (!sessions.length) return console.log(W.none)
  for (const s of sessions) console.log(`${s.id}  ${s.state === 'working' ? '●' : s.process === 'on' ? '○' : '·'} ${String(s.agent).padEnd(12)} ${s.title}`)
}

async function attach(which) {
  const { sessions } = await ask('list')
  const s = sessions.find(x => x.id === which) || sessions.find(x => x.id.endsWith(which)) || sessions.find(x => x.title.startsWith(which))
  if (!s) throw new Error(W.notFound(which))
  console.log(c('1', s.title), c('2', `· ${s.agent} · ${s.cwd}`))
  console.log(c('2', W.help))
  console.log('')
  const said = {}
  let after = 0
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout, prompt: c('36', '› ') }) : null
  const print = lines => {
    if (!lines.length) return
    if (rl) { clearLine(process.stdout, 0); cursorTo(process.stdout, 0) }
    for (const l of lines) console.log(l)
    rl?.prompt(true)
  }
  let pulling = false
  const pull = async () => {
    if (pulling) return
    pulling = true
    try {
      const r = await ask('read', { sid: s.id, after })
      const events = r.events.filter(e => e.seq > after)
      if (events.length) after = events.at(-1).seq
      print(events.flatMap(e => show(e, said)))
    } finally { pulling = false }
  }
  await pull()
  const timer = setInterval(() => pull().catch(err => { print([c('31', /no session/.test(err.message) ? W.gone : err.message)]); clearInterval(timer); process.exit(1) }), 700)
  if (!rl) return // (no keyboard: only the mirror — until stopped)
  rl.prompt()
  rl.on('line', async line => {
    const text = line.trim()
    // (what was typed goes: the conversation shows it as the session heard it, once — and what is typed elsewhere too)
    const rows = Math.max(1, Math.ceil((2 + width(line)) / (process.stdout.columns || 80)))
    process.stdout.write('\x1b[1A\x1b[2K'.repeat(rows) + '\r')
    if (!text) return rl.prompt()
    if (text === '/quit') return rl.close()
    try {
      if (text === '/stop') { await ask('stop', { sid: s.id }); print([c('2', W.stopped)]) } else { const r = await ask('send', { sid: s.id, text }); if (r.queued) print([c('2', W.queued)]) }
    } catch (err) { print([c('31', err.message)]) }
    rl.prompt()
  })
  rl.on('close', () => { clearInterval(timer); conn?.end(); process.exit(0) })
}

const [cmd, arg] = process.argv.slice(2)
try {
  if (cmd === 'list' || !cmd) await list()
  else if (cmd === 'attach' && arg) await attach(arg)
  else { console.error('ruyix session list | ruyix session attach <id | the start of its title>'); process.exit(2) }
  if (cmd !== 'attach') { conn?.end(); process.exit(0) }
} catch (err) { console.error(`ruyix session: ${err.message}`); process.exit(1) }
