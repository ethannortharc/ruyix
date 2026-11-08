// The interactive desk's map (src/layout.js): pages become places by what they are, the ones nobody knows villages, the
// fixed places always there, tasks islands in the south and the scheduled ones in the east; the view fits the whole map,
// zooms round the pointer and stays on the map. The client builds (client.js) and declares its two maps.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { KINDS, WORLD, ZOOM, clampView, fit, islandsOf, placesOf, toScreen, toWorld, zoomAt } from './src/layout.js'

const page = id => ({ id, label: id })
const pages = ['ruyix-workbench', 'ruyix-workbench-inbox', 'ruyix-workbench-flow', 'ruyix-workbench-chat', 'agent-hub', 'agent-hub-skills', 'ruyix-apps', 'connectors', 'ruyix-box', 'notes', 'ruyix-settings'].map(page)
const places = placesOf(pages)
const by = id => places.find(p => p.id === id)
assert.equal(places[0].kind, 'capital', 'the capital first (the scenes draw the roads from it)')
assert.equal(by('capital').page.id, 'ruyix-workbench-chat', 'the conversation is the capital')
assert.deepEqual(['ruyix-workbench', 'ruyix-workbench-inbox', 'ruyix-workbench-flow', 'agent-hub', 'ruyix-apps', 'connectors', 'ruyix-box', 'ruyix-settings'].map(id => by(id).kind),
  ['harbor', 'post', 'library', 'guild', 'workshop', 'port', 'fort', 'settings'])
assert.deepEqual(['agent-hub-skills', 'notes'].map(id => by(id).kind), ['village', 'village'], 'pages nobody knows: villages')
assert.notDeepEqual([by('agent-hub-skills').x, by('agent-hub-skills').y], [by('notes').x, by('notes').y], 'each its own spot')
for (const id of ['launch', 'gate', 'clock', 'archive']) assert.ok(by(id), `${id} is always there (the archive with the tasks)`)
assert.equal(places.filter(p => p.kind === 'settings').length, 1)
assert.ok(placesOf([page('ruyix-apps')]).some(p => p.kind === 'settings'), 'settings even when no page says so')
assert.ok(!placesOf([page('ruyix-apps')]).some(p => p.kind === 'archive'), 'no records without the tasks')
// the runs page folded into 「任务」 (work-in-one-place.md): 「任务」 is the harbour; with both, the runs page keeps it
{
  const folded = placesOf(['ruyix-tasks', 'ruyix-works', 'ruyix-workbench-inbox'].map(page))
  assert.equal(folded.find(p => p.id === 'ruyix-tasks').kind, 'harbor')
  assert.ok(folded.some(p => p.kind === 'archive'), 'and what is done beside it')
  const both = placesOf(['ruyix-workbench', 'ruyix-tasks'].map(page))
  assert.deepEqual(['ruyix-workbench', 'ruyix-tasks'].map(id => both.find(p => p.id === id).kind), ['harbor', 'village'])
}
assert.ok(places.length <= 24, 'the scenes take 24 places')
for (const p of places) assert.ok(Math.abs(p.x) <= WORLD.w / 2 && Math.abs(p.y) <= WORLD.h / 2, `${p.id} on the map`)
// two places never on top of each other
for (const a of places) for (const b of places) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 0.12, `${a.id} and ${b.id} apart`)
// many pages: the villages run out quietly
assert.ok(placesOf(Array.from({ length: 30 }, (_, i) => page(`p${i}`))).length <= 24)

// tasks: islands in the south, scheduled ones in the fog of the east, none on the mainland's places
const isl = islandsOf([{ key: 'a', kind: 1 }, { key: 'b', kind: 2 }, { key: 'c', kind: 3 }, { key: 'd', kind: 4 }])
assert.deepEqual(isl.map(i => [i.key, i.y < 0 || i.kind === 3]), [['a', true], ['b', true], ['c', true], ['d', true]])
assert.ok(isl.find(i => i.key === 'c').x > 1.1, 'the scheduled one in the east')
for (const i of isl) for (const p of places) assert.ok(Math.hypot(i.x - p.x, i.y - p.y) > i.r + 0.06, `island ${i.key} clear of ${p.id}`)

// the view: the whole map on the first screen; zoom round the pointer; never off the map, never nearer than ZOOM.in
for (const aspect of [16 / 9, 16 / 10, 4 / 3, 21 / 9]) {
  const v = fit(aspect)
  assert.ok(v.z >= WORLD.h && v.z * aspect >= WORLD.w, `all of it on a ${aspect.toFixed(2)} screen`)
}
const v0 = fit(16 / 10)
const near = zoomAt(v0, 0.5, 0.3, 0.2, 16 / 10)
const [wx, wy] = toWorld(v0, 0.3, 0.2), [sx, sy] = toScreen(near, wx, wy)
assert.ok(Math.abs(sx - 0.3) < 1e-9 && Math.abs(sy - 0.2) < 1e-9, 'the point under the pointer stays under it')
assert.equal(clampView({ x: 0, y: 0, z: 0.01 }, 16 / 10).z, ZOOM.in)
assert.ok(clampView({ x: 99, y: -99, z: 1 }, 16 / 10).x < WORLD.w / 2, 'the centre stays on the map')
assert.ok(clampView({ x: 0, y: 0, z: 99 }, 16 / 10).z <= fit(16 / 10).z * 1.08 + 1e-9)
assert.ok(Object.values(KINDS).every(k => Number.isInteger(k.n)))

