// Self-check: find (find.js) — the person's words meet what things are for (「剪视频」 the video editor, 「终端」 the
// terminals), the best first, each hit with how to act on it; a finder that fails or hangs is left out. (The App
// Center's own finder: the apps' check.)
import assert from 'node:assert/strict'
import { createFinders, createUsage, findParts, scoreOf, unitsOf } from './find.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSystemTools } from './system.js'

assert.deepEqual([...unitsOf('剪视频 FFmpeg')].sort(), ['ffmpeg', '剪视', '视频'].sort())
assert.ok(scoreOf('剪视频', 'FFmpeg', '转换、剪切、合并音视频') >= 0.5, 'a pair of characters meets')
assert.equal(scoreOf('终端', '文件管理器'), 0)
assert.ok(scoreOf('term', 'terminal') > 0 && scoreOf('erm', 'terminal') === 0 && scoreOf('terminal', 'a terminal here') > 1, 'a latin word at a word\'s start')
assert.ok(scoreOf('读书笔记', '读书笔记 · Reading notes') > scoreOf('读书笔记', '笔记本'), 'there whole: before a part of it')

const tools = createSystemTools(), finders = createFinders()
const s = { type: 'object', properties: {} }
tools.register({ name: 'desk_set', title: { zh: '改桌面', en: 'Change the desk' }, effect: 'direct', description: 'Change the desktop: theme, wallpaper (壁纸), widgets.', parameters: s, run: async () => ({ text: '' }) })
tools.register({ name: 'ui_card', title: { zh: '卡片', en: 'Cards' }, effect: 'read', chat: true, description: '天气 卡片', parameters: s, run: async () => ({ text: '' }) })
const { abilities, tool } = findParts({ finders, tools })
finders.register(abilities)
tools.register(tool)
finders.register({ kind: 'open', title: { zh: '打开着的', en: 'Open' }, find: () => [{ id: 'term:tmux', title: '终端（tmux）', hint: 'term', at: 2, how: 'open_focus { id: "term:tmux" }' }, { id: 'tab:1', title: 'YouTube', hint: 'web', at: 3, how: 'open_focus { id: "tab:1" }' }] })
finders.register({ kind: 'broken', title: { zh: '坏的', en: 'Broken' }, find: () => { throw new Error('no') } })
finders.register({ kind: 'slow', title: { zh: '慢的', en: 'Slow' }, find: () => new Promise(() => {}) })
finders.register({ kind: 'app', title: { zh: '应用', en: 'Apps' }, find: () => [{ id: 'video', title: '视频剪辑', text: '剪辑视频、加字幕', how: 'apps_open { app: "video" }' }, { id: 'tmux', title: '终端（tmux）', hint: '还没装', how: 'apps_install { app: "tmux" }' }] })

const t0 = Date.now()
const hits = await finders.find('剪视频')
assert.ok(Date.now() - t0 < 4500, 'a finder that hangs does not hold the rest')
assert.equal(hits[0]?.kind, 'app'); assert.match(hits[0].title, /视频/)
assert.ok(hits.every(h => h.how), 'every hit says how to act on it')
const term = await finders.find('终端')
assert.deepEqual(term.map(h => `${h.kind}:${h.id}`).sort(), ['app:tmux', 'open:term:tmux'], 'the terminal app and the open terminal')
assert.ok(!(await finders.find('天气')).some(h => h.id === 'ui_card'), 'the conversation\'s cards are no ability to find')
assert.equal((await finders.find('壁纸'))[0].id, 'desk_set', 'an ability by the words of what it does')
assert.deepEqual((await finders.find('YouTube', { kinds: ['open'] })).map(h => h.id), ['tab:1'])

// the tool: hits as lines; no query: the kinds; nothing: where else to look
assert.match((await tool.run({ query: '剪视频' })).text, /^- \[app\] 视频剪辑 → apps_open \{ app: "video" \}/m)
assert.match((await tool.run({})).text, /^Kinds: ability \(能做的事\), open/)
assert.match((await tool.run({ query: 'zzqqxx' })).text, /Nothing here matches/)
// what the person uses comes first: a tool that acted is counted (by what it acted on), a listing is not
{
  const home = mkdtempSync(join(tmpdir(), 'ruyix-usage-'))
  let t = 1e12
  const usage = createUsage({ file: join(home, 'usage.json'), now: () => t })
  const reg = createSystemTools({ onUse: (n, a) => usage.note(n, a) })
  reg.register({ name: 'apps_open', effect: 'direct', description: '', parameters: s, run: async ({ app }) => (app ? { text: 'ok', summary: { zh: '开', en: 'open' } } : { text: 'list' }) })
  for (let i = 0; i < 3; i++) await reg.get('apps_open').run({ app: 'zellij' })
  await reg.get('apps_open').run({})
  assert.ok(usage.boost('zellij') > 0.1 && usage.boost('terminal') === 0, 'counted by what it acted on; a listing not')
  const f = createFinders({ boost: id => usage.boost(id) })
  f.register({ kind: 'app', title: { zh: '应用', en: 'Apps' }, find: () => [{ id: 'terminal', title: '终端', how: 'a' }, { id: 'zellij', title: '终端（Zellij）', how: 'b' }, { id: 'files', title: '文件', how: 'c' }] })
  assert.deepEqual((await f.find('终端')).map(h => h.id), ['zellij', 'terminal'], 'the one used comes first; nothing that does not match')
  t += 30 * 86400e3
  assert.ok(createUsage({ file: join(home, 'usage.json'), now: () => t }).boost('zellij') < usage.boost('zellij') + 0.2, 'kept in the home, less once long ago')
  rmSync(home, { recursive: true, force: true })
}
// the desk's widgets, as the page said them: found by their names, each saying whether it is on the desk and how
{
  const { writeFileSync } = await import('node:fs')
  const home = mkdtempSync(join(tmpdir(), 'ruyix-widgets-')), was = process.env.RUYIX_HOME
  process.env.RUYIX_HOME = home
  writeFileSync(join(home, 'desktop.json'), JSON.stringify({ widgets: [{ id: 'clock', type: 'clock', size: 'sm' }] }))
  const { apply } = await import('./index.js')
  const routes = new Map(), provided = {}
  apply({ connection: { fetch: { register: r => routes.set(r.path, r) } }, effect() {}, provide: (n, svc) => { provided[n] = svc }, inject() {} })
  process.env.RUYIX_HOME = was ?? ''; if (was === undefined) delete process.env.RUYIX_HOME
  const said = await routes.get('/api/ruyix/surfaces').fetch(new Request('http://x/api/ruyix/surfaces', { method: 'POST', body: JSON.stringify({ widgets: [{ type: 'workbench:tasks', name: { zh: '任务', en: 'Tasks' }, sizes: ['md'] }, { type: 'clock', name: { zh: '时钟', en: 'Clock' }, sizes: ['sm'] }] }) }))
  assert.equal(said.status, 200)
  const f = provided.ruyixShell.finders
  const hits = await f.find('任务小组件', { kinds: ['widget'] })
  assert.deepEqual([hits[0]?.id, hits[0]?.how], ['workbench:tasks', 'desk_set { widget_add: { type: "workbench:tasks" } }'])
  const clock = (await f.find('时钟', { kinds: ['widget'] }))[0]
  assert.match(clock.hint, /已在桌面上/); assert.match(clock.how, /widget_remove: "clock"/)
  rmSync(home, { recursive: true, force: true })
}
console.log('shell find check: ok')
