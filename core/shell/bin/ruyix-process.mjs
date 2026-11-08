// A port and a recycled PID do not prove which service is safe to stop.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// whose dsh a process is, from its arguments: one string when npm exec renamed it ("npm exec @deepseek-ai/dsh@<v> --profile …")
// or, on macOS, ps's whole command line (split on spaces: a path with a space in it is not recognised, and is refused)
export function identify(argv, title = argv.length === 1 ? argv[0] : '') {
  const flag = argv.findIndex(a => a === '--profile')
  const profile = flag >= 0 ? argv[flag + 1] : argv.find(a => a.startsWith('--profile='))?.slice(10)
    || title.match(/(?:^| )--profile(?:=| )([\w.-]+)(?: |$)/)?.[1] || 'default'
  const dsh = argv.some(a => {
    if (!a.startsWith('/')) return false
    try { return realpathSync(a).includes('/node_modules/@deepseek-ai/dsh/') } catch { return false }
  }) || /^npm exec @deepseek-ai\/dsh@[\w.-]+ --profile(?:=| )/.test(title) || /(?:^|\/)npx -y @deepseek-ai\/dsh@[\w.-]+ --profile(?:=| )/.test(title.replace(/^\S*node /, ''))
  return { profile, dsh }
}

/**
 * One line of `ps -o pid=,ppid=,pgid=,uid=,lstart=,command=` (macOS): lstart is five words in any locale's order ("Tue Oct
 * 13 09:12:01 2026" under C, "Tue 13 Oct …" under en_CA), kept as it is — it is only compared with itself. macOS's ps
 * has no session id (its `sess` is a kernel address): a group leader stands for one, as setsid makes it on Linux.
 */
export function parsePs(line) {
  const m = String(line).trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/)
  if (!m) throw new Error('cannot parse process line')
  const [pid, parent, group, uid] = m.slice(1, 5).map(Number), command = m[6]
  return { pid, uid, parent, group, session: group, start: m[5].replace(/\s+/g, ' '), ...identify(command.split(/\s+/), command) }
}

export function readProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('invalid process id')
  if (process.platform === 'darwin') {
    let out = ''
    try { out = execFileSync('ps', ['-p', String(pid), '-ww', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,command='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }) } catch (err) { out = err.stdout || '' }
    // no such process: as /proc's missing directory says it (a process gone is not an error to stop it)
    if (!out.trim()) throw Object.assign(new Error(`no process ${pid}`), { code: 'ENOENT' })
    return parsePs(out)
  }
  const base = `/proc/${pid}`
  const stat = readFileSync(`${base}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const argv = readFileSync(`${base}/cmdline`, 'utf8').split('\0').filter(Boolean)
  return { pid, uid: statSync(base).uid, parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), start: fields[19], ...identify(argv) }
}

export function ownedProcess(identity, profile, record, read = readProcess, uid = process.getuid()) {
  if (identity?.product !== 'ruyix' || identity.profile !== profile) throw new Error('the port belongs to another service or profile')
  const server = read(identity.pid)
  const matches = p => p.uid === uid && p.dsh && p.profile === profile
  if (!matches(server)) throw new Error('the server process is not this profile’s dsh')
  let target = server
  if (record) {
    const saved = read(record.pid)
    if (!matches(saved) || (record.start && saved.start !== record.start)) throw new Error('the saved process id is stale or belongs to another profile')
    let ancestor = server
    const seen = new Set()
    while (ancestor.pid !== saved.pid && ancestor.parent > 1 && !seen.has(ancestor.pid)) {
      seen.add(ancestor.pid); ancestor = read(ancestor.parent)
    }
    if (ancestor.pid !== saved.pid) throw new Error('the saved process is not the server’s parent')
    target = saved
  }
  return { pid: target.pid, start: target.start, group: target.group === target.pid && target.session === target.pid }
}

export function signalProcess(target, profile, signal, read = readProcess, kill = process.kill, uid = process.getuid()) {
  let p
  try { p = read(target.pid) } catch (err) { if (err.code === 'ENOENT') return; throw err }
  if (p.uid !== uid || !p.dsh || p.profile !== profile || p.start !== target.start) throw new Error('process identity changed; refusing to signal it')
  const group = target.group ?? (p.group === p.pid && p.session === p.pid)
  if (group && (p.group !== p.pid || p.session !== p.pid)) throw new Error('process group changed; refusing to signal it')
  try { kill(group ? -p.pid : p.pid, signal) } catch (err) { if (err.code !== 'ESRCH') throw err }
}

function main() {
  const [op, profile, value, extra] = process.argv.slice(2)
  if (op === 'remember') {
    const p = readProcess(Number(value))
    if (p.uid !== process.getuid()) throw new Error('the process has another owner')
    writeFileSync(extra, JSON.stringify({ pid: p.pid, start: p.start }) + '\n', { mode: 0o600 })
  } else if (op === 'owned') {
    const identity = JSON.parse(readFileSync(0, 'utf8'))
    let record
    try {
      const raw = readFileSync(value, 'utf8').trim()
      record = /^\d+$/.test(raw) ? { pid: Number(raw) } : JSON.parse(raw)
    } catch (err) { if (err.code !== 'ENOENT') throw err }
    console.log(JSON.stringify(ownedProcess(identity, profile, record)))
  } else if (op === 'alive') {
    // the dsh a pid file names still runs: that very process (its start), a dsh of that profile → exit 0
    let record
    try { const raw = readFileSync(value, 'utf8').trim(); record = /^\d+$/.test(raw) ? { pid: Number(raw) } : JSON.parse(raw) } catch { process.exit(1) }
    let p
    try { p = readProcess(Number(record?.pid)) } catch { process.exit(1) }
    process.exit(p.dsh && p.profile === profile && (!record.start || p.start === record.start) ? 0 : 1)
  } else if (op === 'signal') {
    signalProcess(JSON.parse(value), profile, extra)
  } else throw new Error('unknown process operation')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() } catch (err) { console.error(err.message); process.exitCode = 1 }
}
