// The desktop: how this Ruyix looks as an operating system — the interface (the desktop, or the classic sidebar), its
// theme (a set of the rest, chosen at once: THEMES), wallpaper, whether a live wallpaper moves, the accent, the tint of
// the windows' grounds, the material (glass or solid) and the system style: the interface's size, the density, the
// corners (docs/design/system-style.md). One file, desktop.json, a surface like the theme: the person sets it in
// Settings → General or by hand (the page follows within seconds), an agent proposes a change (surfaces.js, or
// `ruyix desk`). Shared by the Host (the check) and the page (the lists it draws), so nothing here reads a file.

/** The wallpapers: each but `plain` is a scene a small shader draws (src/desktop/wallpaper.js, by its id); `plain` is the
 * appearance's own ground. `group`: where the pickers show it (WALLPAPER_GROUPS). `tone`: what the wallpaper mostly is,
 * for what sits on it (the clock, the widgets, the top bar and the dock). `c`: the scene's four colours. */
export const WALLPAPERS = [
  { id: 'satin', group: 'quiet', zh: '丝缎', en: 'Satin', live: true, tone: 'dark', c: ['#0e1116', '#1d2633', '#6b7f99', '#c9d5e4'] },
  { id: 'drift', group: 'quiet', zh: '流光', en: 'Drift', live: true, tone: 'dark', c: ['#0b1118', '#123a40', '#2b2f5c', '#4c6a72'] },
  { id: 'contour', group: 'quiet', zh: '等高线', en: 'Contour', live: true, tone: 'light', c: ['#e6e9ee', '#d5dbe3', '#9aa6b5', '#ffffff'] },
  { id: 'night', group: 'quiet', zh: '夜空', en: 'Night', live: true, tone: 'dark', c: ['#04060c', '#0c1424', '#3a4f7a', '#e8eefc'] },
  { id: 'haze', group: 'quiet', zh: '晨岚', en: 'Haze', live: false, tone: 'light', c: ['#dfe7ef', '#c6d4e3', '#eef1f4', '#a9bcd0'] },
  { id: 'sandstone', group: 'quiet', zh: '砂岩', en: 'Sandstone', live: false, tone: 'light', c: ['#d9c6b4', '#b89a83', '#efe4d8', '#8a6f5c'] },
  { id: 'plain', group: 'quiet', zh: '素色', en: 'Plain', live: false, tone: 'auto', c: [] },
  { id: 'neural', group: 'intelligence', zh: '神经', en: 'Neural', live: true, tone: 'dark', c: ['#03060e', '#0b1630', '#4fd8ff', '#8b7bff'] },
  { id: 'sky', group: 'intelligence', zh: '星图', en: 'Agent sky', live: true, tone: 'dark', agents: true, c: ['#02040b', '#111a44', '#5a0c10', '#ffb46a'] },
  { id: 'atlas', group: 'intelligence', zh: '古地图', en: 'Old map', live: true, tone: 'light', agents: true, c: ['#e9dab4', '#cfd0a0', '#3a2c1e', '#b33a26'] },
  { id: 'core', group: 'intelligence', zh: '核心', en: 'Core', live: true, tone: 'dark', c: ['#04050c', '#121638', '#5ee7ff', '#b56bff'] },
  { id: 'voice', group: 'intelligence', zh: '声波', en: 'Voice', live: true, tone: 'dark', c: ['#05050b', '#12102a', '#4fd1ff', '#c06bff'] },
  { id: 'streams', group: 'intelligence', zh: '信息流', en: 'Streams', live: true, tone: 'dark', c: ['#03050b', '#0c1226', '#3fd9ff', '#7a6bff'] },
  { id: 'lattice', group: 'intelligence', zh: '点阵', en: 'Lattice', live: true, tone: 'dark', c: ['#02040a', '#0a1430', '#3ee8d0', '#5a7bff'] },
  { id: 'globe', group: 'intelligence', zh: '全息地球', en: 'Globe', live: true, tone: 'dark', c: ['#03060c', '#0a1a2e', '#45e3ff', '#3f7bff'] },
  { id: 'aurora', group: 'modern', zh: '极光', en: 'Aurora', live: true, tone: 'dark', c: ['#03050c', '#0b1a2c', '#3cf0a6', '#8f5bff'] },
  { id: 'ribbons', group: 'modern', zh: '光带', en: 'Ribbons', live: true, tone: 'dark', c: ['#05060d', '#120f2a', '#29d3ff', '#ff4fd8'] },
  { id: 'iris', group: 'modern', zh: '虹彩', en: 'Iris', live: true, tone: 'dark', c: ['#07080d', '#262833', '#9fb4ff', '#ffffff'] },
  { id: 'shallows', group: 'modern', zh: '水光', en: 'Shallows', live: true, tone: 'dark', c: ['#062a33', '#0f5a63', '#bff8ff', '#e8fff9'] },
  { id: 'bokeh', group: 'modern', zh: '光斑', en: 'Bokeh', live: true, tone: 'dark', c: ['#07070c', '#16142a', '#ffbf69', '#5cc8ff'] },
  { id: 'glass', group: 'modern', zh: '琉璃', en: 'Glass', live: true, tone: 'light', c: ['#efe9f2', '#ff8a6b', '#6b5cff', '#5ec8ff'] },
  { id: 'ink', group: 'classical', zh: '远山', en: 'Far hills', live: true, tone: 'light', c: ['#efe9dc', '#24262b', '#a9aaa6', '#c4513a'] },
  { id: 'azure', group: 'classical', zh: '青绿', en: 'Blue-green', live: true, tone: 'light', c: ['#e8dcc0', '#2f6f62', '#5a8fae', '#b07f4f'] },
  { id: 'moonlit', group: 'classical', zh: '月夜', en: 'Moonlit lake', live: true, tone: 'dark', c: ['#060b16', '#1a2944', '#f2ead0', '#0a101c'] },
  { id: 'wash', group: 'classical', zh: '水墨', en: 'Ink wash', live: true, tone: 'light', c: ['#f1ede4', '#1c1e22', '#8a8c90', '#b0443a'] },
]
/** The wallpapers' groups, in the order the pickers show them. */
export const WALLPAPER_GROUPS = ['quiet', 'intelligence', 'modern', 'classical']

