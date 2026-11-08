// Installs belong to the request that asked for them. Shared jobs settle every request; a request with several jobs
// stays at work until all finish. Pending associations survive a restart so a lost outcome is reported, not left working.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const said = (zh, en) => ({ zh, en })
const terminal = job => ['done', 'failed'].includes(job?.state)
const interrupted = why => ({ state: 'failed', error: `${why} before the outcome was confirmed: check App Center` })
const resultOf = ({ app, remove, job }) => {
  const ok = job.state === 'done', why = String(job.error || '').slice(0, 200)
  return remove
    ? (ok ? said(`${app.name.zh} 卸载好了。`, `${app.name.en} is uninstalled.`) : said(`没卸载成 ${app.name.zh}：${why}`, `Could not uninstall ${app.name.en}: ${why}`))
    : (ok ? said(`${app.name.zh} 装好了。${app.kind === 'gui' || app.kind === 'term' ? '可以打开了。' : ''}`, `${app.name.en} is installed.${app.kind === 'gui' || app.kind === 'term' ? ' It can be opened now.' : ''}`)
      : said(`没装成 ${app.name.zh}：${why}`, `Could not install ${app.name.en}: ${why}`))
}

export function createPieces({ tasks = () => null, log = () => {}, home = null } = {}) {
  const file = home && join(home, 'apps-pending-tasks.json'), open = new Map() // job id → request entries
  let previous = []
  try { if (file && existsSync(file)) previous = JSON.parse(readFileSync(file, 'utf8')) } catch (err) { log(`apps: pending tasks: ${err.message}`) }
  previous = (Array.isArray(previous) ? previous : []).filter(p => typeof p?.task === 'string' && typeof p.app?.name?.en === 'string' && typeof p.app?.name?.zh === 'string')
  const persist = () => {
    if (!file) return
    const pending = [...previous, ...[...open.values()].flat()]
    if (!pending.length) { rmSync(file, { force: true }); return }
    mkdirSync(home, { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(pending), { mode: 0o600 }); renameSync(`${file}.tmp`, file)
  }
  const tell = (id, patch) => {
    try {
      const t = tasks(), fn = t?.update || t?.change
      if (!fn) return false
      if (t.get && !t.get(id)) return true
      fn.call(t, id, patch); return true
    } catch (err) { log(`apps: task ${id}: ${err?.message || err}`); return false }
  }
  const settle = () => {
    for (const task of new Set([...open.values()].flat().map(p => p.task))) {
      const entries = [...open.values()].flat().filter(p => p.task === task)
      if (!entries.every(p => terminal(p.job))) continue
      const results = entries.map(resultOf), ok = entries.every(p => p.job.state === 'done')
      if (!tell(task, { state: ok ? 'done' : 'failed', result: said(results.map(r => r.zh).join('\n'), results.map(r => r.en).join('\n')) })) continue
      for (const [id, list] of open) { const rest = list.filter(p => p.task !== task); if (rest.length) open.set(id, rest); else open.delete(id) }
    }
  }
  return {
    now() { try { return tasks()?.current?.() || null } catch { return null } },
    start(task, job, app, remove = false) {
      if (!task || !job?.id) return
      const entries = open.get(job.id) || []
      if (entries.some(p => p.task === task)) return
      entries.push({ task, app, remove }); open.set(job.id, entries); persist()
      tell(task, { state: 'working', step: remove ? said(`正在卸载 ${app.name.zh}`, `Uninstalling ${app.name.en}`) : said(`正在安装 ${app.name.zh}`, `Installing ${app.name.en}`) })
    },
    end(job) {
      if (!terminal(job) || !open.has(job.id)) return
      for (const entry of open.get(job.id)) entry.job = { state: job.state, error: job.error || '' }
      persist(); settle(); persist()
    },
    recover() {
      for (const entry of previous) { if (!terminal(entry.job)) entry.job = interrupted('Ruyix restarted'); open.set(Symbol('recovered'), [entry]) }
      previous = []; persist(); settle(); persist()
    },
    dispose() {
      for (const entries of open.values()) for (const entry of entries) if (!terminal(entry.job)) entry.job = interrupted('Ruyix stopped')
      persist(); settle(); persist()
    },
    open: () => [...open.keys()],
  }
}
