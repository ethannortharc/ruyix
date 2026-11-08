// A board from a conversation (the workbench assistant's workbench_ui): the data it has in hand and the widgets to show
// it, drawn by the one renderer (Board.jsx) — so a chat's table, counts, breakdown or trend look like a board's.
//   { title?, data: { name: { fields: { field: type }, rows: [...] } }, widgets: [{ view, data, title?, by?, value?,
//     columns?, filter?, sort?, limit?, size?, text? }] }
// → { spec, datasets, snapshots, history, errors } (Board's props; errors: what to change, for the model to fix).
import { FIELD_TYPES, validateDashboard } from './schema.js'

export const LIMITS = { datasets: 4, rows: 300, widgets: 12, bytes: 150_000 }
export const UI_VIEWS = ['count', 'list', 'table', 'breakdown', 'trend', 'people', 'note']
const ALIAS = /^[a-z][a-z0-9-]{0,30}$/

// a cell as a page can show it: a string, a number, a bool or nothing (a model may send an object)
const cell = v => (v == null || ['string', 'number', 'boolean'].includes(typeof v) ? v : typeof v === 'object' ? (JSON.stringify(v) ?? '').slice(0, 500) : null)
const words = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : undefined)
const text2 = v => (v && typeof v === 'object' ? { zh: String(v.zh ?? v.en ?? ''), en: String(v.en ?? v.zh ?? '') } : { zh: String(v ?? ''), en: String(v ?? '') })
const timeOf = v => (typeof v === 'number' ? v : Date.parse(v))

export function inlineBoard(raw) {
  const errors = []
  const err = (path, message) => errors.push({ path, message })
  const ui = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (JSON.stringify(ui).length > LIMITS.bytes) err('', `at most ${LIMITS.bytes / 1000} KB: fewer rows or columns`)
  const data = ui.data && typeof ui.data === 'object' && !Array.isArray(ui.data) ? ui.data : {}
  const names = Object.keys(data).slice(0, LIMITS.datasets)
  if (Object.keys(data).length > LIMITS.datasets) err('data', `at most ${LIMITS.datasets} data sets`)
  const datasets = {}, snapshots = {}, history = {}, aliases = {}
  for (const alias of names) {
    if (!ALIAS.test(alias)) { err(`data.${alias}`, 'a data set\'s name is a short lowercase word (letters, digits, dashes)'); continue }
    const d = data[alias] || {}
    const fields = d.fields && typeof d.fields === 'object' && !Array.isArray(d.fields) ? d.fields : {}
    for (const [k, type] of Object.entries(fields)) if (!FIELD_TYPES.includes(type)) err(`data.${alias}.fields.${k}`, `a field's type is one of ${FIELD_TYPES.join(', ')}`)
    const rows = Array.isArray(d.rows) ? d.rows.filter(r => r && typeof r === 'object' && !Array.isArray(r)) : []
    if (!Array.isArray(d.rows)) err(`data.${alias}.rows`, 'rows: a list of objects')
    if (rows.length > LIMITS.rows) err(`data.${alias}.rows`, `at most ${LIMITS.rows} rows`)
    const name = `ui-${alias}`
    aliases[alias] = name
    // labels: a field's name as words ({ zh, en } or a string) — anything else is left out
    const labels = d.labels && typeof d.labels === 'object' && !Array.isArray(d.labels) ? Object.fromEntries(Object.entries(d.labels).filter(([, v]) => typeof v === 'string' || (v && typeof v === 'object' && ['zh', 'en'].some(k => typeof v[k] === 'string'))).map(([k, v]) => [k, text2(v)])) : null
    datasets[name] = { name, kind: 'dataset', title: text2(d.title || alias), fields, ...(labels && { labels }) }
    // the declared fields first (a widget reads them), then the others up to 40 in all
    const declared = Object.keys(fields)
    const kept = rows.slice(0, LIMITS.rows).map(r => Object.fromEntries([...declared.filter(k => Object.hasOwn(r, k)), ...Object.keys(r).filter(k => !declared.includes(k))].slice(0, Math.max(40, declared.length)).map(k => [k, cell(r[k])])))
    // (no `at`: a chat's data says no age)
    snapshots[name] = { ok: { rows: kept, count: kept.length } }
    // a trend's points: the rows by their time (field `at`, or the first time field)
    const t = 'at' in fields || kept.some(r => 'at' in r) ? 'at' : Object.keys(fields).find(k => fields[k] === 'time')
    if (t) history[name] = kept.map(r => ({ ...r, at: timeOf(r[t]), count: r.count ?? null })).filter(p => Number.isFinite(p.at)).sort((a, b) => a.at - b.at)
  }
  const list = Array.isArray(ui.widgets) ? ui.widgets.slice(0, LIMITS.widgets) : []
  if (!list.length) err('widgets', 'at least one widget')
  if (Array.isArray(ui.widgets) && ui.widgets.length > LIMITS.widgets) err('widgets', `at most ${LIMITS.widgets} widgets`)
  const widgets = list.map((w, i) => {
    const raw = w && typeof w === 'object' && !Array.isArray(w) ? w : {}
    // only what a chat's board shows (no actions: a drawn board's rows do nothing)
    const x = Object.fromEntries(['view', 'data', 'title', 'by', 'value', 'filter', 'sort', 'limit', 'size', 'text'].filter(k => raw[k] !== undefined).map(k => [k, raw[k]]))
    if (raw.columns !== undefined) { x.columns = words(raw.columns); if (!x.columns) err(`widgets.${i}.columns`, 'columns: a list of field names') }
    if (x.filter !== undefined && (typeof x.filter !== 'object' || Array.isArray(x.filter) || x.filter === null)) { err(`widgets.${i}.filter`, 'filter: { field: value }'); delete x.filter }
    for (const k of ['data', 'by', 'value', 'sort', 'size']) if (x[k] !== undefined && typeof x[k] !== 'string') { err(`widgets.${i}.${k}`, `${k}: a name`); delete x[k] }
    x.id = `w${i + 1}`
    if (!UI_VIEWS.includes(x.view)) err(`widgets.${i}.view`, `view: one of ${UI_VIEWS.join(', ')}`)
    if (x.title !== undefined) x.title = text2(x.title)
    if (x.view === 'note') x.text = text2(x.text)
    if (x.view === 'trend' && x.data in aliases && !history[aliases[x.data]]) err(`widgets.${i}`, 'a trend needs its rows\' time: a field "at" (or a time field)')
    return x
  })
  const spec = { kind: 'dashboard', name: 'chat-ui', version: '1.0.0', datasets: Object.fromEntries(Object.entries(aliases).map(([a, n]) => [a, n])), pages: [{ id: 'p', title: text2(ui.title || ''), widgets }] }
  // the board's own check: views, fields a widget names, groupings, limits
  let v = { errors: [] }
  try { v = validateDashboard({ ...spec, title: text2(ui.title || 'chat') }, { datasets }) } catch (e) { err('', `not drawable: ${e?.message || e}`) }
  for (const e of v.errors) if (e.path !== 'pages.0.title' && !/\.view$/.test(e.path)) err(e.path.replace(/^pages\.0\./, ''), e.message)
  return { spec, datasets, snapshots, history, errors }
}
