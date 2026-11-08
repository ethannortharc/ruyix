// Finding things by what they are for (docs/design/agent-control.md; Ethan: "我之前记很多 APP，这个 APP 做什么、那个 APP
// 做什么，太麻烦了"): one search for the agent over what this Ruyix can do (the system tools, the apps of the App Center)
// and what there is (pages, settings, what is open, tasks, sessions, studios and their records, …). Each plugin adds its
// own kinds (ruyixShell.finders.register); every hit says how to act on it — which tool, with what.
//   finder: { kind, title: { zh, en }, find(query, { limit }) → [{ id, title, hint?, how?, at?, text? }] }
//   (`text`: more words to match than it shows — a summary, keywords; `at`: when it was last touched, for the order)

import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const CJK = /[㐀-鿿豈-﫿]/

/** The units a text is matched by: its latin / number words, and every pair of CJK characters next to each other (and
 * a lone one) — 「剪视频」 meets 「剪辑视频」 on 视频. */
export function unitsOf(text) {
  const s = String(text || '').toLowerCase(), out = new Set()
  for (const w of s.match(/[a-z0-9][a-z0-9_.-]*/g) || []) out.add(w)
  for (const run of s.match(/[㐀-鿿豈-﫿]+/g) || []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

/** How well `query` meets these texts: 0 (not at all) … 1 (every unit of it), a little more when it is there whole. */
export function scoreOf(query, ...texts) {
  const q = unitsOf(query)
  if (!q.size) return 0
  const hay = texts.filter(Boolean).map(t => String(t).toLowerCase()).join('\n')
  let hit = 0
  for (const u of q) {
    if (CJK.test(u) ? hay.includes(u) : new RegExp(`(^|[^a-z0-9])${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(hay)) hit++
  }
  const whole = String(query).trim().toLowerCase()
  return hit / q.size + (hit && whole && hay.includes(whole) ? 0.25 : 0)
}

const TARGET_KEYS = ['app', 'page', 'tab', 'id', 'agent', 'studio', 'name']
/**
 * What the person has used (~/.ruyix/usage.json): each thing a tool acted on — an app opened, a page, an agent … —
 * counted, with when last. `boost(id)`: a little more for a thing used often and lately (at most 0.3).
 */
export function createUsage({ file, now = Date.now }) {
  let all = null
  const read = () => (all ??= (() => { try { const v = JSON.parse(readFileSync(file, 'utf8')); return v && typeof v === 'object' ? v : {} } catch { return {} } })())
  return {
    note(tool, args = {}) {
      const key = TARGET_KEYS.map(k => args[k]).find(v => typeof v === 'string' && v && v.length <= 120)
      if (!key) return
      const u = read(), was = u[key] || { n: 0 }
      u[key] = { n: Math.min(was.n + 1, 1000), at: now(), tool }
      const keys = Object.keys(u)
      if (keys.length > 500) for (const k of keys.sort((a, b) => u[a].at - u[b].at).slice(0, keys.length - 500)) delete u[k]
      try { writeFileSync(`${file}.tmp`, JSON.stringify(u)); renameSync(`${file}.tmp`, file) } catch { /* kept in memory */ }
    },
    boost(id) {
      const x = read()[String(id)]
      if (!x) return 0
      const days = (now() - x.at) / 86400e3
      return Math.min(0.3, 0.06 * Math.log2(1 + x.n) + (days < 1 ? 0.1 : days < 7 ? 0.05 : 0))
    },
  }
}

export function createFinders({ boost = () => 0 } = {}) {
  const finders = new Map()
  return {
    register(f) {
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(String(f?.kind || '')) || typeof f.find !== 'function') throw new Error(`a finder is { kind, title, find }: ${f?.kind}`)
      if (finders.has(f.kind)) throw new Error(`a finder of ${f.kind} is there already`)
      finders.set(f.kind, f)
      return () => { if (finders.get(f.kind) === f) finders.delete(f.kind) }
    },
    kinds: () => [...finders.values()].map(f => ({ kind: f.kind, title: f.title })),
    /** Every finder asked at once (one that fails or takes over 4 s is left out) → hits, best first. */
    async find(query, { kinds = null, limit = 20 } = {}) {
      const asked = [...finders.values()].filter(f => !kinds?.length || kinds.includes(f.kind))
      const per = await Promise.all(asked.map(f => {
        let timer
        return Promise.race([
          Promise.resolve().then(() => f.find(String(query), { limit: 40 })).catch(() => []),
          new Promise(r => { timer = setTimeout(() => r([]), 4000) }),
        ]).finally(() => clearTimeout(timer)).then(hits => (Array.isArray(hits) ? hits : []).map(h => ({ ...h, kind: f.kind, score: h.score ?? scoreOf(query, h.title, h.hint, h.text) })))
      }))
      // (what the person used often and lately comes a little before the rest — never in place of a match)
      return per.flat().filter(h => h.score > 0.34 && h.title).map(h => ({ ...h, score: h.score + (boost(h.id) || 0) }))
        .sort((a, b) => b.score - a.score || (b.at || 0) - (a.at || 0))
        .slice(0, Math.min(Math.max(1, limit), 60))
    },
  }
}

const said = (zh, en) => ({ zh, en })
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

/**
 * The finder of what can be done here — the system tools themselves (an ability the agent may not know it has) — and
 * the `find` tool over every finder.
 */
export function findParts({ finders, tools }) {
  const abilities = {
    kind: 'ability',
    title: said('能做的事', 'What can be done'),
    find: () => tools.list().filter(t => !t.chat && t.name !== 'find').map(t => ({ id: t.name, title: t.title?.en || t.name, hint: t.title?.zh || '', text: t.description, how: `${t.name} (${t.effect === 'read' ? 'only looks' : 'acts'})` })),
  }
  const tool = {
    name: 'find',
    title: said('查找', 'Find'),
    effect: 'read',
    description: 'Find anything in this Ruyix by what it is or what it is for, in the person\'s words ("剪视频", "上周的周报", "那个读书笔记", "终端", "搜索设置"): '
      + 'what can be done (the tools; the apps of the App Center, installed or not) and what there is (pages, settings, what is open, tasks, sessions, agents, studios and their records, workflows, runs, outputs). '
      + 'Each hit: [kind] title — hint → how to act on it (the tool and its arguments). Use it first when you do not know which app, page or thing the person means — they should never need to know which app does what.',
    parameters: schema({ query: { type: 'string', description: 'what to look for, in the person\'s words' }, kinds: { type: 'array', items: { type: 'string' }, description: 'only these kinds (find with no query lists them)' }, limit: { type: 'integer', minimum: 1, maximum: 60 } }),
    async run({ query = '', kinds, limit = 20 } = {}) {
      if (!String(query).trim()) return { text: `Kinds: ${finders.kinds().map(k => `${k.kind} (${k.title?.zh || k.kind})`).join(', ')}` }
      const hits = await finders.find(query, { kinds, limit })
      if (!hits.length) return { text: `Nothing here matches "${query}". If it is something to get, the App Center may have it (find with kinds ["app"]), or it can be made (an app, a studio, a workflow).` }
      return { text: hits.map(h => `- [${h.kind}] ${h.title}${h.hint ? ` — ${h.hint}` : ''}${h.how ? ` → ${h.how}` : ''}`).join('\n') }
    },
  }
  return { abilities, tool }
}
