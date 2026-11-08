// What boards are made of, as data checked alike wherever they are read — the shell (a board an agent proposes), the
// workbench (one drawn in a conversation), the page that runs them: a dataset (one metric's single definition: what it
// reads, its fields, how often), a dashboard (pages of widgets over datasets, actions only by name), a workspace preset, a
// layout, a snapshot (one run of a dataset). Pure: no I/O, no React — the server validates and self-checks with it, the views render
// from what `derive` computes, so a number is computed one way everywhere.

export const RENDERER = 1 // a description's `renderer: ">=N"` asks for at least this major

export const FIELD_TYPES = ['string', 'number', 'bool', 'enum', 'time', 'person', 'url']
export const VIEWS = ['count', 'list', 'table', 'breakdown', 'trend', 'people', 'note', 'runs', 'custom']
export const SIZES = ['s', 'm', 'l']
const APP = /^[a-z][a-z0-9-]{0,39}$/ // an app's id (a plugin of this Ruyix)
const NAME = /^[a-z][a-z0-9-]{1,48}$/, CORE = /^core\.[a-z]+$/, ID = /^[a-z0-9][a-z0-9-]{0,40}$/
const VERSION = /^\d+\.\d+\.\d+$/

/**
 * What a widget may ask the host to do — by name, with these arguments (a value "$row.<field>" takes the row's).
 * A host maps a name to its own operation and checks the person's capabilities; a dashboard brings no write of its own.
 */
export const ACTIONS = {
  'run.open': { args: { run: 'string' }, label: { zh: '打开 run', en: 'Open the run' } },
  'url.open': { args: { url: 'url' }, label: { zh: '打开链接', en: 'Open' } },
}

/**
 * The read operations a dataset may call, per connector type: their parameters and the fields they can give. Read
 * only — a connector's writes are never here. The connectors plugin runs them (`read`); everyone else checks names.
 */
export const OPS = {
  gitlab: {
    'mrs.list': { params: { project: 'string', state: 'string', target: 'string', limit: 'number' },
      fields: { id: 'string', ref: 'string', title: 'string', author: 'person', state: 'enum', source: 'string', target: 'string', pipeline: 'enum', updated: 'time', url: 'url' } },
    'pipelines.list': { params: { project: 'string', ref: 'string', status: 'string', limit: 'number' },
      fields: { id: 'string', ref: 'string', status: 'enum', source: 'enum', sha: 'string', created: 'time', updated: 'time', url: 'url' } },
  },
  k8s: {
    workloads: { params: { namespace: 'string' },
      fields: { name: 'string', namespace: 'string', kind: 'enum', ready: 'number', desired: 'number', image: 'string', updated: 'time' } },
    events: { params: { namespace: 'string', type: 'string', limit: 'number' },
      fields: { at: 'time', type: 'enum', reason: 'string', object: 'string', message: 'string' } },
  },
}

/** The datasets there are without a connection: this Ruyix's own record, read where it is kept (the workbench's store). */
export const CORE_DATASETS = {
  'core.runs': { title: { zh: 'run', en: 'Runs' }, key: 'id', fields: { id: 'string', task: 'string', workflow: 'string', state: 'enum', stage: 'string', verdict: 'enum', member: 'person', node: 'string', started: 'time', ended: 'time' } },
}

// ── small helpers ──
const err = (path, code, message) => ({ path, code, message })
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const text2 = v => isObj(v) && typeof v.zh === 'string' && typeof v.en === 'string'
const UNITS = { s: 1e3, m: 60e3, h: 3600e3, d: 864e5 }

/** "10m" → 600000 (s, m, h, d); NaN when it is not one. */
export const parseDuration = v => { const m = /^(\d{1,4})([smhd])$/.exec(String(v || '')); return m ? Number(m[1]) * UNITS[m[2]] : NaN }
export const MIN_REFRESH = 60e3 // a workspace's policy may set a higher floor; never lower

