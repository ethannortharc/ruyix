// The workflow editor's model, without React: a workflow as the canvas holds it (items, a branch's routes and a parallel
// block's lanes as lanes of items), the edits (insert, move, remove, routes, lanes, loops), where a step may go, and the
// left-to-right layout (nodes, edges, the + slots, a parallel block's join, the loops back, the phases). The page
// (workflows.jsx) and the editor (wf-editor.jsx) draw it; config-check.mjs tests it.
import { FLOW_TEMPLATE } from '../lib/flow/names.js'

let seq = 0
export const uid = () => `n${++seq}`
export const NODE = { w: 224, h: 76 }
export const DX = 284, DY = 132
/**
 * The handles every node kind draws (StepNode, JoinNode, SlotNode: l r tt ts bs) at their places on a w × h box. A node
 * carries them up front: React Flow measures them only in a page it can lay out, so a background tab, a hidden window or a
 * zero-size box would leave the canvas with steps and no lines.
 */
export const handlesOf = (w, h) => [['l', 'target', 'left', 0, h / 2], ['r', 'source', 'right', w, h / 2], ['tt', 'target', 'top', w / 2, 0], ['ts', 'source', 'top', w / 2, 0], ['bs', 'source', 'bottom', w / 2, h]]
  .map(([id, type, position, x, y]) => ({ id, type, position, x, y }))
/** Where a built-in workflow sends the work back, as its outline says (step key → the step it goes back to; drawn dashed). */
export const backsOf = outline => Object.fromEntries((outline || []).filter(s => s.back).map(s => [s.key, s.back]))
/**
 * A copy of a workflow of one's own: the whole definition (a deep copy) under an id not taken (`<id>-copy`, `-copy-2`…,
 * within the 40 characters an id has) and a new title — without what belongs to the original (its status, times, author,
 * the registry version it came from, its checks' results).
 */
