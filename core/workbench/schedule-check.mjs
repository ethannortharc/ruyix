// When a task runs (lib/schedule.js): a time every day and on chosen weekdays, every N minutes, cron lines, the person's
// time zone with daylight saving on both sides, a box that was off when a run was due, the words a schedule is said in.
import assert from 'node:assert/strict'
import { checkSchedule, describe, dueSince, instantOf, nextAt, parseCron, wallClock } from './lib/schedule.js'

const SH = { tz: 'Asia/Shanghai' }, NY = { tz: 'America/New_York' }
const at = (iso, tz) => { const [d, t] = iso.split(' '); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return instantOf(y, m, dd, h, mi, tz) }
const show = (ms, tz) => { const w = wallClock(ms, tz); return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')} ${String(w.h).padStart(2, '0')}:${String(w.min).padStart(2, '0')}` }

// ── checks ──
assert.deepEqual(checkSchedule({ kind: 'daily', at: '8:00' }), { schedule: { kind: 'daily', at: '08:00' }, errors: [] })
assert.deepEqual(checkSchedule({ kind: 'daily', at: '09:30', days: [3, 1, 1] }).schedule, { kind: 'daily', at: '09:30', days: [1, 3] })
assert.deepEqual(checkSchedule({ kind: 'daily', at: '09:30', days: [0, 1, 2, 3, 4, 5, 6] }).schedule, { kind: 'daily', at: '09:30' }, 'all seven days is every day')
assert.match(checkSchedule({ kind: 'daily', at: '25:00' }).errors[0], /time like 08:00/)
assert.match(checkSchedule({ kind: 'daily', at: '08:00', days: [7] }).errors[0], /weekdays 0–6/)
assert.match(checkSchedule({ kind: 'every', minutes: 5 }).errors[0], /15 to a week/)
assert.match(checkSchedule({ kind: 'cron', expr: '0 8 * *' }).errors[0], /five fields/)
assert.match(checkSchedule({ kind: 'cron', expr: '61 8 * * *' }).errors[0], /out of 0–59/)
assert.match(checkSchedule({ kind: 'cron', expr: '0 0 31 2 *' }).errors[0], /no matching date/)
assert.match(checkSchedule({ kind: 'hourly' }).errors[0], /kind is/)
assert.deepEqual(parseCron('*/15 8-10 * * 1-5').minute, [0, 15, 30, 45])
assert.deepEqual(parseCron('0 9 * * 7').weekday, [0], 'Sunday is 0 and 7')

// ── every day at 08:00, Shanghai ──
const daily = { kind: 'daily', at: '08:00' }
assert.equal(show(nextAt(daily, at('2026-10-17 07:59', SH.tz), SH), SH.tz), '2026-10-17 08:00')
assert.equal(show(nextAt(daily, at('2026-10-17 08:00', SH.tz), SH), SH.tz), '2026-10-18 08:00', 'strictly after')
assert.equal(show(nextAt(daily, at('2026-12-31 09:00', SH.tz), SH), SH.tz), '2027-01-01 08:00', 'across the year')
// weekdays only: Friday evening → Monday
const workdays = { kind: 'daily', at: '09:30', days: [1, 2, 3, 4, 5] }
assert.equal(show(nextAt(workdays, at('2026-10-16 18:00', SH.tz), SH), SH.tz), '2026-10-19 09:30')

// ── daylight saving (New York): 08:00 stays 08:00 on both sides; a time in the skipped hour, the first minute after ──
assert.equal(show(nextAt(daily, at('2026-03-07 09:00', NY.tz), NY), NY.tz), '2026-03-08 08:00')
assert.equal(show(nextAt(daily, at('2026-10-31 09:00', NY.tz), NY), NY.tz), '2026-11-01 08:00')
assert.equal(nextAt(daily, at('2026-03-08 08:00', NY.tz), NY) - at('2026-03-08 08:00', NY.tz), 24 * 3600e3, 'a calendar day, 24 h here')
assert.equal(at('2026-03-09 08:00', NY.tz) - at('2026-03-08 08:00', NY.tz), 24 * 3600e3)
assert.equal(at('2026-03-08 08:00', NY.tz) - at('2026-03-07 08:00', NY.tz), 23 * 3600e3, 'the day clocks go forward has 23 h')
assert.equal(show(nextAt({ kind: 'daily', at: '02:30' }, at('2026-03-07 03:00', NY.tz), NY), NY.tz), '2026-03-08 03:00', '02:30 does not exist that night: the first minute after the gap')
assert.equal(show(at('2026-11-01 01:30', NY.tz), NY.tz), '2026-11-01 01:30', 'twice that night: the first')
assert.equal(new Date(at('2026-11-01 01:30', NY.tz)).toISOString(), '2026-11-01T05:30:00.000Z', 'the first occurrence, not just the same wall clock')
assert.equal(show(at('2026-03-29 02:30', 'Europe/Berlin'), 'Europe/Berlin'), '2026-03-29 03:00', 'a gap east of UTC also ends at the first existing minute')
assert.equal(show(at('2026-10-04 02:15', 'Australia/Lord_Howe'), 'Australia/Lord_Howe'), '2026-10-04 02:30', 'a half-hour gap')
assert.equal(new Date(at('2026-04-05 01:45', 'Australia/Lord_Howe')).toISOString(), '2026-04-04T14:45:00.000Z', 'a half-hour overlap: the earlier occurrence')
assert.equal(show(at('2011-12-30 08:00', 'Pacific/Apia'), 'Pacific/Apia'), '2011-12-31 00:00', 'a skipped calendar day')

// ── every 6 hours, from when it was made ──
const every = { kind: 'every', minutes: 360, from: Date.UTC(2026, 9, 17, 1, 0) }
assert.equal(nextAt(every, Date.UTC(2026, 9, 17, 0, 0)), every.from)
assert.equal(nextAt(every, every.from), every.from + 6 * 3600e3)
assert.equal(nextAt(every, every.from + 6 * 3600e3 - 1), every.from + 6 * 3600e3)

// ── cron: weekdays at 08:00 and 20:00; the 1st of the month or Mondays (either matches) ──
const cron = { kind: 'cron', expr: '0 8,20 * * 1-5' }
assert.equal(show(nextAt(cron, at('2026-10-16 20:00', SH.tz), SH), SH.tz), '2026-10-19 08:00')
assert.equal(show(nextAt(cron, at('2026-10-19 08:00', SH.tz), SH), SH.tz), '2026-10-19 20:00')
assert.equal(show(nextAt({ kind: 'cron', expr: '0 9 1 * 1' }, at('2026-10-27 10:00', SH.tz), SH), SH.tz), '2026-11-01 09:00')
assert.equal(show(nextAt({ kind: 'cron', expr: '0 9 1 * 1' }, at('2026-11-01 10:00', SH.tz), SH), SH.tz), '2026-11-02 09:00')
assert.equal(nextAt({ kind: 'cron', expr: '0 0 31 2 *' }, Date.now(), SH), null, 'never: no time within a year and a bit')
assert.equal(nextAt({ kind: 'once' }, Date.now()), null)

// ── the box was off: one catch-up run stands for the last time it was due ──
const last = at('2026-10-14 08:00', SH.tz)
assert.equal(show(dueSince(daily, last, at('2026-10-17 07:00', SH.tz), SH), SH.tz), '2026-10-16 08:00', 'three days off: once, for the 16th')
assert.equal(dueSince(daily, at('2026-10-17 08:00', SH.tz), at('2026-10-17 12:00', SH.tz), SH), null, 'ran already today')
assert.equal(new Date(nextAt({ kind: 'cron', expr: '0 9 29 2 *' }, Date.UTC(2026, 9, 17), { tz: 'UTC' })).toISOString(), '2028-02-29T09:00:00.000Z', 'leap-day schedules stay armed')
assert.equal(dueSince(every, every.from, every.from + 13 * 3600e3), every.from + 12 * 3600e3)
// Catch-up finds the last occurrence without replaying years of missed minutes.
{
  const original = Intl.DateTimeFormat.prototype.formatToParts
  let calls = 0
  Intl.DateTimeFormat.prototype.formatToParts = function (...args) { assert.ok(++calls < 10000, 'catch-up must not enumerate missed minutes'); return original.apply(this, args) }
  try {
    assert.equal(dueSince({ kind: 'cron', expr: '* * * * *' }, Date.UTC(2020, 0, 1), Date.UTC(2026, 9, 17, 8, 17, 45), { tz: 'UTC' }), Date.UTC(2026, 9, 17, 8, 17))
  } finally { Intl.DateTimeFormat.prototype.formatToParts = original }
}

// ── words ──
assert.equal(describe(daily), '每天 08:00')
assert.equal(describe(workdays), '工作日 09:30')
assert.equal(describe({ kind: 'daily', at: '10:00', days: [1, 3] }), '每周一、三 10:00')
assert.equal(describe({ kind: 'every', minutes: 360 }), '每 6 小时')
assert.equal(describe({ kind: 'every', minutes: 2880 }, 'en'), 'every 2 day(s)')
assert.equal(describe({ kind: 'every', minutes: 45 }), '每 45 分钟')
assert.equal(describe(cron, 'en'), 'cron 0 8,20 * * 1-5')
console.log('schedule check: ok')
