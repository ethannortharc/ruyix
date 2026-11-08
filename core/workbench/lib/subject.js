// What a run is about: the request a person (or an agent) hands in — a title, a text, attachments, and the fields the
// workflow's form asks for (workflow.input) — checked before anything is stored.
//   input: [{ name, type: text|textarea|select|multiselect|checkbox|files, label?, options?, required?, default? }]
// `ref`: one record of a studio's collection (docs/design/studio.md), by its id — `ref: { studio, collection }` says which;
// the form offers its records (the `refOptions` op), the run reads it when it starts
const TYPES = ['text', 'textarea', 'select', 'multiselect', 'checkbox', 'files', 'ref']
const NAME = /^[A-Za-z][\w-]{0,39}$/
/** The folder a run's agents and script steps work in: the one its person named (a host folder), else the run's own. */
export const dirOf = r => r.folder || r.dir
export const LIMITS = { title: 200, text: 100000, line: 2000, area: 100000, files: 20, bytes: 25 << 20 }
const MIME = { vtt: 'text/vtt', srt: 'application/x-subrip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  m4v: 'video/mp4', mkv: 'video/x-matroska', ogv: 'video/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav', pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', log: 'text/plain', yaml: 'text/yaml', yml: 'text/yaml', xml: 'application/xml', bmp: 'image/bmp', avif: 'image/avif' }
export const mimeOf = name => MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream'
const optionValues = f => (Array.isArray(f.options) ? f.options : []).map(o => (o && typeof o === 'object' ? o.value : o)).map(String)

/** A form definition (workflow.input) as a list of problems — [] when it is well formed. */
export function checkInput(input) {
  if (input === undefined) return []
  if (!Array.isArray(input)) return ['input must be a list of fields']
  const errors = [], seen = new Set()
  for (const [i, f] of input.entries()) {
    if (!f || typeof f !== 'object' || !NAME.test(f.name || '')) { errors.push(`input[${i}]: a field needs a name (letters, digits, - _)`); continue }
    if (seen.has(f.name)) errors.push(`input: the field ${f.name} appears twice`)
    seen.add(f.name)
    if (!TYPES.includes(f.type)) errors.push(`input.${f.name}: type is one of ${TYPES.join(', ')}`)
    if (['select', 'multiselect'].includes(f.type) && !optionValues(f).length) errors.push(`input.${f.name}: ${f.type} needs options`)
    if (f.type === 'ref' && !(typeof f.ref?.studio === 'string' && typeof f.ref?.collection === 'string')) errors.push(`input.${f.name}: ref names { studio, collection }`)
  }
  return errors
}

/**
 * The values a form got, against the workflow's fields: → { fields (declared ones that were given or have a default), errors }.
 * An undeclared name, a value of the wrong type, a select value that is not an option, a missing required one are errors.
 */
export function checkFields(input = [], given = {}, attachments = []) {
  const errors = [], out = {}
  if (given === undefined || given === null) given = {}
  if (typeof given !== 'object' || Array.isArray(given)) return { fields: {}, errors: ['fields must be an object'] }
  const known = new Set(input.map(f => f.name))
  for (const k of Object.keys(given)) if (!known.has(k)) errors.push(`unknown field "${k}"`)
  const filesFields = input.filter(f => f.type === 'files')
  for (const f of input) {
    const label = f.label || f.name
    if (f.type === 'files') {
      const mine = attachments.filter(a => a.field === f.name || (!a.field && filesFields.length === 1))
      if (f.required && !mine.length) errors.push(`${label}: attach at least one file`)
      continue
    }
    let v = given[f.name]
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) v = f.default
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
    if (f.type === 'checkbox') {
      if (v !== undefined && typeof v !== 'boolean') { errors.push(`${label}: yes or no`); continue }
      if (f.required && v !== true) errors.push(`${label}: must be ticked`)
      if (v !== undefined) out[f.name] = v
      continue
    }
    if (empty) { if (f.required) errors.push(`${label}: required`); continue }
    if (f.type === 'multiselect') {
      const options = optionValues(f)
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) { errors.push(`${label}: a list of choices`); continue }
      const bad = v.filter(x => !options.includes(x))
      if (bad.length) { errors.push(`${label}: ${bad.join(', ')} ${bad.length > 1 ? 'are' : 'is'} not one of ${options.join(', ')}`); continue }
      out[f.name] = [...new Set(v)]
      continue
    }
    if (typeof v !== 'string') { errors.push(`${label}: text`); continue }
    if (f.type === 'select') {
      const options = optionValues(f)
      if (!options.includes(v)) { errors.push(`${label}: ${v} is not one of ${options.join(', ')}`); continue }
    } else if (v.length > (f.type === 'textarea' ? LIMITS.area : LIMITS.line)) { errors.push(`${label}: too long`); continue }
    out[f.name] = f.type === 'select' ? v : v.trim()
  }
  return { fields: out, errors }
}

/** Attachments as the API gets them — [{ name, base64, mime?, field? }] — decoded: [{ name, bytes, mime, size, field? }] or the problems. */
export function decodeAttachments(list) {
  if (list === undefined || list === null) return { files: [], errors: [] }
  if (!Array.isArray(list)) return { files: [], errors: ['attachments must be a list'] }
  if (list.length > LIMITS.files) return { files: [], errors: [`at most ${LIMITS.files} attachments`] }
  const files = [], errors = []
  for (const [i, a] of list.entries()) {
    const name = String(a?.name ?? '').split(/[\\/]/).pop().trim()
    if (!name || name.startsWith('.')) { errors.push(`attachment ${i + 1}: needs a file name`); continue }
    if (typeof a.base64 !== 'string' || !/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(a.base64)) { errors.push(`${name}: content must be base64`); continue }
    const bytes = Buffer.from(a.base64, 'base64')
    if (bytes.length > LIMITS.bytes) { errors.push(`${name}: over ${LIMITS.bytes >> 20} MB`); continue }
    files.push({ name, bytes, size: bytes.length, mime: String(a.mime || '').trim().slice(0, 100) || mimeOf(name), ...(a.field && { field: String(a.field).slice(0, 40) }) })
  }
  return { files, errors }
}
