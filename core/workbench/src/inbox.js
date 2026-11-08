// The inbox as one place, without React: what other plugins publish into it and how it is counted.
// Three slots carry other plugins into the inbox — a slot entry keeps only { id, order, label() }, so a plugin's stores
// live in window.__ruyixInbox[id]:
//   ruyix.inbox.tab     a tab of its own (before the notifications): { count } — a store of how many are new there;
//   ruyix.inbox.needs   what waits on the person elsewhere, listed above the approvals and counted with them: { items };
//   ruyix.inbox.system  what this machine needs from the person (a connection that fails, a CLI not signed in…), the
//                        System tab: { items }.
// `items` is an external store (subscribe / getSnapshot) of rows { key, icon?, kind?, tone, title, detail?, affects?,
// since?, actions?: [{ label, primary?, run() }], open?() }. Tones come in two vocabularies — the panels' (red, amber, blue,
// green, muted) and the System tab's (danger: broken now, warning: breaks within days, info) — and read as one here.
export const INBOX_SLOT = 'ruyix.inbox.tab'
export const NEEDS_SLOT = 'ruyix.inbox.needs'
export const SYSTEM_SLOT = 'ruyix.inbox.system'

const TONES = { danger: 'red', warning: 'amber', info: 'blue', red: 'red', amber: 'amber', blue: 'blue', green: 'green', muted: 'muted' }
/** A row's tone in the panel's colours (an unknown one: amber, it waits on someone). */
export const toneOf = tone => TONES[tone] || 'amber'
/** A System row that blocks work now (danger) or within days (warning): what the inbox's badge counts. */
export const blocksWork = row => ['danger', 'warning', 'red', 'amber'].includes(row?.tone)
/** How many System rows block work, over the tab's groups ([{ items }]). */
export const blocking = groups => groups.reduce((n, g) => n + (g.items || []).filter(blocksWork).length, 0)
/** How many rows wait on the person elsewhere (the needs slot's groups). */
export const needsCount = groups => groups.reduce((n, g) => n + (g.items || []).length, 0)

/** The plugin entries of a slot as shown: each slot entry's id / order / label with its stores, in their order. */
export function entriesOf(entries, stores = {}) {
  return (entries || []).map(e => e?.options || e || {}).filter(o => o.id).map(o => ({ ...stores[o.id], ...o })).sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
}
/** Groups of rows from the slot's entries that have items: [{ id, label, items }] (an entry whose store has none is left out). */
export function groupsOf(entries) {
  return entries.filter(o => o.items?.getSnapshot).map(o => {
    let items = []
    try { items = o.items.getSnapshot() || [] } catch { /* a store mid-reload: none now */ }
    return { id: o.id, label: typeof o.label === 'function' ? o.label() : o.label ?? o.id, items }
  }).filter(g => g.items.length)
}

/** Has a person step's card waited past its hours (its person was reminded, or is due to be)? */
export const overdue = (a, now = Date.now()) => ['pending', 'failed'].includes(a?.status) && !!(a.payload?.remindedAt || (a.payload?.deadline && now > a.payload.deadline))
/**
 * A person step's cards that waited past their hours: a reminder each, as the inbox's notifications show them —
 * { key, at, run, kind: 'remind', approval } (newest first). Archived runs' cards are left out.
 */
export function remindersOf(approvals, runs, now = Date.now()) {
  return [...(approvals || [])].filter(a => a.payload?.remindedAt && overdue(a, now)).map(a => ({ a, run: runs.get(a.runId) })).filter(x => x.run && !x.run.archivedAt)
    .map(({ a, run }) => ({ key: `${a.id}:remind`, at: a.payload.remindedAt, run, kind: 'remind', approval: a })).sort((x, y) => y.at - x.at)
}
