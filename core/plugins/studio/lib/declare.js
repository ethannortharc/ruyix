// A studio's declaration (docs/design/studio.md): which kinds of records it keeps, where its materials come from, what
// it starts, how its home page is laid out. A pack declares one (packs/plume/studio.js) and registers it with the
// `ruyixStudio` service; defineStudio checks it — a mistake is said with where it is, never half taken.
//   { id, name: { zh, en } | text, icon,
//     collections: { <key>: { title, fields: [{ name, type, label?, required?, default?, options? (select, tags),
//                    values? (status: [{ value, label, tone }]), multiple? (image) }], single? (one record) }
//                  | { title, runs: '<workflow>' } (a list of the studio's runs: not stored here, the workbench's) },
//     materials?: { kinds?: ['image', 'markdown', 'pdf', …] },
//     start?: [{ id, label, workflow, from?: <collection>, title?, text?, fields?: { <run field>: <record field> },
//               allowedStatuses?: [<status values>], showForm?: boolean,
//               status?: { start?, done?, failed? } (the record's status field when its run starts, ends well, does not) }],
//     home?: [<view> | { view, collection?, title?, size: full | half, … }], views?: { <name>: { title } } (its own),
//     remind?: [{ collection, at: <datetime field>, unless?: [<status values>] }] (its time come, the record waits for the
//              person on the desk — unless its status is one of these),
//     seed?: ({ packSettings }) => ({ <collection>: [records] }) (the first records, once — e.g. settings moved in) }
// The record checks (checkRecord) are here too: a field of an unknown type is no field, a value of the wrong kind no value.

/** The icons a studio can have (lucide names; the page maps each to its picture — src/icons.js — and Boxes is the fallback). */
export const STUDIO_ICONS = ['Feather', 'PenLine', 'Clapperboard', 'Camera', 'Video', 'Music', 'Mic', 'BookOpen', 'Newspaper', 'Megaphone', 'Briefcase', 'ShoppingBag', 'Image', 'Code', 'FlaskConical', 'GraduationCap', 'Heart', 'Sparkles', 'Boxes']
export const FIELD_TYPES = ['text', 'textarea', 'number', 'bool', 'select', 'status', 'date', 'datetime', 'color', 'links', 'tags', 'image', 'file']
/** The views a home block can be (the client draws them); a studio's own: `own:<name>` of its `views`. */
export const VIEWS = ['start', 'working', 'list', 'board', 'calendar', 'library', 'form', 'history']
const TONES = ['neutral', 'info', 'progress', 'success', 'warning', 'danger']
const ID = /^[a-z][a-z0-9-]{1,31}$/, KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/

const fail = (code, message, params = {}) => { throw Object.assign(new Error(message), { code, params }) }
const words = (v, where) => {
  if (typeof v === 'string' && v.trim()) return { zh: v.trim(), en: v.trim() }
  if (v && typeof v === 'object' && (typeof v.zh === 'string' || typeof v.en === 'string')) return { zh: String(v.zh || v.en).trim(), en: String(v.en || v.zh).trim() }
  return fail('badDeclaration', `${where}: a name, as text or { zh, en }`, { where })
}
const optionsOf = (list, where) => {
  if (!Array.isArray(list) || !list.length) fail('badDeclaration', `${where}: options, a list of values or { value, label }`, { where })
  return list.map(o => (typeof o === 'string' ? { value: o, label: { zh: o, en: o } } : o && typeof o.value === 'string' ? { value: o.value, label: words(o.label ?? o.value, `${where} ${o.value}`) } : fail('badDeclaration', `${where}: an option is a value or { value, label }`, { where })))
}

