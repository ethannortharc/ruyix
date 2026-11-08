// Self-check of the main agent's system tools (system.js): the registry, the page's actions, and the shell's own tools
// against a real changes journal and voice settings in a throwaway home. `node system-check.mjs`
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPageActions, createSystemTools, shellTools } from './system.js'
import { createChanges } from './surfaces.js'
import { createVoice } from './voice.js'

// ── the registry ──
{
  const r = createSystemTools()
  const off = r.register({ name: 'a_tool', effect: 'direct', run: async () => ({ text: 'x' }) })
  r.register({ name: 'a_undo', effect: 'undo', run: async () => ({ text: 'y' }) })
  assert.deepEqual(r.list().map(t => t.name), ['a_tool'], 'an undo tool is offered to no agent')
  assert.deepEqual(r.list({ undo: true }).map(t => t.name), ['a_tool', 'a_undo'])
  assert.throws(() => r.register({ name: 'a_tool', effect: 'read', run: () => {} }), /there already/)
  assert.throws(() => r.register({ name: 'Bad Name', effect: 'read', run: () => {} }), /snake_case/)
  assert.throws(() => r.register({ name: 'b_tool', effect: 'whatever', run: () => {} }), /effect/)
  off()
  assert.equal(r.get('a_tool'), null)
}

// ── the page's actions: those after the last taken, kept a while ──
{
  let clock = 1000
  const p = createPageActions({ now: () => clock, keepMs: 100 })
  assert.equal(p.last, 0)
  assert.match(p.boot, /^[0-9a-z]{6,}$/); assert.notEqual(createPageActions().boot, p.boot, 'a boot of its own (a restarted host)')
  const a = p.add('ruyix-apps:open', { appId: 'gimp' })
  p.add('ruyix-apps:close', { appId: 'gimp' })
  assert.deepEqual(p.since(0).map(x => x.event), ['ruyix-apps:open', 'ruyix-apps:close'])
  assert.deepEqual(p.since(a).map(x => x.event), ['ruyix-apps:close'])
  clock += 200
  assert.deepEqual(p.since(0), [], 'gone after a while')
  assert.throws(() => p.add('not an event!'), /not a page event/)
}

