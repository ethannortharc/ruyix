// What an agent may change in this Ruyix — its surfaces: the sidebar's order and hidden entries, this Ruyix's name and
// colour, the theme's colours, personal boards — and the journal of every change (<RUYIX_HOME>/changes/<id>.json). A change set keeps each
// file's text before and after: applying checks every file is still as it was before (nothing moved under it),
// undoing checks it is still as the change left it and writes "before" back. Nothing here writes outside these files,
// and only a person applies a change, on Ruyix's page: the card of changes waiting (wherever the agent was asked — the
// assistant, the Chat page, a dsh session, a CLI agent) or Settings → Changes. `ruyix changes` (for a page hard to use) only
// goes back — undo, restore — to what the person applied before. An agent proposes; its undo is a proposal too (the
// change's reverse), applied the same way. The boundary is the agent's tools: an agent whose shell may write the user's
// home (dsh's full access, a sandbox whose writable roots hold RUYIX_HOME) can write these files, as any file of the
// user's — confining that is dsh's sandbox's part, not this journal's.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { DATASETS } from '@ruyix/board/presets'
import { refOf, satisfies, validateDashboard, validateDataset } from '@ruyix/board/schema'
import { withLock } from './lock.js'
import { commit as commitFiles } from './commit.js'
import { DESKTOP_DEFAULT, THEMES, checkDesktop, desktopCss, desktopKeys, themePatch } from './desktop.js'

const MAX_BYTES = 512 << 10, KEEP = 200, MAX_PENDING = 20, PENDING_BYTES = 2 << 20
const ID = /^c[0-9a-z]{8,24}$/, ENTRY = /^[\w.:-]{1,80}$/, HEX = /^#[0-9a-f]{6}$/i
const fail = (code, message) => Object.assign(new Error(message), { code })
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)

// ── the theme: the colour tokens tokens.css names (not its corner radii), with what each is for ──
const TOKEN_CSS = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
export const TOKENS = Object.fromEntries([...TOKEN_CSS.matchAll(/^[ \t]*(--ruyix-[a-z0-9-]+)[ \t]*:[ \t]*([^;]+);[ \t]*(?:\/\*[ \t]*(.*?)[ \t]*\*\/)?/gm)]
  .filter(m => !m[1].startsWith('--ruyix-radius')).map(m => [m[1], { value: m[2].trim(), note: m[3] || '' }]))
// a colour and nothing else (no url(), no var(), no ";" or "}"): what a theme writes into the page's CSS
// each function's own grammar (CSS Color 4): legacy commas, or spaces with "/ alpha"; a hue may say deg
const NUM = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)', PCT = `${NUM}%`, NP = `${NUM}%?`, HUE = `${NUM}(?:deg)?`
const fn = (names, a, b, c) => `(?:${names})\\(\\s*${a}\\s*,\\s*${b}\\s*,\\s*${c}\\s*(?:,\\s*${NP}\\s*)?\\)|(?:${names})\\(\\s*${a}\\s+${b}\\s+${c}\\s*(?:\\/\\s*${NP}\\s*)?\\)`
const space = (names, a, b, c) => `(?:${names})\\(\\s*${a}\\s+${b}\\s+${c}\\s*(?:\\/\\s*${NP}\\s*)?\\)`
const legacy = (names, a, b, c) => `(?:${names})\\(\\s*${a}\\s*,\\s*${b}\\s*,\\s*${c}\\s*(?:,\\s*${NP}\\s*)?\\)`
const COLOR = new RegExp(`^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|${legacy('rgba?', NUM, NUM, NUM)}|${legacy('rgba?', PCT, PCT, PCT)}|${space('rgba?', NP, NP, NP)}|${fn('hsla?', HUE, PCT, PCT)}|${space('oklch', NP, NP, HUE)}|${space('oklab', NP, NP, NP)})$`, 'i')
// text against what it sits on: WCAG's 4.5:1, checked where both are plain #hex (light and dark each)
// what is drawn on what: the words and the states' colours on the page's grounds; a row (hovered, selected) carries a title,
// text and the accent; a warning's soft ground carries text and the warning
const PAGE_TEXT = ['--ruyix-title', '--ruyix-text', '--ruyix-text-muted', '--ruyix-text-dim', '--ruyix-accent', '--ruyix-highlight', '--ruyix-success', '--ruyix-warning', '--ruyix-danger']
const ON = { '--ruyix-surface': PAGE_TEXT, '--ruyix-canvas': PAGE_TEXT, '--ruyix-surface-sunk': PAGE_TEXT, '--ruyix-chrome': PAGE_TEXT,
  '--ruyix-hover': ['--ruyix-title', '--ruyix-text', '--ruyix-accent'], '--ruyix-selection': ['--ruyix-title', '--ruyix-text', '--ruyix-accent'],
  '--ruyix-warning-soft': ['--ruyix-title', '--ruyix-text', '--ruyix-warning'] }