/** "1.2.3" against "1.2.3" | "^1" | "^1.2" | "~1.2" | "1.x" | ">=1" | "*". */
export function satisfies(version, range = '*') {
  const v = String(version).split('.').map(Number), r = String(range).trim()
  if (!VERSION.test(String(version))) return false
  if (r === '*' || r === '') return true
  if (VERSION.test(r)) return r === version
  const m = /^(\^|~|>=)?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(r.replace(/\.x$/, ''))
  if (!m) return false
  const [, op = '^', a, b, c] = m, want = [Number(a), b === undefined || b === 'x' ? null : Number(b), c === undefined || c === 'x' ? null : Number(c)]
  const cmp = (x, y) => x[0] - y[0] || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0)
  if (op === '>=') return cmp(v, want.map(x => x ?? 0)) >= 0
  if (v[0] !== want[0]) return false
  if (op === '~' && want[1] !== null && v[1] !== want[1]) return false
  if (op === '~' && want[1] === null) return true
  if (want[1] !== null && op === '^' && v[1] < want[1] && v[0] === want[0]) return false
  if (want[2] !== null && v[1] === want[1] && v[2] < want[2]) return false
  return true
}
/** "name@range" → { name, range }. */
export const refOf = s => { const i = String(s).lastIndexOf('@'); return i > 0 ? { name: s.slice(0, i), range: s.slice(i + 1) } : { name: String(s), range: '*' } }

/** {{settings.a.b}} in a dataset's params, from the workspace's (or this machine's) settings; an unset one stays a hole. */
export function renderParams(params = {}, settings = {}) {
  const get = path => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), settings)
  const one = v => (typeof v === 'string' ? (/^\{\{\s*settings\.([\w.]+)\s*\}\}$/.test(v) ? get(/settings\.([\w.]+)/.exec(v)[1]) ?? null : v.replace(/\{\{\s*settings\.([\w.]+)\s*\}\}/g, (_, p) => String(get(p) ?? ''))) : Array.isArray(v) ? v.map(one) : v)
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, one(v)]))
}

// ── datasets ──

