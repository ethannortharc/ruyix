// What an agent shows the person as the result of an exchange (docs/design/agent-tasks.md「回答要看得见」): cards, not only
// text — the weather as a weather card, a web page as a link the person opens, a question as a choice to click. The one
// description every place draws the same (the conversation, the main agent's strip, the desk: ./cards.jsx), and its check:
// the main agent's `ui_card` tool (../../cards-tool.js) checks before anything is drawn and says what to fix. Plain JS,
// no React: checked in node.
//
//   { cards: [card, …] } (1–6). Every card: { type, title? }, and its type's fields (CARD_TYPES[type].fields: name →
//   { type, need?, max?, values? }); EXAMPLES has one of each.
// How the person answers: the renderer calls its onAnswer(answer) — or, given none, sends the window event ANSWER_EVENT
// ('ruyix:card-answer', { detail: { answer, origin? } }) for the conversation to take; answerText(answer, lang) is the
// reply it says in the person's name:
//   choice  → { type: 'choice', card, values: [the picked labels] } — the conversation says them as the person's reply
//   confirm → { type: 'confirm', card, value: 'ok' | 'revise', text? (what to change), task? } — the task is confirmed
//             or sent back (agent-tasks.md: 好了 / 再改), and the conversation says it
//   link, video → no answer: the click opens a new tab in the person's browser (window.open in the click handler — a
//             page cannot open one by itself)
//   file    → no answer: the click opens the viewer window (`ruyix-workbench:view` with the card's run / session / files)
//   task    → no answer: the click opens the task (`ruyix:open` { panel: 'ruyix-tasks', task } — 「任务」). The card reads
//             its task while it goes on (./live.js): what it is doing now (`step`), then how it ended (`result`) and
//             what it made — so the conversation shows something started there to its end (work-in-one-place.md)

export const ANSWER_EVENT = 'ruyix:card-answer'
/** The reply an answer is, in the person's words (the conversation sends it as theirs). */
export function answerText(a, lang = 'zh') {
  const zh = lang !== 'en'
  if (a?.type === 'choice') return (a.values || []).join(zh ? '、' : ', ')
  if (a?.type === 'confirm') return a.value === 'ok' ? (zh ? '好了' : 'OK, done') : `${zh ? '再改：' : 'Change it: '}${String(a.text || '').trim()}`
  return ''
}

export const SKIES = ['clear', 'partly', 'cloudy', 'rain', 'showers', 'storm', 'snow', 'fog', 'wind', 'night']
const S = (max = 200, need = false) => ({ type: 'string', max, ...(need && { need }) })
const N = (need = false) => ({ type: 'number', ...(need && { need }) })
const URL_ = (need = false) => ({ type: 'url', ...(need && { need }) })

