// The sidebar's groups, owned by the shell. A plugin joins a group by the `order` of its sidebar.panellist entry — the
// one convention it follows; nothing else of a plugin is read. The shell orders every row and puts each group's
// caption on its first present entry, so enabling or disabling any plugin leaves the same shape.
export const GROUPS = [
  { from: 10, to: 19, zh: '工作台', en: 'Workbench' }, // home, the inbox, runs, workflows
  { from: 20, to: 29, zh: '应用', en: 'Apps' }, // each app's pages, boards
  { from: 30, to: 39, zh: '智能体', en: 'Agents' },
  { from: 40, to: 49, zh: '系统', en: 'System' }, // connections, the changes, what the machine has
  { from: 50, to: 59, zh: '盒子', en: 'Box' }, // the box this Ruyix runs in (only there)
]
export const NAV = 'nav:has([data-slot="sidebar.panellist"])'
const RAIL = ':is([class*="_railIn"], [class*="_collapsed"])' // the sidebar as its icon rail: collapsed by hand, or by a narrow window

const labelOf = e => (typeof e.options?.label === 'function' ? e.options.label() : e.options?.label)
const groupOf = order => GROUPS.findIndex(x => order >= x.from && order <= x.to)


/** The entries the list shows (each with its group's name): what this Ruyix's own `nav` may order and hide. */
export function navEntries(entries, lang = 'en', tabs = new Set(), preset = null, extra = {}, own = {}) {
  const hidden = new Set(own.hidden || [])
  return entries.filter(e => e.options?.id && !awayOf(e, tabs, preset, extra) && groupOf(e.options?.order ?? 0) >= 0 && labelOf(e))
    .map(e => ({ id: String(e.options.id), label: String(labelOf(e)), group: GROUPS[groupOf(e.options.order ?? 0)][lang] || GROUPS[groupOf(e.options.order ?? 0)].en, ...(hidden.has(e.options.id) && { hidden: true }) }))
}
// an entry another page hosts (a tab of the Settings page: `tabs`, their ids)
// leaves the list too, and so does one for other presets than this Ruyix's, one with nothing to show now, or one folded
// into another page. dsh keeps only an entry's id, order and label, so a plugin says those in window.__ruyixNav[id]
// (`extra`): { for: ['…'], shown(), badge() — a number the dock puts on the page's icon, count() — the number where its
// own icon is not drawn (the interactive desk's places; badge() when there is none), into: '<page id>' — this page now
// lives in that one (docs/design/work-in-one-place.md: the runs and the records in 「任务」), land: { … } — where on it
// (an open of this page is that page's open, its detail kept: intoOf) }, then sends 'ruyix:nav'
const awayOf = (e, tabs, preset, extra) => {
  const x = extra[e.options?.id] || {}
  return tabs.has(e.options?.id) || (preset && Array.isArray(x.for) && !x.for.includes(preset)) || x.shown?.() === false || (!!x.into && x.into !== e.options?.id)
}
/** The open a page folded into another is now ({ ...detail, ...its land, panel: the other }); null for a page of its own. */
export function intoOf(detail = {}, extra = globalThis.window?.__ruyixNav || {}) {
  const x = extra[detail.panel]
  return x?.into && x.into !== detail.panel ? { ...detail, ...x.land, panel: String(x.into) } : null
}

/**
 * The panel list's rows (dsh labels each row with its entry's label) → CSS that orders and captions them. `own`: this
 * Ruyix's own sidebar (its layout's nav) — `hidden` entries leave the list, `order`'s come first in their group, in its order.
 */
export function navCss(entries, lang = 'en', tabs = new Set(), preset = null, extra = {}, own = {}) {
  const mine = new Set(own.hidden || []), ordered = own.order || []
  const away = e => awayOf(e, tabs, preset, extra) || mine.has(e.options?.id)
  const all = entries.map(e => ({ id: e.options?.id, label: labelOf(e), order: away(e) ? -1 : e.options?.order ?? 0 })).filter(r => r.label)
  const row = r => `${NAV} > button[aria-label=${JSON.stringify(String(r.label))}]`
  // entries outside every group leave the list: dsh's own pages (its Plugins page, order 0), a product's own Settings
  const hidden = all.filter(r => groupOf(r.order) < 0).map(r => `${row(r)} { display: none; }`)
  const placed = id => { const i = ordered.indexOf(id); return i < 0 ? Infinity : i }
  const rows = all.filter(r => groupOf(r.order) >= 0).map(r => ({ ...r, group: groupOf(r.order), rank: r.order }))
    .sort((a, b) => a.group - b.group || (placed(a.id) === placed(b.id) ? 0 : placed(a.id) - placed(b.id)) || a.rank - b.rank)
  const css = [...hidden, ...rows.map((r, i) => `${row(r)} { order: ${i}; }`)]
  const first = new Set()
  for (const r of rows) {
    if (first.has(r.group)) continue
    // a group's first row: room for the caption above it (and, after the first group, for the hairline between groups)
    css.push(`${row(r)} { margin-top: ${first.size ? 46 : 32}px; }`, `${row(r)}::before { content: ${JSON.stringify(GROUPS[r.group][lang] || GROUPS[r.group].en)}; }`,
      `${RAIL} ${row(r)} { margin-top: 10px; }`)
    if (first.size) css.push(`${row(r)}::after { content: ''; position: absolute; top: -37px; left: 12px; right: 12px; height: 1px; background: var(--ruyix-line); pointer-events: none; }`,
      `${RAIL} ${row(r)}::after { top: -6px; left: 10px; right: 10px; }`)
    first.add(r.group)
  }
  return css.join('\n')
}