function fieldOf(f, where, collections) {
  if (!f || !KEY.test(f.name || '')) fail('badDeclaration', `${where}: a field needs a name (letters, digits, _)`, { where })
  const at = `${where}.${f.name}`
  const ref = typeof f.type === 'string' && f.type.startsWith('ref:') ? f.type.slice(4) : null
  if (ref !== null ? !Object.hasOwn(collections, ref) : !FIELD_TYPES.includes(f.type)) {
    fail('badDeclaration', ref !== null ? `${at}: ref:${ref} — no collection ${ref} in this studio` : `${at}: no field type ${f.type} (${FIELD_TYPES.join(', ')}, ref:<collection>)`, { where: at, type: f.type })
  }
  const out = { name: f.name, type: f.type, label: words(f.label ?? f.name, at), ...(f.required && { required: true }), ...(f.hint && { hint: words(f.hint, `${at} hint`) }) }
  if (f.type === 'select' || (f.type === 'tags' && f.options)) out.options = optionsOf(f.options, at)
  if (f.type === 'status') {
    if (!Array.isArray(f.values) || !f.values.length) fail('badDeclaration', `${at}: a status lists its values in order ({ value, label, tone })`, { where: at })
    out.values = f.values.map(v => {
      if (!v || typeof v.value !== 'string') fail('badDeclaration', `${at}: a status value is { value, label, tone }`, { where: at })
      if (v.tone && !TONES.includes(v.tone)) fail('badDeclaration', `${at} ${v.value}: no tone ${v.tone} (${TONES.join(', ')})`, { where: at })
      return { value: v.value, label: words(v.label ?? v.value, `${at} ${v.value}`), tone: v.tone || 'neutral' }
    })
  }
  if (['image', 'file'].includes(f.type) && f.multiple) out.multiple = true
  if (f.default !== undefined) out.default = checkValue(out, f.default, `${at} default`, null)
  else if (f.type === 'status') out.default = out.values[0].value // (a new record starts where the status starts: on the board, in its first column)
  return out
}

