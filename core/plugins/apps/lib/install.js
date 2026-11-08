// Installing Debian packages into the box (and removing ones it installed), and knowing what is installed.
// In a nookbox box, nookbox installs them (POST $NOOKBOX_API/v1/packages: apt as root from the image's own sources,
// kept in the box's spec so a rebuild has them too) — only when the box's spec allows it (`self_install`); the box user
// never has root. Outside a box nothing here installs: the page says what to run instead.
import { execFile as nodeExecFile } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { checkPackages } from './catalog.js'

/** An error the page can say in its language: code + params, the English message as the fallback. */
export const coded = (code, message, params) => Object.assign(new Error(message), { code, params })

/**
 * Which of `names` are installed: { name: true|false }. dpkg-query needs no root; it exits 1 when one of the names is
 * unknown and still prints the others. No dpkg at all (not a Debian system): null.
 */
export function installedOf(names, { execFile = nodeExecFile } = {}) {
  if (!names.length) return Promise.resolve({})
  return new Promise(resolve => {
    execFile('dpkg-query', ['-W', '-f=${Package}\t${db:Status-Abbrev}\n', ...names], { timeout: 15000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err && (err.code === 'ENOENT' || !stdout)) return resolve(err.code === 'ENOENT' ? null : Object.fromEntries(names.map(n => [n, false])))
      const ok = new Set()
      for (const line of String(stdout).split('\n')) {
        const [pkg, status] = line.split('\t')
        // "ii " = wanted install, installed; the package name may carry an :arch
        if (pkg && /^ii/.test(status || '')) ok.add(pkg.split(':')[0])
      }
      resolve(Object.fromEntries(names.map(n => [n, ok.has(n)])))
    })
  })
}

/**
 * A JSON request to the box's nookbox window. Not fetch: an install takes minutes before the answer's first byte, and
 * fetch (undici) gives up on headers after five; here only our own `timeoutMs` counts.
 */
export function nookboxCall(base, path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let url
    try { url = new URL(path, base) } catch { return reject(coded('notInBox', `not an address: ${base}`)) }
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method, headers: { accept: 'application/json', ...(data && { 'content-type': 'application/json', 'content-length': data.length }) },
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text })
      })
      res.on('error', reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(coded('timeout', `nookbox did not answer in ${Math.round(timeoutMs / 1000)} s`)))
    req.on('error', err => reject(err.code === 'timeout' ? err : coded('notInBox', `nookbox did not answer at ${base} (${err?.code || err?.message || err})`, { api: base })))
    req.end(data || undefined)
  })
}

const KEEP_DONE = 12 // finished jobs kept for the page to show

/**
 * The install queue: one apt run at a time (apt holds a lock anyway), the rest wait in order. A job is
 * { id, appId?, packages, remove?, state: queued|running|done|failed, output, error?, code?, params?, at, startedAt?,
 * endedAt? } — `remove`: the packages taken out again (nookbox 0.5.11's POST /v1/packages/remove: only ones nookbox
 * installed, with the dependencies only they needed; never the image's own).
 * `base()` is the box window's address ('' outside a box).
 */
export function createInstaller({ base, timeoutMs = 30 * 60e3, onChange = () => {}, log = () => {} }) {
  const jobs = []
  let seq = 0, running = null
  const boxInfo = async () => {
    const r = await nookboxCall(base(), '/v1/box').catch(() => null)
    return r?.status === 200 ? r.json : null
  }
  const pump = async () => {
    if (running) return
    const job = jobs.find(j => j.state === 'queued')
    if (!job) return
    running = job
    job.state = 'running'; job.startedAt = Date.now()
    onChange()
    try {
      const r = await nookboxCall(base(), job.remove ? '/v1/packages/remove' : '/v1/packages', { method: 'POST', body: { packages: job.packages }, timeoutMs })
      if (r.status === 200 && r.json?.ok) Object.assign(job, { state: 'done', output: r.json.output || '' })
      else if (r.status === 200) Object.assign(job, { state: 'failed', output: r.json?.output || '', code: 'aptFailed', error: `apt exited with ${r.json?.code}`, params: { status: r.json?.code } })
      else if (r.status === 403) {
        // the box's spec does not allow it: what to run on the host (nookbox's own words carry the box's name too)
        const name = (await boxInfo())?.box?.name || '<box>'
        Object.assign(job, { state: 'failed', code: 'notAllowed', error: r.json?.error || 'this box may not install packages itself', params: { box: name, allow: `nookbox update ${name} --self-install true`, install: `nookbox install ${name} ${job.packages.join(' ')}` } })
      } else if (r.status === 404) Object.assign(job, job.remove
        ? { state: 'failed', code: 'oldNookboxRemove', error: 'the host\'s nookbox cannot remove packages from inside a box: upgrade it (0.5.11 or later)' }
        : { state: 'failed', code: 'oldNookbox', error: 'the host\'s nookbox cannot install packages from inside a box: upgrade it (0.5.10 or later)' })
      else if (r.status === 400 && job.remove && /not installed into this box by nookbox/.test(r.json?.error || '')) Object.assign(job, { state: 'failed', code: 'notRemovable', error: r.json.error })
      else Object.assign(job, { state: 'failed', code: 'http', error: r.json?.error || `nookbox answered HTTP ${r.status}`, params: { status: r.status } })
    } catch (err) {
      Object.assign(job, { state: 'failed', code: err.code || 'failed', error: err.message || String(err), params: err.params })
    }
    job.endedAt = Date.now()
    log(`apps: ${job.remove ? 'uninstall' : 'install'} ${job.packages.join(' ')}: ${job.state}${job.error ? ` (${job.error})` : ''}`)
    running = null
    // keep the queue and the last few finished
    const finished = jobs.filter(j => j.state === 'done' || j.state === 'failed')
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_DONE))) jobs.splice(jobs.indexOf(j), 1)
    onChange(job)
    pump()
  }
  return {
    /** Queue packages (checked names) → the job; `remove`: to take them out again. Not in a box: throws notInBox. */
    add(packages, { appId, remove = false } = {}) {
      const names = checkPackages(packages)
      if (!base()) throw coded('notInBox', 'this Ruyix does not run in a nookbox box: nothing here can install software', { install: `sudo apt ${remove ? 'remove' : 'install'} ${names.join(' ')}` })
      const same = jobs.find(j => (j.state === 'queued' || j.state === 'running') && j.packages.join() === names.join() && !!j.remove === remove)
      if (same) return same
      const job = { id: `i${++seq}`, appId: appId || null, packages: names, ...(remove && { remove: true }), state: 'queued', output: '', at: Date.now() }
      jobs.push(job)
      onChange()
      pump()
      return job
    },
    jobs: () => jobs.map(j => ({ ...j })),
    /** What a restart would cut short: the queued and running installs. */
    busy: () => jobs.filter(j => j.state === 'queued' || j.state === 'running').map(j => `${j.remove ? 'uninstall' : 'install'} ${j.packages.join(' ')}: ${j.state}`),
    boxInfo,
  }
}
