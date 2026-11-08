// The things open on the desk and how they group (docs/design/sessions.md §5) — the same on the page and in the box, so
// no Node here. Whoever opens a thing adds it; the box keeps the list (open.js, ~/.ruyix/open.json), the page shows it
// in groups (src/open.js). A group is, in this order:
// 1. where the person put it (`group`, by moving it — remembered as a rule for things like it: the same site, folder, app);
// 2. the thing it belongs to (`of`: 'run:<id>' | 'session:<id>' | 'task:<id>' — a run's page, its files and browser together);
// 3. a rule learned from an earlier move;
// 4. its kind (网页, 文件, 终端, 应用, 页面…).
// The main agent groups what is left by looking at it (open_list, open_group): no guessing here.

export const KINDS = ['page', 'window', 'app', 'term', 'web', 'file', 'session', 'run']
export const KIND_TITLES = {
  page: { zh: '页面', en: 'Pages' }, window: { zh: '窗口', en: 'Windows' }, app: { zh: '应用', en: 'Apps' }, term: { zh: '终端', en: 'Terminals' },
  web: { zh: '网页', en: 'Web pages' }, file: { zh: '文件', en: 'Files' }, session: { zh: '会话', en: 'Sessions' }, run: { zh: '运行', en: 'Runs' },
}
export const MAX_ITEMS = 200, MAX_CLOSED = 50, MAX_RULES = 200
const OF = /^(run|session|task):[\w.-]{1,80}$/
const GROUP = /^(run|session|task):[\w.-]{1,80}$|^g:.{1,60}$|^kind:[a-z]+$/

export const emptyOpen = () => ({ rev: 0, items: [], closed: [], rules: [], pins: [], titles: {} })
/** Its name in `lang` ('zh' | 'en'): the opener's words in both (`names`: the page can change language), else its title. */
export const nameOf = (it, lang) => it?.names?.[lang] || it?.title || ''
/** What a rule matches an item by: its kind and its hint (a site, a folder, an app — the opener's), else its title. */
export const likeOf = it => `${it.kind}:${it.hint || it.title}`
/** The group an item is in (see the head of this file). */
export function groupOf(it, rules = []) {
  if (it.group) return it.group
  if (it.of) return it.of
  return rules.find(r => r.like === likeOf(it))?.group || `kind:${it.kind}`
}

/**
 * The groups, the latest used first: [{ key, title, items (latest first), usedAt, folded (every item folded), pinned }].
 * `titleOf(key)` names a thing's group (the work list's title for 'run:…'); else the name kept for it (`titles`: the
 * work's title as first seen — a run looked at leaves the work list), the thing's own item's, or a person's own name
 * ('g:<name>'); a kind's group has no title — the page words it in the person's language (KIND_TITLES).
 */
export function groupsOf(state, { titleOf = () => null } = {}) {
  const by = new Map()
  for (const it of state.items) {
    const key = groupOf(it, state.rules)
    if (!by.has(key)) by.set(key, [])
    by.get(key).push(it)
  }
  return [...by.entries()].map(([key, items]) => {
    items.sort((a, b) => b.usedAt - a.usedAt)
    const named = key.startsWith('kind:') ? null : titleOf(key) || state.titles?.[key] || (key.startsWith('g:') ? key.slice(2) : null)
    // (else its own item's name: in both languages when the opener gave both)
    const own = key.startsWith('kind:') || named ? null : items.find(x => x.id === key) || items.find(x => x.of === key) || items[0]
    return { key, title: named || own?.title || null, ...(own?.names && { names: own.names }), items, usedAt: items[0].usedAt, folded: items.every(x => x.folded), pinned: (state.pins || []).includes(key) }
  }).sort((a, b) => b.usedAt - a.usedAt)
}

const fail = (code, message) => Object.assign(new Error(message), { code, status: 400 })
const text = (v, n) => String(v ?? '').slice(0, n)
const namesOf = v => { const n = v && typeof v === 'object' ? Object.fromEntries(['zh', 'en'].filter(l => v[l]).map(l => [l, text(v[l], 120)])) : {}; return Object.keys(n).length ? n : null }
/** An item as added: checked and cut to size. */
function itemOf(x, now) {
  if (!x || typeof x !== 'object' || !/^[\w:.\/-]{1,160}$/.test(String(x.id || ''))) throw fail('badOpen', 'an open thing is { id, kind, title, reopen: { event, detail } }')
  if (!KINDS.includes(x.kind)) throw fail('badOpen', `kind: one of ${KINDS.join(', ')}`)
  if (!x.reopen || typeof x.reopen.event !== 'string') throw fail('badOpen', 'reopen: { event, detail } — how to bring it back')
  if (x.of && !OF.test(x.of)) throw fail('badOpen', "of: 'run:<id>' | 'session:<id>' | 'task:<id>'")
  const reopen = { event: text(x.reopen.event, 80), detail: x.reopen.detail ?? null }
  // A file viewer carries its list (up to 200 files); other open things only carry a short locator.
  const reopenLimit = x.kind === 'file' ? 256 * 1024 : 2000
  if (JSON.stringify(reopen).length > reopenLimit) throw fail('badOpen', `reopen: at most ${reopenLimit} characters`)
  const names = namesOf(x.names)
  return { id: x.id, kind: x.kind, title: text(x.title || x.id, 120), ...(names && { names }), ...(x.icon && { icon: text(x.icon, 40) }), ...(x.hint && { hint: text(x.hint, 200) }), ...(x.of && { of: x.of }), ...(x.win && { win: text(x.win, 120) }), ...(x.bg && { bg: true }), reopen, openedAt: now, usedAt: now, folded: false }
}