/** A declaration, checked and in its plain form (functions kept on the side: `seed`). Throws { code: badDeclaration, params: { where } }. */
export function defineStudio(d) {
  if (!d || !ID.test(d.id || '')) fail('badDeclaration', 'a studio needs an id (lowercase letters, digits, -; 2–32)', { where: 'id' })
  const where = d.id
  const raw = d.collections && typeof d.collections === 'object' ? d.collections : fail('badDeclaration', `${where}: collections, the kinds of records it keeps`, { where })
  for (const k of Object.keys(raw)) if (!KEY.test(k)) fail('badDeclaration', `${where}: a collection's key is letters, digits, _ (${k})`, { where: k })
  const collections = {}
  for (const [k, c] of Object.entries(raw)) {
    const at = `${where}.collections.${k}`
    if (c?.runs) { collections[k] = { key: k, title: words(c.title ?? k, at), runs: String(c.runs) }; continue }
    if (!Array.isArray(c?.fields) || !c.fields.length) fail('badDeclaration', `${at}: fields, or runs: '<workflow>'`, { where: at })
    const fields = c.fields.map(f => fieldOf(f, at, raw))
    const dup = fields.find((f, i) => fields.findIndex(x => x.name === f.name) !== i)
    if (dup) fail('badDeclaration', `${at}: two fields named ${dup.name}`, { where: at })
    collections[k] = { key: k, title: words(c.title ?? k, at), fields, ...(c.single && { single: true }) }
  }
  const start = (d.start || []).map((s, i) => {
    const at = `${where}.start[${i}]`
    if (!s || !KEY.test(s.id || '') || typeof s.workflow !== 'string') fail('badDeclaration', `${at}: { id, label, workflow }`, { where: at })
    const from = s.from ? collections[s.from] : null
    if (s.from && (!from || from.runs)) fail('badDeclaration', `${at}: from ${s.from} — no collection of records by that name`, { where: at })
    const has = name => from?.fields.some(f => f.name === name)
    for (const [k, v] of Object.entries({ title: s.title, text: s.text, ...(s.fields || {}) })) if (v && !has(v)) fail('badDeclaration', `${at}: ${k} ← ${v}, not a field of ${s.from || 'any collection'}`, { where: at })
    const status = from?.fields.find(f => f.type === 'status')
    for (const v of Object.values(s.status || {})) if (v && !status?.values.some(x => x.value === v)) fail('badDeclaration', `${at}: status ${v} — not a value of ${s.from}'s status`, { where: at })
    if (s.allowedStatuses !== undefined && (!status || !Array.isArray(s.allowedStatuses) || !s.allowedStatuses.length || s.allowedStatuses.some(v => !status.values.some(x => x.value === v)))) fail('badDeclaration', `${at}: allowedStatuses must list values of the source collection's status`, { where: at })
    if (s.showForm !== undefined && (typeof s.showForm !== 'boolean' || !from)) fail('badDeclaration', `${at}: showForm is a boolean for a start from a collection`, { where: at })
    return { id: s.id, label: words(s.label ?? s.id, at), workflow: s.workflow, ...(s.from && { from: s.from }), ...(s.title && { title: s.title }), ...(s.text && { text: s.text }), fields: { ...(s.fields || {}) }, ...(s.status && status && { status: { ...s.status } }), ...(status && (s.status || s.allowedStatuses) && { statusField: status.name }), ...(s.allowedStatuses && { allowedStatuses: [...new Set(s.allowedStatuses)] }), ...(s.showForm && { showForm: true }) }
  })
  const remind = (d.remind || []).map((r, i) => {
    const at = `${where}.remind[${i}]`, c = collections[r?.collection]
    if (!c || c.runs) fail('badDeclaration', `${at}: collection ${r?.collection} — not a collection of records`, { where: at })
    const f = c.fields.find(x => x.name === r.at)
    if (f?.type !== 'datetime') fail('badDeclaration', `${at}: at ${r.at} — not a datetime field of ${c.key}`, { where: at })
    const status = c.fields.find(x => x.type === 'status')
    for (const v of r.unless || []) if (!status?.values.some(x => x.value === v)) fail('badDeclaration', `${at}: unless ${v} — not a value of ${c.key}'s status`, { where: at })
    return { collection: c.key, at: f.name, unless: [...(r.unless || [])], ...(status && { statusField: status.name }) }
  })
  const views = Object.fromEntries(Object.entries(d.views || {}).map(([k, v]) => [k, { title: words(v?.title ?? k, `${where}.views.${k}`) }]))
  const home = (d.home || ['start', 'working', ...Object.keys(collections).map(k => ({ view: collections[k].runs ? 'list' : 'board', collection: k }))]).map((b, i) => {
    const at = `${where}.home[${i}]`, block = typeof b === 'string' ? { view: b } : { ...b }
    const own = typeof block.view === 'string' && block.view.startsWith('own:') ? block.view.slice(4) : null
    if (own !== null ? !Object.hasOwn(views, own) : !VIEWS.includes(block.view)) fail('badDeclaration', `${at}: no view ${block.view} (${VIEWS.join(', ')}, own:<a view of its own>)`, { where: at })
    if (block.collection && !Object.hasOwn(collections, block.collection)) fail('badDeclaration', `${at}: no collection ${block.collection}`, { where: at })
    if (['list', 'board', 'form', 'calendar'].includes(block.view) && !block.collection) fail('badDeclaration', `${at}: a ${block.view} shows a collection`, { where: at })
    // (full by default: start, working, history, and a board — its status columns need the width)
    if (block.size && !['full', 'half'].includes(block.size)) fail('badDeclaration', `${at}: size is full or half`, { where: at })
    return { ...block, size: block.size || (['start', 'working', 'history', 'board'].includes(block.view) ? 'full' : 'half'), ...(block.title && { title: words(block.title, at) }) }
  })
  return {
    id: d.id, name: words(d.name ?? d.id, `${where}.name`), icon: d.icon === undefined ? 'Boxes' : STUDIO_ICONS.includes(d.icon) ? d.icon : fail('badDeclaration', `${where}.icon: no icon ${d.icon} (${STUDIO_ICONS.join(', ')})`, { where: `${where}.icon` }),
    collections, materials: { kinds: Array.isArray(d.materials?.kinds) ? d.materials.kinds.map(String) : ['image', 'markdown', 'pdf', 'text'] },
    start, home, views, remind, ...(typeof d.seed === 'function' && { seed: d.seed }),
  }
}

/** What a page or a tool sees of a declaration: everything but its functions. */
export const plain = d => { const { seed, ...rest } = d; return rest }

/** Start buttons and server-side status restrictions use the same decision. Legacy declarations keep their UI behavior. */
export function canStartRecord(start, record, collection) {
  const status = collection?.fields?.find(f => f.type === 'status')
  if (start.allowedStatuses) return !!record && start.allowedStatuses.includes(record[start.statusField || status?.name])
  return !status || !start.status || ![start.status.start, start.status.done].includes(record?.[status.name])
}