// the star map's constellations: a real one for each place but the clock, true to the sky; in bounds
const { figuresOf, figureUniforms, project, SKY, PLACE_SKY, VILLAGE_SKY, LIMIT } = await import('./src/constellations.js')
const figs = figuresOf(places)
assert.ok(figs.stars.length > 30 && figs.stars.length <= LIMIT.stars && figs.lines.length <= LIMIT.lines, `${figs.stars.length} stars, ${figs.lines.length} lines`)
const around = (pl, r) => figs.stars.filter(s => Math.hypot(s[0] - pl.x, s[1] - pl.y) <= r + 1e-9).length
assert.equal(around(by('capital'), 0.002), 1, 'the main agent is Polaris, right on its place')
assert.equal(around(by('ruyix-workbench-inbox'), figs.radius['ruyix-workbench-inbox']), 6, 'the inbox is Lyra: Vega and five more')
assert.ok(!('clock' in figs.radius), 'the clock has no stars')
for (const c of Object.values(SKY)) {
  const pts = project(c)
  assert.ok(pts.every(([x, y]) => Math.hypot(x, y) <= 1 + 1e-9) && c.lines.every(([a, b]) => pts[a] && pts[b]), `${c.en}: in its circle, its lines between its stars`)
}
assert.ok(Object.values(PLACE_SKY).concat(VILLAGE_SKY).every(id => SKY[id]) && new Set(Object.values(PLACE_SKY).concat(VILLAGE_SKY)).size === Object.keys(SKY).length, 'every place a constellation of its own')
// as one sees them: Betelgeuse (east, north) up and left of Rigel; the Big Dipper's bowl (Dubhe) right of its handle (Alkaid)
const ori = project(SKY.orion), ursa = project(SKY.bigDipper)
assert.ok(ori[0][0] < ori[7][0] && ori[0][1] > ori[7][1] && ursa[0][0] > ursa[6][0], 'north up, east to the left')
assert.ok(figuresOf(placesOf(Array.from({ length: 30 }, (_, i) => page(`p${i}`)))).stars.length <= LIMIT.stars, 'never more than the scene takes')
assert.equal(figureUniforms(figs).uCS.length, LIMIT.stars * 4)

// the scenes' GLSL: a // comment never runs on over code that closes a block (a whole loop's '}' swallowed: the scene
// does not compile, and the map stays black)
for (const mod of ['./src/scenes.js', './src/future-scene.js']) {
  for (const [name, sc] of Object.entries(await import(mod))) {
    if (!sc || typeof sc !== 'object' || typeof sc.body !== 'string') continue
    const bad = `${sc.fn || ''}\n${sc.body}`.split('\n').filter(l => /\S.*\/\/.*\}\s*$/.test(l) && !/^\s*\/\//.test(l))
    assert.deepEqual(bad, [], `${name}: a comment swallows a closing brace`)
  }
}

// the client: built, two maps, their styles
const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
assert.ok(/__ruyixWorlds/.test(client), 'it registers its maps')
assert.ok(/id:\s*"atlas"/.test(client) && /id:\s*"sky"/.test(client), 'the old map and the star map')
assert.ok(/id:\s*"future"/.test(client), 'and the future (a city of light)')
assert.ok(/registerWorld/.test(client), 'a map is a definition (registerWorld)')

// the template others start their own map from (MAKE-A-MAP.md): it builds against this kit, and registers one map
{
  const { execFileSync } = await import('node:child_process')
  const { rmSync } = await import('node:fs')
  const dir = new URL('./template/', import.meta.url)
  execFileSync(process.execPath, ['build.mjs', '--kit', '../src/kit.js'], { cwd: dir, stdio: 'pipe' })
  const built = readFileSync(new URL('./client.js', dir), 'utf8')
  rmSync(new URL('./client.js', dir))
  assert.ok(/id:\s*"blueprint"/.test(built) && /registerWorld|__ruyixWorlds/.test(built), 'the template builds and registers its map')
}
console.log('world check: ok')

{
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./template/src/scene.js', import.meta.url), 'utf8')
  assert.match(source, /5 failed/)
  assert.ok(source.indexOf('if (T.w > 4.5)') < source.indexOf('if (T.w > 3.5)'), 'failed tasks have their own branch before completed tasks')
}
