// Tasks: what the person wants done — a workflow, its request (title, text, form fields, note) and when it runs: once,
// or again and again on a schedule (lib/schedule.js: every day at a time, on weekdays, every N hours, a cron line). A
// run is one time a task ran; runs carry `taskId`. A run started without a task (the assistant, a pack, a home from
// before tasks) gets a one-off task of its own, so every run belongs to one.
//   { id, title, workflow, request: { title, text, fields, note, tags }, schedule, tz, enabled, catchUp, carry,
//     nextAt, lastAt, lastRunId, runCount, skipped?: { at, why }, error?: { at, message, code }, createdAt, archivedAt, by }
// When it is due and its last run is still going, this time is skipped (said on the task), not stacked. A box that was
// off when it was due runs it once on waking (`catchUp`), or waits for the next time. `carry`: each run gets the files
// of the task's last finished run in previous/ and is told to write only what is new.
import { pageOf } from './page.js'
import { cpSync, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkSchedule, describe, dueSince, nextAt } from './schedule.js'
import { LINK_KINDS, OVER, SOURCES, STATES, archivedOf, checkOutput, lineIn, lineOf, openOf, runOutputs, sourceOf, taskState, taskView } from './task-model.js'

const ACTIVE = new Set(['queued', 'running', 'waiting'])
const MIN = 60e3
const RETRY_MS = 30 * MIN // a run that cannot start yet (Agent Hub still coming up): tried again for this long
const CARRY = { fileBytes: 2 << 20, totalBytes: 20 << 20, files: 300 } // what previous/ takes of the last run's folder
const fail = (code, params, message) => Object.assign(new Error(message), { code, params })
const machineTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const validTz = tz => { try { return !!tz && !!new Intl.DateTimeFormat('en-US', { timeZone: tz }) } catch { return false } }

/** The one-off task a run without one belongs to (its id from the run's, so making it twice makes the same). */
export function oneOffOf(run) {
  const s = run.subject || {}
  return {
    id: `t${String(run.id).replace(/^r/, '')}`, title: s.title || String(s.text || '').split('\n')[0].slice(0, 80) || run.template, workflow: run.template,
    request: { title: s.title || '', text: s.text || '', fields: s.fields || {}, ...(run.note && { note: run.note }), ...(run.tags?.length && { tags: run.tags }), ...(run.params && { params: run.params }) },
    schedule: { kind: 'once' }, enabled: false, catchUp: false, carry: false, nextAt: null,
    lastAt: run.createdAt, lastRunId: run.id, runCount: 1, ...(s.attachments?.length && { attachmentsFrom: run.id }),
    createdAt: run.createdAt, archivedAt: run.archivedAt || null, by: 'run',
  }
}

/**
 * The files of a finished run's folder, copied into `dir`/previous for the next run of its task: its own files (not its
 * attachments, not an earlier previous/, nothing hidden, no links), each at most 2 MB, 20 MB and 300 files at most.
 * → how many files were copied.
 */
export function carryFiles(fromDir, dir) {
  const to = join(dir, 'previous')
  let bytes = 0, files = 0
  const walk = rel => {
    let names
    try { names = readdirSync(join(fromDir, rel)) } catch { return }
    for (const name of names.sort()) {
      if (name.startsWith('.') || (!rel && ['attachments', 'previous'].includes(name))) continue
      const r = rel ? `${rel}/${name}` : name, st = lstatSync(join(fromDir, r), { throwIfNoEntry: false })
      if (!st || st.isSymbolicLink()) continue
      if (st.isDirectory()) { walk(r); continue }
      if (!st.isFile() || st.size > CARRY.fileBytes || bytes + st.size > CARRY.totalBytes || files >= CARRY.files) continue
      mkdirSync(join(to, rel), { recursive: true })
      cpSync(join(fromDir, r), join(to, r))
      bytes += st.size; files++
    }
  }
  walk('')
  return files
}

/**
 * The tasks over the store and the engine. now/setTimer/clearTimer: a clock to check it by. reviseRun(run, text): a run's
 * 再改 (on again from its last step, told what to change); removeRun(run): a run gone with its folder. → { create, update,
 * runNow, archive, noteRun, adopt, tick, dispose } for a workflow's tasks, and every task's (docs/design/agent-tasks.md):
 * { make, change, addOutput, link, find, registerSource, confirm, revise, remove, list, view, outputs, onChange }
 */