/** A dataset as published: one producer (a connector's read op, or a Market script; an agent later), its fields, its cadence. */
export function validateDataset(d) {
  const out = []
  if (!isObj(d)) return { ok: false, errors: [err('', 'notObject', 'a dataset is an object')] }
  if (d.kind !== 'dataset') out.push(err('kind', 'kind', 'kind must be "dataset"'))
  if (!NAME.test(String(d.name || ''))) out.push(err('name', 'name', 'name: 2–49 lowercase letters, digits, dashes'))
  if (!VERSION.test(String(d.version || ''))) out.push(err('version', 'version', 'version: x.y.z'))
  if (d.title !== undefined && !text2(d.title)) out.push(err('title', 'title', 'title: { zh, en }'))
  const producers = ['connector', 'script', 'agent'].filter(k => d[k] !== undefined)
  if (producers.length !== 1) out.push(err('connector', 'producer', 'exactly one producer: connector + op, script, or agent'))
  let offered = null
  if (d.params !== undefined && !isObj(d.params)) out.push(err('params', 'params', 'params: { name: value }'))
  if (d.connector !== undefined && (typeof d.connector !== 'string' || typeof d.op !== 'string')) out.push(err('connector', 'connector', 'connector and op: names (strings)'))
  else if (d.connector !== undefined) {
    const ops = Object.hasOwn(OPS, d.connector) ? OPS[d.connector] : null, op = ops && Object.hasOwn(ops, d.op) ? ops[d.op] : null // own names only
    if (!ops) out.push(err('connector', 'connector', `no read ops for the connector type "${d.connector}"`))
    else if (!op) out.push(err('op', 'op', `"${d.op}" is not a read op of ${d.connector} (${Object.keys(OPS[d.connector]).join(', ')})`))
    else {
      offered = op.fields
      // a value of its type
      // a setting is text: it stands only where text goes — a string, or a string in a list (["{{settings.…}}"])
      const typed = { number: v => typeof v === 'number' && Number.isFinite(v), string: v => typeof v === 'string', 'string[]': v => Array.isArray(v) && v.every(x => typeof x === 'string') }
      for (const [k, v] of Object.entries(d.params || {})) {
        if (Object.hasOwn(op.params, k) && !(typed[op.params[k]] || (() => true))(v)) out.push(err(`params.${k}`, 'paramType', `${d.connector} ${d.op}: "${k}" is a ${op.params[k]}`))
        if (!Object.hasOwn(op.params, k)) out.push(err(`params.${k}`, 'param', `${d.connector} ${d.op} takes no "${k}"`))
        else if (typeof v === 'string' && /\{\{/.test(v) && !/^[^{]*(\{\{\s*settings\.[\w.]+\s*\}\}[^{]*)+$/.test(v)) out.push(err(`params.${k}`, 'template', 'a template is {{settings.<path>}}'))
      }
    }
  } else if (d.op !== undefined) out.push(err('op', 'op', 'op goes with connector'))
  if (d.script !== undefined && !/^[a-z0-9][\w.-]{0,63}@[\w.^~>=*-]{1,20}$/.test(String(d.script))) out.push(err('script', 'script', 'script: "<name>@<range>" of a Market script'))
  if (d.agent !== undefined) out.push(err('agent', 'notYet', 'an agent-made dataset is not supported yet'))
  if (!isObj(d.fields) || !Object.keys(d.fields).length) out.push(err('fields', 'fields', 'fields: { name: type } — at least one'))
  else for (const [k, t] of Object.entries(d.fields)) {
    if (!/^[a-z_][a-z0-9_]{0,40}$/i.test(k)) out.push(err(`fields.${k}`, 'field', 'a field name is a word'))
    if (!FIELD_TYPES.includes(t)) out.push(err(`fields.${k}`, 'type', `a field's type is one of ${FIELD_TYPES.join(', ')}`))
    else if (offered && !Object.hasOwn(offered, k)) out.push(err(`fields.${k}`, 'notOffered', `${d.connector} ${d.op} gives no "${k}"`))
  }
  if (d.key !== undefined && !Object.hasOwn(d.fields || {}, d.key)) out.push(err('key', 'key', 'key: one of the fields'))
  for (const [k, v] of Object.entries(d.labels || {})) if (!Object.hasOwn(d.fields || {}, k) || !text2(v)) out.push(err(`labels.${k}`, 'label', 'labels: { field: { zh, en } } of its fields'))
  const every = parseDuration(d.refresh)
  if (!(every >= MIN_REFRESH)) out.push(err('refresh', 'refresh', `refresh: a duration like "10m", at least ${MIN_REFRESH / 60e3} minute`))
  if (d.history !== undefined) {
    if (!isObj(d.history) || !Array.isArray(d.history.keep) || !d.history.keep.every(k => k === 'count' || (d.fields?.[k] === 'number')))
      out.push(err('history', 'history', 'history.keep: "count" or number fields'))
    else if (d.history.days !== undefined && !(Number.isInteger(d.history.days) && d.history.days >= 1 && d.history.days <= 365)) out.push(err('history.days', 'days', 'history.days: 1–365'))
  }
  return { ok: !out.length, errors: out }
}

/** A dataset's spec by name: a core one, or one of `datasets` ({ name: spec }). */
export const datasetOf = (name, datasets = {}) => (CORE.test(name) ? { name, kind: 'dataset', core: true, ...CORE_DATASETS[name] } : Object.hasOwn(datasets, name) ? datasets[name] : null)

// A string field's text leaves the machine without an email or an IPv4 address in it (a title can quote one).
const scrub = v => v.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>').replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')

/**
 * A run's rows as the dataset says they are: only its fields, each of its type (a value that is not: null), strings
 * scrubbed — what a board is given, checked again where it is drawn. → { rows, bad } (bad: [{ row, field, value }], at most 20).
 */
export function shapeRows(rows, dataset) {
  const fields = dataset.fields || {}, bad = []
  const ok = (t, v) => v == null || (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'bool' ? typeof v === 'boolean' : t === 'time' ? !Number.isNaN(Date.parse(v)) || typeof v === 'number' : typeof v === 'string')
  const out = (Array.isArray(rows) ? rows : []).map((r, i) => Object.fromEntries(Object.entries(fields).map(([k, t]) => {
    const v = r?.[k]
    if (ok(t, v)) return [k, t === 'string' && v ? scrub(v) : v ?? null]
    if (bad.length < 20) bad.push({ row: i, field: k, value: String(v).slice(0, 60) })
    return [k, null]
  })))
  return { rows: out, bad }
}

/** One point of a dataset's history from a run's rows: { at, count (rows), <number field kept>: its sum }. */
export const historyPoint = (rows, dataset, at) => Object.fromEntries([['at', at], ['count', rows.length], ...(dataset.history?.keep || []).filter(k => k !== 'count').map(k => [k, rows.reduce((n, r) => n + (Number(r[k]) || 0), 0)])])

/** The rows as one string — the same on every machine — for the snapshot's hash (the host hashes it: sha256). */
export const canonical = (rows, dataset) => JSON.stringify(shapeRows(rows, dataset).rows.map(r => Object.keys(r).sort().map(k => [k, r[k]])))

// ── dashboards ──

/** Is `$row.<field>` (or a literal) a valid value of an action's argument over these fields? */
const argOk = (v, fields) => (typeof v === 'string' && v.startsWith('$row.') ? Object.hasOwn(fields, v.slice(5)) : typeof v === 'string' || typeof v === 'number')

/**
 * A dashboard as published: pages of widgets, each over one of the datasets it names (alias → "name@range"); fields it
 * filters, groups or shows must be the dataset's; actions only from ACTIONS. `datasets`: the specs to check against
 * ({ name: spec } — the versions the ranges resolve to); without one, a widget's fields are not checked.
 */
export function validateDashboard(b, { datasets = {} } = {}) {
  const out = []
  if (!isObj(b)) return { ok: false, errors: [err('', 'notObject', 'a dashboard is an object')] }
  if (b.kind !== 'dashboard') out.push(err('kind', 'kind', 'kind must be "dashboard"'))
  if (!NAME.test(String(b.name || ''))) out.push(err('name', 'name', 'name: 2–49 lowercase letters, digits, dashes'))
  if (!VERSION.test(String(b.version || ''))) out.push(err('version', 'version', 'version: x.y.z'))
  if (b.title !== undefined && !text2(b.title)) out.push(err('title', 'title', 'title: { zh, en }'))
  const need = /^>=\s*(\d+)$/.exec(String(b.renderer || '>=1'))
  if (!need) out.push(err('renderer', 'renderer', 'renderer: ">=N"'))
  else if (Number(need[1]) > RENDERER) out.push(err('renderer', 'rendererNewer', `needs renderer ${need[1]}; this is ${RENDERER}`))
  const aliases = isObj(b.datasets) ? b.datasets : {}
  for (const [a, ref] of Object.entries(aliases)) {
    if (!ID.test(a)) out.push(err(`datasets.${a}`, 'alias', 'an alias is a short word'))
    const { name } = refOf(ref)
    if (!CORE.test(name) && !NAME.test(name)) out.push(err(`datasets.${a}`, 'ref', '"name@range" of a dataset, or core.<name>'))
    if (CORE.test(name) && !Object.hasOwn(CORE_DATASETS, name)) out.push(err(`datasets.${a}`, 'core', `no built-in dataset ${name}`))
  }
  if (!Array.isArray(b.pages) || !b.pages.length) out.push(err('pages', 'pages', 'at least one page'))
  const pageIds = new Set()
  ;(b.pages || []).forEach((p, pi) => {
    const at = `pages.${pi}`
    if (typeof p?.id !== 'string' || !ID.test(p.id)) out.push(err(`${at}.id`, 'id', 'a page id is a short word (a string)'))
    else if (pageIds.has(p.id)) out.push(err(`${at}.id`, 'dup', `two pages are "${p.id}"`))
    pageIds.add(p?.id)
    if (!text2(p?.title)) out.push(err(`${at}.title`, 'title', 'a page title is { zh, en }'))
    const wIds = new Set()
    ;(p?.widgets || []).forEach((w, wi) => {
      const wat = `${at}.widgets.${wi}`
      if (typeof w?.id !== 'string' || !ID.test(w.id)) out.push(err(`${wat}.id`, 'id', 'a widget id is a short word (a string)'))
      else if (wIds.has(w.id)) out.push(err(`${wat}.id`, 'dup', `two widgets are "${w.id}"`))
      wIds.add(w?.id)
      if (!VIEWS.includes(w?.view)) out.push(err(`${wat}.view`, 'view', `view: one of ${VIEWS.join(', ')}`))
      if (w?.size !== undefined && !SIZES.includes(w.size)) out.push(err(`${wat}.size`, 'size', 'size: s, m or l'))
      if (w?.title !== undefined && !text2(w.title)) out.push(err(`${wat}.title`, 'title', 'title: { zh, en }'))
      if (w?.view === 'note') { if (!text2(w.text)) out.push(err(`${wat}.text`, 'text', 'a note is text: { zh, en }')); return }
      if (!Object.hasOwn(aliases, w?.data)) { out.push(err(`${wat}.data`, 'data', `data: one of the dashboard's datasets (${Object.keys(aliases).join(', ') || 'none'})`)); return }
      const spec = datasetOf(refOf(aliases[w.data]).name, datasets), fields = spec?.fields
      if (!fields) return
      const field = (k, path) => { if (!Object.hasOwn(fields, k)) out.push(err(path, 'field', `"${k}" is not a field of ${refOf(aliases[w.data]).name}`)) }
      // a filter is what matchRow reads: a value, a list of values, or { min, max (numbers), since (a duration), has (text) }
      const prim = v => ['string', 'number', 'boolean'].includes(typeof v) && (typeof v !== 'number' || Number.isFinite(v))
      if (w.filter !== undefined && !isObj(w.filter)) out.push(err(`${wat}.filter`, 'filter', 'filter: { field: value | [values] | { min, max, since, has } }'))
      for (const [k, f] of Object.entries(isObj(w.filter) ? w.filter : {})) {
        field(k, `${wat}.filter.${k}`)
        const ok = prim(f) || (Array.isArray(f) && f.every(prim)) || (isObj(f) && Object.keys(f).length > 0 && Object.entries(f).every(([o, x]) =>
          (['min', 'max'].includes(o) && typeof x === 'number' && Number.isFinite(x)) || (o === 'since' && parseDuration(x) > 0) || (o === 'has' && typeof x === 'string')))
        if (!ok) out.push(err(`${wat}.filter.${k}`, 'filterValue', 'a filter is a value, a list of values, or { min, max, since, has }'))
      }
      for (const [key, v] of [['by', w.by], ['sort', w.sort], ['value', w.value]]) if (v !== undefined && typeof v !== 'string') out.push(err(`${wat}.${key}`, key, `${key}: a field's name`))
      if (w.columns !== undefined && !(Array.isArray(w.columns) && w.columns.every(c => typeof c === 'string'))) out.push(err(`${wat}.columns`, 'columns', 'columns: field names'))
      if (w.by !== undefined) field(w.by, `${wat}.by`)
      if (['breakdown', 'people'].includes(w.view) && w.by === undefined) out.push(err(`${wat}.by`, 'by', `a ${w.view} groups by a field: by`))
      for (const k of w.columns || []) field(k, `${wat}.columns`)
      if (w.sort !== undefined) field(String(w.sort).replace(/^-/, ''), `${wat}.sort`)
      if (w.value !== undefined && !(w.value === 'count' || fields[w.value] === 'number')) out.push(err(`${wat}.value`, 'value', 'value: "count" (rows) or a number field (summed)'))
      if (w.limit !== undefined && !(Number.isInteger(w.limit) && w.limit >= 1 && w.limit <= 500)) out.push(err(`${wat}.limit`, 'limit', 'limit: 1–500'))
      ;(w.actions || []).forEach((a, ai) => {
        const def = ACTIONS[a?.op]
        if (!def) { out.push(err(`${wat}.actions.${ai}.op`, 'action', `op: one of ${Object.keys(ACTIONS).join(', ')}`)); return }
        if (a.label !== undefined && !text2(a.label)) out.push(err(`${wat}.actions.${ai}.label`, 'label', 'label: { zh, en } (words, shown on its button)'))
        for (const k of Object.keys(def.args)) if (!argOk(a.args?.[k], fields)) out.push(err(`${wat}.actions.${ai}.args.${k}`, 'arg', `${a.op} needs ${k}: "$row.<field>" or a value`))
        for (const k of Object.keys(a.args || {})) if (!(k in def.args)) out.push(err(`${wat}.actions.${ai}.args.${k}`, 'arg', `${a.op} takes no "${k}"`))
      })
    })
  })
  return { ok: !out.length, errors: out }
}

/** A workspace preset (Market `workspace`): what a new workspace starts with — copied into its layout and policy once. */
export function validateWorkspace(w) {
  const out = []
  if (!isObj(w)) return { ok: false, errors: [err('', 'notObject', 'a workspace preset is an object')] }
  if (w.kind !== 'workspace') out.push(err('kind', 'kind', 'kind must be "workspace"'))
  if (!NAME.test(String(w.name || ''))) out.push(err('name', 'name', 'name: 2–49 lowercase letters, digits, dashes'))
  if (!VERSION.test(String(w.version || ''))) out.push(err('version', 'version', 'version: x.y.z'))
  if (!text2(w.title)) out.push(err('title', 'title', 'title: { zh, en }'))
  ;(w.dashboards || []).forEach((d, i) => { if (!NAME.test(refOf(d).name)) out.push(err(`dashboards.${i}`, 'ref', '"name@range" of a dashboard')) })
  ;(w.apps || []).forEach((a, i) => {
    if (!APP.test(String(a?.id || ''))) out.push(err(`apps.${i}.id`, 'app', 'an app: its id (lowercase letters, digits, dashes)'))
    for (const [k, v] of Object.entries(a?.kinds || {})) if (!isObj(v) || typeof v.workflow !== 'string') out.push(err(`apps.${i}.kinds.${k}`, 'kind', 'a task kind names its workflow'))
  })
  for (const [k, v] of Object.entries(w.reports || {})) if (!NAME.test(refOf(v).name)) out.push(err(`reports.${k}`, 'ref', '"name@range" of a report template'))
  if (w.layout !== undefined && !isObj(w.layout)) out.push(err('layout', 'layout', 'layout: { home, order }'))
  return { ok: !out.length, errors: out }
}

/** A layout (a Ruyix's own): its dashboards (locked), its apps, its home. */
export function validateLayout(l) {
  const out = []
  if (!isObj(l)) return { ok: false, errors: [err('', 'notObject', 'a layout is an object')] }
  ;(l.dashboards || []).forEach((d, i) => {
    if (isObj(d) ? typeof d.local !== 'string' : !(NAME.test(refOf(d).name) && VERSION.test(refOf(d).range))) out.push(err(`dashboards.${i}`, 'ref', 'a dashboard: "name@x.y.z" (locked) or { local }'))
  })
  for (const a of l.apps || []) if (!APP.test(String(a))) out.push(err('apps', 'app', 'an app: its id (lowercase letters, digits, dashes)'))
  if (l.preset !== undefined && !(NAME.test(refOf(l.preset).name) && VERSION.test(refOf(l.preset).range))) out.push(err('preset', 'preset', 'preset: the "name@x.y.z" it was applied from'))
  for (const [k, v] of Object.entries(l.lock || {})) if (!VERSION.test(String(v))) out.push(err(`lock.${k}`, 'lock', 'a locked version is x.y.z'))
  if (l.home !== undefined && !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(String(l.home))) out.push(err('home', 'home', 'home: "<dashboard>/<page>"'))
  return { ok: !out.length, errors: out }
}

// ── what a widget shows: computed from one snapshot's rows, the same way on every host ──

const lc = v => String(v ?? '').toLowerCase()
/** A row passes a filter: { field: value | [values] (any of) | { min, max } | { since: "7d" } }. */
export function matchRow(row, filter = {}, now = Date.now()) {
  for (const [k, f] of Object.entries(filter || {})) {
    const v = row[k]
    if (Array.isArray(f)) { if (!f.some(x => lc(x) === lc(v))) return false } else if (isObj(f)) {
      if (f.min !== undefined && !(Number(v) >= f.min)) return false
      if (f.max !== undefined && !(Number(v) <= f.max)) return false
      if (f.since !== undefined) { const t = typeof v === 'number' ? v : Date.parse(v); if (!(t >= now - parseDuration(f.since))) return false }
      if (f.has !== undefined && !lc(v).includes(lc(f.has))) return false
    } else if (lc(f) !== lc(v)) return false
  }
  return true
}
const sortBy = (rows, sort) => {
  if (!sort) return rows
  const desc = String(sort).startsWith('-'), k = String(sort).replace(/^-/, '')
  const val = r => { const v = r[k]; const t = typeof v === 'string' ? Date.parse(v) : NaN; return typeof v === 'number' ? v : Number.isNaN(t) || !/^\d{4}-/.test(v) ? lc(v) : t }
  return [...rows].sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * (desc ? -1 : 1) })
}

/**
 * A widget's numbers from rows: count → { value }, breakdown / people → { groups: [{ key, count }] } (largest first) —
 * rows counted, or with `value` a number field, that field summed;
 * list / table / runs → { rows, total } (filtered, sorted, cut to limit — total before the cut), trend → { points } from a
 * snapshot's history, note → {}. The count a widget shows and the rows it opens are the same rows.
 */
export function derive(rows = [], w = {}, { history = [], now = Date.now() } = {}) {
  const hit = rows.filter(r => matchRow(r, w.filter, now))
  const sum = w.value && w.value !== 'count' ? r => Number(r[w.value]) || 0 : () => 1
  if (w.view === 'count') return { value: hit.reduce((n, r) => n + sum(r), 0), rows: hit }
  if (w.view === 'breakdown' || w.view === 'people') {
    const m = new Map()
    for (const r of hit) { const k = r[w.by] ?? null; m.set(k, (m.get(k) || 0) + sum(r)) }
    return { groups: [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key))), total: hit.reduce((n, r) => n + sum(r), 0) }
  }
  if (['list', 'table', 'runs'].includes(w.view)) {
    const sorted = sortBy(hit, w.sort)
    const cut = sorted.slice(0, w.limit || 50)
    const args = (w.actions || []).flatMap(a => Object.values(a.args || {}))
    const actionColumns = args.filter(v => typeof v === 'string' && v.startsWith('$row.')).map(v => v.slice(5))
    const columns = w.columns && [...new Set([...w.columns, ...actionColumns])]
    return { rows: columns ? cut.map(r => Object.fromEntries(columns.map(c => [c, r[c] ?? null]))) : cut, total: hit.length }
  }
  if (w.view === 'trend') return { points: (history || []).map(h => ({ at: h.at, value: w.value && w.value !== 'count' ? h[w.value] ?? null : h.count ?? null })) }
  return {}
}

