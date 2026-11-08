// When a task runs: once, or again and again — every day (or chosen weekdays) at a time, every N hours, or a cron line
// for whoever wants one. Times are the person's wall clock in their time zone (an IANA name; the machine's by default),
// daylight saving included: "08:00 every day" is 08:00 on both sides of a change. No library: Intl gives the wall clock.
//   { kind: 'once' }
//   { kind: 'daily', at: 'HH:MM', days?: [0–6, Sunday 0] }   — every day, or those weekdays
//   { kind: 'every', minutes: n, from?: ms }                    — every n minutes (15 at least), counted from `from`
//   { kind: 'cron', expr: 'm h dom mon dow' }                   — five fields: *, n, a-b, lists, */n, a-b/n
// A box that was off when a run was due: `dueSince` says the last time it was due (one run makes up for it, not one per miss).

const MIN = 60e3, DAY = 864e5
const pad = n => String(n).padStart(2, '0')
const fmtCache = new Map()
const fmt = tz => {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }))
  return fmtCache.get(tz)
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
/** An instant's wall clock in a time zone: { y, m (1–12), d, h, min, s, wd (0 Sunday) }. */
export function wallClock(ms, tz) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, wd: WD[p.weekday] }
}
const offsetAt = (ms, tz) => { const w = wallClock(ms, tz); return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(ms / 1000) * 1000 }
/**
 * The instant a wall-clock time stands for in a time zone. A time that does not exist (the hour skipped when clocks go
 * forward) is the first minute after the gap; one that happens twice (clocks go back) is the first of the two.
 */
export function instantOf(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min)
  // Try both sides of an offset change (some changes are half an hour or a whole day).
  const candidates = [...new Set([-DAY, 0, DAY].map(delta => guess - offsetAt(guess + delta, tz)))].sort((a, b) => a - b)
  const wall = t => { const w = wallClock(t, tz); return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) }
  const exact = candidates.find(t => wall(t) === guess)
  if (exact !== undefined) return exact // twice: the earlier occurrence
  // In a gap, start before it and stop at the first existing minute after it.
  for (let t = candidates[0]; t <= candidates.at(-1); t += MIN) if (wall(t) >= guess) return t
  return candidates.at(-1)
}
/** The next calendar day's date (y, m, d) — by the calendar, not by adding 24 h. */
const nextDay = ({ y, m, d }, delta = 1) => { const t = new Date(Date.UTC(y, m - 1, d + delta)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() } }

// ── cron ──
const FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day', 1, 31], ['month', 1, 12], ['weekday', 0, 7]]
/** One cron field → the sorted values it allows, or throws. */
function field(text, [name, lo, hi]) {
  const out = new Set()
  for (const part of String(text).split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim())
    if (!m) throw new Error(`${name}: "${part}" is not a cron value`)
    const step = m[4] ? Number(m[4]) : 1
    const a = m[1] === '*' ? lo : Number(m[2]), b = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : a
    if (step < 1 || a < lo || b > hi || a > b) throw new Error(`${name}: "${part}" is out of ${lo}–${hi}`)
    for (let v = a; v <= b; v += step) out.add(name === 'weekday' && v === 7 ? 0 : v)
  }
  return [...out].sort((x, y) => x - y)
}
export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('a cron line has five fields: minute hour day month weekday')
  const [minute, hour, day, month, weekday] = parts.map((p, i) => field(p, FIELDS[i]))
  // like cron: when both day and weekday are restricted, either one matching is enough
  return { minute, hour, day, month, weekday, anyDay: parts[2] === '*', anyWeekday: parts[4] === '*' }
}
const cronDay = (c, { m, d, wd }) => c.month.includes(m) && (c.anyDay && c.anyWeekday ? true : c.anyDay ? c.weekday.includes(wd) : c.anyWeekday ? c.day.includes(d) : c.day.includes(d) || c.weekday.includes(wd))

