// What a model cost, in the person's currency (desktop.json `currency`, `cnyPerUsd`: Settings → General): the models
// price in dollars; said as $0.55, or as ¥3.96 at the rate the person set. The page's layout (window.__ruyixLayout, read
// again on 'ruyix:layout-changed') says which. Exported as @ruyix/shell/money for the plugins' pages.
const RATE = 7.2

/** The currency now: { code: 'usd' | 'cny', rate } (yuan to the dollar; 1 for dollars). */
export function currency(d = globalThis.window?.__ruyixLayout?.desktop) {
  return d?.currency === 'cny' ? { code: 'cny', rate: Number(d.cnyPerUsd) > 0 ? Number(d.cnyPerUsd) : RATE } : { code: 'usd', rate: 1 }
}

/** A cost in dollars → '$0.55' / '¥3.96' (a fraction of a cent: three places; '' for nothing or a cost not known). */
export function money(usd, cur = currency()) {
  if (!(Number(usd) > 0)) return ''
  const v = Number(usd) * cur.rate, sign = cur.code === 'cny' ? '¥' : '$'
  return `${sign}${v < 0.01 ? v.toFixed(3) : v < 1000 ? v.toFixed(2) : Math.round(v).toLocaleString('en')}`
}