/** The accents: one colour for actions, links and selection, in light and in dark (each 4.5:1 or more on Ruyix's grounds). */
export const ACCENTS = [
  { id: 'teal', zh: '青', en: 'Teal', light: '#0f766e', dark: '#5eead4' },
  { id: 'blue', zh: '蓝', en: 'Blue', light: '#1d64d8', dark: '#8ab4ff' },
  { id: 'indigo', zh: '靛', en: 'Indigo', light: '#5b4fd6', dark: '#b1a8ff' },
  { id: 'rose', zh: '玫红', en: 'Rose', light: '#c0265e', dark: '#ff8fb3' },
  { id: 'amber', zh: '琥珀', en: 'Amber', light: '#975600', dark: '#f3b562' },
  { id: 'graphite', zh: '石墨', en: 'Graphite', light: '#4b5563', dark: '#c7ccd4' },
  { id: 'vermilion', zh: '朱砂', en: 'Vermilion', light: '#b4372a', dark: '#ff9b87' },
]

/** The tints: the windows' grounds, lines and text a shade warmer (paper) or cooler (blue-grey) than Ruyix's own
 * neutral — [light, dark] for each token they change (each text 4.5:1 or more on each ground: check.mjs). */
export const TINTS = {
  neutral: null,
  warm: {
    '--ruyix-canvas': ['#f4f0e8', '#25221e'], '--ruyix-surface': ['#fffdf8', '#2e2a25'], '--ruyix-surface-sunk': ['#efe9de', '#28241f'],
    '--ruyix-hover': ['#ebe4d6', '#3a342c'], '--ruyix-line': ['#e3dccf', '#4a433a'], '--ruyix-line-strong': ['#cfc5b3', '#5e5548'],
    '--ruyix-text': ['#3b372f', '#e8e1d4'], '--ruyix-text-muted': ['#5c5548', '#c9bfad'], '--ruyix-text-dim': ['#665e4f', '#ada392'],
  },
  cool: {
    '--ruyix-canvas': ['#eef2f8', '#171c26'], '--ruyix-surface': ['#ffffff', '#1e2531'], '--ruyix-surface-sunk': ['#eaeff6', '#19202b'],
    '--ruyix-hover': ['#e0e8f3', '#29344a'], '--ruyix-line': ['#d9e1ec', '#303b4e'], '--ruyix-line-strong': ['#bfcadb', '#45526b'],
  },
}

