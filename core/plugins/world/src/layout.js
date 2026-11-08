// Where things are on the map (both maps: the old map and the star map have the same places, drawn their own way).
// World units: y up, the whole map WORLD.w × WORLD.h round (0, 0); a screen at the first zoom shows all of it.
// Pages become places by what they are (KNOWN: the workbench's runs page is the harbour, its inbox the post station…);
// a page nobody knows yet (another plugin's) becomes a village on the mainland, in the next free spot. Tasks are islands
// (rings in the sky) in the southern sea, the scheduled ones in the eastern sea. Pure: checked in node (check.mjs).

export const WORLD = { w: 3.5, h: 1.96 }

/** The places' kinds: their number in the shader, where they stand, how much land round them (the old map's mainland). */
export const KINDS = {
  capital: { n: 1, at: [0, 0.18], land: 0.42 },
  harbor: { n: 2, at: [0.06, -0.24], land: 0.2 },
  launch: { n: 3, at: [0.36, -0.42], land: 0 },
  post: { n: 4, at: [0.74, -0.02], land: 0.2 },
  library: { n: 5, at: [0.82, 0.42], land: 0.22 },
  guild: { n: 6, at: [-0.36, 0.58], land: 0.2 },
  workshop: { n: 7, at: [-0.84, 0.36], land: 0.24 },
  port: { n: 8, at: [-1.12, -0.04], land: 0.18 },
  fort: { n: 9, at: [0.38, 0.62], land: 0.18 },
  archive: { n: 10, at: [-0.56, -0.12], land: 0.2 },
  settings: { n: 11, at: [1.48, -0.72], land: 0 },
  gate: { n: 12, at: [-1.52, -0.76], land: 0.13 },
  village: { n: 13, land: 0.15 },
  clock: { n: 14, at: [-1.42, 0.8], land: 0 },
}
/** The pages each kind stands for (by the page's id). */
export const KNOWN = {
  // (「任务」 takes the harbour when the runs page is folded into it: work-in-one-place.md)
  'ruyix-workbench': 'harbor', 'ruyix-tasks': 'harbor', 'ruyix-workbench-inbox': 'post', 'ruyix-workbench-flow': 'library', 'ruyix-workbench-chat': 'capital',
  'agent-hub': 'guild', 'ruyix-apps': 'workshop', connectors: 'port', 'ruyix-box': 'fort', 'ruyix-settings': 'settings',
}
// where the pages nobody knows go, in this order: the mainland's free spots
export const VILLAGES = [[-0.46, 0.12], [0.46, 0.16], [-1.02, 0.66], [1.08, 0.7], [1.12, 0.12], [-0.92, -0.38], [0.02, 0.62], [-0.12, -0.02]]
// the islands of the tasks at work (southern sea) and of the scheduled ones (eastern sea)
export const ISLANDS = [[-0.98, -0.6], [-0.5, -0.72], [0.68, -0.64], [-0.02, -0.76], [1.12, -0.44], [-1.38, -0.32], [0.22, -0.84], [-0.78, -0.86]]
export const FOG = [[1.44, 0.26], [1.42, -0.12], [1.5, 0.62], [1.2, -0.24]]

/**
 * The places for these pages: [{ id, kind, n, x, y, land, page? }]. The fixed ones (the capital, the new-task launch,
 * the settings, the gate back to the desktop, the clock) are always there; each page goes to its kind's place, or to a
 * village; settings keeps its own.
 */
export function placesOf(pages) {
  const out = [], taken = new Set()
  const add = (id, kind, at, page) => out.push({ id, kind, n: KINDS[kind].n, x: at[0], y: at[1], land: KINDS[kind].land, ...(page && { page }) })
  add('capital', 'capital', KINDS.capital.at, pages.find(p => p.id === 'ruyix-workbench-chat'))
  add('launch', 'launch', KINDS.launch.at)
  add('gate', 'gate', KINDS.gate.at)
  add('clock', 'clock', KINDS.clock.at)
  let v = 0
  for (const p of pages) {
    const kind = KNOWN[p.id]
    if (kind === 'capital') continue
    if (kind && !taken.has(kind)) { taken.add(kind); add(p.id, kind, KINDS[kind].at, p); continue }
    if (v < VILLAGES.length) add(p.id, 'village', VILLAGES[v++], p)
  }
  if (!taken.has('settings')) add('ruyix-settings', 'settings', KINDS.settings.at, { id: 'ruyix-settings' })
  // what is done: a place of its own beside the harbour (what is not looked at yet, else 「任务」's 完成)
  if (taken.has('harbor')) add('archive', 'archive', KINDS.archive.at)
  return out
}

/** The islands (rings) for the tasks: the runs going and just over in the south, the scheduled ones in the east. */
export function islandsOf(items) {
  let i = 0, f = 0
  return items.flatMap(it => {
    if (it.kind === 3) return f < FOG.length ? [{ ...it, x: FOG[f][0], y: FOG[f++][1], r: 0.1 }] : []
    return i < ISLANDS.length ? [{ ...it, x: ISLANDS[i][0], y: ISLANDS[i++][1], r: 0.13 }] : []
  })
}

// ── the view: where the screen looks (x, y: the world point at its centre) and how far out (z: the world height a
// screen's height shows); the screen's own points are centred, its height 1, y up ──
/** The view that shows the whole map on a screen of this aspect (width / height). */
export const fit = aspect => ({ x: 0, y: 0, z: Math.max(WORLD.w / aspect, WORLD.h) * 1.02 })
export const ZOOM = { in: 0.42 } // the nearest: this much of the world's height on a screen
/** A screen point (centred, height 1) → the world point under it. */
export const toWorld = (v, sx, sy) => [sx * v.z + v.x, sy * v.z + v.y]
/** A world point → the screen point over it. */
export const toScreen = (v, wx, wy) => [(wx - v.x) / v.z, (wy - v.y) / v.z]
/** The view kept on the map: not further out than the whole of it, not nearer than ZOOM.in, its centre on the map. */
export function clampView(v, aspect) {
  const far = fit(aspect).z * 1.08, z = Math.min(far, Math.max(ZOOM.in, v.z))
  const hw = Math.max(0, WORLD.w / 2 - (aspect * z) / 2 * 0.35), hh = Math.max(0, WORLD.h / 2 - z / 2 * 0.35)
  return { x: Math.min(hw, Math.max(-hw, v.x)), y: Math.min(hh, Math.max(-hh, v.y)), z }
}
/** Zoom by `k` (< 1 nearer) keeping the world point under the screen point (sx, sy) where it is. */
export function zoomAt(v, k, sx, sy, aspect) {
  const [wx, wy] = toWorld(v, sx, sy)
  const z = clampView({ ...v, z: v.z * k }, aspect).z
  return clampView({ x: wx - sx * z, y: wy - sy * z, z }, aspect)
}