// ── a schedule ──
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/
/** A schedule as given (a form, an agent, a file) → { schedule (normalized), errors: [text] }. */
export function checkSchedule(s) {
  const errors = []
  const k = s?.kind
  if (!s || typeof s !== 'object' || !['once', 'daily', 'every', 'cron'].includes(k)) return { schedule: null, errors: ['kind is once, daily, every or cron'] }
  if (k === 'once') return { schedule: { kind: 'once' }, errors }
  if (k === 'daily') {
    const at = String(s.at ?? '')
    if (!HHMM.test(at)) errors.push('at is a time like 08:00')
    const days = s.days === undefined || s.days === null ? null : (Array.isArray(s.days) ? [...new Set(s.days.map(Number))].sort() : null)
    if (s.days !== undefined && s.days !== null && (!days || !days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6))) errors.push('days are weekdays 0–6 (Sunday 0)')
    const [, h, m] = HHMM.exec(at) || []
    return { schedule: { kind: 'daily', at: h ? `${pad(h)}:${m}` : at, ...(days?.length && days.length < 7 && { days }) }, errors }
  }
  if (k === 'every') {
    const minutes = Number(s.minutes)
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 7 * 24 * 60) errors.push('minutes is 15 to a week')
    return { schedule: { kind: 'every', minutes, ...(Number.isFinite(s.from) && { from: s.from }) }, errors }
  }
  try {
    parseCron(s.expr)
    if (nextAt({ kind: 'cron', expr: s.expr }, Date.now(), { tz: 'UTC' }) === null) errors.push('cron has no matching date')
  } catch (err) { errors.push(err.message) }
  return { schedule: { kind: 'cron', expr: String(s.expr || '').trim().split(/\s+/).join(' ') }, errors }
}

const timesOf = s => s.kind === 'daily'
  ? { days: d => !s.days || s.days.includes(d.wd), list: [[Number(s.at.slice(0, 2)), Number(s.at.slice(3))]] }
  : (() => { const c = parseCron(s.expr); return { days: d => cronDay(c, d), list: c.hour.flatMap(h => c.minute.map(mi => [h, mi])) } })()
const HORIZON = 8 * 366 // includes the longest gap between leap days, across a non-leap century

/** The first time after `after` (ms) the schedule is due; null for `once` (or a cron with no match within eight years). */
export function nextAt(s, after, { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  if (!s || s.kind === 'once') return null
  if (s.kind === 'every') {
    const p = s.minutes * MIN, from = s.from ?? 0
    return after < from ? from : from + (Math.floor((after - from) / p) + 1) * p
  }
  const times = timesOf(s)
  let day = wallClock(after, tz)
  for (let i = 0; i < HORIZON; i++) {
    if (times.days(day)) {
      for (const [h, mi] of times.list) {
        const t = instantOf(day.y, day.m, day.d, h, mi, tz)
        if (t > after) return t
      }
    }
    day = nextDay(day)
  }
  return null
}
/** The last time it was due in (since, now] — what one catch-up run stands for — or null when it was not due. */
export function dueSince(s, since, now, { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  if (!s || s.kind === 'once' || now <= since) return null
  if (s.kind === 'every') {
    const p = s.minutes * MIN, from = s.from ?? 0
    const t = from + Math.floor((now - from) / p) * p
    return now >= from && t > since ? t : null
  }
  // Find the latest occurrence directly; replaying every missed minute blocks startup after an outage.
  const times = timesOf(s), first = wallClock(since, tz), firstDate = Date.UTC(first.y, first.m - 1, first.d)
  let day = wallClock(now, tz)
  for (let i = 0; i < HORIZON && Date.UTC(day.y, day.m - 1, day.d) >= firstDate; i++, day = nextDay(day, -1)) {
    if (!times.days(day)) continue
    for (const [h, mi] of [...times.list].reverse()) {
      const t = instantOf(day.y, day.m, day.d, h, mi, tz)
      if (t <= now) return t > since ? t : null
    }
  }
  return null
}

const WEEK = { zh: ['日', '一', '二', '三', '四', '五', '六'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }
/** A schedule in words: 每天 08:00 · 每周一、三 09:30 · 每 6 小时 · cron 0 8 * * 1-5. */
export function describe(s, lang = 'zh') {
  const zh = lang === 'zh'
  if (!s || s.kind === 'once') return zh ? '一次' : 'once'
  if (s.kind === 'daily') {
    if (!s.days) return zh ? `每天 ${s.at}` : `every day at ${s.at}`
    if (s.days.join() === '1,2,3,4,5') return zh ? `工作日 ${s.at}` : `weekdays at ${s.at}`
    return zh ? `每周${s.days.map(d => WEEK.zh[d]).join('、')} ${s.at}` : `${s.days.map(d => WEEK.en[d]).join(', ')} at ${s.at}`
  }
  if (s.kind === 'every') {
    const h = s.minutes / 60
    return zh ? (Number.isInteger(h) ? (h % 24 === 0 ? `每 ${h / 24} 天` : `每 ${h} 小时`) : `每 ${s.minutes} 分钟`) : (Number.isInteger(h) ? (h % 24 === 0 ? `every ${h / 24} day(s)` : `every ${h} hour(s)`) : `every ${s.minutes} minutes`)
  }
  return `cron ${s.expr}`
}
export const SCHEDULE_DAY = DAY
