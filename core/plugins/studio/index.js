// @ruyix/studio — studios (docs/design/studio.md): one end-to-end line of work pulled out of the whole system — what to
// make (its records), how (a workflow), who (agents), with what (materials, settings), what came of it (its runs) — with
// a home page of its own. A studio is mostly a declaration a pack registers (lib/declare.js); this half keeps its
// records (lib/store.js: <home>/<id>/studio.db), starts its workflow from a record, and follows the run to its end.
//   service `ruyixStudio` (for the packs and the workbench): register(declaration) → off · studios() · declaration(id)
//     · list(studio, collection) · get(studio, collection, id) · put(studio, collection, record, { by }) · remove(…)
//     · start(studio, startId, recordId, { by }) → run · onRunEnd(run) (the workbench calls it: the record's status moves)
//   /api/ruyix-studio (the pages; src/data.js): studios, studio, items, put, remove, restore, history, revs, materials,
//     upload, removeMaterial, start · GET /api/ruyix-studio/file?studio=&id= (a material's bytes, for its picture)
// The run ↔ record link lives in the run (run.studio = { id, collection, record }); a record's runs are the workbench's
// query (runsOf), never a list kept here.
// A studio of the person's own (the main agent made it from what they described: lib/tools.js studio_create) is its
// declaration in <home>/<id>/studio.json, registered at start like a pack's — only the workflows there are, no code.
// The main agent's tools (lib/tools.js) go on the shell's system tools.
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { studioTools } from './lib/tools.js'
import { STUDIO_ICONS, canStartRecord, checkRecord, defineStudio, plain } from './lib/declare.js'
import { MATERIAL_MAX, openStudioStore } from './lib/store.js'
import { studioFeedback } from './lib/feedback.js'

export const inject = ['connection']
export const HOME = process.env.RUYIX_STUDIO_HOME || join(homedir(), '.ruyix/studios')
const coded = (code, message, params = {}) => Object.assign(new Error(message), { code, params })
const DUE_DAYS = 14 // a reminder older than this is not brought up any more
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', json: 'application/json', csv: 'text/csv; charset=utf-8', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }

/** The studios' half that is not dsh's: for the plugin and for check.mjs. */
export function createStudios({ home = HOME, workbench = () => null, logger = null } = {}) {
  const decls = new Map(), stores = new Map(), own = new Map() // own: the person's studios (id → the declaration as written)
  const listeners = new Set()
  const starting = new Set()
  const runKey = at => `run:${at.collection}:${at.record}`
  const ownerOf = at => { try { return JSON.parse(storeOf(at.id).note(runKey(at))) } catch { return null } }
  const startOfRun = run => {
    const at = run?.studio
    if (!at?.id || !at.record || !decls.has(at.id)) return null
    const d = decls.get(at.id), owner = ownerOf(at)
    if (starting.has(`${at.id}:${runKey(at)}`)) return null
    if (owner ? owner.run !== run.id : workbench()?.runsOf?.({ studio: at.id, collection: at.collection, record: at.record })?.runs?.[0]?.id !== run.id) return null
    return d.start.find(x => x.from === at.collection && x.status && (owner ? x.id === owner.start : !run.template || x.workflow === run.template || x.workflow.endsWith(`.${run.template}`) || x.workflow === run.workflow)) || null
  }
  const rememberStatus = (run, value, written) => {
    const at = run.studio, owner = ownerOf(at)
    if (owner?.run === run.id && storeOf(at.id).get(at.collection, at.record)?.rev === written.rev) storeOf(at.id).setNote(runKey(at), JSON.stringify({ ...owner, managedStatus: value }))
  }
  const changed = (studio, collection) => { for (const fn of listeners) try { fn({ studio, collection }) } catch { /* one listener's trouble */ } }
  const declOf = id => decls.get(String(id)) || (() => { throw coded('noStudio', `no studio ${id}`, { studio: String(id) }) })()
  const storeOf = id => {
    const d = declOf(id)
    if (!stores.has(d.id)) stores.set(d.id, openStudioStore(join(home, d.id)))
    return stores.get(d.id)
  }
  const collOf = (studio, coll) => declOf(studio).collections[coll] || (() => { throw coded('noCollection', `${studio} has no collection ${coll}`, { studio, collection: coll }) })()
  const prefixOf = coll => coll.key.replace(/[^a-z]/gi, '').slice(0, 1).toLowerCase() || 'r'
  const writeOwn = (id, raw) => {
    const dir = join(home, id), file = join(dir, 'studio.json')
    openStudioStore(dir).close() // (its folder, as its records will have it)
    writeFileSync(`${file}.tmp`, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  // the first records of a collection, once (e.g. a pack's settings moved into its first account)
  const seed = d => {
    if (!d.seed) return
    const s = storeOf(d.id)
    let got = null
    for (const [k, c] of Object.entries(d.collections)) {
      if (c.runs || s.seeded(k)) continue
      try {
        got ??= d.seed({ packSettings: id => workbench()?.packSettings?.(id) || null }) || {}
        for (const rec of got[k] || []) s.put(k, c.single ? 'main' : null, checkRecord(c, rec), { by: 'seed', prefix: prefixOf(c) })
        s.markSeeded(k)
      } catch (err) { logger?.warn?.(`ruyix-studio: ${d.id}'s first ${k}: ${err.message}`) }
    }
  }

  /** A collection that lists the studio's runs (a workflow's): the workbench's query, as items. */
  const runItems = (d, c) => {
    const wb = workbench()
    if (!wb?.runsOf) return []
    const { runs = [] } = wb.runsOf({ studio: d.id, workflow: c.runs }) || {}
    return runs.map(r => ({
      id: r.id, title: r.title, status: r.status, ok: r.status === 'done' && r.verdict !== 'failed', record: r.studio?.record || null, ...(r.account && { account: r.account }),
      createdAt: r.createdAt, updatedAt: r.endedAt || r.createdAt, endedAt: r.endedAt || null, ...(r.outcome && { outcome: r.outcome }),
    }))
  }

  const studios = {
    register(input) {
      const d = defineStudio(input)
      decls.set(d.id, d)
      seed(d)
      changed(d.id, null)
      logger?.info?.(`ruyix-studio: ${d.id} (${Object.keys(d.collections).length} collections)`)
      return () => { if (decls.get(d.id) === d) { decls.delete(d.id); stores.get(d.id)?.close(); stores.delete(d.id); changed(d.id, null) } }
    },
    studios: () => [...decls.values()].map(d => ({ id: d.id, name: d.name, icon: d.icon })),
    declaration: id => plain(declOf(id)),
    // Only the workflow's pack chooses an implicit owner. A person's Studio may host a shared/core workflow,
    // but that does not make unrelated workbench tasks part of it. Explicit starts may select that Studio.
    workflowStudio(workflow, owner, { explicit = false } = {}) {
      const d = decls.get(owner)
      if (!d || (!explicit && own.has(owner))) return null
      return d.start.some(s => s.workflow === workflow) || Object.values(d.collections).some(c => c.runs === workflow) ? d.id : null
    },
    list(studio, coll) {
      const d = declOf(studio), c = collOf(studio, coll)
      return c.runs ? runItems(d, c) : storeOf(studio).list(coll)
    },
    get(studio, coll, id) { const c = collOf(studio, coll); return c.runs ? runItems(declOf(studio), c).find(r => r.id === id) || null : storeOf(studio).get(coll, id) },
    put(studio, coll, record, { by = 'person' } = {}) {
      const c = collOf(studio, coll), s = storeOf(studio)
      const id = c.single ? 'main' : record?.id || null
      const before = id ? s.get(coll, id) : null
      if (id && !before && !c.single) throw coded('noRecord', `${studio} has no ${coll} ${id}`, { studio, collection: coll, id })
      const data = checkRecord(c, record, { before, exists: (k, x) => s.has(k, x) })
      const out = s.put(coll, id, data, { by, prefix: prefixOf(c) })
      // Explicit status edits belong to the person, even when they choose the same value again. Notes-only patches do not revoke lifecycle ownership.
      if (id) {
        const at = { id: studio, collection: coll, record: id }, owner = ownerOf(at)
        const start = owner && declOf(studio).start.find(x => x.id === owner.start && x.from === coll)
        if (start && Object.hasOwn(record, start.statusField)) s.setNote(runKey(at), JSON.stringify({ ...owner, managedStatus: null }))
      }
      changed(studio, coll)
      return out
    },
    remove(studio, coll, id, { by = 'person' } = {}) { collOf(studio, coll); const ok = storeOf(studio).remove(coll, id, { by }); if (ok) changed(studio, coll); return ok },
    restore(studio, coll, id, { by = 'person' } = {}) { collOf(studio, coll); const r = storeOf(studio).restore(coll, id, { by }); if (r) changed(studio, coll); return r },
    history: (studio, coll, id) => { collOf(studio, coll); return storeOf(studio).history(coll, id) },
    rev: studio => storeOf(studio).rev(),
    materials: studio => storeOf(studio).materials(),
    material: (studio, id) => storeOf(studio).material(id),
    addMaterial(studio, name, bytes, opts) { const m = storeOf(studio).addMaterial(name, bytes, opts); changed(studio, null); return m },
    removeMaterial(studio, id) { const ok = storeOf(studio).removeMaterial(id); if (ok) changed(studio, null); return ok },
    /**
     * Start a studio's workflow from one of its records: the run's title, text and fields from the record (the start's
     * mapping), the run knowing where it came from (run.studio); the record's status moved to the start's `status.start`.
     */
    async start(studio, startId, recordId, { by = 'person', fields: extra = {} } = {}) {
      const d = declOf(studio), s = d.start.find(x => x.id === startId)
      if (!s) throw coded('noStart', `${studio} has no start ${startId}`, { studio, start: startId })
      const wb = workbench()
      if (!wb?.startRun) throw coded('noWorkbench', 'the workbench is not on: nothing can start a workflow', {})
      const rec = s.from && recordId ? storeOf(studio).get(s.from, recordId) : null
      if (s.from && recordId && !rec) throw coded('noRecord', `${studio} has no ${s.from} ${recordId}`, { studio, collection: s.from, id: recordId })
      // a picture field's materials go as the run's attachments (its own copies), the rest as its form's fields
      const typeOf = name => d.collections[s.from]?.fields.find(f => f.name === name)?.type
      const fields = {}, attachments = []
      for (const [to, from] of Object.entries(s.fields)) {
        const v = rec?.[from]
        if (v === null || v === undefined || (Array.isArray(v) && !v.length)) continue
        if (!['image', 'file'].includes(typeOf(from))) { fields[to] = v; continue }
        for (const id of [v].flat()) {
          const m = storeOf(studio).material(id)
          if (!m) throw coded('noMaterial', `${s.from}.${from}: the material ${id} is gone`, { id })
          attachments.push({ name: m.name, base64: m.bytes.toString('base64'), mime: MIME[m.name.split('.').pop().toLowerCase()] || 'application/octet-stream', field: to })
        }
      }
      Object.assign(fields, extra)
      const at = rec && { id: d.id, collection: s.from, record: rec.id }, key = at && `${at.id}:${runKey(at)}`
      if (key && (starting.has(key) || wb.runsOf?.({ studio: d.id, collection: s.from, record: rec.id })?.runs?.some(r => ['queued', 'running', 'waiting'].includes(r.status)))) throw coded('recordBusy', 'this record already has a workflow at work', { studio, record: rec.id })
      if (s.allowedStatuses && !canStartRecord(s, rec, d.collections[s.from])) throw coded('recordState', 'this record cannot start a workflow in its current status; create a new idea to reuse completed work', { studio, record: rec?.id, allowedStatuses: s.allowedStatuses })
      if (key) starting.add(key)
      let run
      try {
        run = await wb.startRun({
          workflow: s.workflow, title: (s.title && rec?.[s.title]) || d.name.zh, text: (s.text && rec?.[s.text]) || (s.title && rec?.[s.title]) || '', fields, ...(attachments.length && { attachments }),
          studio: { id: d.id, ...(rec && { collection: s.from, record: rec.id }) },
        })
        if (rec) {
          storeOf(studio).setNote(runKey(at), JSON.stringify({ run: run.id, start: s.id }))
          if (s.status?.start && storeOf(studio).get(s.from, rec.id)) {
            const written = studios.put(studio, s.from, { id: rec.id, [s.statusField]: s.status.start }, { by })
            rememberStatus(run, s.status.start, written)
          }
        }
      } finally { if (key) starting.delete(key) }
      const latest = rec && wb.runsOf?.({ studio: d.id, collection: s.from, record: rec.id })?.runs?.find(r => r.id === run.id)
      if (latest && ['done', 'failed', 'cancelled', 'interrupted'].includes(latest.status)) studios.onRunEnd(latest)
      return run
    },
    /** A pack's confirmed outcome may move only the record owned by this run. */
    setRunStatus(run, to) {
      const s = startOfRun(run), at = run?.studio
      if (!s || !to || !storeOf(at.id).get(at.collection, at.record)) return false
      const written = studios.put(at.id, at.collection, { id: at.record, [s.statusField]: to }, { by: `run:${run.id}` })
      rememberStatus(run, to, written)
      return true
    },
    /** A resumed run reclaims only a status this same run last wrote; manual status choices and newer owners stay put. */
    onRunResume(run) {
      const at = run?.studio, s = startOfRun(run)
      if (!s?.status.start) return false
      const rec = storeOf(at.id).get(at.collection, at.record), owner = ownerOf(at)
      if (!rec || !owner?.managedStatus || rec[s.statusField] !== owner.managedStatus || ![s.status.done, s.status.failed].includes(owner.managedStatus)) return false
      return studios.setRunStatus(run, s.status.start)
    },
    /** A run of a studio ended (the workbench says so): its record's status moves to the start's done / failed. */
    onRunEnd(run) {
      const at = run?.studio, s = startOfRun(run)
      if (!s) return false
      const rec = storeOf(at.id).get(at.collection, at.record)
      const owner = ownerOf(at)
      if (!rec || owner?.managedStatus === null || (owner?.managedStatus && owner.managedStatus !== rec[s.statusField]) || (s.status.start && rec[s.statusField] !== s.status.start)) return false
      const ok = run.status === 'done' && run.verdict !== 'failed' && run.verdict?.level !== 'failed'
      const to = ok ? s.status.done : s.status.failed
      return studios.setRunStatus(run, to)
    },
    /** Is it one of the person's own (studio.json), not a pack's? */
    isOwn: id => own.has(String(id)),
    ownDeclaration: id => own.get(String(id)) || null,
    /**
     * A studio of the person's own, from a declaration (no functions: JSON): checked like a pack's, and its workflows
     * must be ones this Ruyix has. Kept in <home>/<id>/studio.json; the same id again replaces it. A pack's id is not
     * taken. → the declaration as registered
     */
    create(input) {
      const raw = JSON.parse(JSON.stringify(input ?? null))
      const d = defineStudio(raw)
      if (decls.has(d.id) && !own.has(d.id)) throw coded('packStudio', `${d.id} is a pack's studio: give yours another id`, { studio: d.id })
      const have = workbench()?.workflows?.()?.map(w => w.id)
      if (!have) throw coded('noWorkbench', 'the workbench is not on: a studio\'s workflows cannot be checked', {})
      for (const s of d.start) if (!have.includes(s.workflow)) throw coded('noWorkflow', `start ${s.id}: no workflow ${s.workflow} here (${have.join(', ')})`, { workflow: s.workflow })
      for (const c of Object.values(d.collections)) if (c.runs && !have.includes(c.runs)) throw coded('noWorkflow', `${c.key}: no workflow ${c.runs} here`, { workflow: c.runs })
      writeOwn(d.id, raw)
      own.set(d.id, raw)
      studios.register(raw)
      return plain(declOf(d.id))
    },
    /** One of the person's studios out of the list (its records stay, in its folder: made again with the same id, they are back). */
    drop(id) {
      if (!own.has(String(id))) throw coded('notOwn', `${id} is not a studio of the person's own`, { studio: String(id) })
      own.delete(String(id))
      rmSync(join(home, String(id), 'studio.json'), { force: true })
      if (decls.has(String(id))) { decls.delete(String(id)); stores.get(String(id))?.close(); stores.delete(String(id)); changed(String(id), null) }
      return true
    },
    /**
     * What waits for the person now (the declarations' `remind`): records whose time has come (the last DUE_DAYS), not
     * of a status that says it is done, not seen at that time — each with its latest run, if it has one. Oldest first.
     */
    due(now = Date.now()) {
      const out = []
      for (const d of decls.values()) for (const r of d.remind || []) {
        const c = d.collections[r.collection], titleField = c.fields.find(f => f.type === 'text')?.name
        for (const rec of storeOf(d.id).list(r.collection)) {
          const at = rec[r.at]
          if (!at || at > now || now - at > DUE_DAYS * 864e5) continue
          if (r.statusField && r.unless.includes(rec[r.statusField])) continue
          if (storeOf(d.id).note(`due:${r.collection}:${rec.id}`) === String(at)) continue
          const run = workbench()?.runsOf?.({ studio: d.id, collection: r.collection, record: rec.id })?.runs?.[0] || null
          out.push({ studio: d.id, collection: r.collection, id: rec.id, title: (titleField && rec[titleField]) || rec.id, at, ...(r.statusField && { status: rec[r.statusField] }), run: run && { id: run.id, status: run.status } })
        }
      }
      return out.sort((a, b) => a.at - b.at)
    },
    /** The person saw it (the desk's 擦掉): not again for this time — a new time is a new reminder. */
    dueSeen(studio, collection, id) {
      const rec = storeOf(studio).get(collection, id), r = declOf(studio).remind.find(x => x.collection === collection)
      if (!rec || !r || !rec[r.at]) return false
      storeOf(studio).setNote(`due:${collection}:${id}`, rec[r.at])
      return true
    },
    /** Told of every change: ({ studio, collection | null }) → off. */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    close() { for (const s of stores.values()) s.close(); stores.clear() },
  }

  Object.assign(studios, studioFeedback({ storeOf, workbench, changed }))

  // the person's own studios, as they were left
  for (const id of existsSync(home) ? readdirSync(home) : []) {
    const file = join(home, id, 'studio.json')
    if (!existsSync(file)) continue
    try { const raw = JSON.parse(readFileSync(file, 'utf8')); if (raw?.id !== id) throw new Error(`its id is ${raw?.id}, its folder ${id}`); own.set(id, raw); studios.register(raw) } catch (err) { logger?.warn?.(`ruyix-studio: ${file}: ${err.message}`) }
  }

  const ops = {
    feedback: ({ studio, run }) => studios.feedbackView(studio, run),
    rate: ({ studio, ...input }) => studios.rate(studio, input),
    removeFeedback: ({ studio, id }) => studios.removeFeedback(studio, id),
    learning: ({ studio, enabled }) => ({ profile: studios.setLearning(studio, enabled) }),
    studios: () => ({ studios: studios.studios() }),
    studio: ({ id }) => ({ studio: studios.declaration(id), rev: studios.rev(id) }),
    items: ({ studio, collection }) => ({ items: studios.list(studio, collection), rev: studios.rev(studio) }),
    put: ({ studio, collection, record }) => ({ item: studios.put(studio, collection, record) }),
    remove: ({ studio, collection, id }) => ({ removed: studios.remove(studio, collection, id) }),
    restore: ({ studio, collection, id }) => ({ item: studios.restore(studio, collection, id) }),
    history: ({ studio, collection, id }) => ({ history: studios.history(studio, collection, id) }),
    /** Each studio's revision: a page asks this one number now and then, and reloads what moved. */
    revs: () => ({ revs: Object.fromEntries([...decls.keys()].map(id => [id, studios.rev(id)])) }),
    materials: ({ studio }) => ({ materials: studios.materials(studio).map(m => ({ ...m, url: `api/ruyix-studio/file?studio=${encodeURIComponent(studio)}&id=${m.id}` })) }),
    upload({ studio, name, data }) {
      if (typeof data !== 'string') throw coded('badUpload', 'data: the file, base64', {})
      if (data.length > (MATERIAL_MAX * 4) / 3 + 8) throw coded('tooBig', `a material is at most ${MATERIAL_MAX / 1024 / 1024} MB`, {})
      return { material: studios.addMaterial(studio, name, Buffer.from(data, 'base64')) }
    },
    removeMaterial: ({ studio, id }) => ({ removed: studios.removeMaterial(studio, id) }),
    start: async ({ studio, start, record, fields }) => ({ run: await studios.start(studio, start, record, { fields }) }),
    due: () => ({ due: studios.due() }),
    dueSeen: ({ items }) => ({ seen: (Array.isArray(items) ? items : []).slice(0, 100).filter(x => studios.dueSeen(String(x.studio), String(x.collection), String(x.id))).length }),
  }
  return { studios, ops }
}

export function apply(ctx) {
  let wb = null
  const { studios, ops } = createStudios({ workbench: () => wb, logger: ctx.logger })
  ctx.inject?.(['ruyixWorkbench'], inner => { wb = inner.ruyixWorkbench; inner.effect(() => () => { wb = null }, 'ruyix-studio: workbench') })
  ctx.provide?.('ruyixStudio', studios)
  // the main agent's hands in the studios (lib/tools.js), on the shell's system tools
  ctx.inject?.(['ruyixShell'], inner => {
    const sh = inner.ruyixShell
    if (!sh?.systemTools) return
    for (const tool of studioTools({ studios, icons: STUDIO_ICONS })) inner.effect(() => sh.systemTools.register(tool), `ruyix-studio: tool ${tool.name}`)
    // the studios and their records, for the shell's find (a record by its words: its first text field is its title)
    if (sh.finders) inner.effect(() => sh.finders.register({
      kind: 'studio', title: { zh: '工作室和记录', en: 'Studios and records' },
      find: () => studios.studios().flatMap(st => {
        const d = studios.declaration(st.id)
        const own = { id: st.id, title: `${st.name.zh} · ${st.name.en}`, hint: '工作室 studio', text: Object.values(d.collections).map(c => `${c.title.zh} ${c.title.en}`).join(' '), how: `studio_list, studio_items { studio: "${st.id}", collection }` }
        const recs = Object.entries(d.collections).filter(([, c]) => !c.runs).flatMap(([key, c]) => {
          const words = c.fields.filter(f => ['text', 'textarea', 'tags', 'select', 'url'].includes(f.type)), first = words.find(f => f.type === 'text') || words[0]
          return first ? studios.list(st.id, key).slice(0, 300).map(r => ({ id: `${st.id}/${key}/${r.id}`, title: String(r[first.name] ?? r.id).slice(0, 80), hint: `${st.name.zh} · ${c.title.zh}`, text: words.map(f => (Array.isArray(r[f.name]) ? r[f.name].join(' ') : r[f.name] ?? '')).join(' ').slice(0, 2000), at: r.updatedAt, how: `studio_items { studio: "${st.id}", collection: "${key}" } (record ${r.id})` })) : []
        })
        return [own, ...recs]
      }),
    }), 'ruyix-studio: found')
  })
  ctx.effect?.(() => () => studios.close(), 'ruyix-studio: stores')
  ctx.connection.fetch.register({
    path: '/api/ruyix-studio',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const { op, ...args } = await request.json()
        if (!Object.hasOwn(ops, op)) return Response.json({ error: `unknown op ${op}` }, { status: 400 })
        return Response.json(await ops[op](args))
      } catch (err) {
        const status = ['noStudio', 'noCollection', 'noRecord', 'noStart'].includes(err?.code) ? 404 : err?.code && err.code !== 'failed' ? 400 : 500
        return Response.json({ error: err?.message || String(err), code: err?.code, params: err?.params }, { status })
      }
    },
  })
  // a material's bytes (a picture on a card, the file a viewer opens): the studio's own files only
  ctx.connection.fetch.register({
    path: '/api/ruyix-studio/file',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const q = new URL(request.url, 'http://x').searchParams
      let m = null
      try { m = studios.material(q.get('studio'), q.get('id')) } catch { /* no such studio */ }
      if (!m) return new Response('not found', { status: 404 })
      const ext = m.name.split('.').pop().toLowerCase()
      return new Response(m.bytes, { headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', ...(ext === 'svg' && { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" }) } })
    },
  })
}
