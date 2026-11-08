// A Plume 工作室 account (studio.js) as Plume's settings for one run (pack.js `account`): no imports, so both can use it.

/** An account laid over Plume's settings (a run that writes as it): its voice, its brand, its X, its connections. */
export function settingsFromAccount(a, s = {}) {
  const has = v => v !== undefined && v !== null && v !== ''
  const pick = (base, pairs) => ({ ...(base || {}), ...Object.fromEntries(pairs.filter(([, v]) => has(v))) })
  return {
    ...s,
    style: pick(s.style, [['name', a.name], ['positioning', a.positioning], ['guide', a.guide], ['language', a.language]]),
    brand: pick(s.brand, [['accent', a.accent], ['background', a.background], ['signature', a.signature]]),
    x: { ...(s.x || {}), ...(a.xPremium !== undefined && { premium: !!a.xPremium }), ...(a.xCover !== undefined && { cover: !!a.xCover }) },
    accounts: pick(s.accounts, [['x', a.xConnection], ['xhs', a.xhsConnection]]),
  }
}