/** The themes: a wallpaper, an accent, a tint and corners that go together, chosen at once — and light or dark for the
 * windows (`appearance`; null: each browser's own). Picking one writes its keys into desktop.json with `theme`, its
 * id; a key changed after stays changed (the pickers say the theme is changed). */
export const THEMES = [
  { id: 'default', zh: '默认', en: 'Default', wallpaper: 'satin', accent: 'teal', tint: 'neutral', corners: 'standard', appearance: null },
  { id: 'night', zh: '夜空', en: 'Night sky', wallpaper: 'night', accent: 'indigo', tint: 'cool', corners: 'standard', appearance: 'dark' },
  { id: 'neural', zh: '智能', en: 'Intelligence', wallpaper: 'neural', accent: 'blue', tint: 'cool', corners: 'standard', appearance: 'dark' },
  { id: 'aurora', zh: '极光', en: 'Aurora', wallpaper: 'aurora', accent: 'teal', tint: 'cool', corners: 'large', appearance: 'dark' },
  { id: 'glass', zh: '琉璃', en: 'Glass', wallpaper: 'glass', accent: 'indigo', tint: 'neutral', corners: 'large', appearance: 'light' },
  { id: 'haze', zh: '晨岚', en: 'Morning haze', wallpaper: 'haze', accent: 'blue', tint: 'neutral', corners: 'standard', appearance: 'light' },
  { id: 'hills', zh: '远山', en: 'Far hills', wallpaper: 'ink', accent: 'vermilion', tint: 'warm', corners: 'small', appearance: 'light' },
  { id: 'inkwash', zh: '水墨', en: 'Ink wash', wallpaper: 'wash', accent: 'graphite', tint: 'warm', corners: 'small', appearance: 'light' },
  { id: 'bluegreen', zh: '青绿', en: 'Blue-green', wallpaper: 'azure', accent: 'teal', tint: 'warm', corners: 'small', appearance: 'light' },
  { id: 'moonlit', zh: '月夜', en: 'Moonlit lake', wallpaper: 'moonlit', accent: 'amber', tint: 'cool', corners: 'small', appearance: 'dark' },
  { id: 'sandstone', zh: '砂岩', en: 'Sandstone', wallpaper: 'sandstone', accent: 'amber', tint: 'warm', corners: 'standard', appearance: 'light' },
]
/** The keys a theme sets. */
export const THEME_KEYS = ['wallpaper', 'accent', 'tint', 'corners']
/** What choosing a theme writes into desktop.json (its id and its keys). */
export const themePatch = id => { const th = THEMES.find(x => x.id === id); return th && { theme: th.id, ...Object.fromEntries(THEME_KEYS.map(k => [k, th[k]])) } }
/** A desktop's theme and which of its keys were changed after it was chosen ({ theme: null } when none was). */
export function themeOf(d) {
  const th = THEMES.find(x => x.id === d?.theme)
  return th ? { theme: th, changed: THEME_KEYS.filter(k => d[k] !== th[k]) } : { theme: null, changed: [] }
}

/** desktop: windows on a desk; classic: a sidebar beside one page; world: the interactive desk — a map a plugin draws
 * (window.__ruyixWorlds), every page a place on it (without such a plugin: the desktop). */
