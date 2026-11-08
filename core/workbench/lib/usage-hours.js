// What the tasks used, by the hour (the desk's 「今天」, Ethan 2026-10-19): a task keeps only its totals (its runs' ledger,
// its conversation's turns, its session's work), so the when is kept here. Every few minutes every task's totals are
// read; what grew since the last read goes to this hour. The first read of all — or a task seen for the first time —
// puts what it used so far at the hour it last moved. Kept a few days, in the store's meta ('usage-hours').
const HOUR = 3600e3
const hourOf = ms => Math.floor(ms / HOUR) * HOUR

/** `read()` → Map(task id → { tokens, cost (null: not priced), at: when it last moved }). */
export function createUsageHours({ store, read, now = Date.now, keepHours = 72 }) {
  const doc = () => store.get('meta', 'usage-hours') || null
  let readAt = 0
  /** Read every task's totals once and put what grew where it belongs. */
  function sample() {
    const at = now(), d = doc(), hours = { ...(d?.hours || {}) }, last = {}
    const add = (h, tokens, cost) => {
      if (at - h >= keepHours * HOUR || (!tokens && !cost)) return
      const b = (hours[h] ||= { tokens: 0, cost: 0, priced: false })
      b.tokens += tokens; if (cost != null) { b.cost += cost; b.priced = true }
    }
    for (const [id, u] of read()) {
      const tokens = Math.max(0, Number(u.tokens) || 0), cost = Number.isFinite(u.cost) ? Math.max(0, u.cost) : null
      last[id] = { tokens, cost }
      const was = d?.last?.[id]
      if (!was) add(hourOf(u.at || at), tokens, cost)
      else add(hourOf(at), Math.max(0, tokens - (was.tokens || 0)), cost == null ? null : Math.max(0, cost - (was.cost || 0)))
    }
    for (const h of Object.keys(hours)) if (at - Number(h) >= keepHours * HOUR) delete hours[h]
    store.put('meta', { id: 'usage-hours', at, last, hours })
    readAt = at
  }
  return {
    sample,
    /** Read again unless it was read within `fresh` ms. */
    fresh(fresh = 60e3) { if (now() - readAt > fresh) sample() },
    /**
     * Since `from` (the person's midnight): { tokens, cost (null: nothing priced), hours: the last `n` hours, the one
     * now last — [{ at, tokens, cost }] }.
     */
    since(from, n = 12) {
      const hours = doc()?.hours || {}, at = now(), cut = Number(from) || at - 24 * HOUR
      let tokens = 0, cost = 0, priced = false
      for (const [h, b] of Object.entries(hours)) if (Number(h) + HOUR > cut && Number(h) <= at) { tokens += b.tokens; if (b.priced) { cost += b.cost; priced = true } }
      const k = Math.min(Math.max(Number(n) || 12, 1), 48), top = hourOf(at)
      const series = Array.from({ length: k }, (_, i) => { const h = top - (k - 1 - i) * HOUR, b = hours[h]; return { at: h, tokens: b?.tokens || 0, cost: b?.priced ? b.cost : 0 } })
      return { tokens, cost: priced ? Math.round(cost * 10000) / 10000 : null, hours: series }
    },
  }
}
