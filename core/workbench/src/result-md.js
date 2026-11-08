// Agent results (stage_result JSON, evidence inputs) → readable Markdown, deterministically: a headline of the
// short answers, the prose under headings, lists with status marks. Pure — check.mjs tests it.

const MARK = {
  result: { ok: '✅', problem: '❌' },
  verdict: { ok: '✅', regression: '❌' },
  tests: { passed: '✅', failed: '❌', unavailable: '⚪' },
  severity: { blocking: '🟥', critical: '🟥', major: '🟧', high: '🟧', minor: '🟨', medium: '🟨', low: '⬜' },
}
// Flags whose good value is true, and whose good value is false.
const GOOD_TRUE = new Set(['ready', 'agrees', 'agrees_fixed'])
const GOOD_FALSE = new Set(['blocking', 'regression', 'real'])
const NUMBERED = new Set(['criteria', 'behaviours', 'steps', 'questions'])
const CODE = new Set(['files', 'deploy_targets', 'workloads', 'repro_id', 'branch', 'commit', 'base', 'head', 'script_sha256', 'image', 'task', 'job'])
const MAIN = ['what', 'text', 'summary', 'title', 'name', 'why']
const isEvidence = k => /evidence|^seq$/i.test(k || '')
const scalar = v => v === null || typeof v !== 'object'
const empty = v => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
const human = k => k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase())
const oneLine = s => String(s).replace(/\s*\n\s*/g, ' ')
const SEQ = ['123456789', 'abcdefgh']
/** A paragraph with an inline enumeration "(1) … (2) …" or "(a) … (b) …" → intro + numbered list; anything else as is. */
export function prose(text) {
  const s = String(text)
  if (s.includes('\n')) return s
  const marks = [...s.matchAll(/(?:^|\s)\(([1-9]|[a-h])\)\s/g)]
  const seq = SEQ.find(q => q.startsWith(marks.map(m => m[1]).join('')))
  if (marks.length < 2 || !seq) return s
  const parts = s.split(/(?:^|\s)\((?:[1-9]|[a-h])\)\s/)
  return [parts[0].trim(), parts.slice(1).map((x, i) => `${i + 1}. ${x.trim().replace(/[;；]$/, '')}`).join('\n')].filter(Boolean).join('\n\n')
}

function value(k, v, t) {
  if (typeof v === 'boolean') {
    const mark = GOOD_TRUE.has(k) ? (v ? '✅ ' : '❌ ') : GOOD_FALSE.has(k) ? (v ? '❌ ' : '✅ ') : ''
    return mark + t(v ? 'yes' : 'no')
  }
  if (isEvidence(k) && typeof v === 'number') return `#${v}`
  if (Array.isArray(v)) return v.map(x => value(k, x, t)).join(isEvidence(k) ? ' ' : ', ')
  const s = oneLine(v)
  const mark = MARK[k]?.[s] ? `${MARK[k][s]} ` : ''
  return mark + (CODE.has(k) ? `\`${s}\`` : s)
}
const short = (k, v) => k !== 'markdown' && (typeof v !== 'string' || (v.length <= 90 && !v.includes('\n')) || CODE.has(k))
const inline = (k, v) => scalar(v) ? short(k, v) : Array.isArray(v) && v.every(x => typeof x === 'number') && isEvidence(k)

/** One list item from an object: status mark, the main text, the rest as "· label: value", evidence last. */
function item(o, t, label) {
  const statusKey = ['result', 'severity', 'verdict', 'tests'].find(k => MARK[k][o[k]])
  const mainKey = MAIN.find(k => typeof o[k] === 'string' && o[k])
  const head = [statusKey && MARK[statusKey][o[statusKey]], statusKey === 'severity' && `**${o.severity}**`, 'real' in o && (o.real ? '❌' : '⚪'), mainKey && oneLine(o[mainKey])].filter(Boolean).join(' ')
  const rest = Object.entries(o).filter(([k, v]) => k !== statusKey && k !== mainKey && !(k === 'real') && !isEvidence(k) && !empty(v))
  const said = new Set((mainKey ? o[mainKey].match(/#\d+/g) : null) || [])
  const ev = Object.entries(o).filter(([k, v]) => isEvidence(k) && !empty(v)).map(([k, v]) => value(k, v, t)).join(' ').split(' ').filter(x => x && !said.has(x)).join(' ')
  const tail = rest.filter(([k, v]) => inline(k, v)).map(([k, v]) => `${label(k)}：${value(k, v, t)}`)
  const nested = rest.filter(([k, v]) => !inline(k, v)).map(([k, v]) => `  - ${label(k)}：${scalar(v) ? oneLine(v) : Array.isArray(v) && v.every(scalar) ? v.map(x => value(k, x, t)).join('；') : oneLine(JSON.stringify(v))}`)
  return [`- ${head || '·'}${tail.length ? `${head ? ' · ' : ''}${tail.join(' · ')}` : ''}${ev ? ` — ${ev}` : ''}`, ...nested].join('\n')
}

function list(k, arr, t, label) {
  if (arr.every(scalar)) return arr.map((x, i) => `${NUMBERED.has(k) ? `${i + 1}.` : '-'} ${value(k, x, t)}`).join('\n')
  return arr.map(x => (scalar(x) ? `- ${value(k, x, t)}` : item(x, t, label))).join('\n')
}

/**
 * @param value the JSON (object, array or scalar)
 * @param t locale lookup; `key.<field>` labels fields, `yes` / `no` booleans
 */
export function toMarkdown(data, t = k => k) {
  const label = k => { const x = t(`key.${k}`); return x === `key.${k}` ? human(k) : x }
  if (scalar(data)) return data === null || data === undefined ? '' : String(data)
  if (Array.isArray(data)) return list('', data, t, label)
  const entries = Object.entries(data).filter(([, v]) => !empty(v))
  const head = entries.filter(([k, v]) => inline(k, v)).map(([k, v]) => `**${label(k)}**：${value(k, v, t)}`)
  const texts = entries.filter(([k, v]) => typeof v === 'string' && !inline(k, v)).sort(([a], [b]) => (b === 'summary') - (a === 'summary'))
  const rest = entries.filter(([k, v]) => !scalar(v) && !inline(k, v))
  return [
    head.join(' · '),
    // "markdown" already is Markdown (the reporter's explanation): no heading of ours on top of its own.
    ...texts.map(([k, v]) => (k === 'markdown' ? v : `#### ${label(k)}\n\n${prose(v)}`)),
    ...rest.map(([k, v]) => `#### ${label(k)}\n\n${Array.isArray(v) ? list(k, v, t, label) : item(v, t, label).replace(/^- /, '')}`),
  ].filter(Boolean).join('\n\n')
}

/** dsh's Markdown keeps only http(s) links: evidence links use a reserved .invalid host the page intercepts. */
export const EV_URL = 'https://evidence.invalid/'
/**
 * "#12" → a link the page turns into "open evidence 12" — only for evidence the run has, never inside code,
 * existing links, or longer numbers such as ticket ids.
 */
export function linkEvidence(md, has) {
  return String(md).split(/(```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\))/).map((part, i) => (i % 2 ? part
    : part.replace(/(^|[^\w#&[])#(\d{1,4})(?!\w)/g, (m, pre, n) => (has(Number(n)) ? `${pre}[#${n}](${EV_URL}${n})` : m)))).join('')
}