const TEXT = PAGE_TEXT, GROUND = Object.keys(ON)
const rgb = h => { let s = h.slice(1); if (s.length === 3) s = [...s].map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255) }
const lum = h => { const [r, g, b] = rgb(h).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const pair = v => (Array.isArray(v) ? v : [v, v])
const defaultPair = name => { const m = /^light-dark\(\s*(#[0-9a-f]{3,6})\s*,\s*(#[0-9a-f]{3,6})\s*\)$/i.exec(TOKENS[name]?.value || ''); return m ? [m[1], m[2]] : [null, null] }
const plainHex = v => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v || '')

function checkTheme(t) {
  if (!plain(t)) throw fail('badTheme', 'a theme is { name, tokens: { "--ruyix-…": "#hex" | ["#light", "#dark"] } }')
  const extra = Object.keys(t).filter(k => !['name', 'tokens'].includes(k))
  if (extra.length) throw fail('badTheme', `a theme has only name and tokens (not ${extra.join(', ')})`)
  if (t.name !== undefined && (typeof t.name !== 'string' || t.name.length > 60 || /[\u0000-\u001f]/.test(t.name))) throw fail('badTheme', 'the name is up to 60 characters')
  if (!plain(t.tokens) || !Object.keys(t.tokens).length) throw fail('badTheme', 'tokens: at least one --ruyix-… colour')
  for (const [name, v] of Object.entries(t.tokens)) {
    if (!TOKENS[name]) throw fail('badTheme', `no token ${name} (see ruyix_surfaces for the names)`)
    const both = pair(v)
    if (both.length !== 2 || both.some(c => typeof c !== 'string' || !COLOR.test(c.trim()))) throw fail('badTheme', `${name}: a colour (#hex, rgb(), hsl(), oklch()), or [light, dark]`)
  }
  // text and what it sits on: plain #hex (no alpha, no other syntax), so their contrast is always checked
  for (const n of [...TEXT, ...GROUND]) if (t.tokens[n] && pair(t.tokens[n]).some(c => !plainHex(c.trim()))) throw fail('badTheme', `${n}: #rrggbb (the words, the states' colours and their grounds are checked for contrast)`)
  // only where the theme changes one side of the pair: the defaults are not this theme's to answer for. The selection's
  // ground is derived (tokens.css: 12% of the accent over the surface) unless the theme sets it: worked out from this theme's
  const eff = (n, mode) => (t.tokens[n] ? pair(t.tokens[n])[mode].trim() : defaultPair(n)[mode])
  const mix = (a, b, p) => (plainHex(a) && plainHex(b) ? `#${rgb(a).map((x, i) => Math.round((x * p + rgb(b)[i] * (1 - p)) * 255).toString(16).padStart(2, '0')).join('')}` : null)
  const derived = g => g === '--ruyix-selection' && !t.tokens[g]
  const ground = (g, mode) => (derived(g) ? mix(eff('--ruyix-accent', mode), eff('--ruyix-surface', mode), 0.12) : eff(g, mode))
  const touched = g => !!t.tokens[g] || (derived(g) && !!(t.tokens['--ruyix-accent'] || t.tokens['--ruyix-surface']))
  // the highlight's default is dsh's brand colour (dsh's theme's, not one ruyix can read): a theme that changes a ground it
  // is drawn on says the highlight too, so the pair is checked
  const under = GROUND.filter(g => ON[g].includes('--ruyix-highlight') && t.tokens[g])
  if (under.length && !t.tokens['--ruyix-highlight']) throw fail('badTheme', `--ruyix-highlight too: it is drawn on ${under.join(', ')}, and its default (dsh's brand colour) cannot be checked against them`)
  for (const mode of [0, 1]) for (const bg of GROUND) for (const fg of ON[bg]) {
    if (!t.tokens[fg] && !touched(bg)) continue
    const a = eff(fg, mode), b = ground(bg, mode)
    if (plainHex(a?.trim()) && plainHex(b?.trim()) && contrast(a.trim(), b.trim()) < 4.5) throw fail('lowContrast', `${fg} on ${bg} (${mode ? 'dark' : 'light'}): ${contrast(a, b).toFixed(2)}:1, at least 4.5:1`)
  }
  return t
}
/** The page's CSS for a theme: its colours over every plugin's tokens (theirs are :where(body), this is body). */
export const themeCss = t => (t?.tokens ? `body { ${Object.entries(t.tokens).map(([n, v]) => `${n}: ${Array.isArray(v) ? `light-dark(${v[0].trim()}, ${v[1].trim()})` : v.trim()};`).join(' ')} }` : '')

// ── the layout: the sidebar (nav) and who this Ruyix is (identity); its preset and plugins stay the Settings page's ──
function checkLayout(l, known, was) {
  if (!plain(l)) throw fail('badLayout', 'the layout is an object')
  if (l.nav !== undefined) {
    if (!plain(l.nav)) throw fail('badLayout', 'nav is { order: [entry ids], hidden: [entry ids] }')
    const extra = Object.keys(l.nav).filter(k => !['order', 'hidden'].includes(k))
    if (extra.length) throw fail('badLayout', `nav has only order and hidden (not ${extra.join(', ')})`)
    for (const k of ['order', 'hidden']) {
      const ids = l.nav[k]
      if (ids === undefined) continue
      if (!Array.isArray(ids) || ids.length > 100 || ids.some(x => !ENTRY.test(String(x))) || new Set(ids).size !== ids.length) throw fail('badLayout', `nav.${k}: up to 100 different sidebar entry ids`)
      const unknown = known?.length ? ids.filter(x => !known.includes(x) && !was?.nav?.[k]?.includes(x)) : [] // one kept as it was may belong to a plugin off for now
      if (unknown.length) throw fail('badLayout', `nav.${k}: no sidebar entry ${unknown.join(', ')} (ruyix_surfaces lists them)`)
    }
  }
  if (l.identity !== undefined) {
    const id = l.identity
    if (!plain(id) || Object.keys(id).some(k => !['name', 'color'].includes(k))) throw fail('badLayout', 'identity is { name, color }')
    if (id.name !== undefined && (typeof id.name !== 'string' || id.name.length > 40 || /[\u0000-\u001f]/.test(id.name))) throw fail('badLayout', 'identity.name is up to 40 characters')
    if (id.color !== undefined && !HEX.test(String(id.color))) throw fail('badLayout', 'identity.color is #rrggbb')
  }
  return l
}

// ── personal boards: a dashboard of its own over built-in datasets and datasets of its own (my-…), each through a
// connection of this Ruyix (a Boards page runs and draws them) — checked before it is kept ──
export const MINE = /^my-[a-z0-9]+(?:-[a-z0-9]+)*$/ // no "--" in a board's id: its datasets' names are "<id>--…"
const mineId = x => MINE.test(String(x || '')) && String(x).length <= 40
function checkBoard(v, id) {
  if (!plain(v) || !plain(v.dashboard)) throw fail('badBoard', 'a board is { dashboard, datasets: { "<board id>--<name>": dataset } }')
  const extra = Object.keys(v).filter(k => !['dashboard', 'datasets'].includes(k))
  if (extra.length) throw fail('badBoard', `a board has only dashboard and datasets (not ${extra.join(', ')})`)
  const own = v.datasets ?? {}, problems = []
  if (!plain(own)) throw fail('badBoard', 'datasets: { "<board id>--<name>": dataset }')
  for (const [n, d] of Object.entries(own)) {
    // named after its board — "<board id>--<name>" (no board id has "--"): two boards never share one (its
    // definition, its snapshots, its connection)
    if (d?.name !== n || !new RegExp(`^${id}--[a-z0-9]+(?:-[a-z0-9]+)*$`).test(n) || n.length > 49) problems.push(`datasets.${n}: a board's own dataset is named "${id}--<name>" (its key and its name, up to 49 characters)`)
    if (d?.connector === undefined) problems.push(`datasets.${n}: reads through a connector (connector + op)`)
    // a setting it takes is a plain path ({{settings.app.project}}): never one that reaches into an object's machinery
    for (const m of JSON.stringify(d?.params ?? {}).matchAll(/\{\{\s*settings\.([^}\s]*)\s*\}\}/g)) {
      if (m[1].split('.').some(seg => !/^[a-z0-9_]{1,40}$/i.test(seg) || ['__proto__', 'constructor', 'prototype'].includes(seg))) problems.push(`datasets.${n}.params: {{settings.${m[1]}}} is not a plain setting path`)
    }
    for (const e of validateDataset(d).errors) problems.push(`datasets.${n}.${e.path}: ${e.message}`)
  }
  const b = v.dashboard
  if (b.name !== id) problems.push(`dashboard.name: "${id}" (the board's id)`)
  if (!plain(b.datasets)) problems.push('dashboard.datasets: { alias: "<dataset>@*" }')
  ;(Array.isArray(b.pages) ? b.pages : []).forEach((pg, i) => { if (!Array.isArray(pg?.widgets) || !pg.widgets.length) problems.push(`dashboard.pages.${i}.widgets: at least one widget`) })
  for (const [a, ref] of Object.entries(plain(b.datasets) ? b.datasets : {})) {
    const { name: n, range } = refOf(ref), has = Object.hasOwn(own, n) ? own[n] : Object.hasOwn(DATASETS, n) ? DATASETS[n] : null
    if (has && !satisfies(String(has.version || ''), range)) problems.push(`dashboard.datasets.${a}: ${n}@${range} does not resolve (it is ${has.version}): use "${n}@*"`)
    if (!has) problems.push(`dashboard.datasets.${a}: ${n} is neither this board's own dataset nor a built-in one (${Object.keys(DATASETS).join(', ')})`)
  }
  for (const e of validateDashboard(b, { datasets: { ...DATASETS, ...own } }).errors) problems.push(`dashboard.${e.path}: ${e.message}`)
  if (problems.length) throw fail('badBoard', problems.slice(0, 12).join('; '))
  return v
}

const parse = (text, what) => { if (text == null) return undefined; try { return JSON.parse(text) } catch { throw fail('badFile', `${what} is not JSON now: fix or remove it first`) } }
const json = v => `${JSON.stringify(v, null, 2)}\n`

/**
 * The surfaces: where each lives, and how a value given for it becomes the file's next text (checked; null: none).
 * `known` is what the page last said its sidebar entries are (their ids), for a change proposed now.
 */
export const SURFACES = {
  layout: {
    file: () => 'layout.json',
    // the keys given replace those keys (null removes one); everything else of the layout stays as it is
    next(text, value, known) {
      if (!plain(value) || !Object.keys(value).length) throw fail('badLayout', 'give { nav } and/or { identity } (null removes one)')
      const extra = Object.keys(value).filter(k => !['nav', 'identity'].includes(k))
      if (extra.length) throw fail('badLayout', `only nav and identity change here (not ${extra.join(', ')}): the preset and the plugins are the Settings page's`)
      const was = parse(text, 'layout.json') || {}, l = { ...was }
      for (const [k, v] of Object.entries(value)) { if (v === null) delete l[k]; else l[k] = v }
      return json(checkLayout(l, known, was))
    },
    check: text => checkLayout(parse(text, 'layout.json') || {}),
  },
  theme: {
    file: () => 'theme.json',
    // the whole theme (null: back to Ruyix's own colours)
    next: (_text, value) => (value === null ? null : json(checkTheme(value))),
    check: text => (text == null ? null : checkTheme(parse(text, 'theme.json'))),
  },
  desktop: {
    file: () => 'desktop.json',
    // the keys given replace those keys (a key null: its default); null: back to the defaults
    next(text, value) {
      if (value === null) return null
      if (!plain(value) || !Object.keys(value).length) throw fail('badDesktop', `give some of { ${Object.keys(DESKTOP_DEFAULT).join(', ')} } (null: the defaults)`)
      const d = { ...parse(text, 'desktop.json'), ...value }
      for (const k of Object.keys(d)) if (d[k] === null) delete d[k]
      return json(checkDesktop(d))
    },
    check: text => (text == null ? null : checkDesktop(parse(text, 'desktop.json'))),
  },
  boards: {
    // one board per id (my-…); null removes it
    file: id => { if (!mineId(id)) throw fail('badBoard', 'a board\'s id is my-… (lowercase letters and digits, single dashes, up to 40)'); return `boards/${id}.json` },
    next: (_text, value, _known, id) => (value === null ? null : json(checkBoard(value, id))),
    check: (text, id) => (text == null ? null : checkBoard(parse(text, `boards/${id}.json`), id)),
  },
}
/** The surface a file is (and the board it is, for boards/<id>.json), or null. */
const surfaceOf = path => (path === 'layout.json' ? { s: SURFACES.layout } : path === 'theme.json' ? { s: SURFACES.theme } : path === 'desktop.json' ? { s: SURFACES.desktop }
  : /^boards\/my-[a-z0-9-]+\.json$/.test(path) && mineId(path.slice(7, -5)) ? { s: SURFACES.boards, id: path.slice(7, -5) } : null)
/** The personal boards there are (their ids). */
export const boardsIn = home => { try { return readdirSync(join(home, 'boards')).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).filter(mineId).sort() } catch { return [] } }

// ── files ──
const readText = f => { try { return readFileSync(f, 'utf8') } catch (err) { if (err.code === 'ENOENT') return null; throw err } } // absent only when it is

// ── what a change does, as a person reads it ──
/** Where two values differ: the paths into objects, an array or a scalar as a whole. */
export function diff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return []
  const at = k => (path ? `${path}.${k}` : String(k))
  // an object that comes or goes is shown key by key, as if from (or to) an empty one
  if ((plain(a) || a === undefined) && (plain(b) || b === undefined)) { a ||= {}; b ||= {}; return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => diff(a[k], b[k], at(k))) }
  // a list of objects (a board's pages, its widgets) item by item; a list of names stays whole
  const items = v => Array.isArray(v) && v.some(x => plain(x))
  if ((items(a) || items(b)) && (Array.isArray(a) || a === undefined) && (Array.isArray(b) || b === undefined)) { a ||= []; b ||= []; return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => diff(a[i], b[i], at(i))).flat() }
  return [{ path, from: a, to: b }]
}
// a person reads it: a list of names as names, a sidebar entry by its label
const shown = (v, label = x => x) => (v === undefined || (Array.isArray(v) && !v.length) ? '—' : Array.isArray(v) && v.every(x => typeof x === 'string') ? v.map(label).join(', ') : JSON.stringify(v))
const loose = text => { if (text == null) return undefined; try { return JSON.parse(text) } catch { return '(not JSON)' } } // a broken file can still be replaced
// a board as one line: its title, how many widgets, which datasets
const boardLine = v => (plain(v?.dashboard) ? `${v.dashboard.title?.zh || v.dashboard.title?.en || v.dashboard.name} · ${(v.dashboard.pages || []).reduce((n, p) => n + (p?.widgets?.length || 0), 0)} widgets · ${Object.values(v.dashboard.datasets || {}).map(r => String(r).split('@')[0]).join(', ')}` : '—')
const linesOf = (c, label) => c.files.flatMap(f => {
  if (f.path.startsWith('boards/')) {
    // its summary first, then everything it changes — what the person applies is all of it, seen
    const id = f.path.slice(7, -5), b0 = loose(f.before), b1 = loose(f.after)
    return [`board ${id}: ${boardLine(b0)} → ${boardLine(b1)}`, ...diff(b0, b1).map(x => `board ${id}.${x.path}: ${shown(x.from)} → ${shown(x.to)}`)]
  }
  const d = diff(loose(f.before), loose(f.after))
  return d.map(x => { const l = x.path.startsWith('nav.') ? label : undefined; return `${f.path.replace(/\.json$/, '')}${x.path ? `.${x.path}` : ''}: ${shown(x.from, l)} → ${shown(x.to, l)}` })
})
/** The theme's colours a change sets: [token, light, dark] — the page draws them as swatches. */
const coloursOf = c => { const t = loose(c.files.find(f => f.path === 'theme.json')?.after); return plain(t?.tokens) ? Object.entries(t.tokens).slice(0, 16).map(([n, v]) => [n, ...pair(v)]) : [] }
/** A change as a list or the page's poll carries it: no diff (a change's diff is fetched whole, by its id). */
const lightOf = c => ({ id: c.id, at: c.at, by: c.by || '', summary: c.summary, state: c.state, files: c.files.map(f => f.path), lines: c.files.length,
  ...(c.undoes && { undoes: c.undoes }), ...(c.seq && { seq: c.seq }), ...(c.appliedAt && { appliedAt: c.appliedAt }), ...(c.state === 'undone' && { undoneAt: c.undoneAt, undoneWith: c.undoneWith || '' }) })