/**
 * How a widget's data stands — the five a page must never confuse, and fine: denied (not allowed to see it), unset
 * (nothing runs it: not granted, no connection to run it), loading (no snapshot yet), error (failed and nothing good to show),
 * empty (0 rows), stale (older than twice its refresh; the rows still show with the age), ok. `failed`: the newest run
 * failed while an older good one shows.
 */
export function stateOf(snapshot, dataset, { now = Date.now(), denied = false, unset = false } = {}) {
  if (denied) return { state: 'denied' }
  if (unset && !dataset?.core) return { state: 'unset' }
  if (dataset?.core) return { state: 'ok' }
  if (!snapshot) return { state: 'loading' }
  const good = snapshot.ok, last = snapshot.last || {}
  const failed = last.status && last.status !== 'ok' ? { status: last.status, error: last.error || '', at: last.at } : null
  if (!good) return failed ? { state: 'error', failed } : { state: 'loading' }
  const age = now - good.at, every = parseDuration(dataset?.refresh)
  const base = { at: good.at, age, ...(failed && { failed }) }
  if (Number.isFinite(every) && age > 2 * every) return { state: 'stale', ...base }
  if (!good.count) return { state: 'empty', ...base }
  return { state: 'ok', ...base }
}

/**
 * A dashboard checked against its datasets' samples — what the registry runs before it publishes one: valid, and every
 * widget of every page derives from its sample without throwing. samples: { name: rows }. → { ok, errors, pages }
 */
export function check(b, { datasets = {}, samples = {} } = {}) {
  const v = validateDashboard(b, { datasets })
  if (!v.ok) return { ...v, pages: [] }
  const errors = [], pages = []
  for (const p of b.pages) {
    const shown = []
    for (const w of p.widgets || []) {
      if (w.view === 'note' || w.view === 'custom') { shown.push({ id: w.id, view: w.view }); continue }
      const name = refOf(b.datasets[w.data]).name, spec = datasetOf(name, datasets)
      const rows = samples[name]
      if (!spec?.core && !Array.isArray(rows)) { errors.push(err(`pages.${p.id}.${w.id}`, 'noSample', `no sample rows for ${name}`)); continue }
      try { shown.push({ id: w.id, view: w.view, ...derive(spec ? shapeRows(rows || [], spec).rows : rows || [], w) }) } catch (e) { errors.push(err(`pages.${p.id}.${w.id}`, 'derive', e.message)) }
    }
    pages.push({ id: p.id, widgets: shown })
  }
  return { ok: !errors.length, errors, pages }
}