export const MODES = ['desktop', 'classic', 'world']
const WORLD_ID = /^[a-z][a-z0-9-]{0,30}$/
/** The interface's sizes: 'auto' follows the desk (scaleOf); a number is that size everywhere. */
export const SCALES = ['auto', 0.8, 0.9, 1, 1.1, 1.25, 1.5]
/** The system style's dials (tokens.css): how much room controls and spacing take, how round the corners are. */
export const DENSITIES = { compact: 0.88, standard: 1, roomy: 1.12 }
export const CORNERS = { small: 0.6, standard: 1, large: 1.4 }
/** How much of the desk shows through open windows and the conversation (desktop.json `transparency`): their grounds' share. */
export const TRANSPARENCY = { off: 1, light: 0.8, strong: 0.6 }
/** How agents at work show on the desk: a light with its icon, the light alone, a light with a simple face, or not at all. */
export const AGENT_LOOKS = ['icon', 'light', 'face', 'off']
/** How windows take their place (desktop.json `windows`): laid out by themselves, side by side (auto), or where they open (free). */
export const WINDOW_MODES = ['auto', 'free']
/** What costs are shown in (desktop.json `currency`): the models' own dollars, or yuan at `cnyPerUsd` yuan to the dollar. */
export const CURRENCIES = ['usd', 'cny']
export const CNY_PER_USD = 7.2
export const DESKTOP_DEFAULT = Object.freeze({ mode: 'desktop', theme: null, wallpaper: 'satin', motion: true, accent: 'teal', tint: 'neutral', glass: true, transparency: 'light', scale: 'auto', density: 'standard', corners: 'standard', agents: 'icon', world: 'atlas', windows: 'auto', widgets: null, widgetsOffered: [], currency: 'usd', cnyPerUsd: CNY_PER_USD })

/**
 * The widgets on the desk, in order: [{ id, type, size, at? }] — `type` a built-in (WIDGETS), `overview:<section>` (a
 * plugin's overview section) or a plugin's own (`<plugin>:<name>`); `size` sm (narrow) or md (wide). Without `at` a
 * widget sits in the column at the desk's right, in this order; with it, where it was dragged on the desk:
 * { x, y, w, h?, ax } in the desk's pixels — x from the left edge (ax 'l') or the right one ('r', so it keeps to that
 * edge as the desk changes size), y from the top, h left out: as tall as it needs. null: the default set (the setup
 * while it is open, a clock and a calendar, every plugin's overview, and the plugins' widgets that ask to be there).
 * `widgetsOffered`: the plugins' widgets once put on a desk of the person's own (`widgets` a list) as they came — each
 * only once, so one taken off stays off.
 */
export const WIDGETS = ['setup', 'clock', 'calendar', 'note', 'ask']
export const WIDGET_SIZES = ['sm', 'md']
export const MAX_WIDGETS = 24
const AT_MAX = 8000, AT_MIN = { w: 100, h: 60 }
/** A widget's place on the desk (`at`) as given → as kept, or a throw saying why. */
function checkAt(at, id) {
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi
  if (!plain(at) || !int(at.x, -AT_MAX, AT_MAX) || !int(at.y, 0, AT_MAX) || !int(at.w, AT_MIN.w, AT_MAX) || (at.h !== undefined && at.h !== null && !int(at.h, AT_MIN.h, AT_MAX)) || !['l', 'r'].includes(at.ax)) {
    throw fail(`widget ${id}: at is { x, y, w, h?, ax: l | r } in whole pixels (w ≥ ${AT_MIN.w}, h ≥ ${AT_MIN.h})`)
  }
  return { x: at.x, y: at.y, w: at.w, ...(at.h != null && { h: at.h }), ax: at.ax }
}
const WIDGET_TYPE = /^[a-z][a-z0-9-]*(:[a-z0-9][a-z0-9._-]{0,48})?$/
const WIDGET_ID = /^[a-z0-9]{1,12}$/

/**
 * The interface's size for a choice on a desk (the browser's page) of w × h pixels: a number chosen is itself; 'auto'
 * shrinks it on a desk smaller than about 1600 × 900 so that much still fits (a 13-inch laptop's browser: about 0.85,
 * 0.8 at least) and never grows it: a larger desk gives more room, not larger text — as on a Mac, where the screen's own
 * setting decides how large things look and a larger screen shows more. Larger is a choice (SCALES).
 */
