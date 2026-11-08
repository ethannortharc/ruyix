// Host half of the box plugin: the nookbox box this dsh runs in, inside dsh. It reads the box's own window on nookbox
// (http://nookbox.internal/v1 — answered by the nookbox gateway for this box only; no token, read-only) and serves it to
// the panel and, as tools, to every AI session. Changing the box (policy, credentials, mounts, ports) stays on the host,
// out of reach of what runs in the box; the panel shows the host command for it.
// Settings (~/.ruyix/box/settings.json): api — the box API's address; empty = the one nookbox gives the box.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { boxApi, coded, shieldOf } from './lib/box.js'
import { setupTools } from './lib/tools.js'

export const inject = ['connection', 'agents']
export const HOME = join(homedir(), '.ruyix/box')
const DEFAULTS = { api: '' }

export function apply(ctx, _config, { home = HOME, env = process.env } = {}) {
  const settingsFile = join(home, 'settings.json')
  // read once and on save: a read per request would fill the box's own timeline with this file
  let current = (() => { try { return { ...DEFAULTS, ...JSON.parse(readFileSync(settingsFile, 'utf8')) } } catch { return { ...DEFAULTS } } })()
  const settings = () => ({ ...current })
  const save = s => { mkdirSync(home, { recursive: true }); writeFileSync(`${settingsFile}.tmp`, `${JSON.stringify(s, null, 2)}\n`); renameSync(`${settingsFile}.tmp`, settingsFile); current = { ...s } }
  // nookbox tells each box where its window is (NOOKBOX_API); the setting can point elsewhere (a test server)
  const base = () => settings().api || env.NOOKBOX_API || ''
  const api = () => boxApi(base())
  // the AI work beside the box's insights: the workbench's (a ruyix part) Agent Hub tasks, workflow steps and own model calls
  let shell = () => null
  ctx.inject?.(['ruyixShell'], inner => { shell = () => inner.ruyixShell; inner.effect(() => () => { shell = () => null }, 'box: ruyix parts') })
  // ponytail: the first workbench's — each one's aiWork has every Agent Hub task; a second product's own steps and calls would need a merge
  const aiWork = async hours => {
    const w = shell()?.parts?.().find(p => p.workbench?.aiWork)?.workbench
    if (!w) throw coded('noWorkbench', 'no workbench in this Ruyix: the AI work done here is not known')
    return w.aiWork({ hours: Math.min(Math.max(Number(hours) || 24, 1), 24 * 90) })
  }
  setupTools(ctx, { api, aiWork })

  // the shield (the top bar's light, the desk's box widget): the box in a few numbers since `since`, one call, kept 60 s per since
  const shields = new Map() // since → { at, value }
  const shield = async ({ since } = {}) => {
    const now = Date.now()
    // the browser's local midnight; anything else (none, in the future, over two days back) is the last 24 hours
    let from = Number(since)
    if (!Number.isFinite(from) || from > now || from < now - 48 * 3600e3) from = now - 24 * 3600e3
    from = Math.floor(from)
    const kept = shields.get(from)
    if (kept && now - kept.at < 60e3) return kept.value
    const hours = Math.min(Math.max(Math.ceil((now - from) / 3600e3), 1), 48)
    let value
    if (!base()) value = { inBox: false }
    else {
      try {
        const [box, stats, insights] = await Promise.all([api().box(), api().stats({ hours }), api().insights({ hours })])
        value = shieldOf({ box, stats, insights }, from)
      } catch (err) {
        // outside a box it is a state; a nookbox that fails or lacks insights (before 0.5.0) is told by its code
        value = err.code === 'notInBox' ? { inBox: false } : { inBox: true, error: err.code === 'notFound' ? 'oldNookbox' : err.code || 'http' }
      }
    }
    for (const [k, v] of shields) if (now - v.at >= 60e3) shields.delete(k)
    shields.set(from, { at: now, value })
    return value
  }

  const ops = {
    shield,
    async status() {
      const where = base()
      if (!where) return { inBox: false, api: '', settings: settings() }
      try { return { inBox: true, api: where, settings: settings(), ...await api().box() } } catch (err) {
        if (err.code === 'notInBox') return { inBox: false, api: where, settings: settings(), error: err.message }
        throw err
      }
    },
    flows: ({ limit, before, host }) => api().flows({ limit: Math.min(Number(limit) || 100, 500), before, host }),
    flow: ({ id }) => { if (!/^\d+$/.test(String(id ?? ''))) throw coded('badId', 'no such exchange'); return api().flow(String(id)) },
    events: ({ kinds, before, text, limit }) => api().events({ kinds, before, text, limit: Math.min(Number(limit) || 200, 500) }),
    usage: ({ days }) => api().usage({ days: Math.min(Math.max(Number(days) || 30, 1), 365) }),
    stats: ({ hours }) => api().stats({ hours: Math.min(Math.max(Number(hours) || 24, 1), 24 * 365) }),
    // a host nookbox from before 0.5.0 has no insights: said as such, not as a missing record
    insights: ({ hours }) => api().insights({ hours: Math.min(Math.max(Number(hours) || 24, 1), 24 * 90) }).catch(err => {
      throw err.code === 'notFound' ? coded('oldNookbox', 'the host runs a nookbox without insights: upgrade it (0.5.0 or later)') : err
    }),
    aiWork: ({ hours }) => aiWork(hours),
    saveSettings({ settings: patch }) {
      const next = { ...settings() }
      if (patch && Object.hasOwn(patch, 'api')) {
        const v = String(patch.api || '').trim()
        if (v && !/^https?:\/\/[^\s/]+\/?$/.test(v)) throw coded('badApi', 'the address must be http(s)://host[:port]', { value: v })
        next.api = v
      }
      save(next)
      return { settings: next }
    },
  }
  ctx.connection.fetch.register({
    path: '/api/ruyix-box',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const { op, ...args } = await request.json()
        if (!Object.hasOwn(ops, op)) return Response.json({ error: `unknown op ${op}` }, { status: 400 })
        return Response.json(await ops[op](args))
      } catch (err) {
        // outside a box (or a box whose nookbox does not answer): a state, not a server error
        return Response.json({ error: err?.message || String(err), code: err?.code, params: err?.params }, { status: err?.code === 'notInBox' ? 409 : 500 })
      }
    },
  })
}
