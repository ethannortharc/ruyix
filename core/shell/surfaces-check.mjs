// surfaces.js: what an agent may change in this Ruyix, checked; a change set applied only over what it found, undone only
// where it is still as it left it, a restore all or nothing; the tools, which only propose (an undo too).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contrast, createChanges as create, surfaceTools, themeCss, TOKENS } from './surfaces.js'
import { ACCENTS, DESKTOP_DEFAULT, THEMES, TINTS, WALLPAPERS, WALLPAPER_GROUPS, checkDesktop, desktopCss, scaleOf, themeOf, themePatch } from './desktop.js'
import { SCENE_IDS } from './src/desktop/wallpaper.js'

// the person applies what they reviewed: these checks apply with the digest of the change's whole view, as the page does
const createChanges = o => { const c = create(o), apply = c.apply; c.apply = async (id, opts = {}) => apply(id, { ...opts, digest: opts.digest ?? (await c.get(id)).digest }); return c }

const home = mkdtempSync(join(tmpdir(), 'ruyix-surfaces-'))
try {
  const read = f => { try { return readFileSync(join(home, f), 'utf8') } catch { return null } }
  const layout0 = '{"preset":"dev","plugins":{"@ruyix/social":false}}\n'
  writeFileSync(join(home, 'layout.json'), layout0)
  let t = 1_800_000_000_000
  const entries = [{ id: 'inbox', label: 'Inbox', group: 'Workbench' }, { id: 'runs', label: 'Runs', group: 'Workbench' }, { id: 'clips', label: 'Clips', group: 'Apps' }]
  const changes = createChanges({ home, entries: () => entries, now: () => (t += 1000) })
  const code = async f => { try { await f(); return 'ok' } catch (err) { return err.code } }

  // A stale desktop write cannot remove widgets that were added meanwhile.
  assert.equal(read('desktop.json'), null)
  await changes.setDesktop({ widgets: [{ id: 'a1', type: 'clock', size: 'sm' }] }, null)
  const base = JSON.parse(read('desktop.json')).widgets
  await changes.setDesktop({ widgets: [...base, { id: 'a2', type: 'note', size: 'sm' }] })
  await assert.rejects(changes.setDesktop({ widgets: base }, base), e => e.code === 'stale')
  assert.deepEqual(JSON.parse(read('desktop.json')).widgets.map(w => w.id), ['a1', 'a2'])
  await changes.setDesktop({ widgets: null })
  // the layout: nav and identity only, known entries only; nothing written until applied
  assert.equal(await code(() => changes.propose({ summary: 'x', edits: [{ surface: 'layout', value: { preset: 'devops' } }] })), 'invalid', 'the preset is the Settings page\'s')
  assert.equal(await code(() => changes.propose({ summary: 'x', edits: [{ surface: 'layout', value: { nav: { order: ['nope'] } } }] })), 'invalid', 'an entry the sidebar does not have')
  assert.equal(await code(() => changes.propose({ summary: 'x', edits: [{ surface: 'files', value: {} }] })), 'invalid', 'no such surface')
  assert.equal(await code(() => changes.propose({ summary: '', edits: [{ surface: 'layout', value: { nav: {} } }] })), 'badChange')
  const a = await changes.propose({ summary: 'Runs first, Clips hidden', edits: [{ surface: 'layout', value: { nav: { order: ['runs'], hidden: ['clips'] } } }], by: 'agent s1' })
  assert.equal(a.state, 'proposed')
  assert.deepEqual(a.diff, ['layout.nav.order: — → Runs', 'layout.nav.hidden: — → Clips'], 'entries by their labels')
  assert.equal(read('layout.json'), layout0, 'a proposal writes nothing')
  const v0 = await changes.version()
  assert.equal((await changes.apply(a.id, { by: 'me' })).state, 'applied')
  assert.deepEqual(JSON.parse(read('layout.json')), { preset: 'dev', plugins: { '@ruyix/social': false }, nav: { order: ['runs'], hidden: ['clips'] } }, 'the rest of the layout stays')
  assert.notEqual(await changes.version(), v0, 'the page sees it moved')
  assert.equal(await code(() => changes.apply(a.id)), 'notProposed', 'once')
  assert.equal(await code(() => changes.propose({ summary: 'same', edits: [{ surface: 'layout', value: { nav: { order: ['runs'], hidden: ['clips'] } } }] })), 'noChange')

  // the theme: colours only, known tokens only, readable text
  const theme = tokens => () => changes.propose({ summary: 'theme', edits: [{ surface: 'theme', value: { name: 'T', tokens } }] })
  assert.equal(await code(theme({ '--ruyix-accent': 'red; } body { background: url(https://x.example/a.png)' })), 'invalid', 'no CSS but a colour')
  assert.equal(await code(theme({ '--ruyix-accent': 'var(--x)' })), 'invalid')
  assert.equal(await code(theme({ '--ruyix-radius': '#123456' })), 'invalid', 'not a colour token')
  assert.equal(await code(theme({ '--ruyix-nope': '#123456' })), 'invalid')
  assert.equal(await code(theme({ '--ruyix-text': ['#eeeeee', '#d9e3ef'] })), 'invalid', 'pale text on the white surface')
  assert.ok(contrast('#000000', '#ffffff') > 20 && contrast('#777777', '#777777') === 1)
  assert.deepEqual(Object.keys(TOKENS), [...readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').matchAll(/^\s*(--ruyix-[a-z0-9-]+):/gm)].map(m => m[1]).filter(n => !n.startsWith('--ruyix-radius')), 'every colour token of tokens.css, none of its radii')
  const b = await theme({ '--ruyix-accent': ['#6d4bb3', '#b9a3f0'] })()
  await changes.apply(b.id)
  assert.equal(themeCss(JSON.parse(read('theme.json'))), 'body { --ruyix-accent: light-dark(#6d4bb3, #b9a3f0); }')
  assert.deepEqual((await changes.get(b.id)).colours, [['--ruyix-accent', '#6d4bb3', '#b9a3f0']], 'the page draws them')
  assert.match((await changes.page()).themeCss, /--ruyix-accent: light-dark/)
  assert.deepEqual((await changes.page()).nav, { order: ['runs'], hidden: ['clips'] })

  // Apply is bound to what the person reviewed: without its digest, or with another's, nothing is applied
  const raw = create({ home, entries: () => entries })
  const rv = await raw.propose({ summary: 'reviewed', edits: [{ surface: 'layout', value: { identity: { name: 'Reviewed' } } }] })
  assert.equal(await code(() => raw.apply(rv.id)), 'stale', 'no digest')
  assert.equal(await code(() => raw.apply(rv.id, { digest: 'f'.repeat(64) })), 'stale', 'another digest')
  const rec = JSON.parse(read(`changes/${rv.id}.json`)); rec.files[0].after = rec.files[0].after.replace('Reviewed', 'Unseen'); writeFileSync(join(home, `changes/${rv.id}.json`), JSON.stringify(rec))
  assert.equal(await code(() => raw.apply(rv.id, { digest: rv.digest })), 'stale', 'its record changed since it was reviewed')
  await raw.discard(rv.id)
  // undo: back to the bytes before (no theme file at all); twice is refused
  await changes.undo(b.id)
  assert.equal(read('theme.json'), null)
  assert.equal(await code(() => changes.undo(b.id)), 'notApplied')

  // stale: the file moved after the proposal → not applied
  const c = await changes.propose({ summary: 'name', edits: [{ surface: 'layout', value: { identity: { name: 'Mine', color: '#2563eb' } } }] })
  writeFileSync(join(home, 'layout.json'), `${read('layout.json').trim()} \n`)
  assert.equal(await code(() => changes.apply(c.id)), 'stale')
  await changes.discard(c.id)
  assert.equal((await changes.get(c.id)).state, 'discarded')

  // a later change over the same file: undoing the earlier is refused; restoring to it undoes both, all or nothing
  const before = read('layout.json')
  const d = await changes.propose({ summary: 'hide inbox', edits: [{ surface: 'layout', value: { nav: { order: [], hidden: ['inbox'] } } }] }); await changes.apply(d.id)
  const e = await changes.propose({ summary: 'a name', edits: [{ surface: 'layout', value: { identity: { name: 'Mine' } } }] }); await changes.apply(e.id)
  assert.equal(await code(() => changes.undo(d.id)), 'moved')
  writeFileSync(join(home, 'theme.json'), '{"tokens":{"--ruyix-accent":"#123456"}}\n') // outside the changes: not theirs to touch
  assert.deepEqual((await changes.restore(d.id)).undone, [e.id, d.id])
  assert.equal(read('layout.json'), before, 'byte for byte')
  const rs = await changes.get(await changes.last())
  assert.deepEqual([rs.undoes, rs.state, (await changes.get(d.id)).state, (await changes.get(e.id)).state, (await changes.get(a.id)).state], [[e.id, d.id], 'applied', 'undone', 'undone', 'applied'], 'a restore is a change too (it can be undone); what came before it stays applied')
  const f = await changes.propose({ summary: 'show inbox', edits: [{ surface: 'layout', value: { nav: { order: ['runs'], hidden: [] } } }] }); await changes.apply(f.id)
  writeFileSync(join(home, 'layout.json'), '{"preset":"dev"}\n') // a hand edit after it
  assert.equal(await code(() => changes.restore(f.id)), 'moved')
  assert.equal(read('layout.json'), '{"preset":"dev"}\n', 'a restore that cannot finish writes nothing')

  // a broken file never breaks the page
  writeFileSync(join(home, 'theme.json'), '{nope')
  assert.deepEqual(await changes.page(), { themeCss: '', desktop: DESKTOP_DEFAULT, desktopProblem: '', nav: null, themeName: '', myBoards: [] })
  assert.equal(await code(() => changes.propose({ summary: 't', edits: [{ surface: 'theme', value: null }] })), 'ok', 'a broken theme can still be removed')

  // the desktop: known values only; the keys given replace those keys (null: that key's default); the person's own
  // choice is written at once, an agent's waits for the person like any change; a broken file is the default desktop
  assert.equal(await code(() => changes.propose({ summary: 'd', edits: [{ surface: 'desktop', value: { wallpaper: 'beach' } }] })), 'invalid', 'a wallpaper there is not')
  assert.equal(await code(() => changes.propose({ summary: 'd', edits: [{ surface: 'desktop', value: { mode: 'tiles' } }] })), 'invalid')
  assert.equal(await code(() => changes.propose({ summary: 'd', edits: [{ surface: 'desktop', value: { glass: 'yes' } }] })), 'invalid')
  assert.equal(await code(() => changes.propose({ summary: 'd', edits: [{ surface: 'desktop', value: { theme: 'x' } }] })), 'invalid', 'a theme there is not')
  assert.equal(await code(() => changes.propose({ summary: 'd', edits: [{ surface: 'desktop', value: { look: 'x' } }] })), 'invalid', 'only the desktop\'s own keys')
  assert.equal(await code(() => changes.propose({ summary: 'd', edits: [{ surface: 'desktop', value: { scale: 3 } }] })), 'invalid', 'an interface size of the list only')
  assert.equal(checkDesktop({ scale: 1.25 }).scale, 1.25)
  // every wallpaper: a group the pickers show, a tone for what sits on it, a scene that draws it (plain: none), four colours
  for (const w of WALLPAPERS) {
    assert.ok(WALLPAPER_GROUPS.includes(w.group), `${w.id}: its group`)
    assert.ok(['dark', 'light', 'auto'].includes(w.tone), `${w.id}: its tone`)
    assert.equal(SCENE_IDS.includes(w.id), w.id !== 'plain', `${w.id}: a scene draws it`)
    assert.ok(w.id === 'plain' ? !w.c.length : w.c.length === 4 && w.c.every(c => /^#[0-9a-f]{6}$/.test(c)), `${w.id}: its colours`)
  }
  assert.deepEqual(SCENE_IDS.filter(id => !WALLPAPERS.some(w => w.id === id)), [], 'no scene without its wallpaper')
  assert.equal(checkDesktop({ wallpaper: 'moonlit' }).wallpaper, 'moonlit')
  // 'auto': smaller on a small desk, never below 0.8; never larger than 1 (a large screen gives room); a chosen size is itself
  assert.equal(scaleOf('auto', 1440, 780), 0.85, 'a 13-inch laptop\'s browser: smaller'); assert.equal(scaleOf('auto', 1600, 900), 1)
  assert.equal(scaleOf('auto', 1100, 600), 0.8, 'never below 0.8'); assert.equal(scaleOf('auto', 1920, 1000), 1, 'a large screen: room, not larger text'); assert.equal(scaleOf('auto', 2560, 1300), 1); assert.equal(scaleOf('auto', 5120, 2700), 1)
  assert.equal(scaleOf(1.25, 2560, 1440), 1.25, 'larger is a choice')
  assert.equal(scaleOf(0.9, 2560, 1440), 0.9)
  // the system style's dials: known names only; a choice other than standard is written on body
  assert.equal(await code(() => changes.propose({ summary: 'd', edits: [{ surface: 'desktop', value: { density: 'tiny' } }] })), 'invalid')
  assert.equal(desktopCss(checkDesktop({ density: 'compact', corners: 'large' })), 'body { --ruyix-density: 0.88; --ruyix-radius-k: 1.4; }')
  // the widgets: a list of { id, type, size } (or null, the default set); ids once each, at most 24
  assert.deepEqual(checkDesktop({ widgets: [{ id: 'a1', type: 'clock', size: 'sm' }, { id: 'b2', type: 'overview:workbench', size: 'md' }, { id: 'c3', type: 'apps:launcher', size: 'md' }] }).widgets.map(w => w.type), ['clock', 'overview:workbench', 'apps:launcher'])
  for (const bad of [[{ id: 'a1', type: 'clock', size: 'xl' }], [{ id: 'A!', type: 'clock', size: 'sm' }], [{ id: 'a', type: 'Clock', size: 'sm' }], [{ id: 'a', type: 'clock', size: 'sm' }, { id: 'a', type: 'note', size: 'md' }], 'clock'])
    assert.equal(await code(() => changes.propose({ summary: 'w', edits: [{ surface: 'desktop', value: { widgets: bad } }] })), 'invalid', JSON.stringify(bad))
  assert.equal(await code(() => changes.propose({ summary: 'w', edits: [{ surface: 'desktop', value: { widgets: Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, type: 'note', size: 'sm' })) } }] })), 'invalid', 'at most 24')
  assert.deepEqual(await changes.setDesktop({ wallpaper: 'night' }), { ...DESKTOP_DEFAULT, wallpaper: 'night' })
  assert.deepEqual(await changes.setDesktop({ accent: 'rose', motion: false }), { ...DESKTOP_DEFAULT, wallpaper: 'night', accent: 'rose', motion: false }, 'the keys given, the rest kept')
  assert.equal(await code(() => changes.setDesktop({ accent: 'gold' })), 'badDesktop')
  assert.match((await changes.page()).themeCss, /--ruyix-accent: light-dark\(#c0265e, #ff8fb3\)/, 'the accent reaches the page')
  const dk = await changes.propose({ summary: 'Night is too dark: haze, still', edits: [{ surface: 'desktop', value: { wallpaper: 'haze', motion: null } }], by: 'agent s1' })
  assert.equal((await changes.page()).desktop.wallpaper, 'night', 'nothing changes until the person applies it')
  await changes.apply(dk.id)
  assert.deepEqual((await changes.page()).desktop, { ...DESKTOP_DEFAULT, wallpaper: 'haze', accent: 'rose' }, 'motion back to its default')
  await changes.undo(dk.id)
  assert.equal((await changes.page()).desktop.wallpaper, 'night', 'undone')
  // desktop.json edited by hand into something wrong: the desktop as it last was right, and what is wrong said
  const kept = (await changes.page()).desktop
  for (const broken of ['{nope', '{"wallpaper":"beach"}']) {
    writeFileSync(join(home, 'desktop.json'), broken)
    const p = await changes.page()
    assert.deepEqual(p.desktop, kept, `${broken}: the desktop stays`)
    assert.ok(p.desktopProblem, `${broken}: said`)
  }
  writeFileSync(join(home, 'desktop.json'), '{"wallpaper":"ink"}')
  assert.deepEqual([(await changes.page()).desktop.wallpaper, (await changes.page()).desktopProblem], ['ink', ''], 'right again: followed')
  rmSync(join(home, 'desktop.json'))
  assert.equal(desktopCss(checkDesktop({})), '', 'the default accent is the tokens\' own')
  for (const a of ACCENTS) for (const [mine, ground] of [[a.light, '#ffffff'], [a.light, '#f3f5f8'], [a.dark, '#2b333f'], [a.dark, '#22272f']]) assert.ok(contrast(mine, ground) >= 4.5, `${a.id} on ${ground}`)
  // the tints: each text 4.5:1 or more on each ground, light and dark (a tint's own text, else Ruyix's), every accent on the surface and the canvas (as Ruyix's own)
  const own = n => TOKENS[n].value.match(/#[0-9a-f]{6}/gi)
  for (const [id, tint] of Object.entries(TINTS)) for (const i of [0, 1]) {
    const v = n => (tint?.[n] || own(n))[i]
    for (const ground of ['--ruyix-surface', '--ruyix-canvas', '--ruyix-surface-sunk']) {
      for (const text of ['--ruyix-text', '--ruyix-text-muted', '--ruyix-text-dim']) assert.ok(contrast(v(text), v(ground)) >= 4.5, `${id} ${i ? 'dark' : 'light'}: ${text} on ${ground} ${contrast(v(text), v(ground)).toFixed(2)}`)
      if (ground !== '--ruyix-surface-sunk') for (const a of ACCENTS) assert.ok(contrast(i ? a.dark : a.light, v(ground)) >= 4.5, `${id} ${i ? 'dark' : 'light'}: ${a.id} on ${ground}`)
    }
  }
  assert.match(desktopCss(checkDesktop({ tint: 'warm' })), /--ruyix-canvas: light-dark\(#f4f0e8, #25221e\)/)
  // the themes: each one's keys make a right desktop; choosing one writes them with its id; a key changed after is said
  assert.equal(new Set(THEMES.map(t => t.id)).size, THEMES.length)
  for (const t of THEMES) {
    const d = checkDesktop(themePatch(t.id))
    assert.deepEqual([d.theme, d.wallpaper, d.accent, d.tint, d.corners], [t.id, t.wallpaper, t.accent, t.tint, t.corners])
    assert.ok([null, 'light', 'dark'].includes(t.appearance) && t.zh && t.en, t.id)
    assert.deepEqual(themeOf(d).changed, [])
  }
  assert.deepEqual(themeOf(checkDesktop({ ...themePatch('hills'), accent: 'blue', wallpaper: 'night' })).changed, ['wallpaper', 'accent'])
  assert.equal(themeOf(checkDesktop({})).theme, null)
  assert.equal(themePatch('nope'), undefined)

  // personal boards: checked before they are kept; built-in datasets by name, its own named my-…
  const board = (id, extra = {}) => ({ surface: 'boards', id, value: {
    dashboard: { kind: 'dashboard', name: id, version: '1.0.0', title: { zh: '今天的错误', en: 'Errors today' }, datasets: { s: 'gitlab-open-mrs@*', m: 'my-errors--fatal@*' },
      pages: [{ id: 'main', title: { zh: '概览', en: 'Overview' }, widgets: [{ id: 'n', data: 's', view: 'count', size: 's', title: { zh: '未解决', en: 'Unresolved' } }, { id: 'f', data: 'm', view: 'table', columns: ['title', 'updated'], size: 'l', title: { zh: '致命', en: 'Fatal' } }] }] },
    datasets: { 'my-errors--fatal': { kind: 'dataset', name: 'my-errors--fatal', version: '1.0.0', title: { zh: '致命错误', en: 'Fatal errors' }, connector: 'gitlab', op: 'mrs.list', params: { project: '{{settings.gitlab.project}}', state: 'merged' }, fields: { title: 'string', updated: 'time' }, refresh: '10m' } },
    ...extra } })
  assert.equal(await code(() => changes.propose({ summary: 'b', edits: [board('errors')] })), 'invalid', 'a board\'s id is my-…')
  assert.equal(await code(() => changes.propose({ summary: 'b', edits: [{ ...board('my-errors'), id: '../x' }] })), 'invalid')
  { const b0 = board('my-errors'); b0.value.dashboard.datasets.s = 'prod-nope@*'; assert.match(String(await (async () => { try { await changes.propose({ summary: 'b', edits: [b0] }) } catch (e) { return e.message } })()), /prod-nope is neither/) }
  { const b0 = board('my-errors'); b0.value.datasets = { fatal: { ...b0.value.datasets['my-errors--fatal'], name: 'fatal' } }; assert.equal(await code(() => changes.propose({ summary: 'b', edits: [b0] })), 'invalid', 'its own datasets are my-…') }
  { const b0 = board('my-errors'); b0.value.dashboard.pages[0].widgets[1].columns = ['nope']; assert.equal(await code(() => changes.propose({ summary: 'b', edits: [b0] })), 'invalid', 'a column its dataset does not give') }
  const bb = await changes.propose({ summary: '今天的错误看板', edits: [board('my-errors')] })
  assert.equal(bb.diff[0], 'board my-errors: — → 今天的错误 · 2 widgets · gitlab-open-mrs, my-errors--fatal', 'a board\'s summary first')
  assert.ok(bb.diff.includes('board my-errors.datasets.my-errors--fatal.params.state: — → "merged"'), 'then all it sets')
  await changes.apply(bb.id)
  assert.equal(JSON.parse(read('boards/my-errors.json')).dashboard.name, 'my-errors')
  assert.deepEqual((await changes.page()).myBoards, ['my-errors'])
  await changes.apply((await changes.propose({ summary: 'remove it', edits: [{ surface: 'boards', id: 'my-errors', value: null }] })).id)
  assert.equal(read('boards/my-errors.json'), null)
  await changes.undo(await changes.last())
  assert.deepEqual((await changes.page()).myBoards, ['my-errors'], 'undoing the removal brings it back')

  // the tools: they propose (a change, an undo), never apply; the page lists what waits
  const tools = Object.fromEntries(surfaceTools({ changes, entries: () => entries, home }).map(x => [x.name, x]))
  assert.deepEqual(Object.keys(tools), ['ruyix_surfaces', 'ruyix_change_propose', 'ruyix_change_undo', 'ruyix_changes'], 'no tool applies')
  assert.match((await tools.ruyix_surfaces.execute({})).text, /- runs · Runs · Workbench[\s\S]*--ruyix-accent: light-dark\(#0f766e, #5eead4\) · actions/)
  const p = (await tools.ruyix_change_propose.execute({ summary: '运行放第一位', edits: [{ surface: 'layout', value: { nav: { order: ['runs', 'inbox'], hidden: [] } } }] }, { agent: { session: { id: 's9' } } })).text
  assert.match(p, /^Proposed — waiting for the person[^\n]*\nc[0-9a-z]+ \[proposed\] 运行放第一位\n  layout\.nav\.order: — → Runs, Inbox\n/)
  assert.match((await tools.ruyix_change_propose.execute({ summary: 'x', edits: [{ surface: 'theme', value: { tokens: { '--ruyix-accent': 'url(x)' } } }] })).text, /^Not proposed: edit 1 \(theme\)/)
  const id = p.match(/\n(c[0-9a-z]{9,}) /)[1]
  assert.equal((await changes.get(id)).by, 'agent s9')
  assert.ok((await changes.pending()).some(x => x.id === id), 'the page\'s card lists it')
  await changes.apply(id, { by: 'the person (ruyix page)' })
  assert.ok(!(await changes.pending()).some(x => x.id === id))
  // an agent's undo is a proposal of the reverse; applying it undoes the change
  assert.match((await tools.ruyix_change_undo.execute({ id: 'cnope00000' })).text, /^Not proposed: no change/)
  const u = (await tools.ruyix_change_undo.execute({ id })).text, uid = u.match(/\n(c[0-9a-z]+)/)[1]
  assert.match(u, /\[proposed\] ↶ 运行放第一位/)
  assert.equal((await changes.get(id)).state, 'applied', 'nothing undone until the person applies it')
  const navNow = read('layout.json')
  await changes.apply(uid)
  assert.equal((await changes.get(id)).state, 'undone')
  assert.notEqual(read('layout.json'), navNow)
  assert.equal(JSON.parse(read('layout.json')).nav, undefined, 'back to no nav at all')
  assert.match((await tools.ruyix_changes.execute({})).text, /\[applied\] ↶ 运行放第一位[\s\S]*\[undone\] 运行放第一位/)

  // ruyix changes (the command line, which an agent's shell may run): the last applied is an undo — undoing it would bring
  // back what the person took away, so it is refused; the person's own undo on the page does it
  const cli = spawnSync(process.execPath, [new URL('./bin/ruyix-changes.mjs', import.meta.url).pathname, 'undo'], { env: { ...process.env, RUYIX_HOME: home }, encoding: 'utf8' })
  assert.equal(cli.status, 1); assert.match(cli.stderr, /is an undo/)
  assert.equal(JSON.parse(read('layout.json')).nav, undefined, 'nothing brought back')
  await changes.undo(uid, { by: 'the person (ruyix page)' })
  assert.equal(JSON.parse(read('layout.json')).nav.order[0], 'runs')
  assert.equal((await changes.get(id)).state, 'applied', 'an undo undone: what it reversed reads applied again')
  assert.deepEqual((await changes.get(await changes.last())).undoes, [uid], 'the last applied: the person\'s undo (by the sequence, not the clock)')
} finally { rmSync(home, { recursive: true, force: true }) }

// the review's cases: one sequence (not the clock) orders the changes; proposals never push out what is applied; a
// write that fails, or a crash, leaves the files as they were; the lock is one writer at a time; checks that bite
{
  const home = mkdtempSync(join(tmpdir(), 'ruyix-surfaces2-')), read = f => { try { return readFileSync(join(home, f), 'utf8') } catch { return null } }
  const code = async f => { try { await f(); return 'ok' } catch (err) { return err.code } }
  try {
    const { chmodSync, mkdirSync, existsSync, readdirSync } = await import('node:fs')
    const { withLock } = await import('./lock.js')
    // a home whose socket file would be longer than a socket's address takes (104 bytes on macOS): the lock still holds
    { const deep = join(home, 'x'.repeat(120)); mkdirSync(deep); assert.equal(await withLock(deep, async () => 'held'), 'held') }
    const changes = createChanges({ home, now: () => 1_900_000_000_000 }) // every change in the same millisecond
    const nav = (order, summary = 'x') => changes.propose({ summary, edits: [{ surface: 'layout', value: { nav: { order, hidden: [] } } }] })
    const A = await nav(['a1'], 'A'); await changes.apply(A.id)
    const B = await changes.propose({ summary: 'B', edits: [{ surface: 'theme', value: { tokens: { '--ruyix-accent': ['#123456', '#9cb9dd'] } } }] }); await changes.apply(B.id)
    await changes.restore(B.id)
    assert.deepEqual([(await changes.get(A.id)).state, (await changes.get(B.id)).state, read('theme.json')], ['applied', 'undone', null], 'a restore to before B in the same millisecond as A leaves A alone')
    // proposals: 20 wait at most; past 200 records the oldest never applied go, the applied ones stay
    const waits = []
    for (let i = 0; i < 19; i++) waits.push(await nav([`p${i}`]))
    assert.equal(await code(() => nav(['p20'])), 'ok')
    assert.equal(await code(() => nav(['p21'])), 'tooMany', 'an agent cannot flood the person')
    for (const w of [...waits, ...(await changes.pending())]) await code(() => changes.discard(w.id))
    for (let i = 0; i < 200; i++) await changes.discard((await nav([`q${i}`])).id)
    assert.ok((await changes.list({ limit: 1000 })).length <= 200)
    assert.equal((await changes.get(A.id)).state, 'applied', 'the applied ones stay')
    assert.equal(await code(() => changes.undo(A.id)), 'ok', 'and can still be undone')
    // a write that fails halfway (its first file written, its second refused): the first put back, the change still waiting
    mkdirSync(join(home, 'boards'), { recursive: true })
    const brd = { dashboard: { kind: 'dashboard', name: 'my-h', version: '1.0.0', datasets: { s: 'gitlab-open-mrs@*' }, pages: [{ id: 'p', title: { zh: 'p', en: 'p' }, widgets: [{ id: 'w', data: 's', view: 'count' }] }] } }
    const two = await changes.propose({ summary: 'two files', edits: [{ surface: 'layout', value: { identity: { name: 'N' } } }, { surface: 'boards', id: 'my-h', value: brd }] })
    const layoutBefore = read('layout.json')
    chmodSync(join(home, 'boards'), 0o500) // the board cannot be written; the layout before it can
    assert.notEqual(await code(() => changes.apply(two.id)), 'ok')
    chmodSync(join(home, 'boards'), 0o700)
    assert.deepEqual([read('layout.json'), read('boards/my-h.json'), (await changes.get(two.id)).state, existsSync(join(home, 'changes/.commit.json'))], [layoutBefore, null, 'proposed', false], 'nothing half done')
    // a crash mid-commit (the process ends between moving the old file aside and putting the new one in place)
    const { spawnSync: run } = await import('node:child_process')
    const surfUrl = new URL('./surfaces.js', import.meta.url).href
    const crash = edits => run(process.execPath, ['--input-type=module', '-e', `import { createChanges } from ${JSON.stringify(surfUrl)}
      const c = createChanges({ home: ${JSON.stringify(home)}, beforeWrite: (phase, step) => { if (phase === 'place' && !step.path.startsWith('changes/')) process.exit(9) } })
      const p = await c.propose({ summary: 'crash', edits: ${JSON.stringify(edits)} }); await c.apply(p.id, { digest: p.digest })`]).status
    const { writeLayout } = await import('./bin/ruyix-plugin.mjs')
    const L0 = read('layout.json')
    assert.equal(crash([{ surface: 'layout', value: { identity: { name: 'Crash' } } }]), 9)
    assert.deepEqual([read('layout.json'), existsSync(join(home, 'changes/.commit.json'))], [null, true], 'cut short: the old file aside, the log there')
    await writeLayout(home, l => ({ ...l, preset: 'dev' })) // the next to take the lock (the layout's own writer) undoes it first
    assert.deepEqual(JSON.parse(read('layout.json')), { ...JSON.parse(L0 || '{}'), preset: 'dev' }, 'put back, then the writer\'s own change')
    assert.equal(existsSync(join(home, 'changes/.commit.json')), false)
    // ruyix start's plugin sync reads the layout under the lock: a crash that moved it aside is undone before it reads
    const L2 = read('layout.json')
    assert.equal(crash([{ surface: 'layout', value: { identity: { name: 'AtStart' } } }]), 9)
    const { readLayout } = await import('./bin/ruyix-plugin.mjs')
    assert.deepEqual(await withLock(home, () => readLayout(home)), JSON.parse(L2), 'read as it was, not as {}')
    // a hand edit after the crash stays (what the commit moved aside is kept beside it, never put over it)
    const L1 = read('layout.json')
    assert.equal(crash([{ surface: 'layout', value: { identity: { name: 'Crash2' } } }]), 9)
    writeFileSync(join(home, 'layout.json'), '{"preset":"dev","by":"hand"}\n')
    await changes.settle()
    assert.equal(read('layout.json'), '{"preset":"dev","by":"hand"}\n', 'the hand edit stays')
    assert.ok(readdirSync(home).some(n => n.startsWith('layout.json.') && n.endsWith('.was')), 'the old revision kept aside')
    for (const n of readdirSync(home).filter(n => n.startsWith('layout.json.'))) rmSync(join(home, n))
    writeFileSync(join(home, 'layout.json'), L1)
    // a read undoes a commit a crash cut short before it reads (no write needed)
    assert.equal(crash([{ surface: 'layout', value: { identity: { name: 'Crash3' } } }]), 9)
    await changes.page()
    assert.equal(read('layout.json'), L1)
    for (const p of await changes.pending()) await changes.discard(p.id) // the "two files" one among them
    // undos of undos, three deep: each change reads what the chain makes it
    const D0 = await nav(['deep'], 'D0'); await changes.apply(D0.id)
    await changes.undo(D0.id)
    const u1 = (await changes.list({ limit: 300 })).find(x => x.undoes?.[0] === D0.id).id
    await changes.undo(u1); const u2 = (await changes.list({ limit: 300 })).find(x => x.undoes?.[0] === u1).id
    await changes.undo(u2); const u3 = (await changes.list({ limit: 300 })).find(x => x.undoes?.[0] === u2).id
    assert.deepEqual(await Promise.all([D0.id, u1, u2, u3].map(async x => (await changes.get(x)).state)), ['undone', 'applied', 'undone', 'applied'], 'A undone again once the undo of its undo is undone')
    assert.equal(await code(() => changes.undo(D0.id)), 'notApplied')
    // undoing a change that a later change in effect touched: refused, whatever the bytes say (A, B, then C back to A's bytes)
    const A1 = await nav(['aba-x'], 'A'); await changes.apply(A1.id)
    const B1 = await nav(['aba-y'], 'B'); await changes.apply(B1.id)
    const C1 = await nav(['aba-x'], 'C'); await changes.apply(C1.id)
    assert.equal(await code(() => changes.undo(A1.id)), 'moved', 'C is in effect on the same file')
    // an undo proposed, its target undone meanwhile and its bytes back: applying it is refused (worked out again)
    const U = await changes.proposeUndo(C1.id)
    await changes.undo(C1.id)
    await changes.apply((await nav(['aba-x'], 'C again')).id)
    assert.equal(await code(() => changes.apply(U.id)), 'stale')
    await changes.discard(U.id)
    // a save by hand between the look and the write (an editor takes no lock): theirs stays, the apply is refused
    let poke = null
    const racy = createChanges({ home, beforeWrite: () => { poke?.(); poke = null } })
    const R = await racy.propose({ summary: 'racy', edits: [{ surface: 'theme', value: { tokens: { '--ruyix-success': ['#226633', '#8fbfa7'] } } }] })
    poke = () => writeFileSync(join(home, 'theme.json'), '{"tokens":{"--ruyix-success":"#123123"}}\n')
    assert.equal(await code(() => racy.apply(R.id)), 'stale')
    assert.equal(read('theme.json'), '{"tokens":{"--ruyix-success":"#123123"}}\n', 'the hand save stays')
    rmSync(join(home, 'theme.json')); await racy.discard(R.id)
    // the person deletes the file just before it is moved aside: their deletion stands, nothing comes back
    writeFileSync(join(home, 'theme.json'), '{"tokens":{"--ruyix-success":["#226633","#8fbfa7"]}}\n')
    let unsave = null
    const racy2 = createChanges({ home, beforeWrite: (phase, step) => { if (phase === 'move' && step.path === 'theme.json') { unsave?.(); unsave = null } } })
    const DEL = await racy2.propose({ summary: 'no theme', edits: [{ surface: 'theme', value: null }] })
    unsave = () => rmSync(join(home, 'theme.json'))
    assert.equal(await code(() => racy2.apply(DEL.id)), 'stale')
    assert.equal(read('theme.json'), null, 'their deletion stands (nothing brought back)')
    await racy2.discard(DEL.id)
    // an old proposal applied now is at the top of the history
    const OLD = await nav(['old-one'])
    for (let i = 0; i < 52; i++) await changes.discard((await nav([`newer${i}`])).id)
    await changes.apply(OLD.id)
    assert.ok((await changes.list()).some(x => x.id === OLD.id && x.state === 'applied'), 'its Undo is there')
    // undone, then its undo undone after much else: applied again, and at the top again
    await changes.undo(OLD.id)
    for (let i = 0; i < 52; i++) await changes.discard((await nav([`later${i}`])).id)
    await changes.undo((await changes.list()).find(x => x.undoes?.[0] === OLD.id).id)
    assert.ok((await changes.list()).some(x => x.id === OLD.id && x.state === 'applied'), 'brought back: listed')
    // the lock, in this process: callers one after another, never overlapping
    const seen = []
    await Promise.all([1, 2, 3].map(n => withLock(home, async () => { seen.push(`in${n}`); await new Promise(r => setTimeout(r, 20)); seen.push(`out${n}`) })))
    assert.deepEqual(seen, ['in1', 'out1', 'in2', 'out2', 'in3', 'out3'])
    // every waiting proposal is listed, however much history is newer
    const W = await nav(['wait-listed'])
    for (let i = 0; i < 55; i++) await changes.discard((await nav([`hist${i}`])).id)
    assert.ok((await changes.list()).some(x => x.id === W.id), 'Settings → Changes shows it')
    await changes.discard(W.id)
    // a waiting proposal is never pruned (past 200 records only discarded ones go)
    const P1 = await nav(['keep-1']), P2 = await nav(['keep-2'])
    assert.deepEqual([(await changes.get(P1.id)).state, (await changes.get(P2.id)).state], ['proposed', 'proposed'])
    await changes.discard(P1.id); await changes.discard(P2.id)
    // the lock across processes: a live holder is waited for, never taken from, however long; one killed frees it at once
    const { spawn } = await import('node:child_process')
    const lockUrl = new URL('./lock.js', import.meta.url).href
    const holder = () => spawn(process.execPath, ['--input-type=module', '-e', `import { withLock } from ${JSON.stringify(lockUrl)}; await withLock(${JSON.stringify(home)}, async () => { process.stdout.write('in'); await new Promise(r => setTimeout(r, 60000)) })`])
    let child = holder()
    await new Promise(ok => child.stdout.once('data', ok))
    assert.equal(await code(() => withLock(home, () => {}, { wait: 300 })), 'busy', 'a live holder keeps it')
    child.kill('SIGKILL')
    await new Promise(ok => child.on('exit', ok))
    assert.equal(await code(() => withLock(home, () => {}, { wait: 300 })), 'ok', 'killed mid-hold: the kernel freed it, nothing to take over')
    // the command line never applies a proposal (an agent's shell could run it too)
    const prop = await nav(['cli-try'])
    const { spawnSync } = await import('node:child_process')
    const cli = spawnSync(process.execPath, [new URL('./bin/ruyix-changes.mjs', import.meta.url).pathname, 'apply', prop.id], { env: { ...process.env, RUYIX_HOME: home }, encoding: 'utf8' })
    assert.deepEqual([cli.status, (await changes.get(prop.id)).state], [2, 'proposed'], 'no apply there')
    await changes.discard(prop.id)
    // what a change says is shown, never run: a board's title with a terminal's escape (OSC 52 sets the clipboard)
    const osc = '\u001b]52;c;cHduZWQ=\u0007', bidi = '\u202e'
    const evil = await changes.propose({ summary: `evil ${osc}`, edits: [{ surface: 'boards', id: 'my-evil', value: { dashboard: { kind: 'dashboard', name: 'my-evil', version: '1.0.0', title: { zh: `t${osc}${bidi}`, en: 't' }, datasets: { s: 'gitlab-open-mrs@*' }, pages: [{ id: 'p', title: { zh: 'p', en: 'p' }, widgets: [{ id: 'w', data: 's', view: 'count' }] }] } } }] })
    for (const args of [['show', evil.id], ['list']]) {
      const o = spawnSync(process.execPath, [new URL('./bin/ruyix-changes.mjs', import.meta.url).pathname, ...args], { env: { ...process.env, RUYIX_HOME: home }, encoding: 'utf8' })
      assert.equal(o.status, 0, o.stderr)
      assert.ok(!/[\u001b\u0007\u202e]/.test(o.stdout) && (args[0] !== 'show' || o.stdout.includes('\\u001b]52')), `${args[0]}: shown escaped: ${JSON.stringify(o.stdout)}`)
    }
    await changes.discard(evil.id)
    // a crash while clearing up after a commit that went through: what it wrote stays, only leftovers go
    const crashClean = edits => run(process.execPath, ['--input-type=module', '-e', `import { createChanges } from ${JSON.stringify(surfUrl)}
      const c = createChanges({ home: ${JSON.stringify(home)}, beforeWrite: (phase, step) => { if (phase === 'clean' && step.path === 'layout.json') process.exit(9) } })
      const p = await c.propose({ summary: 'clean', edits: ${JSON.stringify(edits)} }); await c.apply(p.id, { digest: p.digest })`]).status
    assert.equal(crashClean([{ surface: 'layout', value: { identity: { name: 'Through' } } }]), 9)
    await changes.settle()
    assert.deepEqual([JSON.parse(read('layout.json')).identity, readdirSync(home).filter(n => /\.(new|was)$/.test(n)), existsSync(join(home, 'changes/.commit.json'))], [{ name: 'Through' }, [], false], 'through: kept, leftovers cleared')
    // a machine that stops keeps what reached the disk: every byte flushed when written, the log on the disk before a move,
    // everything in place on the disk before "done", the leftovers' removal on the disk before the log goes
    {
      const { createRequire, syncBuiltinESMExports } = await import('node:module')
      const fs = createRequire(import.meta.url)('node:fs'), ev = [], real = {}, fds = new Map()
      const at = p => String(p).slice(home.length + 1) || '.'
      const spy = (name, f) => { real[name] = fs[name]; fs[name] = (...a) => { const r = real[name](...a); ev.push(f(r, ...a)); return r } }
      spy('writeFileSync', (r, p, _, o) => `write ${at(p)}${o?.flush ? ' flushed' : ''}`)
      spy('renameSync', (r, a, b) => `rename ${at(a)} > ${at(b)}`)
      spy('linkSync', (r, a, b) => `link ${at(a)} > ${at(b)}`)
      spy('rmSync', (r, p) => `rm ${at(p)}`)
      spy('openSync', (fd, p) => { fds.set(fd, at(p)); return `open ${at(p)}` })
      spy('fsyncSync', (r, fd) => `sync ${fds.get(fd)}`)
      const p = await changes.propose({ summary: 'durable', edits: [{ surface: 'layout', value: { identity: { name: 'Durable' } } }] })
      syncBuiltinESMExports()
      try { await changes.apply(p.id) } finally { Object.assign(fs, real); syncBuiltinESMExports() }
      const first = re => ev.findIndex(e => re.test(e)), last = (re, before = ev.length) => ev.slice(0, before).findLastIndex(e => re.test(e))
      const between = (re, a, b) => ev.slice(a + 1, b).some(e => re.test(e))
      assert.ok(ev.filter(e => /^write .*\.(new|commit\.json\.\w+)( |$)/.test(e)).every(e => e.endsWith(' flushed')), `every byte flushed: ${ev.join(' | ')}`)
      const move = first(/^rename layout\.json > layout\.json\.\w+\.was$/), place = first(/^link layout\.json\.\w+\.new > layout\.json$/)
      const logBefore = last(/^rename changes\/\.commit\.json\.\w+ > changes\/\.commit\.json$/, move)
      assert.ok(move > 0 && logBefore >= 0 && between(/^sync changes$/, logBefore, move), 'the log on the disk before the move')
      const done = last(/^rename changes\/\.commit\.json\.\w+ > changes\/\.commit\.json$/) // the last the log says: "done"
      const placed = last(/^link .*\.new > /)
      assert.ok(place > move && done > placed && placed >= place && between(/^sync \.$/, placed, done) && between(/^sync changes$/, placed, done), `in place on the disk before "done": ${ev.join(' | ')}`)
      const logGone = first(/^rm changes\/\.commit\.json$/), lastLeft = last(/^rm layout\.json\.\w+\.(new|was)$/)
      assert.ok(logGone > lastLeft && between(/^sync \.$/, lastLeft, logGone), 'the leftovers\' removal on the disk before the log goes')
    }
    // going back after a failure leaves a file changed in place since it was put there (its words are not the commit's)
    const both = await changes.propose({ summary: 'both', edits: [{ surface: 'layout', value: { identity: { name: 'Both' } } }, { surface: 'theme', value: { tokens: { '--ruyix-success': ['#226633', '#8fbfa7'] } } }] })
    const inPlace = createChanges({ home, beforeWrite: (phase, step) => { if (phase === 'place' && step.path === 'theme.json') { writeFileSync(join(home, 'layout.json'), '{"edited":"in place"}\n', { flag: 'r+' }); throw new Error('boom') } } })
    assert.notEqual(await code(() => inPlace.apply(both.id)), 'ok')
    assert.equal(read('layout.json').startsWith('{"edited":"in place"}'), true, 'the in-place edit stays')
    for (const n of readdirSync(home).filter(n => /\.(new|was)$/.test(n))) rmSync(join(home, n))
    await changes.discard(both.id)
    writeFileSync(join(home, 'layout.json'), L1)
    // a commit log that cannot be read stops every writer (kept, for a person to look at)
    writeFileSync(join(home, 'changes/.commit.json'), '{garbage')
    assert.equal(await code(() => withLock(home, () => {})), 'brokenLog')
    assert.ok(existsSync(join(home, 'changes/.commit.json')))
    rmSync(join(home, 'changes/.commit.json'))
    // an entry hidden before, its plugin now off: a change of something else still goes
    const known = createChanges({ home, entries: () => [{ id: 'inbox', label: 'Inbox', group: 'W' }] })
    await known.apply((await known.propose({ summary: 'h', edits: [{ surface: 'layout', value: { nav: { order: [], hidden: ['inbox'] } } }] })).id)
    const gone = createChanges({ home, entries: () => [{ id: 'runs', label: 'Runs', group: 'W' }] })
    assert.equal(await code(() => gone.propose({ summary: 'n', edits: [{ surface: 'layout', value: { identity: { name: 'X' } } }] })), 'ok', 'its old hidden entry is no new one')
    assert.equal(await code(() => gone.propose({ summary: 'n', edits: [{ surface: 'layout', value: { nav: { order: [], hidden: ['inbox', 'nope'] } } }] })), 'invalid', 'a new one is checked')
    for (const p of await changes.pending()) await changes.discard(p.id)
    // the theme: text and its ground in #hex only (so their contrast is always checked)
    const t = tokens => code(() => changes.propose({ summary: 't', edits: [{ surface: 'theme', value: { tokens } }] }))
    assert.equal(await t({ '--ruyix-text': 'rgb(255 255 255)' }), 'invalid')
    assert.equal(await t({ '--ruyix-surface': '#fff0' }), 'invalid')
    assert.equal(await t({ '--ruyix-accent-alt': 'rgb(1..2 3 4)' }), 'invalid', 'a colour as CSS reads one')
    assert.equal(await t({ '--ruyix-accent-alt': 'oklch(0.5, 0.2, 30)' }), 'invalid')
    assert.equal(await t({ '--ruyix-accent-alt': 'oklch(0.62 0.15 300 / 90%)' }), 'ok')
    assert.equal(await t({ '--ruyix-accent-alt': 'hsl(0, 0, 0)' }), 'invalid', 'legacy hsl wants its percentages')
    assert.equal(await t({ '--ruyix-accent-alt': 'hsl(210deg, 40%, 50%)' }), 'ok')
    assert.equal(await t({ '--ruyix-accent-alt': 'oklab(0.5 0.1 30deg)' }), 'invalid', 'oklab has no angle')
    assert.equal(await t({ '--ruyix-accent-alt': 'rgb(10%, 20, 30)' }), 'invalid', 'legacy rgb: all numbers or all percentages')
    assert.equal(await t({ '--ruyix-surface-sunk': ['#344256', '#d9e3ef'] }), 'invalid', 'the diffs\' wells under the text')
    assert.equal(await t({ '--ruyix-selection': ['#4b6b94', '#9cb9dd'] }), 'invalid', 'a selected row under its words')
    assert.equal(await t({ '--ruyix-hover': ['#344256', '#d9e3ef'] }), 'invalid', 'a row under the pointer')
    assert.equal(await t({ '--ruyix-highlight': 'rgba(0 0 0 / 0)' }), 'invalid', 'the highlight is words too')
    assert.equal(await t({ '--ruyix-surface': ['#ffffff', '#0b0d10'], '--ruyix-text': ['#344256', '#26303c'], '--ruyix-highlight': ['#4b6b94', '#9cb9dd'] }), 'invalid', 'text on the selection derived from the surface')
    assert.equal(await t({ '--ruyix-surface': ['#fefefe', '#2a323e'] }), 'invalid', 'a ground the highlight is drawn on: the highlight said too (its default is dsh\'s, not checkable)')
    assert.equal(await t({ '--ruyix-surface': ['#fefefe', '#2a323e'], '--ruyix-highlight': ['#4b6b94', '#9cb9dd'] }), 'ok')
    assert.equal(await t({ '--ruyix-accent': ['#ffffff', '#2b333f'] }), 'invalid', 'the accent as words on the surface (and the Apply button\'s ground)')
    for (const p of await changes.pending()) await changes.discard(p.id)
    // boards: their own datasets named after the board, plain setting paths, every page with widgets, every change shown
    const ds = (name, params = {}) => ({ kind: 'dataset', name, version: '1.0.0', connector: 'gitlab', op: 'mrs.list', params, fields: { title: 'string' }, refresh: '10m' })
    const dash = (id, data, pages) => ({ kind: 'dashboard', name: id, version: '1.0.0', datasets: { d: `${data}@*` }, pages: pages || [{ id: 'p', title: { zh: 'p', en: 'p' }, widgets: [{ id: 'w', data: 'd', view: 'count' }] }] })
    const bd = (id, value) => code(() => changes.propose({ summary: 'b', edits: [{ surface: 'boards', id, value }] }))
    assert.equal(await bd('my-a', { dashboard: dash('my-a', 'my-shared'), datasets: { 'my-shared': ds('my-shared') } }), 'invalid', 'another board\'s name for its dataset')
    assert.equal(await bd('my-a', { dashboard: dash('my-a', 'my-a-b'), datasets: { 'my-a-b': ds('my-a-b') } }), 'invalid', '"<id>-…" is another board\'s id, not this one\'s data')
    assert.equal(await bd('my-a--b', { dashboard: dash('my-a--b', 'my-a--b--x'), datasets: {} }), 'invalid', 'no "--" in a board\'s id')
    assert.equal(await bd('my-a', { dashboard: dash('my-a', 'constructor'), datasets: {} }), 'invalid', 'an inherited name is no dataset')
    assert.equal(await bd('my-a', { dashboard: dash('my-a', 'my-a--x'), datasets: { 'my-a--x': { ...ds('my-a--x'), params: null } } }), 'invalid', 'params: an object')
    assert.equal(await bd('my-a', { dashboard: { ...dash('my-a', 'gitlab-open-mrs'), pages: [{ id: 'p', title: { zh: 'p', en: 'p' }, widgets: [{ id: 'w', data: 'd', view: 'breakdown', by: '__proto__' }] }] }, datasets: {} }), 'invalid', 'an inherited field is no field')
    assert.equal(await bd('my-a', { dashboard: { ...dash('my-a', 'gitlab-open-mrs'), datasets: { d: 'gitlab-open-mrs@999.0.0' } }, datasets: {} }), 'invalid', 'a version that does not resolve')
    assert.equal(await bd('my-a', { dashboard: { ...dash('my-a', 'gitlab-open-mrs'), pages: [{ id: 'p', title: { zh: 'p', en: 'p' }, widgets: [{ id: 'w', data: 'd', view: 'count', filter: { pipeline: [{ toString: 'x', valueOf: null }] } }] }] }, datasets: {} }), 'invalid', 'a filter value that only looks like one')
    // the list and the poll carry no diffs; one change is fetched whole; what waits is bounded in size too
    const big = n => ({ dashboard: { ...dash(`my-big${n}`, 'gitlab-open-mrs'), pages: [{ id: 'p', title: { zh: 'p', en: 'p' }, widgets: [{ id: 'w', view: 'note', text: { zh: 'x'.repeat(400000), en: 'x' } }] }] }, datasets: {} })
    const sizes = []
    for (let n = 1; n <= 6; n++) sizes.push(await code(() => changes.propose({ summary: `big ${n}`, edits: [{ surface: 'boards', id: `my-big${n}`, value: big(n) }] })))
    assert.deepEqual(sizes.slice(0, 4), ['ok', 'ok', 'ok', 'ok'])
    assert.equal(sizes.at(-1), 'tooBig', '2 MB waiting at most')
    const light = await changes.pending()
    assert.ok(light.length && light.every(x => !('diff' in x)), 'no diffs in the poll')
    assert.ok((await changes.get(light[0].id)).diff.length > 0)
    for (const p of await changes.pending()) await changes.discard(p.id)
    // a change that repairs a broken file can be undone: its undo brings the bytes back as they were
    writeFileSync(join(home, 'theme.json'), '{broken')
    const fix = await changes.propose({ summary: 'repair', edits: [{ surface: 'theme', value: { tokens: { '--ruyix-accent': ['#224466', '#9cb9dd'] } } }] })
    await changes.apply(fix.id)
    await changes.undo(fix.id)
    assert.equal(read('theme.json'), '{broken', 'byte for byte')
    writeFileSync(join(home, 'theme.json'), `{${'x'.repeat(600000)}`) // a broken file larger than a new value may be
    const fix2 = await changes.propose({ summary: 'repair big', edits: [{ surface: 'theme', value: { tokens: { '--ruyix-accent': ['#224466', '#9cb9dd'] } } }] })
    await changes.apply(fix2.id)
    assert.equal(await code(() => changes.undo(fix2.id)), 'ok', 'its own bytes come back, however big')
    assert.equal(read('theme.json').length, 600001)
    rmSync(join(home, 'theme.json'))
    // the personal boards for their readers: read together under the lock
    assert.ok((await changes.boards()).every(b => b.dashboard?.name?.startsWith('my-')))
    writeFileSync(join(home, 'boards', 'my-broken.json'), JSON.stringify({ dashboard: { name: 'my-broken' }, datasets: { 'my-broken--x': null } }))
    assert.ok(!(await changes.boards()).some(b => b.dashboard.name === 'my-broken'), 'a board that breaks its rules is left out for its readers (its file as it is)')
    assert.ok(existsSync(join(home, 'boards', 'my-broken.json')))
    rmSync(join(home, 'boards', 'my-broken.json'))
    assert.equal(await bd('my-a', { dashboard: dash('my-a', 'gitlab-open-mrs', [{ id: 1, title: { zh: 'p', en: 'p' }, widgets: [{ id: 'w', data: 'd', view: 'count' }] }]), datasets: {} }), 'invalid', 'a page id is a string')
    assert.equal(await bd('my-a', { dashboard: dash('my-a', 'my-a--x'), datasets: { 'my-a--x': ds('my-a--x', { project: '{{settings.__proto__.probe}}' }) } }), 'invalid', 'no path into an object\'s machinery')
    assert.equal(await bd('my-a', { dashboard: dash('my-a', 'my-a--x', [{ id: 'p', title: { zh: 'p', en: 'p' } }]), datasets: { 'my-a--x': ds('my-a--x') } }), 'invalid', 'a page with no widgets')
    const b1 = await changes.propose({ summary: 'b', edits: [{ surface: 'boards', id: 'my-a', value: { dashboard: dash('my-a', 'my-a--x'), datasets: { 'my-a--x': ds('my-a--x', { project: 'p1' }) } } }] }); await changes.apply(b1.id)
    const b2 = await changes.propose({ summary: 'b', edits: [{ surface: 'boards', id: 'my-a', value: { dashboard: dash('my-a', 'my-a--x'), datasets: { 'my-a--x': ds('my-a--x', { project: 'p2' }) } } }] })
    assert.ok(b2.diff.includes('board my-a.datasets.my-a--x.params.project: "p1" → "p2"'), `the change is shown, not only its summary: ${b2.diff.join(' | ')}`)
  } finally { rmSync(home, { recursive: true, force: true }) }
}
console.log('ruyix surfaces check: ok')