export function scaleOf(choice, w, h) {
  if (typeof choice === 'number' && SCALES.includes(choice)) return choice
  const fit = Math.min(w / 1600, h / 900)
  return Math.min(1, Math.max(0.8, Math.round(fit * 20) / 20))
}
const KEYS = Object.keys(DESKTOP_DEFAULT)

const fail = message => Object.assign(new Error(message), { code: 'badDesktop' })
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** A desktop.json as given → the whole desktop (what it leaves out is the default); anything else is refused, saying why. */
export function checkDesktop(d) {
  if (!plain(d)) throw fail(`the desktop is { ${KEYS.join(', ')} }`)
  const extra = Object.keys(d).filter(k => !KEYS.includes(k))
  if (extra.length) throw fail(`the desktop has only ${KEYS.join(', ')} (not ${extra.join(', ')})`)
  const out = { ...DESKTOP_DEFAULT, ...d }
  if (!MODES.includes(out.mode)) throw fail(`mode: ${MODES.join(' or ')}`)
  if (out.theme !== null && !THEMES.some(x => x.id === out.theme)) throw fail(`theme: null or one of ${THEMES.map(x => x.id).join(', ')}`)
  if (!WALLPAPERS.some(w => w.id === out.wallpaper)) throw fail(`wallpaper: one of ${WALLPAPERS.map(w => w.id).join(', ')}`)
  if (!ACCENTS.some(a => a.id === out.accent)) throw fail(`accent: one of ${ACCENTS.map(a => a.id).join(', ')}`)
  if (!Object.hasOwn(TINTS, out.tint)) throw fail(`tint: ${Object.keys(TINTS).join(', ')}`)
  for (const k of ['motion', 'glass']) if (typeof out[k] !== 'boolean') throw fail(`${k}: true or false`)
  if (!SCALES.includes(out.scale)) throw fail(`scale: ${SCALES.map(x => JSON.stringify(x)).join(', ')}`)
  if (!Object.hasOwn(DENSITIES, out.density)) throw fail(`density: ${Object.keys(DENSITIES).join(', ')}`)
  if (!Object.hasOwn(CORNERS, out.corners)) throw fail(`corners: ${Object.keys(CORNERS).join(', ')}`)
  if (!Object.hasOwn(TRANSPARENCY, out.transparency)) throw fail(`transparency: ${Object.keys(TRANSPARENCY).join(', ')}`)
  if (!AGENT_LOOKS.includes(out.agents)) throw fail(`agents: ${AGENT_LOOKS.join(', ')}`)
  if (!WINDOW_MODES.includes(out.windows)) throw fail(`windows: ${WINDOW_MODES.join(' or ')}`)
  if (typeof out.world !== 'string' || !WORLD_ID.test(out.world)) throw fail('world: the id of an interactive desk (atlas, sky, or a plugin\'s own)')
  if (out.widgets !== null) {
    if (!Array.isArray(out.widgets) || out.widgets.length > MAX_WIDGETS) throw fail(`widgets: null (the default set) or a list of at most ${MAX_WIDGETS}`)
    const ids = new Set()
    out.widgets = out.widgets.map(w => {
      if (!plain(w) || !WIDGET_ID.test(w.id ?? '') || !WIDGET_TYPE.test(w.type ?? '') || !WIDGET_SIZES.includes(w.size)) throw fail('a widget is { id: [a-z0-9]{1,12}, type: "clock" | "overview:<section>" | "<plugin>:<name>" …, size: "sm" | "md" }')
      if (ids.has(w.id)) throw fail(`widgets: the id ${w.id} twice`)
      ids.add(w.id)
      return { id: w.id, type: w.type, size: w.size, ...(w.at !== undefined && w.at !== null && { at: checkAt(w.at, w.id) }) }
    })
  }
  if (!Array.isArray(out.widgetsOffered) || out.widgetsOffered.length > 64 || !out.widgetsOffered.every(t => typeof t === 'string' && WIDGET_TYPE.test(t))) throw fail('widgetsOffered: a list of widget types (at most 64)')
  out.widgetsOffered = [...new Set(out.widgetsOffered)]
  if (!CURRENCIES.includes(out.currency)) throw fail(`currency: ${CURRENCIES.join(' or ')}`)
  if (typeof out.cnyPerUsd !== 'number' || !Number.isFinite(out.cnyPerUsd) || out.cnyPerUsd < 1 || out.cnyPerUsd > 20) throw fail('cnyPerUsd: yuan to the dollar, a number from 1 to 20')
  return out
}