export function copyOf(d, taken, title) {
  const { status: _s, createdAt: _c, updatedAt: _u, by: _b, origin: _o, errors: _e, ...def } = d
  const stem = d.id.slice(0, 31), used = new Set(taken)
  let id = `${stem}-copy`
  for (let n = 2; used.has(id); n++) id = `${stem}-copy-${n}`
  return { ...structuredClone(def), id, title }
}
/** A template's dotted id becomes a unique workflow slug, including its numeric suffix within 40 characters. */
export function forkId(base, taken = []) {
  const stem = `my-${String(base).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 40), used = new Set(taken)
  let id = stem
  for (let n = 2; used.has(id); n++) { const suffix = `-${n}`; id = stem.slice(0, 40 - suffix.length) + suffix }
  return id
}
/** A list edited in place: item i set to v, appended (i past the end), or removed (v undefined) — its other items untouched. */
export const editList = (list, i, v) => (v === undefined ? list.filter((_, j) => j !== i) : i >= list.length ? [...list, v] : list.map((x, j) => (j === i ? v : x)))
// the blocks a + offers: agent steps (blank and ready-made), a model call, scripts, a person's sign-off, branches
export const PRESETS = [
  { key: 'agent', use: 'agent', group: 'agent' },
  { key: 'check', use: 'agent', group: 'agent', access: 'read' },
  { key: 'draft', use: 'agent', group: 'agent', access: 'write' },
  { key: 'summary', use: 'agent', group: 'agent', access: 'read' },
  { key: 'model', use: 'model', group: 'model' },
  { key: 'command', use: 'script', group: 'script' },
  // a script that drives the step's own steps (lib/flow): agents, commands, a person's answer — each kept, resumed after a stop
  { key: 'flow', use: 'flow', group: 'script' },
  { key: 'approval', use: 'approval', group: 'human' },
  // the person's part: a review, an answer, a choice, something done outside
  { key: 'review', use: 'person', ask: 'review', group: 'human' },
  { key: 'input', use: 'person', ask: 'input', group: 'human' },
  { key: 'decide', use: 'person', ask: 'decide', group: 'human' },
  { key: 'do', use: 'person', ask: 'do', group: 'human' },
  // a discussion with an agent of the run before it goes on (docs/design/agent-work.md §7)
  { key: 'chat', use: 'person', ask: 'chat', group: 'human' },
  // 结果: the files that are the run's results, opened in the viewer (waits for nobody, as a preview node)
  { key: 'output', use: 'output', group: 'human' },
  { key: 'condition', use: 'branch', group: 'flow', mode: 'condition' },
  { key: 'router', use: 'branch', group: 'flow', mode: 'agent' },
  { key: 'parallel', use: 'parallel', group: 'flow' },
]

const lift = s => ({ uid: uid(), step: s })
/** A definition's steps as items: every base step (one left out kept, not drawn) and the steps of one's own. */
export function itemsOf(def, lib) {
  const keys = lib.map(b => b.key)
  const items = def.steps.map(s => {
    const b = lib.find(x => x.key === s.use)
    if (b) return { uid: b.key, base: b, included: true, step: s }
    if (s.use === 'parallel') return { uid: uid(), step: { ...s, lanes: (s.lanes || []).map(({ steps: _s, ...l }) => l) }, lanes: (s.lanes || []).map(l => ({ uid: uid(), items: (l.steps || []).map(lift) })) }
    if (s.use !== 'branch') return lift(s)
    const { routes = [], otherwise = {} } = s
    return { uid: uid(), step: { ...s, routes: routes.map(({ steps: _s, ...r }) => r), otherwise: { label: otherwise.label || '', ...(otherwise.back && { back: otherwise.back }) } },
      lanes: [...routes.map(r => ({ uid: uid(), items: (r.steps || []).map(lift) })), { uid: uid(), items: (otherwise.steps || []).map(lift) }] }
  })
  for (const [k, b] of lib.entries()) {
    if (items.some(it => it.base?.key === b.key)) continue
    const after = items.map((it, i) => [it, i]).filter(([it]) => it.base && keys.indexOf(it.base.key) < k).map(([, i]) => i).pop()
    items.splice(after === undefined ? 0 : after + 1, 0, { uid: b.key, base: b, included: false, step: { use: b.key } })
  }
  return items
}
/**
 * A run's own steps as items, to draw it as it ran (read-only): a person's workflow from the definition the run started
 * with, a built-in one from the run's stages (with the picks it ran with) — never the draft, which may have changed since.
 */
export function runItems(run, lib) {
  if (run.workflowDef) return itemsOf(run.workflowDef, lib)
  return (run.stages || []).filter(st => st.key !== 'followup').map(st => ({
    uid: st.key, included: true, step: { use: st.key, ...(run.config?.steps?.[run.template]?.[st.key] || {}) },
    base: lib.find(b => b.key === st.key) || { key: st.key, owner: st.owner, optional: false, final: false, fullOnly: false, agent: null }, // a step the workflow has since dropped
  }))
}
/** A built-in workflow as items: its steps, each with the person's picks; an optional one turned off is skipped. */
export const builtInItems = (wf, picks) => wf.library.map(b => ({ uid: b.key, base: b, included: !(b.optional && picks.stages?.[b.key] === false), step: { use: b.key, ...(picks.steps?.[wf.id]?.[b.key] || {}) } }))
/** Items back to a definition's steps. */
export const stepsOf = items => items.filter(it => !it.base || it.included).map(it => (!it.lanes ? it.step
  : it.step.use === 'parallel' ? { ...it.step, lanes: it.step.lanes.map((l, k) => ({ ...l, steps: it.lanes[k].items.map(x => x.step) })) }
    : { ...it.step, routes: it.step.routes.map((r, k) => ({ ...r, steps: it.lanes[k].items.map(x => x.step) })), otherwise: { ...it.step.otherwise, steps: it.lanes.at(-1).items.map(x => x.step) } }))
const pickOf = s => Object.fromEntries(Object.entries({ agent: s.agent || undefined, fallback: s.fallback, skills: s.skills?.length ? s.skills : undefined, model: s.model || undefined }).filter(([, v]) => v !== undefined))
export const customized = s => Object.keys(pickOf(s)).length > 0
/** A built-in workflow's configuration as the settings keep it: each agent or model step's picks, the optional steps on or off. */
export function builtInConfig(items) {
  const steps = {}, stages = {}
  for (const it of items) {
    if (it.base.agent || it.base.model) { const p = pickOf(it.step); if (Object.keys(p).length) steps[it.base.key] = p }
    if (it.base.optional) stages[it.base.key] = it.included
  }
  return { steps, stages }
}
/** Every item, a branch's lanes included, with where it is: { it, list (the array it sits in), lane, index }. */
export function walk(items) {
  const out = []
  items.forEach((it, index) => {
    out.push({ it, list: items, lane: null, index })
    it.lanes?.forEach((ln, k) => ln.items.forEach((x, j) => out.push({ it: x, list: ln.items, lane: { branch: it.uid, k }, index: j })))
  })
  return out
}
export const find = (items, id) => walk(items).find(x => x.it.uid === id) || null
const sameLane = (a, b) => (!a && !b) || (a && b && a.branch === b.branch && a.k === b.k)
/** The list a slot points into (a copy of the whole tree changed by fn). */
function edit(items, lane, fn) {
  if (!lane) return fn([...items])
  return items.map(it => (it.uid === lane.branch ? { ...it, lanes: it.lanes.map((ln, k) => (k === lane.k ? { ...ln, items: fn([...ln.items]) } : ln)) } : it))
}
export const insertAt = (items, slot, item) => edit(items, slot.lane, list => { list.splice(slot.index, 0, item); return list })
export const removeId = (items, id) => items.filter(it => it.uid !== id).map(it => (it.lanes ? { ...it, lanes: it.lanes.map(ln => ({ ...ln, items: ln.items.filter(x => x.uid !== id) })) } : it))
export const updateId = (items, id, fn) => items.map(it => (it.uid === id ? fn(it) : it.lanes ? { ...it, lanes: it.lanes.map(ln => ({ ...ln, items: ln.items.map(x => (x.uid === id ? fn(x) : x)) })) } : it))
export function moveId(items, id, slot) {
  const at = find(items, id)
  if (!at) return items
  // the same list: the slot's index counts the item still in place
  const index = sameLane(at.lane, slot.lane) && slot.index > at.index ? slot.index - 1 : slot.index
  return insertAt(removeId(items, id), { ...slot, index }, at.it)
}
export const addRoute = (items, id, route) => updateId(items, id, it => ({ ...it, step: { ...it.step, routes: [...it.step.routes, route] }, lanes: [...it.lanes.slice(0, -1), { uid: uid(), items: [] }, it.lanes.at(-1)] }))
export const removeRoute = (items, id, k) => updateId(items, id, it => ({ ...it, step: { ...it.step, routes: it.step.routes.filter((_, j) => j !== k) }, lanes: it.lanes.filter((_, j) => j !== k) }))
/** A parallel block's lanes: one more (at the end), one fewer. */
export const addLane = (items, id, lane) => updateId(items, id, it => ({ ...it, step: { ...it.step, lanes: [...it.step.lanes, lane] }, lanes: [...it.lanes, { uid: uid(), items: [] }] }))
export const removeLane = (items, id, k) => updateId(items, id, it => ({ ...it, step: { ...it.step, lanes: it.step.lanes.filter((_, j) => j !== k) }, lanes: it.lanes.filter((_, j) => j !== k) }))
/** Is a slot (or an item's place) in a parallel block's lane? Only read-only agent and script steps go there. */
export const inParallel = (items, lane) => !!lane && find(items, lane.branch)?.it.step.use === 'parallel'
/** A route (k: the "otherwise" one last) that goes back to an earlier step instead of going on. */
export const routeBack = (it, k) => (it.step.use !== 'branch' ? null : (k < it.step.routes.length ? it.step.routes[k] : it.step.otherwise)?.back || null)
/**
 * The steps a step can go back to (its "on failure"), or that a branch's route reads: those before it on the main line
 * and, before it in its own lane, the steps of that lane; a parallel block's lanes for what they handed back (`inLane`).
 */
export function before(items, at) {
  const out = [], main = items.filter(x => !x.base || x.included)
  const top = at.lane ? main.findIndex(x => x.uid === at.lane.branch) : main.indexOf(at.it)
  for (const x of main.slice(0, top)) {
    out.push({ it: x, inLane: false })
    if (x.step.use === 'parallel') x.lanes.forEach(l => l.items.forEach(y => out.push({ it: y, inLane: true })))
  }
  if (at.lane) at.list.slice(0, at.index).forEach(x => out.push({ it: x, inLane: false })) // its own route's steps before it
  return out.map(({ it, inLane }) => ({ id: it.base ? it.base.key : it.step.id, uid: it.uid, title: it.base ? null : it.step.title || it.step.id, key: it.base?.key || null, use: it.base ? 'base' : it.step.use, onFail: it.step.onFail, inLane })).filter(x => x.use !== 'branch')
}
/** Can the step `from` go back to `to` (a loop dragged on the canvas)? An agent, model or script step of one's own, to a step before it on its path. */
export function canLoop(items, from, to) {
  const at = find(items, from)
  if (!at || at.it.base || !['agent', 'model', 'script'].includes(at.it.step.use) || inParallel(items, at.lane)) return false
  return before(items, at).some(x => x.uid === to && !x.inLane)
}

/**
 * Where steps of one's own may go: after the workflow's `insertFrom` step (the first one when it names none), before its
 * first closing step (a branch's routes: always; a branch only on the main line) — the same window lib/workflows.js
 * checks. → { canAt(items, slot), restorable(items, slot), from, to }
 */
export function rulesOf(lib, insertFrom) {
  const keys = lib.map(b => b.key)
  const lo = Math.max(0, keys.indexOf(insertFrom)), f = lib.findIndex(b => b.final), hi = f < 0 ? keys.length : f
  // a base step left out does not count: the definition lists only those it keeps
  const baseAt = (list, i) => (list[i]?.base && list[i].included !== false ? keys.indexOf(list[i].base.key) : null)
  const around = (items, index) => {
    let prev = -1, next = keys.length
    for (let k = 0; k < index; k++) if (baseAt(items, k) !== null) prev = baseAt(items, k)
    for (let k = index; k < items.length; k++) if (baseAt(items, k) !== null) { next = baseAt(items, k); break }
    return { prev, next }
  }
  const canAt = (items, slot) => {
    if (slot.lane) return true
    const { prev, next } = around(items, slot.index)
    return prev >= lo && next <= hi
  }
  // the optional base steps left out that belong around a slot (between the base steps before and after it)
  const restorable = (items, slot) => {
    if (slot.lane) return []
    const { prev, next } = around(items, slot.index)
    return items.filter(it => it.base && !it.included && keys.indexOf(it.base.key) > prev && keys.indexOf(it.base.key) < next)
  }
  return { canAt, restorable, from: keys[lo], to: keys[hi] }
}

export const LEFT = 48 // room left of the first column
const ROW_GAP = 70, BAND_PAD = 30
const PHASES = ['all'] // one block: the steps are not grouped into phases

/**
 * Rows, top to bottom: the steps left to right — on to another row after `cols` columns — a branch's routes stacked in
 * its row, then the step after the branch.
 * `backs`: the workflow's loops (backsOf). → { nodes: [{ id, it, x, y, lane, phase, row, n }], edges: [{ id, from, to, slot?, route?, cross?, loop? }] (cross: on to
 *   the next row), labels: [{ id, x, y, lane, k }] (a route's name over its row), slots: [{ slot, x, y, node }] (the +
 *   after each step), phases: [{ id, x0, x1, y0, y1, steps, agents }], width, height }
 */
export function layout(items, { backs = {}, cols = 4, hidden = it => it.base && !it.included } = {}) {
  // the steps on the main line: a unit of one column, a branch one plus its longest route
  const phase = PHASES[0]
  const units = []
  items.forEach((it, i) => {
    if (hidden(it)) return
    // a branch: itself and its longest route; a parallel block: its fork, its longest lane and its join
    units.push({ it, i, phase, cols: it.lanes ? (it.step.use === 'parallel' ? 2 : 1) + Math.max(1, ...it.lanes.map(l => l.items.length)) : 1, span: it.lanes ? (it.lanes.length - 1) * DY : 0 })
  })
  // rows: a phase's units, wrapped after `cols` columns (a branch is never split)
  const rows = []
  for (const u of units) {
    const last = rows.at(-1)
    if (last && last.phase === u.phase && last.cols + u.cols <= cols) { last.units.push(u); last.cols += u.cols } else rows.push({ phase: u.phase, units: [u], cols: u.cols })
  }
  const nodes = [], edges = [], labels = [], slots = []
  let y = 0, n = 0, pending = []
  const link = (to, row) => { for (const p of pending) edges.push({ id: `e-${p.from}-${to}${p.route !== undefined ? `-${p.route}` : ''}`, from: p.from, to, slot: p.slot, route: p.route, cross: p.row !== row }); pending = [] }
  rows.forEach((row, r) => {
    // (a row with routes: room for their names over them, clear of the line coming in)
    if (r) y += ROW_GAP + (row.units.some(u => u.it.lanes) ? 26 : 0)
    const span = Math.max(0, ...row.units.map(u => u.span)), mid = y + span / 2
    let x = LEFT
    for (const u of row.units) {
      const it = u.it
      nodes.push({ id: it.uid, it, x, y: mid, lane: null, phase: row.phase, row: r, n: it.base && it.included === false ? null : ++n })
      link(it.uid, r)
      if (!it.lanes) { pending = [{ from: it.uid, row: r, slot: { lane: null, index: u.i + 1 } }]; x += DX; continue }
      const count = it.lanes.length, par = it.step.use === 'parallel'
      // a parallel block's lanes meet at its join (a column of its own); a branch's routes go on to the step after it
      const join = par ? { id: `join:${it.uid}`, it: null, join: it, x: x + DX * (u.cols - 1), y: mid, lane: null, phase: row.phase, row: r, n: null } : null
      const ends = []
      it.lanes.forEach((ln, k) => {
        const ly = mid + (k - (count - 1) / 2) * DY, lane = { branch: it.uid, k }
        labels.push({ id: `${it.uid}:${k}`, x: x + DX, y: ly, lane, k, branch: it })
        const goesBack = !!routeBack(it, k) // a route that goes back does not go on: its loop is drawn instead
        // an empty route: a placeholder in its row (a + to fill it), straight on to the step after the branch
        if (!ln.items.length) {
          const pid = `ph:${it.uid}:${k}`
          nodes.push({ id: pid, it: null, placeholder: true, x: x + DX, y: ly, lane, phase: row.phase, row: r, n: null })
          edges.push({ id: `e-${it.uid}-${pid}`, from: it.uid, to: pid, route: k })
          if (!goesBack) ends.push({ from: pid, row: r, slot: { lane, index: 0 } })
          return
        }
        edges.push({ id: `e-${it.uid}-${ln.items[0].uid}`, from: it.uid, to: ln.items[0].uid, slot: { lane, index: 0 }, route: k })
        ln.items.forEach((li, j) => {
          nodes.push({ id: li.uid, it: li, x: x + DX * (j + 1), y: ly, lane, phase: row.phase, row: r, n: ++n })
          if (j) edges.push({ id: `e-${ln.items[j - 1].uid}-${li.uid}`, from: ln.items[j - 1].uid, to: li.uid, slot: { lane, index: j } })
        })
        if (!goesBack) ends.push({ from: ln.items.at(-1).uid, row: r, slot: { lane, index: ln.items.length } })
      })
      if (join) {
        nodes.push(join)
        for (const e of ends) edges.push({ id: `e-${e.from}-${join.id}`, from: e.from, to: join.id, slot: e.slot })
        pending = [{ from: join.id, row: r, slot: { lane: null, index: u.i + 1 } }]
      } else pending.push(...ends)
      x += DX * u.cols
    }
    Object.assign(row, { y0: y, y1: y + span + NODE.h, x1: x - DX + NODE.w })
    y += span + NODE.h
  })
  // the + after each step (what follows it)
  for (const nd of nodes) {
    if (nd.join) { slots.push({ slot: { lane: null, index: items.indexOf(nd.join) + 1 }, x: nd.x + NODE.w + 28, y: nd.y + NODE.h / 2, node: nd.id }); continue }
    if (!nd.it || nd.it.lanes) continue
    const at = nd.lane ? { lane: nd.lane, index: find(items, nd.id).index + 1 } : { lane: null, index: items.indexOf(nd.it) + 1 }
    slots.push({ slot: at, x: nd.x + NODE.w + 28, y: nd.y + NODE.h / 2, node: nd.id })
  }
  // the loops, where both ends are there: the workflow's own (a check sends the work back to the change; a step round
  // itself: a retry) and a step's "on failure, go back to"
  const shown = nodes.filter(nd => nd.it && (!nd.it.base || nd.it.included))
  const visible = new Map(shown.map(nd => [nd.it.base ? nd.it.base.key : nd.it.step.id, nd]))
  for (const nd of shown) {
    const own = nd.it.base ? null : nd.it.step.onFail?.goto, to = own || backs[nd.it.base ? nd.it.base.key : nd.it.step.id]
    if (to && visible.has(to)) edges.push({ id: `loop-${nd.id}`, from: nd.id, to: visible.get(to).id, loop: own ? 'own' : 'base' })
    // a branch's routes that go back: from the route's end (its last step, else the branch) to where they go
    if (nd.it.step?.use === 'branch' && nd.it.lanes) nd.it.lanes.forEach((ln, k) => {
      const b = routeBack(nd.it, k)
      if (b && visible.has(b.to)) edges.push({ id: `loop-${nd.id}-${k}`, from: ln.items.at(-1)?.uid || `ph:${nd.it.uid}:${k}`, to: visible.get(b.to).id, loop: 'route', max: b.max })
    })
  }
  // a band per phase, as wide as the widest row
  const width = Math.max(LEFT + NODE.w, ...rows.map(r => r.x1)) + BAND_PAD
  const phases = PHASES.map(p => {
    const mine = rows.filter(r => r.phase === p)
    if (!mine.length) return null
    const steps = nodes.filter(nd => nd.phase === p && nd.it && (!nd.it.base || nd.it.included))
    return { id: p, x0: 0, x1: width, y0: mine[0].y0 - BAND_PAD, y1: mine.at(-1).y1 + BAND_PAD, steps: steps.length,
      agents: steps.filter(nd => (nd.it.base ? nd.it.base.agent : nd.it.step.use === 'agent' || nd.it.step.mode === 'agent')).length }
  }).filter(Boolean)
  return { nodes, edges, labels, slots, phases, width, height: (phases.at(-1)?.y1 || 0) - (phases[0]?.y0 || 0) }
}

/** A ready-made block as a step: an id not taken yet, its title and defaults (texts: the caller's words; `when`: a new condition route's test). */
export function blockStep(preset, { taken, title, instructions, agent, when }) {
  let n = 1
  const base = { agent: 'agent', model: 'model', script: 'script', flow: 'flow', approval: 'approval', person: preset.ask, output: 'result', branch: preset.mode === 'agent' ? 'router' : 'branch', parallel: 'parallel' }[preset.use]
  while (taken.has(`${base}-${n}`)) n++
  const id = `${base}-${n}`
  if (preset.use === 'agent') return { id, use: 'agent', title, instructions: instructions || '', agent: agent || '', fallback: '', access: preset.access || 'read', tools: [], skills: [], onFail: 'stop' }
  if (preset.use === 'model') return { id, use: 'model', title, instructions: instructions || '', model: '', onFail: 'stop' }
  if (preset.use === 'script') return { id, use: 'script', title, ...(preset.script ? { script: preset.script, args: [] } : { run: '' }), cwd: 'run', timeoutMinutes: 10, connectors: {}, onFail: 'stop' }
  if (preset.use === 'flow') return { id, use: 'flow', title, source: FLOW_TEMPLATE, agents: { coder: { agent: agent || '', fallback: '', access: 'write' } }, params: {}, onFail: 'stop' }
  if (preset.use === 'approval') return { id, use: 'approval', title, text: '' }
  if (preset.use === 'output') return { id, use: 'output', title, text: '' }
  if (preset.use === 'person') return { id, use: 'person', ask: preset.ask, title, text: '', ...(preset.ask === 'decide' && { options: [{ label: '' }, { label: '' }] }), wait: PERSON_WAIT[preset.ask] }
  if (preset.use === 'parallel') return { id, use: 'parallel', title, lanes: [{ id: 'lane-1', label: 'A', steps: [] }, { id: 'lane-2', label: 'B', steps: [] }], onFail: 'stop' }
  return preset.mode === 'agent'
    ? { id, use: 'branch', title, mode: 'agent', agent: agent || '', fallback: '', instructions: '', routes: [{ id: 'route-1', label: 'A', hint: '' }, { id: 'route-2', label: 'B', hint: '' }], otherwise: { label: '' } }
    : { id, use: 'branch', title, mode: 'condition', routes: [{ id: 'route-1', label: 'A', when }], otherwise: { label: '' } }
}
/** Hours a person step waits before its person is reminded, by what it asks (0: no reminder) — lib/person.js's WAIT. */
export const PERSON_WAIT = { review: 0, decide: 0, input: 24, do: 72, chat: 0 }
/** A block's item (a branch gets its lanes). */
export const blockItem = step => (step.use === 'branch' ? { uid: uid(), step, lanes: [...step.routes.map(() => ({ uid: uid(), items: [] })), { uid: uid(), items: [] }] }
  : step.use === 'parallel' ? { uid: uid(), step: { ...step, lanes: step.lanes.map(({ steps: _s, ...l }) => l) }, lanes: step.lanes.map(() => ({ uid: uid(), items: [] })) } : lift(step))
/** The step a new condition route looks at by default: the one just before the slot on its path ('' when there is none). */
export function stepBefore(items, slot) {
  const idOf = it => (it.base ? it.base.key : it.step.id)
  const branch = slot.lane ? items.findIndex(x => x.uid === slot.lane.branch) : -1
  const earlier = slot.lane ? [...items.slice(0, branch), ...items[branch].lanes[slot.lane.k].items.slice(0, slot.index)] : items.slice(0, slot.index)
  const prev = earlier.filter(it => (!it.base || it.included) && it.step.use !== 'branch').at(-1)
  return prev ? idOf(prev) : ''
}