/** Each type: what it is for (the tool's description says it), and its fields. */
export const CARD_TYPES = {
  weather: {
    use: 'the weather of a place: now and the next days (from the forecast you read — say its source)',
    fields: {
      place: S(80, true), unit: { type: 'enum', values: ['C', 'F'] },
      now: { type: 'object', fields: { temp: N(), sky: { type: 'enum', values: SKIES }, text: S(80), feels: N(), humidity: N(), wind: S(40) } },
      days: { type: 'list', max: 7, of: { type: 'object', fields: { date: { type: 'date', need: true }, label: S(20), hi: N(), lo: N(), sky: { type: 'enum', values: SKIES }, text: S(80), rain: N() } } },
      source: { type: 'object', fields: { name: S(60, true), url: URL_() } }, at: { type: 'time' },
    },
  },
  time: {
    use: 'what time it is: a live clock for one place or a few (IANA zones), with the date and weekday',
    fields: { zones: { type: 'list', max: 4, need: true, of: { type: 'object', fields: { zone: { type: 'zone', need: true }, label: S(40) } } } },
  },
  link: {
    use: 'a web page to open (the person clicks: a new tab in their own browser) — what to open when asked to open a site',
    fields: { url: URL_(true), title: S(120, true), text: S(300), site: S(60), image: URL_() },
  },
  video: {
    use: 'a video to watch (YouTube and the like): its picture, length, a click opens it in the person\'s browser',
    fields: { url: URL_(true), title: S(160, true), channel: S(80), duration: S(12), thumb: URL_() },
  },
  list: {
    use: 'a short list of things (results, options, steps), each with a line and maybe a link',
    fields: { items: { type: 'list', max: 20, need: true, of: { type: 'object', fields: { title: S(160, true), text: S(300), url: URL_(), meta: S(60) } } } },
  },
  table: {
    use: 'a small table (a few columns): compare, list with numbers',
    fields: { columns: { type: 'list', max: 8, need: true, of: S(40, true) }, rows: { type: 'list', max: 50, need: true, of: { type: 'list', max: 8, of: { type: 'cell' } } } },
  },
  stat: {
    use: 'a few numbers at a glance (how many, how much, up or down)',
    fields: { items: { type: 'list', max: 6, need: true, of: { type: 'object', fields: { label: S(40, true), value: { type: 'cell', need: true }, unit: S(12), delta: S(20) } } } },
  },
  note: {
    use: 'a short note with a heading — a summary, an answer worth keeping (plain text, line breaks kept)',
    fields: { text: S(1200, true) },
  },
  choice: {
    use: 'a question for the person with options to click (instead of asking in text) — their click is their reply',
    fields: { question: S(200, true), options: { type: 'list', max: 6, min: 2, need: true, of: { type: 'object', fields: { label: S(60, true), text: S(160) } } }, multi: { type: 'bool' } },
  },
  confirm: {
    use: 'the result is ready: ask the person to accept it (好了) or say what to change (再改) — a task that made something',
    fields: { text: S(300, true), task: S(80), run: S(80), resultVersion: S(80) },
  },
  file: {
    use: 'a file that was made: a click opens it in the viewer (a run\'s or a session\'s file, or one of this page\'s own links)',
    fields: { name: S(120, true), run: S(80), session: S(80), path: S(300), url: { type: 'local' }, kind: { type: 'enum', values: ['image', 'markdown', 'pdf', 'text', 'video', 'audio'] }, text: S(200) },
  },
  task: {
    use: 'a task the person can follow (agent-tasks.md): its title and state, a click opens it; it shows itself as it goes on (what it is doing, how it ended, what it made)',
    fields: { id: S(80, true), state: { type: 'enum', values: ['queued', 'working', 'waiting', 'to-confirm', 'done', 'failed', 'stopped'] }, text: S(200), step: S(200), result: S(300) },
  },
}

/** One card of each type, as the main agent would send it (the renderer is built and checked against these). */
export const EXAMPLES = [
  { type: 'weather', title: '明天 Campbell 的天气', place: 'Campbell, CA', unit: 'F', now: { temp: 58, sky: 'clear', text: '晴', humidity: 71, wind: 'WSW 3 mph' },
    days: [{ date: '2026-10-19', label: '周一', hi: 78, lo: 52, sky: 'clear', text: '晴' }, { date: '2026-10-20', label: '周二', hi: 74, lo: 51, sky: 'partly', text: '多云间晴', rain: 10 }],
    source: { name: 'NWS', url: 'https://forecast.weather.gov/' }, at: '2026-10-18T06:53:00-07:00' },
  { type: 'time', title: '现在几点', zones: [{ zone: 'America/Los_Angeles', label: 'Campbell' }, { zone: 'Asia/Shanghai', label: '上海' }] },
  { type: 'link', url: 'https://www.youtube.com/', title: 'YouTube', text: '点一下在你的浏览器里打开', site: 'youtube.com' },
  { type: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: '一段视频', channel: '某频道', duration: '3:33' },
  { type: 'list', title: '找到的三篇', items: [{ title: '第一篇', text: '一句话说它讲什么', url: 'https://example.com/a', meta: '10 月 17 日' }, { title: '第二篇', text: '……' }] },
  { type: 'table', title: '三个方案', columns: ['方案', '价格', '好在哪'], rows: [['A', 99, '便宜'], ['B', 199, '快'], ['C', 299, '都有']] },
  { type: 'stat', title: '今天', items: [{ label: '做完的任务', value: 7 }, { label: '花费', value: 1.42, unit: '$', delta: '-12%' }] },
  { type: 'note', title: '要点', text: '第一点。\n第二点。' },
  { type: 'choice', question: '用哪个账号发？', options: [{ label: '小周', text: '写给独立开发者' }, { label: '工作号' }] },
  { type: 'confirm', title: '稿子写好了', text: '小红书、X 两版都在，看一下，可以就点「好了」', task: 't123' },
  { type: 'file', name: 'draft.md', run: 'r24dc2f0', path: 'draft.md', kind: 'markdown', text: '原稿' },
  { type: 'task', id: 't123', title: '写一条：独立开发的第一年', state: 'to-confirm', text: '等你确认' },
]