export function createTasks({ store, engine, logger = null, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, reviseRun = null, removeRun = null, resultsOf = null, previewOf = null, workflowTitle = null }) {
  const get = id => store.get('task', String(id))
  const put = t => store.put('task', { ...t, resultVersion: Math.max(Number(t.resultVersion) || 0, Number(get(t.id)?.resultVersion) || 0) })
  const runsOf = id => store.list('run').filter(r => r.taskId === id)
  const starting = new Set()
  let ticking = false
  const going = id => starting.has(id) || runsOf(id).some(r => ACTIVE.has(r.status))
  const scheduled = t => !!t && t.schedule?.kind && t.schedule.kind !== 'once'
  // the person's time zone, as their browser gave it with a task they made (the machine's may be a box's UTC)
  const personTz = () => store.list('task').filter(x => x.by === 'person' && x.tz).sort((a, b) => b.createdAt - a.createdAt)[0]?.tz || null
  const nextOf = (t, after = now()) => (scheduled(t) && t.enabled && !t.archivedAt ? nextAt(t.schedule, after, { tz: t.tz }) : null)

  /** A schedule as asked → the checked one (an `every` counts from now), or refused saying why. */
  const scheduleOf = (s, t = null) => {
    const { schedule, errors } = checkSchedule(s)
    if (errors.length) throw fail('badSchedule', { errors: errors.join('; ') }, errors.join('; '))
    return schedule.kind === 'every' && !Number.isFinite(schedule.from) ? { ...schedule, from: t?.schedule?.kind === 'every' && t.schedule.minutes === schedule.minutes ? t.schedule.from : now() } : schedule
  }

  /** A run of the task now: its request, the last finished run's files when it carries them. → the run */
  const start = async (t, { why = 'now' } = {}) => {
    if (going(t.id)) throw fail('taskBusy', { id: t.id }, 'the task is running now: wait for it, or stop that run')
    starting.add(t.id)
    try {
      const last = t.carry ? runsOf(t.id).filter(r => r.status === 'done').sort((a, b) => b.createdAt - a.createdAt)[0] : null
      const from = last && !last.folder ? last.dir : null // (a run in a folder the person named finds it as the last one left it)
      let attachments
      if (t.attachmentsFrom) {
        const r = store.get('run', t.attachmentsFrom)
        attachments = (r?.subject?.attachments || []).flatMap(a => { try { return [{ name: a.name, mime: a.mime, base64: store.readArtifact(a.artifact, null).toString('base64'), ...(a.field && { field: a.field }) }] } catch { return [] } })
      }
      const q = t.request || {}
      return await engine.startRun({
        workflow: t.workflow, title: q.title || t.title, text: q.text, fields: q.fields, note: q.note, tags: q.tags, params: q.params, attachments, taskId: t.id,
        ...(last && { previous: { id: last.id, at: last.createdAt, ...(scheduled(t) && { schedule: describe(t.schedule, 'en') }), inFolder: !from } }),
        ...(from && { seed: dir => carryFiles(from, dir) }),
        why,
      })
    } finally {
      starting.delete(t.id)
    }
  }

  const tasks = {
    get,
    /**
     * A new task: { title?, workflow, text?, fields?, note?, tags?, schedule (once by default), tz?, catchUp?, carry?,
     * runNow? }. Once: it runs now. Scheduled: its request is checked as a run's would be, and it runs when it is due
     * (and now too, with runNow). → { task, run? }
     */
    async create({ title, workflow, text, fields, note, tags, params, attachments, schedule = { kind: 'once' }, tz, catchUp = true, carry = true, runNow = false, by = 'person' } = {}) {
      const s = scheduleOf(schedule)
      if (s.kind === 'once') { const run = await engine.startRun({ workflow, title, text, fields, note, tags, params, attachments }); return { task: get(run.taskId), run } }
      if (attachments?.length) throw fail('badInput', { errors: 'a task that runs on a schedule takes no attachments (each run starts from the same request)' }, 'a scheduled task takes no attachments')
      if (tz !== undefined && !validTz(tz)) throw fail('badSchedule', { errors: `no time zone ${tz}` }, `no time zone ${tz}`)
      const checked = await engine.checkRequest({ workflow, title, text, fields })
      const id = `t${Math.random().toString(36).slice(2, 9)}`
      const t = put({
        id, title: String(title || checked.subject.title || String(text || '').split('\n')[0]).trim().slice(0, 120) || workflow, workflow: String(workflow),
        request: { title: checked.subject.title, text: checked.subject.text, fields: checked.subject.fields, ...(note && { note: String(note).slice(0, 2000) }), ...(Array.isArray(tags) && tags.length && { tags: tags.map(String).slice(0, 5) }), ...(params && { params }) },
        schedule: s, tz: tz || personTz() || machineTz(), enabled: true, catchUp: !!catchUp, carry: !!carry, nextAt: null, lastAt: null, lastRunId: null, runCount: 0,
        createdAt: now(), archivedAt: null, by,
      })
      const ready = put({ ...t, nextAt: nextOf(t) })
      arm()
      return runNow ? { task: get(id), run: await tasks.runNow({ id }) } : { task: ready }
    },
    /** Change a task: its title, request, schedule, time zone, on or off, catch-up, carry. → the task */
    update({ id, title, text, fields, note, schedule, tz, enabled, catchUp, carry }) {
      const t = get(id)
      if (!t) throw fail('noTask', { id }, `no task ${id}`)
      if (t.archivedAt) throw fail('taskArchived', { id }, 'the task is archived: bring it back first')
      if (tz !== undefined && !validTz(tz)) throw fail('badSchedule', { errors: `no time zone ${tz}` }, `no time zone ${tz}`)
      const s = schedule === undefined ? t.schedule : scheduleOf(schedule, t)
      const next = {
        ...t, ...(title !== undefined && { title: String(title).trim().slice(0, 120) || t.title }),
        request: { ...t.request, ...(title !== undefined && { title: String(title).trim().slice(0, 120) || t.title }), ...(text !== undefined && { text: String(text).slice(0, 20000) }), ...(fields !== undefined && { fields }), ...(note !== undefined && { note: String(note).slice(0, 2000) }) },
        schedule: s, ...(tz !== undefined ? { tz } : !t.tz && { tz: machineTz() }), ...(enabled !== undefined && { enabled: !!enabled }), ...(catchUp !== undefined && { catchUp: !!catchUp }), ...(carry !== undefined && { carry: !!carry }),
      }
      if (schedule !== undefined && s.kind !== 'once' && t.schedule?.kind === 'once') next.enabled = enabled ?? true // a one-off made to repeat
      const done = put({ ...next, nextAt: nextOf(next), ...((schedule !== undefined || enabled) && { skipped: null, error: null }) })
      arm()
      return done
    },
    /** One run of the task now (not while one is going). → the run */
    async runNow({ id }) {
      const t = get(id)
      if (!t) throw fail('noTask', { id }, `no task ${id}`)
      if (going(t.id)) throw fail('taskBusy', { id }, 'the task is running now: wait for it, or stop that run')
      return start(t)
    },
    /** Archive a task (its runs stay as they are) or bring it back; an archived one does not run. → the task */
    archive({ id, archived = true }) {
      const t = get(id)
      if (!t) throw fail('noTask', { id }, `no task ${id}`)
      if (archived && going(t.id)) throw fail('archiveActive', {}, 'stop the run before archiving the task')
      // (brought back: its runs too — a one-off whose runs are archived counts as archived, lib/task-model.js archivedOf)
      if (!archived) for (const r of runsOf(t.id)) if (r.archivedAt) store.put('run', { ...r, archivedAt: null })
      const next = { ...t, archivedAt: archived ? now() : null }
      const done = put({ ...next, nextAt: nextOf(next) })
      arm()
      return done
    },
    /** A run started (engine): its task knows it — one made for it when it has none. */
    noteRun(run) {
      const t = get(run.taskId)
      if (!t) return put(oneOffOf(run))
      return put({ ...t, lastRunId: run.id, lastAt: run.createdAt, runCount: (t.runCount || 0) + 1, error: null, ...(t.archivedAt && { archivedAt: null }) })
    },
    /** Runs from before tasks: each gets its one-off task (once; a run that has one is left alone). → how many */
    adopt() {
      let n = 0
      for (const r of store.list('run')) {
        if (r.taskId) continue
        const t = get(oneOffOf(r).id) || put(oneOffOf(r))
        store.put('run', { ...r, taskId: t.id })
        n++
      }
      return n
    },
    /** What is due runs (or is skipped, saying why); then the next look is set. */
    async tick() {
      if (stopped || ticking) return
      ticking = true
      try {
        const at = now()
        for (const due of store.list('task')) {
          const t = get(due.id)
          if (!scheduled(t) || !t.enabled || t.archivedAt || !t.nextAt || t.nextAt > at) continue
          if (going(t.id)) { put({ ...t, skipped: { at: t.nextAt, why: 'running' }, nextAt: nextOf(t, at) }); continue }
          try {
            await start(t, { why: 'schedule' })
            const after = get(t.id)
            if (after) put({ ...after, nextAt: nextOf(after, Math.max(at, t.nextAt)), skipped: null, error: null })
          } catch (err) {
            // not up yet (Agent Hub starts after the workbench): again at the next look, for a while; else said on the task
            if (err.code === 'noHub' && at - t.nextAt < RETRY_MS) continue
            logger?.warn?.(`ruyix-workbench: task ${t.id} could not start: ${err.message}`)
            const after = get(t.id)
            if (after) put({ ...after, error: { at, message: String(err.message).slice(0, 500), code: err.code || null }, nextAt: nextOf(after, at) })
          }
        }
      } finally { ticking = false; arm() }
    },
    dispose() { stopped = true; clearTimer(timer) },
    ...general(),
  }

  // waking: a time missed while the box was off — run once now (catch-up) or say it was missed and wait for the next
  for (const t of store.list('task').filter(x => scheduled(x) && x.enabled && !x.archivedAt)) {
    const at = now()
    if (!t.nextAt) { put({ ...t, nextAt: nextOf(t, at) }); continue }
    if (t.nextAt > at) continue
    const missed = dueSince(t.schedule, t.lastAt || t.createdAt, at, { tz: t.tz })
    if (t.catchUp && missed) put({ ...t, nextAt: at }) // (now: its retries while Agent Hub comes up count from waking)
    else put({ ...t, nextAt: nextOf(t, at), ...(missed && { skipped: { at: missed, why: 'off' } }) })
  }

  // ── every task, not only a workflow's (docs/design/agent-tasks.md; lib/task-model.js) ──
  function general() {
    const listeners = new Set(), sources = new Map(), outCache = new Map()
    const emit = ids => { for (const f of listeners) { try { f(ids) } catch (err) { logger?.warn?.(`ruyix-workbench: tasks listener: ${err?.message || err}`) } } }
    const runsByTask = () => {
      const m = new Map()
      for (const r of store.list('run')) { if (!r.taskId) continue; (m.get(r.taskId) || m.set(r.taskId, []).get(r.taskId)).push(r) }
      for (const l of m.values()) l.sort((a, b) => b.createdAt - a.createdAt)
      return m
    }
    // a finished run's result files (as its 结果 tab has them: `resultsOf`, read from its folder's versions), kept while
    // the run stays the same; `known` fills them in before a list is made
    const resCache = new Map()
    const resultsNow = r => { const k = resCache.get(r.id); return k && k.at === (r.updatedAt || 0) ? k.paths : null }
    const known = async runs => {
      if (!resultsOf) return
      for (const r of runs) {
        if (ACTIVE.has(r.status) || resultsNow(r)) continue
        let paths = []
        try { paths = (await resultsOf(r)) || [] } catch (err) { logger?.warn?.(`ruyix-workbench: ${r.id}: its results: ${err?.message || err}`) }
        resCache.set(r.id, { at: r.updatedAt || 0, paths })
      }
    }
    // a finished run's outputs (its result files, its report, what it published; the ledger's files on the way), kept while
    // the run stays the same
    const outputsOfRun = r => {
      if (ACTIVE.has(r.status)) return []
      const results = resultsNow(r), kept = outCache.get(r.id)
      if (kept && kept.at === (r.updatedAt || 0) && kept.results === results) return kept.v
      const v = runOutputs(r, store.evidence(r.id), { results, preview: path => { try { return previewOf?.(r, path) || null } catch { return null } } })
      outCache.set(r.id, { at: r.updatedAt || 0, results, v })
      return v
    }
    /** What group a task's outputs go under: its studio, else its workflow, else where it came from. */
    const SOURCE_TITLE = { chat: ['对话', 'Conversation'], session: ['会话', 'Sessions'], job: ['池子任务', 'Pool jobs'], studio: ['工作室', 'Studio'], schedule: ['定时', 'Scheduled'], run: ['工作流', 'Workflows'] }
    const categoryOf = (t, runs, lang) => {
      const st = t.studio || runs.find(r => r.studio)?.studio
      if (st?.id) return { key: `studio:${st.id}`, title: String(st.name || st.title || st.id) }
      const wf = t.workflow || runs[0]?.template
      if (wf) return { key: `wf:${wf}`, title: String(workflowTitle?.(wf, lang, runs[0]) || wf) }
      const src = sourceOf(t)
      return { key: `src:${src}`, title: (SOURCE_TITLE[src] || [src, src])[lang === 'en' ? 1 : 0] }
    }
    /** Whether an output is final (the portfolio's): its own word (a run's say so), else its task done or waiting for 好了. */
    const finalOf = (o, state) => (typeof o.final === 'boolean' ? o.final : state === 'done' || state === 'to-confirm')
    /** A scheduled task before its first run: it waits for its time, it is not at work. */
    const beforeFirstRun = v => !!v.schedule && !v.runs && !v.archived
    /** A view with its source's lines in the page's language. */
    const inLang = (v, lang) => ({ ...v, ...(v.step && { step: lineIn(v.step, lang) }), ...(v.result && { result: lineIn(v.result, lang) }) })
    // what a run used — its agents' steps as its ledger has them (tokens, cost when they said one), its time — kept while
    // the run stays the same once it is over
    const useCache = new Map()
    const usageOfRun = r => {
      const k = useCache.get(r.id)
      if (k && k.at === (r.updatedAt || 0)) return k.u
      let tokens = 0, cost = null
      try {
        for (const e of store.evidence(r.id)) {
          if (e.kind !== 'agent' || e.carriedFrom) continue
          tokens += Number(e.input?.tokens) || 0
          if (Number.isFinite(e.input?.cost)) cost = (cost || 0) + e.input.cost
        }
      } catch (err) { logger?.warn?.(`ruyix-workbench: ${r.id}: what it used: ${err?.message || err}`) }
      const from = r.startedAt || r.createdAt || 0, live = ACTIVE.has(r.status)
      const u = { tokens, cost, ms: Math.max(0, (r.endedAt || (live ? now() : r.updatedAt || from)) - from) }
      if (!live) useCache.set(r.id, { at: r.updatedAt || 0, u })
      return u
    }
    /** What a task used: its runs', and what its source said (a conversation's turns, a session's work). → { tokens, cost, ms } or none */
    const usageOf = (t, runs) => {
      const all = [...runs.map(usageOfRun), t.usage].filter(Boolean)
      const u = { tokens: all.reduce((n, x) => n + (Number(x.tokens) || 0), 0), cost: all.some(x => Number.isFinite(x.cost)) ? all.reduce((n, x) => n + (Number(x.cost) || 0), 0) : null, ms: all.reduce((n, x) => n + (Number(x.ms) || 0), 0) }
      return u.tokens || u.cost || u.ms ? u : null
    }
    const viewWith = (t, runs, approvals) => {
      const usage = usageOf(t, runs)
      return { ...taskView(t, runs, { approvals }), outputs: (t.outputs || []).length + runs.reduce((n, r) => n + outputsOfRun(r).length, 0), ...(usage && { usage }) }
    }
    const must = id => { const t = get(id); if (!t) throw fail('noTask', { id }, `no task ${id}`); return t }
    const touch = (t, patch, bump = true) => {
      const current = get(t.id) || t
      const result = bump && ('result' in patch || 'outputs' in patch || (['working', 'queued'].includes(patch.state) && patch.state !== current.state))
      const next = put({ ...current, ...patch, ...(result && { resultVersion: (current.resultVersion || 0) + 1 }) })
      emit([t.id]); return next
    }
    const note = (t, kind, text) => [...(t.log || []), { at: now(), kind, ...(text && { text: String(text).slice(0, 2000) }) }].slice(-100)
    // (once: tasks whose last run ended before tasks could be confirmed are taken as done — nothing floods "to confirm")
    if (!store.get('meta', 'tasks-v2')) {
      for (const [id, runs] of runsByTask()) { const t = get(id); if (t && !ACTIVE.has(runs[0].status) && !t.confirmedRunId) put({ ...t, confirmedRunId: runs[0].id }) }
      store.put('meta', { id: 'tasks-v2', at: now() })
    }
    const api = {
      /**
       * A task of another kind than a workflow's: { source (chat | session | job | studio), title, agents?, studio?,
       * links?: [{ kind, id }], state? (working) } → its view
       */
      make({ source, title, agents = [], studio = null, links = [], state = 'working', by } = {}) {
        if (!SOURCES.includes(source) || source === 'run' || source === 'schedule') throw fail('badTask', { source }, `a task's source is chat, session, job or studio (a workflow's task: create)`)
        if (!STATES.includes(state)) throw fail('badTask', { state }, `a task's state is one of ${STATES.join(', ')}`)
        const id = `k${Math.random().toString(36).slice(2, 10)}`
        const t = put({
          id, source, title: String(title || '').trim().slice(0, 120) || source, state, agents: (Array.isArray(agents) ? agents : []).filter(a => a?.id).map(a => ({ id: String(a.id), runtime: a.runtime || null })).slice(0, 10),
          ...(studio?.id && { studio: { id: String(studio.id), ...(studio.collection && { collection: String(studio.collection) }), ...(studio.record && { record: String(studio.record) }) } }),
          links: (Array.isArray(links) ? links : []).filter(l => LINK_KINDS.includes(l?.kind) && l.id).map(l => ({ kind: l.kind, id: String(l.id) })).slice(0, 50),
          outputs: [], createdAt: now(), archivedAt: null, by: by || source, ...(OVER.has(state) && { endedAt: now() }),
        })
        emit([id])
        return api.viewOne(t)
      },
      /**
       * What its source says of it now: { state?, title?, agents?, waitingFor? ({ kind, title, open }), step?, result? } →
       * its view. step: what it is doing now, result: how it ended, in a line ('…' or { zh, en }; null: none). A source
       * that says either has the say on its state: the conversation's turn ending leaves it be (`saidAt`).
       */
      change(id, { state, title, agents, waitingFor, step, result, usage } = {}) {
        const t = must(id)
        if (state !== undefined && !STATES.includes(state)) throw fail('badTask', { state }, `a task's state is one of ${STATES.join(', ')}`)
        const patch = {
          ...(step !== undefined && { step: lineOf(step, now()) }), ...(result !== undefined && { result: lineOf(result, now()) }),
          ...((step || result) && { saidAt: now() }),
          // (what it used, as its source counts it: { tokens?, cost?, ms? } — its totals)
          ...(usage && typeof usage === 'object' && { usage: { tokens: Math.max(0, Number(usage.tokens) || 0), cost: Number.isFinite(usage.cost) ? usage.cost : null, ms: Math.max(0, Number(usage.ms) || 0) } }), ...(step === null && result === null && { saidAt: null }),
          ...(state !== undefined && { state, ...(OVER.has(state) ? { endedAt: now() } : { endedAt: null }), ...(state === 'done' && t.state === 'to-confirm' && { confirmedAt: now() }) }),
          ...(title !== undefined && { title: String(title).trim().slice(0, 120) || t.title }),
          ...(Array.isArray(agents) && { agents: agents.filter(a => a?.id).map(a => ({ id: String(a.id), runtime: a.runtime || null })).slice(0, 10) }),
          ...(waitingFor !== undefined && { waitingFor: waitingFor && typeof waitingFor === 'object' ? { kind: String(waitingFor.kind || ''), title: String(waitingFor.title || '').slice(0, 200), ...(waitingFor.open && { open: waitingFor.open }) } : null }),
        }
        return api.viewOne(touch(t, patch))
      },
      /** Something it made: { kind, title, ref?, thumb?, url?, by? } → the output (lib/task-model.js checkOutput) */
      addOutput(id, o) {
        const t = must(id), list = t.outputs || []
        const out = checkOutput(o, { id: `${t.id}:o${list.length + 1}`, at: now() })
        touch(t, { outputs: [...list, out].slice(-200) })
        return out
      },
      /** What does its work, or what it came from: { kind: run | session | job | chat | studio, id } → its view */
      link(id, l = {}) {
        const t = must(id)
        if (!LINK_KINDS.includes(l.kind) || !l.id) throw fail('badTask', { link: l.kind }, `a link is { kind: ${LINK_KINDS.join(' | ')}, id }`)
        if ((t.links || []).some(x => x.kind === l.kind && x.id === String(l.id))) return api.viewOne(t)
        return api.viewOne(touch(t, { links: [...(t.links || []), { kind: l.kind, id: String(l.id) }].slice(-50) }))
      },
      /** The task a run, session, job, conversation item or studio record belongs to (null: none). */
      find({ kind, id } = {}) {
        if (kind === 'run') { const r = store.get('run', String(id)); return r?.taskId && get(r.taskId) ? api.viewOne(get(r.taskId)) : null }
        const t = store.list('task').find(x => (x.links || []).some(l => l.kind === kind && l.id === String(id)))
        return t ? api.viewOne(t) : null
      },
      /** What a source does with its own tasks: { revise(task, text), stop?(task), remove?(task), timeline?(task) → entries }. → off() */
      registerSource(source, handlers) { sources.set(source, handlers || {}); return () => { if (sources.get(source) === handlers) sources.delete(source) } },
      onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      /** A run of a task ended (the engine): its listeners hear that the task moved on. */
      runEnded(run) {
        const t = run?.taskId && get(run.taskId)
        if (!t) return
        const latest = (runsByTask().get(t.id) || [])[0]
        if (latest && latest.id !== run.id) return
        touch(t, { resultVersion: (t.resultVersion || 0) + 1, ...(t.confirmedRunId === run.id && { confirmedRunId: null, confirmedAt: null }) })
      },
      /** 好了: the person takes what it made. → its view */
      confirm({ id, run, expect }) {
        const t = must(id), runs = runsByTask().get(t.id) || [], state = taskState(t, runs)
        if (run !== undefined && (runs[0]?.id || '') !== String(run || '')) throw fail('changedMeanwhile', {}, 'this task has a different run now: look at its new result')
        if (expect !== undefined && String(expect) !== String(t.resultVersion || 0)) throw fail('changedMeanwhile', {}, 'this task has a different result now: look at it again')
        if (state !== 'to-confirm') throw fail('notToConfirm', { state }, `the task is ${state}: only one that made something waits for 好了`)
        return api.viewOne(touch(t, runs.length ? { confirmedRunId: runs[0].id, confirmedAt: now(), log: note(t, 'confirm') } : { state: 'done', endedAt: now(), confirmedAt: now(), log: note(t, 'confirm') }))
      },
      /** 再改: on again with what the person wants changed — a workflow's from its last step, others by their source. → its view */
      async revise({ id, text, run, expect }) {
        const t = must(id), runs = runsByTask().get(t.id) || [], words = String(text || '').trim()
        if (run !== undefined && (runs[0]?.id || '') !== String(run || '')) throw fail('changedMeanwhile', {}, 'this task has a different run now: look at its new result')
        if (expect !== undefined && String(expect) !== String(t.resultVersion || 0)) throw fail('changedMeanwhile', {}, 'this task has a different result now: look at it again')
        if (!words) throw fail('needInput', {}, 'say what to change')
        const state = taskState(t, runs)
        if (!['to-confirm', 'done', 'failed', 'stopped'].includes(state)) throw fail('taskBusy', { state }, `the task is ${state}: wait for it, or stop it`)
        if (runs.length) {
          if (!reviseRun) throw fail('cannotRevise', {}, 'a workflow task cannot go on again here')
          await reviseRun(runs[0], words)
          return api.viewOne(touch(get(t.id), { log: note(t, 'revise', words) }))
        }
        const h = sources.get(sourceOf(t))
        if (!h?.revise) throw fail('cannotRevise', { source: sourceOf(t) }, `a ${sourceOf(t)} task cannot go on again here`)
        // (working before its source takes it up: a source that answers at once sets what comes after)
        const before = { state: t.state, endedAt: t.endedAt || null, log: t.log || [] }
        const claimed = touch(t, { state: 'working', endedAt: null, log: note(t, 'revise', words) }, false)
        try { await h.revise(api.viewOne(get(t.id)), words) } catch (err) {
          const current = get(t.id)
          if (current?.state === 'working' && current.resultVersion === claimed.resultVersion) touch(current, before, false)
          throw err
        }
        const current = get(t.id)
        if (current && current.resultVersion === claimed.resultVersion) touch(current, { resultVersion: (current.resultVersion || 0) + 1 })
        return api.viewOne(get(t.id))
      },
      /** Delete a task that is over (done, failed, stopped): its runs and their folders go too; its source hears. */
      async remove({ id }) {
        const t = must(id), runs = runsByTask().get(t.id) || [], state = taskState(t, runs)
        if (!OVER.has(state) && !t.archivedAt) throw fail('taskBusy', { state }, `the task is ${state}: stop it first (or archive it)`)
        if (going(t.id)) throw fail('taskBusy', { state }, 'a run of it is still going: stop it first')
        if (scheduled(t) && t.enabled) put({ ...t, enabled: false, nextAt: null })
        for (const r of runs) { await removeRun?.(r); outCache.delete(r.id) }
        try { await sources.get(sourceOf(t))?.remove?.(api.viewOne(t)) } catch (err) { logger?.warn?.(`ruyix-workbench: task ${t.id}: its source: ${err?.message || err}`) }
        store.remove('task', t.id)
        arm()
        emit([t.id])
        return { deleted: true }
      },
      viewOne(t) { return viewWith(t, runsByTask().get(t.id) || [], store.list('approval')) },
      /** What every task used so far (archived too): Map(id → { tokens, cost, at: when it last moved }) — ./usage-hours.js. */
      usageNow() {
        const byTask = runsByTask(), m = new Map()
        for (const t of store.list('task')) { const runs = byTask.get(t.id) || [], u = usageOf(t, runs); if (u) m.set(t.id, { tokens: u.tokens, cost: u.cost, at: taskView(t, runs).updatedAt }) }
        return m
      },
      /**
       * The task center's list: { state?, source?, agent?, studio?, q?, archived?, before?, limit? } → { tasks, more,
       * counts } — the latest touched first; `before`: the last one's updatedAt (the next page).
       */
      list({ state, source, agent, studio, q, archived = false, before = null, limit = 100, lang = 'zh', from = null, to = null } = {}) {
        const byTask = runsByTask(), approvals = store.list('approval')
        const all = store.list('task').map(t => viewWith(t, byTask.get(t.id) || [], approvals))
        // (a scheduled one before its first run is not at work: it waits for its time — counted on its own)
        const counts = Object.fromEntries([...STATES, 'archived', 'scheduled'].map(k => [k, 0]))
        for (const v of all) { if (v.archived) counts.archived++; else if (beforeFirstRun(v)) counts.scheduled++; else counts[v.state]++ }
        const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean)
        // (when: last moved in [from, to))
        const base = all.filter(v => (archived === 'only' ? v.archived : archived || !v.archived)
          && (!state || ((Array.isArray(state) ? state : [state]).includes(v.state) && !beforeFirstRun(v))) && (!source || (Array.isArray(source) ? source : [source]).includes(v.source))
          && (!studio || v.studio?.id === studio) && (!from || v.updatedAt >= Number(from)) && (!to || v.updatedAt < Number(to))
          && (!words.length || words.every(w => `${v.title} ${v.workflow || ''} ${v.agents.map(a => a.id).join(' ')}`.toLowerCase().includes(w))))
        const fit = base.filter(v => !agent || v.agents.some(a => a.id === agent))
        // who did them (the ones that fit, whoever did them): the agents to pick one by
        const who = new Map()
        for (const v of base) for (const a of v.agents) who.set(a.id, (who.get(a.id) || 0) + 1)
        const { page, more, cursor } = pageOf(fit, { before, limit, time: 'updatedAt' })
        return { tasks: page.map(v => inLang(v, lang)), more, cursor, counts, agents: [...who].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n) }
      },
      /**
       * One task — by its id, or a run's (`run`: the task it is a run of) —: its view, what happened in it (timeline,
       * oldest first), what it made. → { task, timeline, outputs }
       */
      async view({ id, run, lang = 'zh' }) {
        if (!id && run) id = store.get('run', String(run))?.taskId || `(the task of ${run})`
        const t = must(id), runs = runsByTask().get(t.id) || [], approvals = store.list('approval')
        await known(runs)
        const task = viewWith(t, runs, approvals), timeline = [], zh = lang !== 'en'
        const name = s => (typeof s.title === 'string' && s.title ? s.title : s.key)
        const ended = r => ({ done: zh ? '做完了' : 'done', failed: zh ? '没做成' : 'did not work out', cancelled: zh ? '停了' : 'stopped', interrupted: zh ? '停了（中断）' : 'stopped (cut short)' })[r.status === 'done' && r.verdict?.level === 'failed' ? 'failed' : r.status] || r.status
        for (const r of [...runs].reverse()) {
          timeline.push({ at: r.createdAt, kind: 'step', who: { kind: 'system' }, text: `${zh ? '开始了：' : 'started: '}${r.subject?.title || r.template}`, open: { event: 'ruyix-workbench:open', detail: { run: r.id } } })
          for (const s of r.stages || []) {
            if (!s.endedAt || !['passed', 'failed'].includes(s.status)) continue
            const why = s.status === 'failed' && s.note ? ` — ${String(s.note).slice(0, 200)}` : ''
            timeline.push({ at: s.endedAt, kind: 'step', who: s.agent?.id ? { kind: 'agent', id: s.agent.id, name: s.agent.id } : { kind: 'system' }, text: `${name(s)}${zh ? '：' : ': '}${s.status === 'passed' ? (zh ? '做完了' : 'done') : (zh ? '没做成' : 'failed')}${why}`, open: { event: 'ruyix-workbench:open', detail: { run: r.id, tab: 'pipeline' } } })
          }
          for (const a of approvals.filter(x => x.runId === r.id)) {
            timeline.push({ at: a.createdAt, kind: 'approval', who: { kind: 'person' }, text: `${zh ? '问你：' : 'asked you: '}${a.title}`, open: { event: 'ruyix-workbench:open', detail: { run: r.id, tab: 'approvals' } } })
            if (a.decidedAt) timeline.push({ at: a.decidedAt, kind: 'approval', who: { kind: 'person' }, text: `${a.status === 'rejected' ? (zh ? '你没同意：' : 'you turned down: ') : (zh ? '你答了：' : 'you answered: ')}${a.title}` })
          }
          if (r.endedAt) timeline.push({ at: r.endedAt, kind: 'state', who: { kind: 'system' }, text: ended(r) })
        }
        const h = sources.get(sourceOf(t))
        if (h?.timeline) { try { timeline.push(...((await h.timeline(task, zh ? 'zh' : 'en')) || []).filter(e => e && e.at && e.text)) } catch (err) { logger?.warn?.(`ruyix-workbench: task ${t.id}: its timeline: ${err?.message || err}`) } }
        for (const e of t.log || []) timeline.push({ at: e.at, kind: 'state', who: { kind: 'person' }, text: e.kind === 'confirm' ? (zh ? '好了' : 'OK, done') : e.kind === 'revise' ? `${zh ? '再改：' : 'change it: '}${e.text || ''}` : e.text || e.kind })
        const outputs = [...(t.outputs || []), ...runs.flatMap(outputsOfRun)].map(o => ({ ...o, final: finalOf(o, task.state), task: { id: t.id, title: t.title, source: task.source, state: task.state }, open: openOf(o, t.id) }))
        // (how it ended, as its source said)
        if (task.result) timeline.push({ at: task.result.at, kind: 'state', who: { kind: 'system' }, text: lineIn(task.result, lang) })
        return { task: inLang(task, lang), timeline: timeline.sort((a, b) => a.at - b.at), outputs }
      },
      /**
       * The portfolio: the final outputs of every task, the latest first — each with its task (and its state), its group
       * (`category`: its studio, else its workflow, else where it came from) and how it opens on its own. { final = true
       * (false: every output, each saying whether it is final), archived = false (true: theirs too; 'only'), kind?, source?,
       * studio?, task?, q?, lang?, before?, limit? } → { outputs, more }
       */
      async outputs({ final = true, archived = false, kind, source, studio, task: only, q, lang = 'zh', before = null, limit = 100 } = {}) {
        const byTask = runsByTask(), approvals = store.list('approval'), words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean)
        const tasks = store.list('task').filter(t => { const a = archivedOf(t, byTask.get(t.id) || []); return (!only || t.id === only) && (archived === 'only' ? a : archived === true || !a) })
        await known(tasks.flatMap(t => byTask.get(t.id) || []))
        const all = []
        for (const t of tasks) {
          const src = sourceOf(t), runs = byTask.get(t.id) || []
          if (source && src !== source) continue
          if (studio && t.studio?.id !== studio && !runs.some(r => r.studio?.id === studio)) continue
          const v = viewWith(t, runs, approvals), category = categoryOf(t, runs, lang), st = t.studio || runs.find(r => r.studio)?.studio
          for (const o of [...(t.outputs || []), ...runs.flatMap(outputsOfRun)]) {
            const isFinal = finalOf(o, v.state)
            if (final !== false && !isFinal) continue
            if (kind && o.kind !== kind) continue
            if (words.length && !words.every(w => `${o.title} ${t.title}`.toLowerCase().includes(w))) continue
            all.push({ ...o, final: isFinal, task: { id: t.id, title: t.title, source: src, state: v.state }, category, ...(st && { studio: st }), open: openOf(o, t.id) })
          }
        }
        const { page, more, cursor } = pageOf(all, { before, limit })
        return { outputs: page, more, cursor }
      },
    }
    return api
  }

  // the next look: at the soonest due time, a minute at most (a clock that jumps, a box that slept)
  let timer = null, stopped = false
  function arm() {
    if (stopped) return
    clearTimer(timer)
    const soon = Math.min(...store.list('task').filter(x => scheduled(x) && x.enabled && !x.archivedAt && x.nextAt).map(x => x.nextAt), now() + MIN)
    timer = setTimer(() => tasks.tick().catch(err => logger?.warn?.(`ruyix-workbench: tasks: ${err?.stack || err}`)), Math.max(1000, soon - now()))
    timer?.unref?.()
  }
  arm()
  return tasks
}