const DATE = /^\d{4}-\d{2}-\d{2}$/, COLOR = /^#[0-9a-fA-F]{6}$/
/** One value as its field takes it (null: empty), or a throw { code: badValue }. `exists(coll, id)`: is a ref there (null: unchecked). */
function checkValue(f, v, where, exists) {
  if (v === null || v === undefined || v === '') return null
  const bad = what => fail('badValue', `${where}: ${what}`, { field: f.name, type: f.type })
  switch (f.type) {
    case 'text': return typeof v === 'string' ? (v.length <= 400 ? v.trim() : bad('at most 400 characters')) : bad('text')
    case 'textarea': return typeof v === 'string' ? (v.length <= 20000 ? v : bad('at most 20000 characters')) : bad('text')
    case 'number': { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : bad('a number') }
    case 'bool': return v === true || v === 'true' ? true : v === false || v === 'false' ? false : bad('yes or no')
    case 'select': return f.options.some(o => o.value === v) ? v : bad(`one of ${f.options.map(o => o.value).join(', ')}`)
    case 'status': return f.values.some(o => o.value === v) ? v : bad(`one of ${f.values.map(o => o.value).join(', ')}`)
    case 'date': return typeof v === 'string' && DATE.test(v) ? v : bad('a date (YYYY-MM-DD)')
    case 'datetime': { const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : bad('a time') }
    case 'color': return typeof v === 'string' && COLOR.test(v) ? v.toLowerCase() : bad('a colour (#rrggbb)')
    case 'links': {
      if (!Array.isArray(v)) bad('a list of links')
      return v.slice(0, 50).map(l => (typeof l === 'string' ? { url: l } : l)).map(l => (l && typeof l.url === 'string' && /^https?:\/\//.test(l.url) ? { url: l.url, ...(l.label && { label: String(l.label).slice(0, 120) }) } : bad('a link is http(s)://…')))
    }
    case 'tags': {
      const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，]/) : bad('a list')
      const out = [...new Set(list.map(x => String(x).trim()).filter(Boolean))].slice(0, 50)
      if (f.options && out.some(x => !f.options.some(o => o.value === x))) bad(`only ${f.options.map(o => o.value).join(', ')}`)
      return out
    }
    case 'file':
    case 'image': {
      // a material of the studio (its id) or a same-origin path: one, or several when the field says so
      const one = x => (typeof x === 'string' && x.length <= 500 && !/^[a-z]+:/i.test(x) ? x : bad('a material of the studio'))
      return f.multiple ? (Array.isArray(v) ? v.slice(0, 30).map(one) : [one(v)]) : one(Array.isArray(v) ? v[0] : v)
    }
    default: { // ref:<collection>
      if (typeof v !== 'string') bad('the id of a record')
      if (exists && !exists(f.type.slice(4), v)) fail('badRef', `${where}: no ${f.type.slice(4)} ${v}`, { field: f.name, id: v })
      return v
    }
  }
}

/**
 * A record of a collection as it is kept: only its fields (one not declared is said, not dropped), each value checked,
 * the defaults filled in a new one, the required ones there. `before`: the record it changes (a patch keeps the rest).
 */
export function checkRecord(coll, input, { before = null, exists = null } = {}) {
  if (coll.runs) fail('readOnly', `${coll.key} is a list of runs: started, not written`, { collection: coll.key })
  const fields = new Map(coll.fields.map(f => [f.name, f]))
  const out = {}
  for (const [k, v] of Object.entries(input || {})) {
    if (['id', 'createdAt', 'updatedAt', 'rev', 'removedAt'].includes(k)) continue
    const f = fields.get(k)
    if (!f) fail('unknownField', `${coll.key}: no field ${k} (${[...fields.keys()].join(', ')})`, { collection: coll.key, field: k })
    out[k] = checkValue(f, v, `${coll.key}.${k}`, exists)
  }
  const merged = { ...(before ? Object.fromEntries(Object.entries(before).filter(([k]) => fields.has(k))) : Object.fromEntries(coll.fields.filter(f => f.default !== undefined).map(f => [f.name, f.default]))), ...out }
  for (const f of coll.fields) if (f.required && (merged[f.name] === null || merged[f.name] === undefined || (Array.isArray(merged[f.name]) && !merged[f.name].length))) fail('required', `${coll.key}.${f.name}: needed`, { collection: coll.key, field: f.name })
  return merged
}