/** What a person reviewing a change saw, as one value: Apply sends it back, and only that change is applied. */
export const digestOf = c => createHash('sha256').update(JSON.stringify(c.files)).digest('hex')
const viewOf = (c, label = x => x) => ({ digest: digestOf(c), id: c.id, at: c.at, by: c.by || '', summary: c.summary, state: c.state, files: c.files.map(f => f.path), diff: linesOf(c, label), colours: coloursOf(c),
  ...(c.undoes && { undoes: c.undoes }), ...(c.seq && { seq: c.seq }), ...(c.appliedAt && { appliedAt: c.appliedAt, appliedBy: c.appliedBy || '' }), ...(c.state === 'undone' && { undoneAt: c.undoneAt, undoneBy: c.undoneBy || '', undoneWith: c.undoneWith || '' }) })

/**
 * The journal of this Ruyix's changes (home: RUYIX_HOME). `entries()`: the sidebar's entry ids the page last reported.
 *
 * Every change applied — an agent's, the person's, an undo, a restore — gets the next number of one sequence and stays
 * in the journal: the files as they are now are the result of those changes, in that order. An undo is a change too
 * (the reverse of one, `undoes: [its id]`); a change it reverses reads "undone", and comes back to "applied" when the
 * undo itself is undone. A restore to before a change reverses it and every change after it, newest first, as one change.
 * Every write holds the lock (lock.js) — this dsh, `ruyix changes` and the layout's own writers take turns — and goes
 * through a commit log: the files' texts before it are kept first, so a write cut short (an error, a crash) is put back
 * whole, then or at the next write.
 */