/**
 * One change: { op: 'add', item } (item.names: its name in both languages, { zh, en }) | { op: 'rename', id, title?, names? }
 * (only its name: one kept from before names, words the opener now has) | { op: 'use' | 'close' | 'reopen', id } | { op: 'fold', id, folded } |
 * { op: 'forget', id } (gone, and nothing could bring it back: not kept among the closed, and out of them if it was there) |
 * { op: 'foldGroup', key, folded } | { op: 'pin', key, pinned } (tidying leaves it alone) | { op: 'move', id, group } (null: back
 * to where it would go) | { op: 'title', key, title } (a work's name, kept). An item's `win` is its window on the desk
 * (__ruyixDesk), when it is one; `ofTitle` with an add names the work it belongs to. → the next state
 */
export function applyOpen(state, change, now = Date.now()) {
  const s = { ...state, items: [...state.items], closed: [...state.closed], rules: [...state.rules], pins: [...(state.pins || [])], titles: { ...(state.titles || {}) } }
  const at = id => s.items.findIndex(x => x.id === id)
  const { op } = change || {}
  if (op === 'add') {
    const it = itemOf(change.item, now), i = at(it.id)
    if (it.of && change.item.ofTitle && !s.titles[it.of]) s.titles[it.of] = text(change.item.ofTitle, 120)
    // (added again: as it is now — the work it belongs to too, which may have changed or gone: the agents' browser's)
    if (i >= 0) { const { of: _was, bg: _bg, names: _names, ...prev } = s.items[i]; s.items[i] = { ...prev, ...it, openedAt: prev.openedAt, group: prev.group, folded: false } }
    else { s.items.push(it); s.closed = s.closed.filter(x => x.id !== it.id) }
    if (s.items.length > MAX_ITEMS) s.items = s.items.sort((a, b) => b.usedAt - a.usedAt).slice(0, MAX_ITEMS)
  } else if (op === 'rename') {
    const i = at(change.id), was = s.items[i]
    if (i < 0) return state
    const title = change.title ? text(change.title, 120) : was.title, names = namesOf(change.names) || was.names
    if (title === was.title && JSON.stringify(names) === JSON.stringify(was.names)) return state
    s.items[i] = { ...was, title, ...(names && { names }) }
  } else if (op === 'use' || op === 'fold') {
    const i = at(change.id)
    if (i < 0) return state
    s.items[i] = { ...s.items[i], ...(op === 'use' ? { usedAt: now, folded: false } : { folded: !!change.folded }) }
  } else if (op === 'foldGroup') {
    s.items = s.items.map(x => (groupOf(x, s.rules) === change.key ? { ...x, folded: !!change.folded } : x))
  } else if (op === 'title') {
    if (!OF.test(String(change.key || '')) || !change.title) throw fail('badGroup', "title: { key: 'run:…' | 'session:…' | 'task:…', title }")
    if (s.titles[change.key] === text(change.title, 120)) return state
    s.titles[change.key] = text(change.title, 120)
  } else if (op === 'pin') {
    if (!GROUP.test(String(change.key || ''))) throw fail('badGroup', 'pin: { key: a group }')
    s.pins = s.pins.filter(k => k !== change.key)
    if (change.pinned) s.pins = [change.key, ...s.pins].slice(0, 50)
  } else if (op === 'close') {
    const i = at(change.id)
    if (i < 0) return state
    const [it] = s.items.splice(i, 1)
    s.closed = [{ ...it, closedAt: now }, ...s.closed.filter(x => x.id !== it.id)].slice(0, MAX_CLOSED)
  } else if (op === 'forget') {
    const i = at(change.id), wasClosed = s.closed.some(x => x.id === change.id)
    if (i < 0 && !wasClosed) return state
    if (i >= 0) s.items.splice(i, 1)
    if (wasClosed) s.closed = s.closed.filter(x => x.id !== change.id)
  } else if (op === 'reopen') {
    const it = s.closed.find(x => x.id === change.id)
    if (!it) return state
    s.closed = s.closed.filter(x => x.id !== it.id)
    const { closedAt, ...back } = it
    s.items.push({ ...back, usedAt: now, folded: false })
  } else if (op === 'move') {
    const i = at(change.id)
    if (i < 0) return state
    const group = change.group || null
    if (group && !GROUP.test(group)) throw fail('badGroup', "a group is 'run:…' | 'session:…' | 'task:…' | 'g:<name>' | 'kind:<kind>'")
    const it = s.items[i], like = likeOf(it)
    // (back where it would go by itself: no group of its own, no rule)
    const own = group && group !== it.of && group !== `kind:${it.kind}` ? group : null
    s.items[i] = { ...it, group: own }
    s.rules = s.rules.filter(r => r.like !== like)
    if (own && !it.of) s.rules = [{ like, group: own, at: now }, ...s.rules].slice(0, MAX_RULES)
  } else throw fail('badOpen', `no op ${op}`)
  // (names kept only for the work something open or lately closed belongs to)
  const used = new Set([...s.items, ...s.closed].map(x => x.of).filter(Boolean))
  for (const k of Object.keys(s.titles)) if (!used.has(k)) delete s.titles[k]
  s.rev = (state.rev || 0) + 1
  return s
}