// ── the shell's tools, in a throwaway home ──
const home = mkdtempSync(join(tmpdir(), 'ruyix-system-'))
try {
  const changes = createChanges({ home })
  const saved = []
  const voice = {
    set: { connection: 'omlx', model: 'qwen3-asr', language: 'zh' },
    async config() { return { set: this.set, using: { connection: this.set.connection, model: this.set.model, language: this.set.language, chosen: true }, choices: [{ kind: 'connection', id: 'omlx', name: 'omlx', baseUrl: 'http://x', models: ['qwen3-asr'] }], languages: ['auto', 'zh', 'en'] } },
    async save(v) { saved.push(v); this.set = { ...v }; return this.config() },
  }
  const tools = Object.fromEntries(shellTools({ home, changes, voice }).map(t => [t.name, t]))
  assert.deepEqual(Object.keys(tools).sort(), ['desk_get', 'desk_note', 'desk_note_back', 'desk_set', 'desk_undo', 'open_page', 'open_settings', 'voice_get', 'voice_restore', 'voice_set'])
  const by = 'Opus (the main agent, as the person asked)'
  const desk = () => { try { return JSON.parse(readFileSync(join(home, 'desktop.json'), 'utf8')) } catch { return null } }

  assert.match((await tools.desk_get.run({})).text, /^Theme: [\s\S]*\nThemes:\n- default: [\s\S]*\nKeys:\n/)
  // a theme: applied at once (no card), on record as the main agent's, undone as the person would
  const r = await tools.desk_set.run({ theme: 'night' }, { by })
  assert.equal(desk().theme, 'night')
  assert.deepEqual(r.summary, { zh: '主题：夜空', en: 'Theme: Night sky' })
  assert.equal(r.undo.tool, 'desk_undo')
  const c = await changes.get(r.undo.args.id)
  assert.equal(c.state, 'applied'); assert.equal(c.by, by)
  assert.equal((await changes.pending()).length, 0, 'nothing waits for the person')
  await tools.desk_undo.run(r.undo.args, { by: 'the person (undo)' })
  assert.notEqual(desk()?.theme, 'night', 'undone')
  await tools.desk_undo.run(r.undo.args, { by: 'the person (undo)' }) // (undone already, elsewhere: nothing more, no error)
  assert.equal((await changes.get(r.undo.args.id)).state, 'undone')
  // a change that cannot be applied leaves no card waiting
  const waiting = (await changes.pending()).length
  const applyFor = changes.apply
  changes.apply = async () => { throw Object.assign(new Error('stale'), { code: 'stale' }) }
  await assert.rejects(tools.desk_set.run({ set: { motion: true } }, { by }), /stale/)
  changes.apply = applyFor
  assert.equal((await changes.pending()).length, waiting, 'discarded')
  // keys, checked before anything is written
  await assert.rejects(tools.desk_set.run({ set: { wallpaper: 'no-such-wallpaper' } }, { by }))
  const k = await tools.desk_set.run({ set: { motion: false } }, { by })
  assert.equal(desk().motion, false); assert.match(k.summary.zh, /motion false/)
  // a widget added, then taken away; a widget that is not there is said
  await tools.desk_set.run({ widget_add: { type: 'apps:launcher', size: 'md' } }, { by })
  assert.ok(desk().widgets.some(w => w.type === 'apps:launcher'))
  await tools.desk_set.run({ widget_remove: 'apps:launcher' }, { by })
  assert.ok(!desk().widgets.some(w => w.type === 'apps:launcher'))
  await assert.rejects(tools.desk_set.run({ widget_remove: 'nothing' }, { by }), /no widget nothing/)
  await assert.rejects(tools.desk_set.run({}, { by }), /say what to change/)
  await assert.rejects(tools.desk_set.run({ theme: 'nope' }, { by }), /no theme nope/)

  // undo by key, when a later change touched desktop.json (the journal's own undo says "moved"): a theme, then a widget,
  // the widget undone (itself a change), then the theme — back to what it was; the widgets as they are
  {
    const before = desk()
    const th = await tools.desk_set.run({ theme: 'aurora' }, { by })
    const wd = await tools.desk_set.run({ widget_add: { type: 'note', size: 'sm' } }, { by })
    await tools.desk_undo.run(wd.undo.args, { by: 'the person (undo)' })
    const r2 = await tools.desk_undo.run(th.undo.args, { by: 'the person (undo)' })
    assert.match(r2.text, /as they were/)
    for (const k of ['theme', 'wallpaper', 'accent']) assert.deepEqual(desk()[k] ?? null, before[k] ?? null, `${k} back`)
    assert.deepEqual(desk().widgets, before.widgets, 'the widgets as they are')
    // a key changed since is left as it is (and said)
    const t3 = await tools.desk_set.run({ set: { accent: 'indigo', motion: false } }, { by })
    await tools.desk_set.run({ set: { accent: 'vermilion' } }, { by }) // (the person, say: the accent changed again)
    await assert.rejects(tools.desk_undo.run(t3.undo.args, { by: 'the person (undo)' }), /nothing to undo: accent changed again since/)
    assert.equal(desk().accent, 'vermilion', 'left as it is')
    const t4 = await tools.desk_set.run({ set: { accent: 'indigo', density: 'roomy' } }, { by })
    await tools.desk_set.run({ set: { accent: 'teal' } }, { by })
    const r4 = await tools.desk_undo.run(t4.undo.args, { by: 'the person (undo)' })
    assert.match(r4.text, /density as they were; left as they are now \(changed since\): accent/)
    assert.equal(desk().accent, 'teal'); assert.equal(desk().density ?? null, before.density ?? null)
  }
  // the widgets there are: listed by desk_get once the page told them; an unknown type refused
  {
    const kinds = [{ type: 'apps:launcher', name: { zh: 'Linux 应用', en: 'Linux apps' }, sizes: ['sm', 'md'] }, { type: 'clock', name: '时钟', sizes: ['sm', 'md'] }]
    const t2 = Object.fromEntries(shellTools({ home, changes, voice, widgetKinds: () => kinds }).map(t => [t.name, t]))
    assert.match((await t2.desk_get.run({})).text, /Widgets there are[^\n]*\n- apps:launcher: Linux apps · Linux 应用 \(sm, md\)\n- clock: 时钟/)
    await assert.rejects(t2.desk_set.run({ widget_add: { type: 'ask-the-agent' } }, { by }), /no widget "ask-the-agent": desk_get lists/)
  }
  // a note on the desk: none there — one put on the desk and written; then added to; undone back to nothing, the note gone
  {
    const { createNotes } = await import('./notes.js')
    const n = createNotes({ home }), asked = []
    const t4 = Object.fromEntries(shellTools({ home, changes, voice, notes: () => n, page: (e, d) => asked.push([e, d]) }).map(t => [t.name, t]))
    const first = await t4.desk_note.run({ text: '买牛奶' }, { by })
    const id = first.undo.args.id
    assert.ok(desk().widgets.some(w => w.id === id && w.type === 'note'), 'a note put on the desk')
    assert.deepEqual([n.all().notes[id], asked.at(-1)], ['买牛奶', ['ruyix:notes', { id }]])
    const second = await t4.desk_note.run({ text: '给妈妈打电话', append: true }, { by })
    assert.equal(n.all().notes[id], '买牛奶\n给妈妈打电话')
    await t4.desk_note_back.run(second.undo.args, { by }); assert.equal(n.all().notes[id], '买牛奶')
    await t4.desk_note_back.run(first.undo.args, { by })
    assert.ok(!n.all().notes[id] && !desk().widgets.some(w => w.id === id), 'the first undone: no text, no note')
    await assert.rejects(t4.desk_note.run({ text: 'x', id: 'nope' }, { by }), /no note nope/)
    const stale = await t4.desk_note.run({ text:'agent note' },{by}), key=stale.undo.args.id
    n.save({id:key,text:'agent note\nperson wrote this later'})
    await assert.rejects(t4.desk_note_back.run(stale.undo.args,{by}),e=>e.code==='noteChanged')
    assert.equal(n.all().notes[key],'agent note\nperson wrote this later');assert.ok(desk().widgets.some(w=>w.id===key))
    n.save({id:key,text:stale.undo.args.after});await t4.desk_note_back.run(stale.undo.args,{by})
    const long = await t4.desk_note.run({text:'x'.repeat(9000)},{by})
    await t4.desk_note_back.run(long.undo.args,{by})

  }
  // a page, a Settings tab: by id or by name, as the page last said them; with none, the list
  {
    const asked = [], pages = [{ id: 'ruyix-tasks', label: '任务', group: 'work' }, { id: 'apps', label: '应用中心' }], tabs = [{ id: 'general', label: '通用' }, { id: 'ruyix-web', label: '搜索' }]
    const t3 = Object.fromEntries(shellTools({ home, changes, voice, pages: () => pages, settingsTabs: () => tabs, page: (e, d) => asked.push([e, d]) }).map(t => [t.name, t]))
    assert.match((await t3.open_page.run({})).text, /^Pages \(id \| name \| group\):\n- ruyix-tasks \| 任务 \| work\n- apps \| 应用中心$/)
    assert.ok(t3.open_page.shows && t3.open_settings.shows && !t3.desk_set.shows, 'showing only: marked so')
    await t3.open_page.run({ page: '任务' }); await t3.open_page.run({ page: 'APPS' })
    assert.deepEqual(asked, [['ruyix:open', { panel: 'ruyix-tasks' }], ['ruyix:open', { panel: 'apps' }]])
    await assert.rejects(t3.open_page.run({ page: '不存在' }), /no page "不存在"/)
    const r = await t3.open_settings.run({ tab: '搜索' })
    assert.deepEqual([asked.at(-1), r.summary.zh], [['ruyix-settings:open', { tab: 'ruyix-web' }], '打开了设置：搜索'])
    assert.match((await shellTools({ home, changes, voice }).find(t => t.name === 'open_settings').run({})).text, /has not said/)
  }

  // voice: set, and back as it was
  assert.match((await tools.voice_get.run({})).text, /^In use: omlx · qwen3-asr · language zh\nModel endpoints \(provider\) and connections set before \(connection\):\n- connection omlx \(http:\/\/x\): qwen3-asr/)
  const v = await tools.voice_set.run({ language: 'en' })
  assert.equal(voice.set.language, 'en'); assert.equal(voice.set.model, 'qwen3-asr', 'the rest kept')
  await tools.voice_restore.run(v.undo.args)
  assert.deepEqual(voice.set, { connection: 'omlx', model: 'qwen3-asr', language: 'zh' })
  // the real voice settings take the same shape (createVoice's save)
  const real = createVoice({ home, connectors: () => null })
  await real.save({ language: 'en' })
  assert.equal(JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8')).language, 'en')
  for (const before of [{ hotkey: { code: 'F5', mods: [], mode: 'hold' } }, {}]) {
    writeFileSync(join(home, 'voice.json'), JSON.stringify(before))
    const realTools = Object.fromEntries(shellTools({ home, changes, voice: real }).map(t => [t.name, t]))
    const action = await realTools.voice_set.run({ provider: 'omlx', model: 'whisper-1' })
    await realTools.voice_restore.run(action.undo.args)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8')), before, 'undo restores even a shortcut-only or empty snapshot')
  }
  writeFileSync(join(home, 'voice.json'), JSON.stringify({ language: 'zh', model: 'whisper-1', hotkey: { code: 'F5', mods: [], mode: 'hold' } }))
  const realTools = Object.fromEntries(shellTools({ home, changes, voice: real }).map(t => [t.name, t]))
  const language = await realTools.voice_set.run({ language: 'en' })
  await real.save({ hotkey: { code: 'F6', mods: [], mode: 'hold' } })
  await real.save({ ...(await real.config()).set, model: 'whisper-2' })
  await realTools.voice_restore.run(language.undo.args)
  assert.deepEqual([(await real.config()).set.language, (await real.config()).set.model, (await real.config()).hotkey.code], ['zh', 'whisper-2', 'F6'])
  const staleLanguage = await realTools.voice_set.run({ language: 'en' })
  await real.save({ ...(await real.config()).set, language: 'ja' })
  await assert.rejects(realTools.voice_restore.run(staleLanguage.undo.args), e => e.code === 'changedMeanwhile')
  await assert.rejects(real.save({ language: 'zh' }, { expect: { language: 'en' } }), e => e.code === 'changedMeanwhile')
  const endpoint = await realTools.voice_set.run({ provider: 'first', model: 'shared-model' })
  await real.save({ ...(await real.config()).set, model: 'second-only-model' })
  await assert.rejects(realTools.voice_restore.run(endpoint.undo.args),e=>e.code==='changedMeanwhile','endpoint undo cannot attach a newer provider-specific model to the old provider')
  writeFileSync(join(home, 'voice.json'), '{}')
} finally { rmSync(home, { recursive: true, force: true }) }

console.log('ruyix system tools check: ok')