const ZONE_OK = z => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true } catch { return false } }
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A value against its field's description → the value (cleaned) or a throw with what is wrong. */
function value(f, v, at, errors) {
  const bad = msg => { errors.push({ path: at, message: msg }); return undefined }
  switch (f.type) {
    case 'string': if (typeof v !== 'string' && typeof v !== 'number') return bad('text'); { const s = String(v).trim(); return s.length > f.max ? bad(`at most ${f.max} characters`) : s }
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? v : bad('a number')
    case 'bool': return typeof v === 'boolean' ? v : bad('true or false')
    case 'cell': return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.length <= 200 ? v : v === null ? '' : bad('a number or a short text')
    case 'enum': return f.values.includes(v) ? v : bad(`one of ${f.values.join(', ')}`)
    case 'date': return typeof v === 'string' && DATE.test(v) ? v : bad('a date, YYYY-MM-DD')
    case 'time': return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : bad('a time, ISO with its offset')
    case 'zone': return typeof v === 'string' && ZONE_OK(v) ? v : bad('an IANA time zone, e.g. Asia/Shanghai')
    case 'url': return typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v) && v.length <= 2000 ? v : bad('a web address, http(s)://…')
    case 'local': return typeof v === 'string' && v.length <= 500 && (/^(\/|api\/)/.test(v) && !/^\/\//.test(v)) ? v : bad('a link of this page\'s own (api/… or /…)')
    case 'object': return object(f.fields, v, at, errors)
    case 'list': {
      if (!Array.isArray(v)) return bad('a list')
      if (f.max && v.length > f.max) return bad(`at most ${f.max}`)
      if (f.min && v.length < f.min) return bad(`at least ${f.min}`)
      return v.map((x, i) => value(f.of, x, `${at}[${i}]`, errors))
    }
    default: return bad(`(no such field type ${f.type})`)
  }
}
function object(fields, v, at, errors) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push({ path: at, message: 'an object' }); return undefined }
  const out = {}
  for (const k of Object.keys(v)) if (!Object.hasOwn(fields, k)) errors.push({ path: `${at}.${k}`, message: `no such field (${Object.keys(fields).join(', ')})` })
  for (const [k, f] of Object.entries(fields)) {
    if (v[k] === undefined || v[k] === null || v[k] === '') { if (f.need) errors.push({ path: `${at}.${k}`, message: 'needed' }); continue }
    const x = value(f, v[k], `${at}.${k}`, errors)
    if (x !== undefined) out[k] = x
  }
  return out
}

/**
 * Check what an agent sent: { cards: [...] } or one card → { cards (clean: only the fields of each type), errors: [{
 * path, message }] }. A card with errors is left out; none at all when nothing checks.
 */
export function checkCards(input) {
  const list = Array.isArray(input?.cards) ? input.cards : input && typeof input === 'object' && input.type ? [input] : null
  if (!list) return { cards: [], errors: [{ path: 'cards', message: 'a list of cards, [{ type, … }]' }] }
  if (!list.length || list.length > 6) return { cards: [], errors: [{ path: 'cards', message: '1 to 6 cards' }] }
  const errors = [], cards = []
  for (const [i, c] of list.entries()) {
    const at = `cards[${i}]`, T = CARD_TYPES[c?.type]
    if (!T) { errors.push({ path: `${at}.type`, message: `one of ${Object.keys(CARD_TYPES).join(', ')}` }); continue }
    const mine = []
    // (a title is every card's; a type whose own fields have one — a link, a video — checks it as its own)
    const { type, ...rest } = c, own = Object.hasOwn(T.fields, 'title'), title = own ? undefined : rest.title
    if (!own) delete rest.title
    const out = object(T.fields, rest, at, mine)
    if (title !== undefined && (typeof title !== 'string' || title.length > 120)) mine.push({ path: `${at}.title`, message: 'a title, at most 120 characters' })
    if (type === 'file' && !rest.run && !rest.session && !rest.url) mine.push({ path: at, message: 'a file is a run\'s (run, path), a session\'s (session, path) or a link of this page\'s own (url)' })
    errors.push(...mine)
    if (!mine.length) cards.push({ type, ...(title && { title: title.trim() }), ...out })
  }
  return { cards, errors }
}