export function createChanges({ home, entries = () => [], now = Date.now, beforeWrite = null }) { // beforeWrite: a check's seam (a save between the look and the write)
  const dir = join(home, 'changes'), at = p => join(home, p), LOG = 'changes/.commit.json', SEQ = 'changes/.seq'
  let goodDesktop = null // the desktop as it last was right (pageNow)
  const fileOf = id => `changes/${id}.json`
  const load = id => {
    const t = ID.test(String(id || '')) ? readText(at(fileOf(id))) : null
    if (!t) throw fail('noChange', `no change ${id}`)
    return JSON.parse(t)
  }
  const ids = () => { try { return readdirSync(dir).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).filter(x => ID.test(x)).sort() } catch { return [] } }
  const all = () => ids().map(id => { try { return load(id) } catch { return null } }).filter(Boolean)
  const label = id => entries().find(e => e.id === id)?.label || id
  const view = c => viewOf(c, label)
  const by = (x = '') => String(x).slice(0, 120)

  // ── writing: one commit at a time, whole or not at all, never over a revision saved meanwhile (commit.js) ──
  const commit = writes => commitFiles(home, writes, beforeWrite)
  const locked = fn => withLock(home, fn) // taking it finishes a commit a crash cut short (lock.js)
  /** Before a read: a commit a crash cut short (here or in another process) is finished first — never read half done. */
  const settle = async () => { if (existsSync(at(LOG))) await withLock(home, () => {}) }
  const nextSeq = () => (Number(readText(at(SEQ))) || 0) + 1
  const record = c => [fileOf(c.id), json(c)]

  // ── what an undo or a restore writes ──
  /** Refused where reversing would bring back what an undo took away (a reversal that passes over an undo). */
  const noRedo = r => { const u = r.undone.find(c => c.undoes?.length); if (u) throw fail('redo', `"${u.summary}" is an undo: bringing back what it took away is the person's, on the page (Settings → Changes)`) }
  /** The changes in the order they were applied (each has its `seq`). */
  const chain = () => all().filter(c => c.seq).sort((a, b) => a.seq - b.seq)
  /**
   * Reversing a change (restore: it and every change applied after it, newest first): the files as they come out, each
   * checked to be as the change left it — one moved outside these changes: refused.
   */
  const reversal = (id, restore) => {
    const target = load(id)
    if (target.state !== 'applied') throw fail('notApplied', `change ${id} is ${target.state}`)
    const undone = restore ? chain().filter(c => c.seq >= target.seq).reverse() : [target]
    // one change undone alone: no later change in effect may have touched its files, whatever their bytes say now
    if (!restore) {
      const paths = new Set(target.files.map(f => f.path)), later = chain().find(c => c.seq > target.seq && c.state === 'applied' && c.files.some(f => paths.has(f.path)))
      if (later) throw fail('moved', `a later change (${later.summary}) touched the same file: undo that first, or restore to here`)
    }
    const next = new Map(), was = new Map(), cur = p => (next.has(p) ? next.get(p) : readText(at(p)))
    for (const c of undone) for (const f of c.files) {
      if (cur(f.path) !== f.after) throw fail('moved', restore ? `${f.path} changed outside these changes: undo by hand, or propose the old values as a new change` : `${f.path} changed after this change (a later one?): undo that first, or restore to here`)
      if (!was.has(f.path)) was.set(f.path, readText(at(f.path)))
      next.set(f.path, f.before)
    }
    return { target, undone, files: [...next].map(([path, after]) => ({ path, before: was.get(path), after })).filter(f => f.after !== f.before) }
  }
  const newChange = (summary, files, who, extra = {}) => {
    if (!extra.undoes && files.some(f => Buffer.byteLength(f.after || '') > MAX_BYTES)) throw fail('badChange', 'a file over 512 KB') // a reversal's bytes were there
    return { id: `c${now().toString(36)}${randomBytes(3).toString('hex')}`, at: now(), by: by(who), summary, state: 'proposed', files, ...extra }
  }
  const undoSummary = (r, restore, summary) => String(summary || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 200) || `${restore ? '⟲' : '↶'} ${r.target.summary}`.slice(0, 200)
  /**
   * Proposals: at most 20 wait at once; past 200 records the oldest discarded ones go — never one waiting, never an
   * applied one (they are how the files came to be).
   */
  const roomFor = adding => {
    const known = all()
    const waiting = known.filter(c => c.state === 'proposed')
    if (waiting.length >= MAX_PENDING) throw fail('tooMany', `${MAX_PENDING} changes already wait for the person: they apply or discard some first`)
    if (waiting.reduce((n, c) => n + c.files.reduce((m, f) => m + Buffer.byteLength(f.after || '') + Buffer.byteLength(f.before || ''), 0), 0) + (adding || 0) > PENDING_BYTES) throw fail('tooBig', 'the changes waiting are too big together (2 MB): the person applies or discards some first')
    const spare = known.filter(c => c.state === 'discarded').sort((a, b) => a.at - b.at)
    return spare.slice(0, Math.max(0, known.length + 1 - KEEP)).map(c => [fileOf(c.id), null])
  }
  /** Apply c (proposed): its files, its record, and the records it undoes (or brings back), as one commit. */
  const applyNow = (c, who) => {
    // a new value is checked; a reversal (an undo, a restore) puts back bytes that were there, checked only for where they go
    for (const f of c.files) { const x = surfaceOf(f.path); if (!x) throw fail('badChange', `${f.path} is no surface`); if (!c.undoes) x.s.check(f.after, x.id) }
    const moved = c.files.filter(f => readText(at(f.path)) !== f.before)
    if (moved.length) throw fail('stale', `${moved.map(f => f.path).join(', ')} changed since this change was proposed: propose it again`)
    // a reversal proposed earlier: worked out again now — the changes it reverses still in effect, the same files to write
    if (c.undoes && c.target) {
      let again = null
      try { again = reversal(c.target, !!c.restore) } catch { /* its target undone meanwhile, or moved */ }
      const same = again && JSON.stringify(again.files) === JSON.stringify(c.files) && JSON.stringify(again.undone.map(x => x.id)) === JSON.stringify(c.undoes)
      if (!same) throw fail('stale', 'what this undo reverses has changed since it was proposed: propose it again')
    }
    const seq = nextSeq(), when = now()
    Object.assign(c, { state: 'applied', seq, appliedAt: when, appliedBy: by(who), activeAt: when })
    // every applied change reads applied or undone from the chain, newest first: a change is undone while a later
    // undo (or restore) that reverses it is itself still in effect — however deep undos of undos go
    const recs = new Map([...chain().filter(x => x.id !== c.id), c].map(x => [x.id, x])), order = [...recs.values()].sort((a, b) => b.seq - a.seq)
    const active = new Map(), touched = new Map([[c.id, c]])
    for (const x of order) {
      const by0 = order.find(u => u.seq > x.seq && active.get(u.id) && (u.undoes || []).includes(x.id))
      active.set(x.id, !by0)
      const state = by0 ? 'undone' : 'applied'
      if (x.state !== state || (by0 && x.undoneWith !== by0.id)) {
        Object.assign(x, by0 ? { state, undoneAt: when, undoneBy: by(who), undoneWith: by0.id, activeAt: when } : { state, undoneAt: undefined, undoneBy: undefined, undoneWith: undefined, activeAt: when })
        touched.set(x.id, x)
      }
    }
    commit([...c.files.map(f => [f.path, f.after, f.before]), ...[...touched.values()].map(record), [SEQ, String(seq)]])
    return view(c)
  }

  return {
    /** A change set from edits ({ surface, id?, value }), every one checked; nothing is written but the journal entry. */
    propose: ({ summary, edits, by: who = '' }) => locked(() => {
      summary = String(summary || '').replace(/[\u0000-\u001f]+/g, ' ').trim()
      if (!summary || summary.length > 200) throw fail('badChange', 'a summary of up to 200 characters: what the change does, in the person\'s words')
      if (!Array.isArray(edits) || !edits.length || edits.length > 20) throw fail('badChange', 'edits: 1 to 20 of { surface, value }')
      const files = new Map(), problems = []
      edits.forEach((e, i) => {
        const sf = Object.hasOwn(SURFACES, e?.surface) ? SURFACES[e.surface] : null
        if (!sf) return problems.push(`edit ${i + 1}: no surface "${e?.surface}" (${Object.keys(SURFACES).join(', ')})`)
        try {
          const path = sf.file(e.id), f = files.get(path) || { before: readText(at(path)) }
          f.after = sf.next(f.after !== undefined ? f.after : f.before, e.value, entries().map(x => x.id), e.id)
          files.set(path, f)
        } catch (err) { problems.push(`edit ${i + 1} (${e.surface}): ${err.message}`) }
      })
      if (problems.length) throw fail('invalid', problems.join('\n'))
      const changed = [...files].filter(([, f]) => f.after !== f.before).map(([path, f]) => ({ path, before: f.before, after: f.after }))
      if (!changed.length) throw fail('noChange', 'nothing would change: that is how it is already')
      const drop = roomFor(changed.reduce((n, f) => n + Buffer.byteLength(f.after || '') + Buffer.byteLength(f.before || ''), 0)), c = newChange(summary, changed, who)
      commit([...drop, record(c)])
      return view(c)
    }),
    /** An agent's undo: the reverse of an applied change (restore: of it and all after it), proposed like any change. */
    proposeUndo: (id, { restore = false, summary = '', by: who = '' } = {}) => locked(() => {
      const r = reversal(id, restore)
      if (!r.files.length) throw fail('noChange', 'nothing would change: that is how it is already')
      const drop = roomFor(r.files.reduce((n, f) => n + Buffer.byteLength(f.after || '') + Buffer.byteLength(f.before || ''), 0)), c = newChange(undoSummary(r, restore, summary), r.files, who, { undoes: r.undone.map(x => x.id), target: id, restore: !!restore })
      commit([...drop, record(c)])
      return view(c)
    }),
    /** Write a proposed change: checked again, and only over files still as it found them. */
    apply: (id, { by: who = '', digest } = {}) => locked(() => {
      const c = load(id)
      if (c.state !== 'proposed') throw fail('notProposed', `change ${id} is ${c.state}`)
      // what the person reviewed (its digest, from the change's whole view) is what is applied, or nothing is
      if (digest !== digestOf(c)) throw fail('stale', 'this change is not the one reviewed: look at it again')
      return applyNow(c, who)
    }),
    /**
     * The person's undo (and `ruyix changes undo`): the reverse of an applied change, applied at once — itself a change.
     * `redo: false` (a shell, which an agent may hold): never the reverse of an undo — that would bring back what the
     * person took away; that is theirs to apply again on the page.
     */
    undo: (id, { by: who = '', redo = true } = {}) => locked(() => {
      const r = reversal(id, false)
      if (!redo) noRedo(r)
      applyNow(newChange(undoSummary(r, false), r.files, who, { undoes: [r.target.id], target: id, restore: false }), who)
      return view(load(id))
    }),
    /** The person's way back to before a change: it and every change applied after it reversed, as one change. */
    restore: (id, { by: who = '', redo = true } = {}) => locked(() => {
      const r = reversal(id, true)
      if (!redo) noRedo(r)
      applyNow(newChange(undoSummary(r, true), r.files, who, { undoes: r.undone.map(x => x.id), target: id, restore: true }), who)
      return { undone: r.undone.map(x => x.id) }
    }),
    discard: id => locked(() => {
      const c = load(id)
      if (c.state !== 'proposed') throw fail('notProposed', `change ${id} is ${c.state}`)
      Object.assign(c, { state: 'discarded', activeAt: now() })
      commit([record(c)])
      return view(c)
    }),
    settle,
    get: id => withLock(home, () => view(load(id))),
    // every change still waiting, then the latest others
    list: ({ limit = 50 } = {}) => withLock(home, () => { const when = c => c.activeAt || c.at || 0; const known = all().sort((a, b) => when(b) - when(a) || (b.seq || 0) - (a.seq || 0)); return [...known.filter(c => c.state === 'proposed'), ...known.filter(c => c.state !== 'proposed').slice(0, limit)].map(lightOf) }),
    /** The change applied last that is still applied (what `ruyix changes undo` undoes). */
    last: () => withLock(home, () => chain().filter(c => c.state === 'applied').at(-1)?.id || null),
    /** What a page polls: it moves when a surface's file does (a change, the Settings page, a hand edit) or the journal. */
    version: async () => { await settle(); return [at('layout.json'), at('theme.json'), at('desktop.json'), at('boards'), ...boardsIn(home).map(b => at(`boards/${b}.json`)), dir].map(f => { try { return statSync(f).mtimeMs } catch { return 0 } }).join(':') },
    /** The changes waiting for the person, newest first (the page's card). */
    pending: () => withLock(home, () => all().filter(c => c.state === 'proposed').sort((a, b) => b.at - a.at).map(lightOf)),
    /** The personal boards ({ dashboard, datasets }), read together under the lock — a cut-short commit finished first. */
    // only the boards that pass their rules now: one an undo brought back broken is left out (its file as it is), never breaking the page
    boards: () => withLock(home, () => goodBoards()),
    /** The page's part of the surfaces, read under the lock (one snapshot) — pageNow inside a lock already held. */
    page: () => withLock(home, () => pageNow()),
    pageNow,
    setDesktop,
  }
  /** The theme's CSS, the desktop and the sidebar's own order, for the page (none when a file is broken: the page stays usable).
   * A desktop.json edited by hand into something wrong is not the defaults all of a sudden: the desktop stays as it last
   * was right, and `desktopProblem` says what is wrong (the page shows it) until the file is right again. */
  function pageNow() {
    let theme = null, nav = null, desktop = null, desktopProblem = ''
    try { theme = SURFACES.theme.check(readText(at('theme.json'))) } catch { /* a broken theme: Ruyix's own colours */ }
    try { nav = SURFACES.layout.check(readText(at('layout.json'))).nav || null } catch { /* a broken layout: the usual sidebar */ }
    try { desktop = SURFACES.desktop.check(readText(at('desktop.json'))); goodDesktop = desktop } catch (err) { desktop = goodDesktop; desktopProblem = err.message }
    desktop ||= { ...DESKTOP_DEFAULT }
    return { themeCss: desktopCss(desktop) + themeCss(theme), desktop, desktopProblem, nav, themeName: theme?.name || '', myBoards: goodBoards().map(b => b.dashboard.name) }
  }
  /** The person's own choice (Settings → General): the keys given, written at once — their click is the yes, as for the name. */
  function setDesktop(value, widgetsBase) {
    return withLock(home, () => {
      const was = readText(at('desktop.json'))
      if (value && Object.hasOwn(value, 'widgets') && widgetsBase !== undefined && JSON.stringify(parse(was, 'desktop.json')?.widgets ?? null) !== JSON.stringify(widgetsBase)) throw Object.assign(new Error('widgets changed meanwhile: reload the desktop and try again'), { code: 'stale' })
      const next = SURFACES.desktop.next(was, value)
      commit([['desktop.json', next, was]])
      return SURFACES.desktop.check(next) || { ...DESKTOP_DEFAULT }
    })
  }
  /** The personal boards that pass their rules now (one an undo brought back broken is left out, its file as it is). */
  function goodBoards() { return boardsIn(home).flatMap(id => { try { return [checkBoard(JSON.parse(readText(at(`boards/${id}.json`))), id)] } catch { return [] } }) }
}