/** The page's CSS for a desktop's accent, tint and system style (before theme.json's: one that sets them has the last word). */
export function desktopCss(d) {
  const a = ACCENTS.find(x => x.id === d?.accent), tint = Object.hasOwn(TINTS, d?.tint) ? TINTS[d.tint] : null
  const vars = [
    a && a.id !== DESKTOP_DEFAULT.accent && `--ruyix-accent: light-dark(${a.light}, ${a.dark});`,
    ...Object.entries(tint || {}).map(([n, [l, k]]) => `${n}: light-dark(${l}, ${k});`),
    Object.hasOwn(DENSITIES, d?.density) && d.density !== 'standard' && `--ruyix-density: ${DENSITIES[d.density]};`,
    Object.hasOwn(CORNERS, d?.corners) && d.corners !== 'standard' && `--ruyix-radius-k: ${CORNERS[d.corners]};`,
  ].filter(Boolean)
  return vars.length ? `body { ${vars.join(' ')} }` : ''
}

/** What each key of desktop.json takes, one line each (`ruyix desk keys`, the agents' description of the surface). */
export function desktopKeys(lang = 'en') {
  const ids = list => list.map(x => x.id).join(', ')
  return [
    `theme: null or ${ids(THEMES)} — choosing one sets ${THEME_KEYS.join(', ')} together (${THEMES.map(x => `${x.id} = ${x[lang] || x.en}`).join('; ')})`,
    `mode: ${MODES.join(' | ')} (classic: the plain sidebar instead of the desktop; world: the interactive desk, a map with every page a place on it)`,
    'world: atlas | sky (which map the interactive desk is: the old map, the star map — or a plugin\'s own)',
    `wallpaper: ${ids(WALLPAPERS)}`,
    `accent: ${ids(ACCENTS)}`,
    `tint: ${Object.keys(TINTS).join(' | ')} (the windows' grounds: Ruyix's own grey, paper-warm, blue-grey)`,
    'motion: true | false (whether a live wallpaper moves)',
    'glass: true | false (glass or solid bars, dock and widgets; false: windows solid too)',
    `transparency: ${Object.keys(TRANSPARENCY).join(' | ')} (how much of the desk or map shows through open windows and the conversation)`,
    `scale: ${SCALES.map(x => JSON.stringify(x)).join(' | ')} (the interface's size; auto: by the screen)`,
    `density: ${Object.keys(DENSITIES).join(' | ')}`,
    `corners: ${Object.keys(CORNERS).join(' | ')}`,
    `agents: ${AGENT_LOOKS.join(' | ')} (agents at work on the desk: a light with its icon, the light alone, a light with a simple face, none)`,
    `windows: ${WINDOW_MODES.join(' | ')} (auto: open windows laid out side by side by themselves, never over each other, beyond four in a drawer; free: where they open)`,
    `widgets: null (the default set) or [{ id: [a-z0-9]{1,12}, type: ${WIDGETS.join(' | ')} | overview:<section> | <plugin>:<name>, size: sm | md, at?: { x, y, w, h?, ax: l | r } (dragged on the desk; left out: in the column) }], at most ${MAX_WIDGETS}`,
    'widgetsOffered: [widget types] (the plugins\' widgets already put on this desk once as they came; a type here is not put there again)',
    `currency: ${CURRENCIES.join(' | ')} (what costs are shown in: the models' dollars, or yuan)`,
    `cnyPerUsd: a number from 1 to 20 (yuan to the dollar, for currency cny; default ${CNY_PER_USD})`,
  ]
}
