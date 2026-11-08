// The questions and their answers for the desk (src/answers.js): one list from the producers' slices, the newest asked
// first; the same slice twice is no change; the hooks reach the item's own producer; where each item shows.
import assert from 'node:assert/strict'
import { answersLayout, answersRegistry } from './src/answers.js'

const w = new EventTarget()
let events = 0
w.addEventListener('ruyix:answers', () => events++)
const reg = answersRegistry(w)
assert.equal(answersRegistry(w), reg, 'one per window')
const did = []
const items = [
  { id: 'ask:1', question: '明天天气', state: 'answered', askedAt: 1, answeredAt: 5, answer: { text: '晴', cards: [{ type: 'note', text: '晴' }] }, open: 'leaf', seen: false, lines: [] },
  { id: 'ask:2', question: '写一份周报', state: 'working', askedAt: 2, lines: [{ at: 3, text: '读了 notes.md', kind: 'tool' }], seen: false },
  { id: 'ask:3', question: '再查一下', state: 'queued', askedAt: 4, seen: false, lines: [] },
  { id: 'ask:0', question: '早上的', state: 'answered', askedAt: 0, open: 'drawer', seen: false, lines: [] },
  { id: 'ask:9', question: '看过的', state: 'answered', askedAt: 0, open: 'drawer', seen: true, lines: [] },
]
reg.set('chat', items, { seen: ids => did.push(['seen', ...ids]), front: id => did.push(['front', id]), close: id => did.push(['close', id]) })
reg.set('chat', items)
assert.equal(events, 1, 'the same slice twice: no change')
assert.deepEqual(reg.get().map(x => x.id), ['ask:3', 'ask:2', 'ask:1', 'ask:0', 'ask:9'], 'the newest asked first')
assert.equal(reg.seen('ask:1'), true); assert.equal(reg.front('ask:1'), true); assert.equal(reg.close('ask:1'), true)
assert.equal(reg.seen('ask:nope'), false, 'no producer holds it')
assert.deepEqual(did, [['seen', 'ask:1'], ['front', 'ask:1'], ['close', 'ask:1']])
const L = answersLayout(reg.get())
assert.deepEqual([L.stem.map(x => x.id), L.leaves.map(x => x.id), L.drawer.map(x => x.id)], [['ask:2', 'ask:3'], ['ask:1'], ['ask:0']], 'the stem: at work and queued (oldest first); a leaf: answered, out; the drawer: closed, not seen')
// Where the leaves go (src/desktop/place.js): clear of what is on the desk and of each other, the newest at the anchor
{
  const { placeBoxes } = await import('./src/desktop/place.js')
  const meet = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  const area = { l: 12, t: 42, r: 1428, b: 769 }
  // (Ethan's desk, 2026-10-20: the clock, the open things, two widgets moved out, the widgets' column)
  const obstacles = [{ l: 65, t: 55, r: 300, b: 175 }, { l: 13, t: 222, r: 191, b: 431 }, { l: 209, t: 223, r: 583, b: 481 }, { l: 209, t: 497, r: 583, b: 727 }, { l: 1176, t: 51, r: 1420, b: 760 }]
  const [a, b, c] = placeBoxes({ area, obstacles, boxes: [{ w: 360, h: 459 }, { w: 360, h: 300 }, { w: 360, h: 420 }], anchor: { x: 874, y: 769 } })
  assert.deepEqual(a, { x: 694, y: 310, w: 360, h: 459 }, 'the newest: whole, where it grows')
  assert.ok(b && b.h >= 200 && b.h < 300 && !meet(a, b), 'the next: where there is room, shorter (its words scroll), not over the first')
  for (const o of obstacles) for (const x of [a, b]) assert.ok(!meet(x, { x: o.l, y: o.t, w: o.r - o.l, h: o.b - o.t }), 'no widget under a leaf')
  assert.equal(c, null, 'no room left: the drawer keeps it')
  // a wide free desk: side by side, the second as near as it can be
  const [d, e] = placeBoxes({ area, obstacles: [], boxes: [{ w: 360, h: 400 }, { w: 360, h: 400 }], anchor: { x: 700, y: 769 } })
  assert.ok(!meet(d, e) && d.y + d.h === 769 && e.y + e.h === 769, 'both down by the line, apart')
  // no room at all: the newest still shows (at the anchor), the rest wait
  const full = [{ l: 0, t: 0, r: 1440, b: 900 }]
  const [f, g] = placeBoxes({ area, obstacles: full, boxes: [{ w: 360, h: 400 }, { w: 360, h: 400 }], anchor: { x: 700, y: 769 } })
  assert.deepEqual([f, g], [{ x: 520, y: 369, w: 360, h: 400 }, null])
}
// About Ruyix's lines (src/about.js)
{
  const { aboutLines } = await import('./src/about.js')
  const lines = aboutLines({ ruyix: '0.2.4', dsh: '0.2.0-rc.2', box: '0.5.11', boxName: 'ruyix' }, { commit: '6e5b1cf', built: '2026-10-18T19:05:00Z', lang: 'zh' })
  assert.deepEqual(lines.map(([k]) => k), ['Ruyix', '这份程序', 'dsh', 'nookbox'])
  assert.match(lines[1][1], /^提交 6e5b1cf · 编译于 2026-10-1\d \d\d:05$/, 'the build time in the person\'s clock')
  assert.equal(lines[3][1], '0.5.11（盒子：ruyix）')
  assert.deepEqual(aboutLines(null, {}).map(([, v]) => v), ['—', '—', '—'], 'nothing known: said so, no box line')
}
console.log('answers check: ok')