// ── the agent's tools (on every dsh agent of this Ruyix): it reads and proposes; the person applies on the page ──
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const textResult = { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: v.text }] }
const text = t => ({ text: String(t) })
const byOf = exec => `agent ${exec?.agent?.session?.id || ''}`.trim()
const brief = v => `${v.id} [${v.state}] ${v.summary}\n${v.diff.slice(0, 40).map(l => `  ${l}`).join('\n')}${v.diff.length > 40 ? `\n  … ${v.diff.length - 40} more` : ''}`

/** The tools: read the surfaces, propose a change or an undo (the person applies it on the page), list them. */
export function surfaceTools({ changes, entries, home }) {
  const current = name => { try { return readFileSync(join(home, name), 'utf8').trim() } catch { return '(none)' } }
  return [
    {
      name: 'ruyix_surfaces',
      description: 'What you can change in this Ruyix (Ruyix) itself, and how: the sidebar (its entries\' order within their groups, hidden entries), this Ruyix\'s name and colour, the theme\'s colours, the desktop (a theme, or its wallpaper, accent, tint, motion, glass, the interface size, density and corners, its widgets, desktop or classic), personal boards (dashboards over production data). Read this before ruyix_change_propose. Credentials, plugin settings, the cloud entry and any other file are not changeable here.',
      parameters: schema({}), output: textResult,
      execute: async () => {
        await changes.settle()
        const list = entries()
        return text([
          '# Surfaces of this Ruyix (change them with ruyix_change_propose; the person applies)',
          '',
          '## layout — the sidebar and who this Ruyix is (layout.json)',
          'value: { "nav": { "order": [entry ids — these first, in this order, each within its own group], "hidden": [entry ids] }, "identity": { "name": "up to 40 characters", "color": "#rrggbb" } }',
          'The keys you give replace those keys (give the whole nav: order and hidden together); null removes one. The preset and the plugins are the Settings page\'s, not here.',
          list.length ? `Sidebar entries now (id · label · group):\n${list.map(e => `- ${e.id} · ${e.label} · ${e.group}`).join('\n')}` : 'Sidebar entries: not known yet (the Ruyix page has not been open since ruyix started): ask the person to open it once.',
          `Now: ${current('layout.json')}`,
          '',
          '## theme — the colours (theme.json)',
          'value: { "name": "…", "tokens": { "--ruyix-…": "#hex" for both, or ["#light", "#dark"] } } — the whole theme (tokens left out keep ruyix\'s own); null: back to ruyix\'s own colours.',
          'Colours only: #hex, rgb(), hsl(), oklch(). Text (--ruyix-title, --ruyix-text, --ruyix-text-muted, --ruyix-text-dim) needs 4.5:1 against --ruyix-surface and --ruyix-canvas, in light and in dark.',
          'Tokens (ruyix\'s own value · what it is for):',
          ...Object.entries(TOKENS).map(([n, t]) => `- ${n}: ${t.value}${t.note ? ` · ${t.note}` : ''}`),
          `Now: ${current('theme.json')}`,
          '',
          '## desktop — how this Ruyix looks as a desktop (desktop.json)',
          'value: some of these keys (those given replace those keys; a key null: its default; value null: all defaults):',
          ...desktopKeys().map(l => `- ${l}`),
          'A theme is the quickest way to change the whole look: give { "theme": id, and its keys } — exactly what choosing it on the page writes: ' + THEMES.map(x => JSON.stringify(themePatch(x.id))).join(' '),
          'Changing one key after (a wallpaper of its own) keeps the theme with that key changed. Light or dark is each browser\'s own, but choosing a theme sets it there to the theme\'s.',
          `Now: ${current('desktop.json')}`,
          '',
          '## boards — personal boards on the Boards page (boards/<id>.json)',
          'An edit: { surface: "boards", id: "my-…", value: { dashboard, datasets } } — the whole board; value null removes it.',
          'dashboard: { kind: "dashboard", name: <the id>, version: "1.0.0", title: { zh, en }, datasets: { alias: "<dataset>@*" }, pages: [{ id, title: { zh, en }, widgets: [{ id, data: alias, view: count|list|table|breakdown|trend|people|note, size: s|m|l, title: { zh, en }, filter?, by?, columns?, sort?, value?, limit? }] }] }.',
          'datasets: its own, named "<board id>--<name>", each { kind: "dataset", name, version: "1.0.0", title: { zh, en }, connector, op, params, fields: { name: type }, refresh: "10m" } over a read the connector type offers; or use the built-in ones by name. Params may take {{settings.<path>}} (a plain path, set on the Boards page). Every page has at least one widget. They run through this Ruyix\'s own connections.',
          `Built-in datasets: ${Object.values(DATASETS).map(d => `${d.name} (${d.connector} ${d.op}: ${Object.keys(d.fields).join(', ')})`).join('; ')}.`,
          `Personal boards now: ${boardsIn(home).join(', ') || '(none)'}`,
          '',
          '## How to change',
          '1. ruyix_change_propose { summary (the person\'s language), edits: [{ surface, value }] } — one intent per change. Nothing is written: you cannot apply it.',
          '2. Tell the person what it changes (the diff it returns) and that it waits for them: the card at the bottom right of the Ruyix page (or Settings → Changes) — Apply, and the page changes at once.',
          '3. To undo: ruyix_change_undo { id } proposes its reverse; { id, restore: true } proposes going back to how things were before it (later changes too). The person applies those the same way. ruyix_changes lists the changes.',
        ].join('\n'))
      },
    },
    {
      name: 'ruyix_change_propose',
      description: 'Propose a change to this Ruyix\'s surfaces (see ruyix_surfaces): every edit is checked, nothing is written. Returns the change\'s id and what it changes, or what is wrong (fix it and propose again).',
      parameters: schema({
        summary: { type: 'string', description: 'What the change does, in the person\'s words and language (up to 200 characters)' },
        edits: { type: 'array', items: schema({ surface: { type: 'string', enum: Object.keys(SURFACES) }, id: { type: 'string', description: 'boards only: the board\'s id, my-…' }, value: { description: 'The surface\'s new value (see ruyix_surfaces); null removes' } }, ['surface', 'value']) },
      }, ['summary', 'edits']),
      output: textResult,
      execute: async ({ summary, edits }, exec) => {
        try { return text(`Proposed — waiting for the person (the card at the bottom right of the Ruyix page, or Settings → Changes):\n${brief(await changes.propose({ summary, edits, by: byOf(exec) }))}`) } catch (err) { return text(`Not proposed: ${err.message}`) }
      },
    },
    {
      name: 'ruyix_change_undo',
      description: 'Propose undoing an applied change (its reverse); restore: true proposes going back to how things were before it (every change applied after it too). The person applies it on the page, like any change.',
      parameters: schema({ id: { type: 'string' }, restore: { type: 'boolean' }, summary: { type: 'string', description: 'In the person\'s language (default: the change\'s own, marked as an undo)' } }, ['id']), output: textResult,
      execute: async ({ id, restore, summary }, exec) => {
        try { return text(`Proposed — waiting for the person:\n${brief(await changes.proposeUndo(id, { restore: !!restore, summary, by: byOf(exec) }))}`) } catch (err) { return text(`Not proposed: ${err.message}`) }
      },
    },
    {
      name: 'ruyix_changes',
      description: 'The latest changes to this Ruyix\'s surfaces (newest first): id, state (proposed / applied / undone / discarded), summary, what each changes.',
      parameters: schema({ limit: { type: 'number' } }), output: textResult,
      execute: async ({ limit } = {}) => {
        const all = await Promise.all((await changes.list({ limit: Math.min(50, Math.max(1, Number(limit) || 10)) })).map(x => changes.get(x.id))) // each whole
        return text(all.length ? all.map(brief).join('\n\n') : 'No changes yet.')
      },
    },
  ]
}
