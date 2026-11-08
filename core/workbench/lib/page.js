// Newest first, with a stable id tie-breaker. A timestamp alone remains a legacy cursor.
export function pageOf(items, { before = null, limit = 100, time = 'at' } = {}) {
  const idOf = x => String(x.id)
  const all = [...items].sort((a, b) => Number(b[time]) - Number(a[time]) || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0))
  const ts = Number(before && typeof before === 'object' ? before.at : before)
  const id = before && typeof before === 'object' ? String(before.id) : null
  const start = before ? all.findIndex(x => Number(x[time]) < ts || (id !== null && Number(x[time]) === ts && idOf(x) > id)) : 0
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500)
  const page = start < 0 ? [] : all.slice(start, start + n), last = page.at(-1)
  return { page, more: start >= 0 && all.length > start + page.length, cursor: last ? { at: Number(last[time]), id: idOf(last) } : null }
}
