// Where the answers' leaves go on the desk (./tree.jsx; Ethan: 「找一些空的地方来放」): each in the free room above the
// main agent's line — clear of the widgets, the clock, the open things, the waiting card, the stem and each other — the
// newest nearest where it grows (beside the stem). Plain JS: checked in node (answers-check.mjs).

/**
 * Boxes (`boxes`: [{ w, h, minH? }], the newest first) placed in `area` ({ l, t, r, b }) clear of `obstacles`
 * ([{ l, t, r, b }]) and of each other, `gap` apart: each where it is whole, nearest `anchor` ({ x, y }: the bottom middle
 * it would like); with no such room, where most of it fits (at least minH: its body scrolls). `force`: the first goes at
 * the anchor even with no room (an answer is always seen). → [{ x, y, w, h } | null] (null: no room — the drawer keeps it)
 */
export function placeBoxes({ area, obstacles = [], boxes, anchor, gap = 12, force = true }) {
  const grow = o => ({ l: o.l - gap, t: o.t - gap, r: o.r + gap, b: o.b + gap })
  const taken = obstacles.filter(o => o.r > o.l && o.b > o.t && o.r > area.l && o.l < area.r && o.b > area.t && o.t < area.b).map(grow)
  return boxes.map(({ w, h, minH = 200 }, i) => {
    w = Math.round(Math.min(w, area.r - area.l)); h = Math.round(Math.min(h, area.b - area.t))
    const need = Math.min(h, minH)
    const xs = new Set([area.l, area.r - w, Math.round(anchor.x - w / 2)]), bottoms = new Set([area.b])
    for (const o of taken) { xs.add(Math.round(o.r)); xs.add(Math.round(o.l - w)); bottoms.add(Math.round(o.t)) }
    let best = null
    for (const x of xs) {
      if (x < area.l || x + w > area.r) continue
      const column = taken.filter(o => o.r > x && o.l < x + w)
      for (const b of bottoms) {
        if (b > area.b || b - need < area.t) continue
        // the room up from that bottom: to the nearest thing above it (one across the bottom line leaves none)
        const ceil = Math.max(area.t, ...column.filter(o => o.t < b).map(o => o.b))
        const fits = Math.min(h, b - ceil)
        if (fits < need) continue
        // whole first; then the nearest the anchor (a shortened one: the taller the better)
        const score = (fits < h ? 1e5 + (h - fits) * 4 : 0) + Math.abs(x + w / 2 - anchor.x) + Math.abs(b - anchor.y)
        if (!best || score < best.score) best = { score, x, y: b - fits, w, h: fits }
      }
    }
    if (!best && i === 0 && force) {
      const x = Math.max(area.l, Math.min(area.r - w, Math.round(anchor.x - w / 2)))
      best = { x, y: area.b - h, w, h }
    }
    if (!best) return null
    taken.push(grow({ l: best.x, t: best.y, r: best.x + best.w, b: best.y + best.h }))
    return { x: best.x, y: best.y, w: best.w, h: best.h }
  })
}
