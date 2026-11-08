// The shell's check: the sidebar's groups come from the entries' order alone, and stay whole when plugins go away.
import assert from 'node:assert/strict'
import { NAV, intoOf, navCss, navEntries } from './src/nav.js'
import { keyNames, pluginsOf, SECTIONS } from './settings.js'
import { TEXT } from './src/settings-text.js'

const e = (label, order, id = String(typeof label === 'function' ? label() : label)) => ({ options: { label, order, id } })
const all = [e('插件', 0), e('收件箱', 10), e('运行', 11), e('短剧推广', 20), e(() => '智能体', 30), e('技能', 31), e('连接', 40), e('工作台设置', 42)]
const css = navCss(all, 'zh')
const caption = label => (css.match(new RegExp(`button\\[aria-label="${label}"\\]::before \\{ content: "([^"]+)"`)) || [])[1]
assert.equal(caption('收件箱'), '工作台')
assert.equal(caption('短剧推广'), '应用')
assert.equal(caption('智能体'), '智能体', 'a label given as a function is resolved')
assert.equal(caption('连接'), '系统')
assert.equal(caption('运行'), undefined)
assert.match(css, new RegExp(`${NAV.replace(/[[\]().*]/g, '\\$&')} > button\\[aria-label="插件"\\] \\{ display: none; \\}`), 'dsh\'s Plugins page (order 0) leaves the list')
// an app's own Settings entry is a tab of the shell's Settings page: it leaves the list
assert.match(navCss(all, 'zh', new Set(['工作台设置'])), /aria-label="工作台设置"\] \{ display: none; \}/, 'an entry that is a Settings tab too')
assert.doesNotMatch(css, /aria-label="插件"\]::before/, 'it captions no group')
// an entry for other presets (`for`) leaves the list; without a preset known yet, it stays (window.__ruyixNav: `extra`)
{
  const two = [...all.slice(0, 3), { options: { label: 'Video', order: 20, id: 'v' } }, { options: { label: 'Boards', order: 22, id: 'b' } }]
  const extra = { v: { for: ['studio'] }, b: { shown: () => false } }
  assert.match(navCss(two, 'en', new Set(), 'ops', extra), /aria-label="Video"\] \{ display: none; \}/)
  assert.doesNotMatch(navCss(two, 'en', new Set(), 'studio', extra), /aria-label="Video"\] \{ display: none; \}/)
  assert.doesNotMatch(navCss(two, 'en', new Set(), null, extra), /aria-label="Video"\] \{ display: none; \}/)
  assert.match(navCss(two, 'en', new Set(), 'studio', extra), /aria-label="Boards"\] \{ display: none; \}/, 'an entry with nothing to show now')
}
// a page folded into another (`into`, work-in-one-place.md): out of the list and the pages an agent opens; its opens are
// the other page's, what they asked kept, the page's own `land` over it
{
  const extra = { 'run-page': { into: 'tasks', land: { tab: 'all' } }, 'self': { into: 'self' } }
  const list = [e('运行', 11, 'run-page'), e('任务', 16, 'tasks')]
  assert.match(navCss(list, 'zh', new Set(), null, extra), /aria-label="运行"\] \{ display: none; \}/)
  assert.deepEqual(navEntries(list, 'zh', new Set(), null, extra).map(x => x.id), ['tasks'])
  assert.deepEqual(intoOf({ panel: 'run-page', run: 'r1' }, extra), { panel: 'tasks', run: 'r1', tab: 'all' })
  assert.equal(intoOf({ panel: 'tasks' }, extra), null)
  assert.equal(intoOf({ panel: 'self' }, extra), null, 'a page folded into itself is its own')
}

// without the workbench and the apps: their groups go, the others keep their captions on what is left
const fewer = navCss(all.filter(x => ![10, 11, 20, 40, 42].includes(x.options.order)), 'en')
assert.match(fewer, /aria-label="智能体"\]::before \{ content: "Agents"/)
assert.doesNotMatch(fewer, /System/, 'with no System entries left, no System caption (Plugins is at the foot)')
assert.doesNotMatch(fewer, /Workbench|Apps/)
// without Agent Hub's first entry: the group starts at the next one
assert.match(navCss(all.filter(x => x.options.order !== 30), 'zh'), /aria-label="技能"\]::before \{ content: "智能体"/)
// dsh's preview notice: its class prefix from its own stylesheet, and the rule that hides it
{
  const { noticeHideCss, noticePrefix } = await import('./src/notice.js')
  const p = noticePrefix('.t1T8VW_copy{color:var(--x)}.t1T8VW_actions{display:flex}')
  assert.equal(p, 't1T8VW')
  assert.match(noticeHideCss(p), /body > :has\(\.t1T8VW_copy\)[\s\S]*opacity: 0/)
  assert.equal(noticeHideCss(noticePrefix('')), '', 'no notice stylesheet, no rule')
}
// the versions: dsh's from the package whose bin started the process (found from a path inside it)
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { dshVersion } = await import('./index.js')
  const root = mkdtempSync(join(tmpdir(), 'ruyix-')), pkg = join(root, 'node_modules/@deepseek-ai/dsh')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-rc.1' }))
  writeFileSync(join(pkg, 'lib/bin.js'), '')
  assert.equal(dshVersion(join(pkg, 'lib/bin.js')), '9.9.9-rc.1')
  assert.equal(dshVersion('/nonexistent/bin.js'), '', 'not found: empty, never a throw')
}
// the tokens: every plugin styles with --ruyix-* (no direct dsh alias for a meaning the tokens name), and every
// --ruyix-* in use is defined in tokens.css
{
  const { readFileSync, readdirSync } = await import('node:fs')
  const tokens = readFileSync('tokens.css', 'utf8')
  const defined = new Set([...tokens.matchAll(/(--ruyix-[a-z0-9-]+):/g)].map(m => m[1]))
  const named = [...tokens.matchAll(/var\(--dsw-alias-([a-z0-9-]+)\)/g)].map(m => m[1])
  const dirs = ['../workbench/src', '../connectors/src', '../board', ...['agent-hub', 'box', 'apps', 'studio', 'web'].map(p => `../plugins/${p}/src`), 'src', 'src/desktop']
  const sources = dirs.flatMap(d => readdirSync(d).filter(f => /\.(css|jsx?)$/.test(f)).map(f => [`${d}/${f}`, readFileSync(`${d}/${f}`, 'utf8')]))
  const direct = sources.flatMap(([f, src]) => named.filter(n => new RegExp(`var\\(--dsw-alias-${n}\\b(?!-)`).test(src)).map(n => `${f}: --dsw-alias-${n}`))
  assert.deepEqual(direct, [], 'use the --ruyix-* token for this meaning')
  const runtime = new Set(['--ruyix-cols']) // (the desktop's, set as it runs: dsh's grid without its sidebar)
  const unknown = [...new Set(sources.flatMap(([, src]) => [...src.matchAll(/var\((--ruyix-[a-z0-9-]+)/g)].map(m => m[1])))].filter(t => !defined.has(t) && !runtime.has(t))
  assert.deepEqual(unknown, [], 'every --ruyix-* in use is defined in tokens.css')
  // the system style (docs/design/system-style.md): sizes of type and corners come from the scale, so the dials reach them
  const css = sources.filter(([f]) => f.endsWith('.css'))
  const rawType = css.flatMap(([f, src]) => [...src.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(m => `${f}: font-size ${m[1]}px`))
  assert.deepEqual(rawType, [], 'a font size from the type scale (var(--ruyix-text-*))')
  const rawCorner = css.flatMap(([f, src]) => [...src.matchAll(/border(?:-[a-z]+)?-radius\s*:([^;}]*)/g)]
    .flatMap(m => [...m[1].replace(/var\([^)]*\)/g, '').matchAll(/(\d+(?:\.\d+)?)px/g)].filter(x => x[1] >= 4 && x[1] <= 20).map(x => `${f}: border-radius ${x[1]}px`)))
  assert.deepEqual(rawCorner, [], 'a corner from the scale (var(--ruyix-radius-*))')
}
// the sign-in page: its language, and the note only after a refused link
{
  const { pickLang, signinPage } = await import('./signin.js')
  assert.equal(pickLang(new URL('http://x/'), 'zh-CN,zh;q=0.9,en;q=0.8'), 'zh')
  assert.equal(pickLang(new URL('http://x/'), 'en-US,zh;q=0.5'), 'en')
  assert.equal(pickLang(new URL('http://x/?lang=en'), 'zh-CN'), 'en', '?lang= wins over the browser')
  assert.equal(pickLang(new URL('http://x/?lang=fr'), ''), 'en')
  assert.match(signinPage({ lang: 'zh' }), /<div class="note" id="note" hidden>/)
  assert.match(signinPage({ lang: 'zh', failed: true }), /id="note">这个链接已经打不开/)
  assert.match(signinPage({ lang: 'en' }), /<title>Sign in · Ruyix<\/title>/)
}
// The authenticated identity carries the explicit profile, never just an occupied port.
{
  const { apply } = await import('./index.js')
  const argv = process.argv
  try {
    for (const flags of [['--profile', 'qa-ruyix'], ['--profile=qa-ruyix'], []]) {
      process.argv = ['node', '/fake/dsh.js', ...flags]
      const routes = new Map()
      apply({ connection: { fetch: { register: r => routes.set(r.path, r) } }, inject() {}, effect() {}, provide() {} })
      const identity = await routes.get('/api/ruyix/identity').fetch().json()
      assert.deepEqual(identity, { product: 'ruyix', profile: flags.length ? 'qa-ruyix' : 'default', pid: process.pid })
    }
  } finally { process.argv = argv }
}
await import('./cli-check.mjs')
await import('./data-check.mjs')
// A failed plugin check must stay visible and prevent "ready", without leaking its exception.
{
  const { apply } = await import('./index.js')
  for (const setup of [() => { throw new Error('secret-token-do-not-return') }, async () => { throw new Error('secret-token-do-not-return') }]) {
    const routes = new Map(), provided = {}
    const services = { credentials: { describe: async () => ({ configured: true }) } }
    apply({ connection: { fetch: { register: r => routes.set(r.path, r) } }, effect() {}, provide: (n, svc) => { provided[n] = svc }, inject: ([name], fn) => {
      if (services[name]) fn({ [name]: services[name], effect() {} })
    } })
    // the plugins join as parts: the shell names none of them
    provided.ruyixShell.part({ id: 'wb', name: { en: 'Workbench', zh: '工作台' }, panel: 'wb-settings', order: 20, setup })
    const leave = provided.ruyixShell.part({ id: 'agents', name: { en: 'Agents', zh: '智能体' }, order: 40, setup: () => [{ id: 'good-team', order: 40, required: true, ready: true, title: { en: 'Team', zh: '团队' }, detail: { en: 'Ready', zh: '已就绪' } }] })
    provided.ruyixShell.part({ id: 'notes', name: { en: 'Notes', zh: '笔记' }, panel: 'notes', order: 50, optional: true, setup, busy: () => ['a run'] })
    const result = await routes.get('/api/ruyix/setup').fetch().then(r => r.json())
    const failure = result.steps.find(s => s.id === 'wb-setup-error')
    assert.deepEqual([failure.required, failure.ready, failure.panel, failure.title.en], [true, false, 'wb-settings', 'Workbench: setup check'])
    assert.equal(result.steps.find(s => s.id === 'notes-setup-error').required, false, 'an optional part that cannot answer holds nothing up')
    assert.deepEqual((await routes.get('/api/ruyix/busy').fetch().json()).busy, ['a run'])
    assert.deepEqual(provided.ruyixShell.parts().map(p => p.id), ['wb', 'agents', 'notes'])
    leave()
    assert.deepEqual(provided.ruyixShell.parts().map(p => p.id), ['wb', 'notes'], 'a plugin that stops leaves')
    assert.equal(result.steps.find(s => s.id === 'good-team').ready, true, 'other services still show their successful checks')
    assert.doesNotMatch(JSON.stringify(result), /secret-token-do-not-return|Error:/, 'exception content and stack never reach onboarding')
  }
}
// What this Ruyix is for: its own preset, from those the parts bring (`default` until one is picked); a part or a setup
// step for other presets leaves the home page; who it is: a name and a colour
{
  const { apply } = await import('./index.js'), { mkdtempSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'ruyix-layout-check-')), was = process.env.RUYIX_HOME
  process.env.RUYIX_HOME = home
  try {
    const routes = new Map(), provided = {}
    apply({ connection: { fetch: { register: r => routes.set(r.path, r) } }, effect() {}, provide: (n, svc) => { provided[n] = svc }, inject: () => {} })
    const step = (id, extra) => ({ id, order: 20, required: false, ready: true, title: { en: id, zh: id }, detail: { en: id, zh: id }, ...extra })
    provided.ruyixShell.part({ id: 'wb', order: 20, setup: () => [step('people', { for: ['studio'] }), step('tools'), step('repo', { required: true, requiredFor: ['studio'] })] })
    provided.ruyixShell.part({ id: 'video', for: ['studio'], order: 21, setup: () => [step('video-step')] })
    const all = async () => (await routes.get('/api/ruyix/setup').fetch().then(r => r.json())).steps
    const steps = async () => (await all()).map(s => s.id).filter(id => id !== 'repo')
    const repo = async () => (await all()).find(s => s.id === 'repo').required
    const layout = body => routes.get('/api/ruyix/layout').fetch(new Request('http://ruyix.invalid/api/ruyix/layout', body ? { method: 'POST', body: JSON.stringify(body) } : {})).then(r => r.json())
    assert.deepEqual(await layout().then(l => [l.preset, l.by, l.presets]), ['default', 'home', []], 'no preset until a part brings one')
    assert.deepEqual(await steps(), ['tools'], 'a part or a step for a preset leaves the others')
    assert.equal(await repo(), false, 'a step required for one preset is optional elsewhere')
    assert.equal((await layout({ preset: 'studio' })).error, 'badPreset', 'only a preset a part brings')
    const leave = provided.ruyixShell.preset({ id: 'studio', name: { en: 'Studio', zh: '工作室' }, dashboards: ['clips@^1'] })
    assert.throws(() => provided.ruyixShell.preset({ id: 'default' }), /other than default/)
    assert.equal((await layout({ preset: 'studio' })).preset, 'studio')
    assert.deepEqual((await layout()).dashboards, ['clips@^1'], 'the preset\'s dashboards')
    assert.deepEqual(await steps(), ['people', 'tools', 'video-step'])
    assert.equal(await repo(), true, 'required where its preset is picked')
    leave()
    assert.equal((await layout()).preset, 'default', 'a preset whose part left is no longer picked')
    // who it is: its own name when given (none: the page says what it is for), a colour of the palette unless given
    let id = (await layout()).identity
    assert.deepEqual([id.name, id.own, /^#[0-9a-f]{6}$/.test(id.color)], [null, { name: '', color: '' }, true])
    id = (await layout({ identity: { name: '  Ops box\u0007 ', color: '#123abc' } })).identity
    assert.deepEqual([id.name, id.color, id.own], ['Ops box', '#123abc', { name: 'Ops box', color: '#123abc' }], 'trimmed, no control characters')
    assert.equal((await layout({ identity: { color: 'red;' } })).error, 'badColor')
    assert.equal((await layout({ identity: {} })).identity.name, null, 'blank: back to the default')
  } finally { if (was === undefined) delete process.env.RUYIX_HOME; else process.env.RUYIX_HOME = was; rmSync(home, { recursive: true, force: true }) }
}

// ── Settings: the same words in both languages; the Host side touches only its sections, keys some provider names, added plugins ──
{
  const shape = o => Object.entries(o).map(([k, v]) => (v && typeof v === 'object' ? `${k}{${shape(v)}}` : `${k}:${typeof v}`)).sort().join(',')
  assert.equal(shape(TEXT.zh), shape(TEXT.en), 'Settings: zh and en hold the same keys')
  const sections = [{ ns: 'llm-pi-ai', value: { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' }, local: {}, bad: { apiKeyEnv: 'lower' } } } }, { ns: 'web-search-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }]
  assert.deepEqual(keyNames(sections), ['OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY'])
  { const { keyUses } = await import('./providers.js'); assert.deepEqual(keyUses('TAVILY_API_KEY', sections), { hosts: ['api.tavily.com'], local: false }, 'a search key goes to its service\'s host only') }
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'ruyix-settings-check-')), pd = join(root, 'profile'), home = join(root, 'ruyix')
  try {
    for (const [n, v] of [['@ruyix/board', '0.1.0'], ['@ruyix/shell', '0.2.0'], ['@acme/notes', '1.2.0']]) { mkdirSync(join(pd, 'node_modules', n), { recursive: true }); writeFileSync(join(pd, 'node_modules', n, 'package.json'), JSON.stringify({ version: v })) }
    writeFileSync(join(pd, 'package.json'), JSON.stringify({ dependencies: { '@ruyix/board': 'link:/src/board', '@ruyix/shell': 'link:/src/shell', '@acme/notes': 'file:/x.tgz', '@deepseek-ai/dsh-web-app': '1' } }))
    mkdirSync(home); writeFileSync(join(home, 'plugins.json'), JSON.stringify({ plugins: { '@acme/notes': { version: '1.2.0', available: { version: '1.3.0' }, id: 'res1' } } }))
    const img = process.env.RUYIX_IMAGE; delete process.env.RUYIX_IMAGE
    assert.deepEqual(pluginsOf(pd, home).release, { version: '0.2.0', from: 'source' }, 'the release: its version, from a source checkout')
    process.env.RUYIX_IMAGE = root
    assert.equal(pluginsOf(pd, home).release.from, 'image', 'the plugins inside the image: as the box came')
    process.env.RUYIX_IMAGE = '/elsewhere'
    writeFileSync(join(pd, 'package.json'), JSON.stringify({ dependencies: { '@ruyix/board': 'link:/src/board', '@ruyix/shell': '0.2.0', '@acme/notes': 'file:/x.tgz', '@deepseek-ai/dsh-web-app': '1' } }))
    assert.equal(pluginsOf(pd, home).release.from, 'release', 'installed here from a registry (ruyix upgrade)')
    if (img === undefined) delete process.env.RUYIX_IMAGE; else process.env.RUYIX_IMAGE = img
    writeFileSync(join(pd, 'package.json'), JSON.stringify({ dependencies: { '@ruyix/board': 'link:/src/board', '@acme/notes': 'file:/x.tgz', '@deepseek-ai/dsh-web-app': '1' } }))
    assert.deepEqual(pluginsOf(pd, home), {
      release: { version: '0.2.0', from: 'release' },
      builtin: [{ name: '@ruyix/board', version: '0.1.0', linked: true, on: true, core: true, default: true }],
      added: [{ name: '@acme/notes', version: '1.2.0', available: '1.3.0', id: 'res1', thirdParty: true, on: true, core: false, default: true }],
    })
    // the routes over fake services: only the page's sections, only a provider's key, only an added plugin
    const { registerSettings } = await import('./settings.js'), routes = new Map(), writes = [], creds = new Map()
    const settings = { writable: true, describe: () => [...sections, { ns: 'tool-plugin-manager', value: {} }].map(s => ({ ...s, revision: 3, secrets: [] })), mutate: async (...a) => { writes.push(a) } }
    const credentials = { describe: async n => ({ configured: creds.has(n) }), set: async (n, v) => { creds.set(n, v) }, unset: async n => { creds.delete(n) }, resolve: async n => (creds.has(n) ? { value: creds.get(n) } : undefined) }
    const asked = []
    const services = { settings, credentials, llm: { discoverModels: async (ns, req) => { asked.push(req); return [{ id: `${req.provider}-m1`, contextWindow: 1000 }] } } }
    process.env.RUYIX_HOME = home
    registerSettings({ connection: { fetch: { register: r => routes.set(r.path, r) } }, effect() {}, inject: ([name], fn) => fn({ [name]: services[name], effect() {} }) }, { profile: 'nope' })
    const call = (path, body) => routes.get(path).fetch(new Request('http://x/', body ? { method: 'POST', body: JSON.stringify(body) } : {})).then(async r => ({ status: r.status, ...(await r.json()) }))
    const got = await call('/api/ruyix/settings')
    assert.deepEqual([got.sections.map(s => s.ns), got.keys], [['llm-pi-ai', 'web-search-deepseek'], { OPENROUTER_API_KEY: false, DEEPSEEK_API_KEY: false }], 'dsh\'s other entries stay out')
    assert.equal((await call('/api/ruyix/settings', { ns: 'tool-plugin-manager', ops: [{ op: 'set', path: ['disabled'], value: false }] })).error, 'notHere')
    assert.equal((await call('/api/ruyix/settings', { ns: 'agent-loop', ops: [] })).error, 'badEdit')
    await call('/api/ruyix/settings', { ns: 'agent-loop', ops: [{ op: 'set', path: ['maxParallelToolCalls'], value: 4 }], revision: 3 })
    assert.deepEqual(writes, [['agent-loop', [{ op: 'set', path: ['maxParallelToolCalls'], value: 4 }], 3]])
    assert.equal((await call('/api/ruyix/credential', { name: 'HOME', value: 'x' })).error, 'notAKey', 'only a key some provider names')
    assert.equal((await call('/api/ruyix/credential', { name: 'OPENROUTER_API_KEY', value: 'a b' })).error, 'badKey')
    await call('/api/ruyix/credential', { name: 'OPENROUTER_API_KEY', value: 'or-1' })
    assert.equal(creds.get('OPENROUTER_API_KEY'), 'or-1')
    // in a nookbox box: a provider's key goes to the host's vault for its host (a catalog provider's known one) and only
    // the placeholder is kept; a local server's (a host port, like omlx) as it is; let go — from the vault too
    {
      const vaulted = [], realFetch = globalThis.fetch
      const PH = `sk-or-NKB${'a1'.repeat(16)}`
      globalThis.fetch = async (url, o = {}) => { vaulted.push([o.method, String(url), o.body ? JSON.parse(o.body) : null]); return new Response(JSON.stringify({ placeholder: PH }), { status: 200 }) }
      process.env.NOOKBOX_API = 'http://box.test'; process.env.NOOKBOX_NAME = 'ruyix'
      sections[0].value.providers.omlx = { api: 'openai-completions', baseURL: 'http://192.168.64.1:8000/v1', apiKeyEnv: 'OMLX_API_KEY' }
      try {
        // (a key the box held before: said so on its row)
        assert.deepEqual((await call('/api/ruyix/settings')).kept, { OPENROUTER_API_KEY: 'box' })
        await call('/api/ruyix/credential', { name: 'OPENROUTER_API_KEY', value: 'sk-or-real' })
        assert.deepEqual(vaulted.at(-1), ['PUT', 'http://box.test/v1/secrets/CONN_RUYIX_OPENROUTER_API_KEY', { value: 'sk-or-real', hosts: ['openrouter.ai'] }], 'named after the credential, bound to its provider\'s host')
        assert.equal(creds.get('OPENROUTER_API_KEY'), PH, 'the box keeps the placeholder only')
        assert.deepEqual((await call('/api/ruyix/settings')).kept, { OPENROUTER_API_KEY: 'vault' })
        await call('/api/ruyix/credential', { name: 'OMLX_API_KEY', value: 'local-key' })
        assert.equal(creds.get('OMLX_API_KEY'), 'local-key'); assert.equal(vaulted.length, 1, 'a local server: no vault (the gateway is not in between)')
        await call('/api/ruyix/credential', { name: 'OPENROUTER_API_KEY', value: '' })
        assert.deepEqual(vaulted.at(-1).slice(0, 2), ['DELETE', 'http://box.test/v1/secrets/CONN_RUYIX_OPENROUTER_API_KEY']); assert.ok(!creds.has('OPENROUTER_API_KEY'))
        // a key two use (the DeepSeek web search and a deepseek provider): one entry, bound to every host that uses it;
        // a migrated endpoint's key keeps its entry's name (RUYIX_ENDPOINT_<ID> → CONN_<BOX>_ENDPOINT_<ID>)
        sections[0].value.providers.deepseek = { apiKeyEnv: 'DEEPSEEK_API_KEY' }
        sections[0].value.providers.gw = { api: 'openai-completions', baseURL: 'https://gw.example/v1', apiKeyEnv: 'RUYIX_ENDPOINT_OLDGW' }
        await call('/api/ruyix/credential', { name: 'DEEPSEEK_API_KEY', value: 'sk-ds' })
        assert.deepEqual(vaulted.at(-1), ['PUT', 'http://box.test/v1/secrets/CONN_RUYIX_DEEPSEEK_API_KEY', { value: 'sk-ds', hosts: ['api.deepseek.com'] }])
        await call('/api/ruyix/credential', { name: 'RUYIX_ENDPOINT_OLDGW', value: 'sk-gw' })
        assert.equal(vaulted.at(-1)[1], 'http://box.test/v1/secrets/CONN_RUYIX_ENDPOINT_OLDGW', 'a renamed provider\'s key stays in the entry it had')
        delete sections[0].value.providers.deepseek; delete sections[0].value.providers.gw
      } finally { globalThis.fetch = realFetch; delete process.env.NOOKBOX_API; delete process.env.NOOKBOX_NAME; delete sections[0].value.providers.omlx }
    }
    assert.deepEqual((await call('/api/ruyix/models', { provider: 'openai' })).models, [{ id: 'openai-m1', contextWindow: 1000 }])
    // a kept provider of an address of its own: dsh is told its address and protocol (it lists models only from those)
    // — what it lists now, with its key; not by name (a catalog id is answered from pi-ai's own list, which lags)
    sections[0].value.providers.lan = { api: 'openai-completions', baseURL: 'http://192.168.64.1:8000/v1', apiKeyEnv: 'LAN_KEY' }
    await call('/api/ruyix/models', { provider: 'lan' })
    assert.deepEqual(asked.at(-1), { baseURL: 'http://192.168.64.1:8000/v1', api: 'openai-completions' }, 'no key set: asked without one')
    creds.set('LAN_KEY', 'lan-k')
    await call('/api/ruyix/models', { provider: 'lan' })
    assert.deepEqual(asked.at(-1), { baseURL: 'http://192.168.64.1:8000/v1', api: 'openai-completions', apiKey: 'lan-k' })
    creds.delete('LAN_KEY')
    await call('/api/ruyix/models', { baseURL: 'http://draft.example/v1', api: 'openai-completions', apiKey: 'k' })
    assert.deepEqual(asked.at(-1), { baseURL: 'http://draft.example/v1', api: 'openai-completions', apiKey: 'k' }, 'a draft: as it is')
    delete sections[0].value.providers.lan
    assert.equal((await call('/api/ruyix/plugins', { action: 'remove', name: '@ruyix/board' })).error, 'notAdded', 'the release\'s own plugins are not removed here')
    settings.mutate = async () => { throw Object.assign(new Error('bad value'), { code: 'settings-invalid' }) }
    assert.deepEqual(await call('/api/ruyix/settings', { ns: 'agent-loop', ops: [{ op: 'set', path: ['x'], value: 1 }] }), { status: 400, error: 'failed', params: { message: 'bad value' } }, 'only a stale write is a conflict')
    settings.mutate = async () => { throw new Error('settings namespace "agent-loop" changed since it was read (expected revision 1, now 2)') }
    assert.equal((await call('/api/ruyix/settings', { ns: 'agent-loop', ops: [{ op: 'set', path: ['x'], value: 1 }] })).error, 'conflict')
  } finally { delete process.env.RUYIX_HOME; rmSync(root, { recursive: true, force: true }) }
}
// the catalog of known provider addresses, here and in Agent Hub (endpoints.js, its own spellings): the same hosts
{
  const { CATALOG: here } = await import('./providers.js'), { CATALOG: hub } = await import('../plugins/agent-hub/endpoints.js')
  const host = u => new URL(u).hostname
  for (const id of Object.keys(hub)) assert.equal(host(hub[id].baseUrl), host(here[id]?.baseUrl || 'http://missing'), `catalog ${id}: the same host in both`)
}
// the work going on (src/work.js): slices merged, the most pressing first, a change only when a slice changed
{
  const { workRegistry, rankOf } = await import('./src/work.js')
  const events = [], w = { dispatchEvent: e => events.push(e.type) }
  const reg = workRegistry(w)
  assert.equal(workRegistry(w), reg, 'one list, whoever asks first')
  reg.set('runs', [{ id: 'run:1', state: 'done', seen: true, endedAt: 5 }, { id: 'run:2', state: 'working', startedAt: 1 }])
  reg.set('sessions', [{ id: 'session:a', state: 'done', seen: false, endedAt: 9 }, { id: 'session:b', state: 'waiting' }, { id: 'session:c', state: 'failed', seen: false }])
  assert.deepEqual(reg.get().map(x => x.id), ['session:b', 'run:2', 'session:c', 'session:a', 'run:1'])
  reg.set('runs', [{ id: 'run:1', state: 'done', seen: true, endedAt: 5 }, { id: 'run:2', state: 'working', startedAt: 1 }])
  assert.deepEqual(events, ['ruyix:work', 'ruyix:work'], 'the same slice again is no change')
  assert.equal(rankOf({ state: 'failed', seen: true }), 4, 'a failure looked at is the rest')
  // through the item's own producer: seen (the desk's 擦掉) and summarize (a lane opened)
  const marked = []
  reg.set('sessions', reg.get().filter(x => x.id.startsWith('session:')), { seen: ids => marked.push(...ids), summarize: async id => `so far: ${id}` })
  assert.deepEqual([reg.seen('session:a'), marked], [true, ['session:a']])
  assert.deepEqual([reg.seen('run:1'), await reg.summarize('session:b'), await reg.summarize('run:1')], [false, 'so far: session:b', null], 'runs: no hooks given here')
}
// an agent's work a line at a time (src/work-lines.js; docs/design/agent-work.md §2): by rule, in the page's language
{
  const { keepLines, linesOf, sayText, shortTarget, toolText } = await import('./src/work-lines.js')
  assert.equal(toolText({ name: 'Read', target: '/Users/x/posts/draft.md' }, 'zh'), '读了 posts/draft.md')
  assert.equal(toolText({ name: 'bash', target: 'npm test', live: true }, 'zh'), '在跑 npm test')
  assert.equal(toolText({ name: 'mcp__ruyix-workbench__stage_result' }, 'zh'), '交了结果', 'a tool of a server: by its own name')
  assert.equal(toolText({ name: 'exec_command', target: 'ls', ok: false }, 'en'), 'ran ls (failed)')
  assert.equal(toolText({ name: 'frobnicate', target: 'x' }, 'zh'), 'frobnicate x', 'one it does not know: as it is')
  assert.equal(toolText({ name: 'ToolSearch', target: 'select:mcp__ruyix-workbench__file_save' }, 'zh'), '找了工具', 'a target that says nothing to a person: left out')
  assert.equal(shortTarget('https://mp.weixin.qq.com/s/abc'), 'mp.weixin.qq.com/s/abc')
  assert.equal(sayText('**好的**，我先读一下原稿。然后改第二段。'), '好的，我先读一下原稿。')
  assert.equal(sayText('Done. Next I will check the links.'), 'Done.')
  assert.equal(sayText('By your clock in America/Los_Angeles, _now_ and __then__ in file_name.md.'), 'By your clock in America/Los_Angeles, now and then in file_name.md.', 'an underscore inside a word stays')
  assert.equal(sayText('a'.repeat(100)).length, 80)
  const act = { turnStartedAt: 100, recent: [{ name: 'Read', target: 'a.md', ok: true }, { name: 'Edit', target: 'a.md', ok: true, at: 300 }], tools: [{ name: 'Bash', target: 'npm test', at: 400 }], said: 'Fixed it.', saidAt: 350 }
  assert.deepEqual(linesOf(act, 'w', 'en').map(l => [l.text, l.kind, !!l.live]), [['read a.md', 'tool', false], ['edited a.md', 'tool', false], ['Fixed it.', 'say', false], ['running npm test', 'tool', true]], 'in time; one without its time after the turn\'s start')
  const many = Array.from({ length: 9 }, (_, i) => ({ at: i, agent: i % 2 ? 'b' : 'a', text: `t${i}`, kind: 'tool' }))
  assert.deepEqual(keepLines(many, 3).map(l => l.text), ['t3', 't4', 't5', 't6', 't7', 't8'], 'the newest few of each agent')
  assert.deepEqual(keepLines([{ at: 1, agent: 'a', text: 'x', kind: 'say' }, { at: 2, agent: 'a', text: 'x', kind: 'say' }]).map(l => l.at), [2], 'the same line again: once')
}
// the things open on the desk (open-model.js, open.js, src/open.js): grouped by where the person put them, the thing
// they belong to, a learned rule, their kind; kept in the box; the page's changes go as ops
{
  const { applyOpen, emptyOpen, groupsOf } = await import('./open-model.js')
  let st = emptyOpen(), t = 100
  const ch = op => { st = applyOpen(st, op, ++t) }
  const item = (id, kind, extra = {}) => ({ id, kind, title: id, reopen: { event: 'x:open', detail: { id } }, ...extra })
  ch({ op: 'add', item: item('run:r1', 'run', { of: 'run:r1', title: '写文章' }) })
  ch({ op: 'add', item: item('web:a', 'web', { of: 'run:r1', hint: 'github.com' }) })
  ch({ op: 'add', item: item('web:b', 'web', { hint: 'mp.weixin.qq.com' }) })
  ch({ op: 'add', item: item('term:main', 'term', { hint: 'tmux', win: 'term-main' }) })
  ch({ op: 'add', item: item('term:bg', 'term', { bg: true }) }); assert.equal(st.items.at(-1).bg, true, 'in the background')
  ch({ op: 'add', item: item('term:bg', 'term') }); assert.equal(st.items.find(x => x.id === 'term:bg').bg, undefined, 'opened again: in front'); ch({ op: 'forget', id: 'term:bg' })
  ch({ op: 'add', item: item('web:shared', 'web', { of: 'session:s9' }) }); ch({ op: 'add', item: item('web:shared', 'web') })
  assert.equal(st.items.find(x => x.id === 'web:shared').of, undefined, 'added again without its work: none'); ch({ op: 'forget', id: 'web:shared' })
  assert.equal(st.items.at(-1).win, 'term-main', 'a window on the desk: its id')
  const keys = () => groupsOf(st).map(g => `${g.key}=${g.items.map(x => x.id).join('+')}`)
  assert.deepEqual(keys(), ['kind:term=term:main', 'kind:web=web:b', 'run:r1=web:a+run:r1'], 'by the thing they belong to, else by kind; the latest used first')
  assert.deepEqual(groupsOf(st).map(g => g.title), [null, null, '写文章'], 'a kind\'s group: the page words it')
  assert.equal(groupsOf(st, { titleOf: k => (k === 'run:r1' ? 'From the work list' : null) }).at(-1).title, 'From the work list')
  // the work's name, kept: from the opener (ofTitle) or a title op; it outlives the work list
  ch({ op: 'add', item: item('file:brief', 'file', { of: 'run:r2', title: '简报原稿.md', ofTitle: '每分钟简报' }) })
  assert.equal(groupsOf(st).find(g => g.key === 'run:r2').title, '每分钟简报')
  ch({ op: 'close', id: 'file:brief' }); assert.equal(st.titles['run:r2'], '每分钟简报', 'kept while among the lately closed')
  ch({ op: 'pin', key: 'run:r1', pinned: true })
  assert.deepEqual(groupsOf(st).map(g => g.pinned), [false, false, true])
  // the person moves one: it stays there, and things like it (the same site) go there next time
  ch({ op: 'move', id: 'web:b', group: 'g:公众号' })
  ch({ op: 'close', id: 'web:b' })
  ch({ op: 'add', item: item('web:c', 'web', { hint: 'mp.weixin.qq.com' }) })
  assert.ok(keys().includes('g:公众号=web:c'), 'a learned rule')
  ch({ op: 'move', id: 'web:c', group: null })
  assert.ok(keys().includes('kind:web=web:c') && !st.rules.length, 'back where it would go: the rule goes too')
  // folding, closing, opening again
  ch({ op: 'foldGroup', key: 'run:r1', folded: true })
  assert.equal(groupsOf(st).find(g => g.key === 'run:r1').folded, true)
  ch({ op: 'use', id: 'web:a' })
  assert.equal(groupsOf(st)[0].key, 'run:r1', 'used: on top, unfolded')
  ch({ op: 'close', id: 'term:main' }); ch({ op: 'reopen', id: 'term:main' })
  ch({ op: 'add', item: item('win:tmp', 'window', { win: 'tmp', reopen: { event: 'ruyix-desk:focus', detail: { win: 'tmp' } } }) }); ch({ op: 'forget', id: 'win:tmp' })
  assert.ok(!st.items.some(x => x.id === 'win:tmp') && !st.closed.some(x => x.id === 'win:tmp'), 'forgotten: nothing could bring it back')
  ch({ op: 'add', item: item('made:gone', 'app') }); ch({ op: 'close', id: 'made:gone' }); ch({ op: 'forget', id: 'made:gone' })
  assert.ok(!st.closed.some(x => x.id === 'made:gone'), 'one closed, then forgotten: out of the closed too')
  assert.ok(st.items.some(x => x.id === 'term:main') && !st.closed.some(x => x.id === 'term:main'))
  assert.throws(() => applyOpen(st, { op: 'add', item: { id: 'x', kind: 'nope', reopen: { event: 'e' } } }), /kind/)
  assert.throws(() => applyOpen(st, { op: 'move', id: 'web:a', group: 'elsewhere' }), /group/)
  // its name in both languages (the page can change language): the page's, else its title; renamed, nothing else moves
  {
    const { nameOf } = await import('./open-model.js')
    let s2 = applyOpen(emptyOpen(), { op: 'add', item: item('win:term:z', 'term', { title: 'Terminal (Zellij)' }) }, 1)
    s2 = applyOpen(s2, { op: 'fold', id: 'win:term:z', folded: true }, 2)
    assert.equal(nameOf(s2.items[0], 'zh'), 'Terminal (Zellij)', 'no names: its title')
    s2 = applyOpen(s2, { op: 'rename', id: 'win:term:z', names: { zh: '终端（Zellij）', en: 'Terminal (Zellij)', fr: 'Terminal' } }, 3)
    assert.deepEqual(s2.items[0].names, { zh: '终端（Zellij）', en: 'Terminal (Zellij)' }, 'only zh and en')
    assert.equal(nameOf(s2.items[0], 'zh'), '终端（Zellij）')
    assert.ok(s2.items[0].usedAt === 1 && s2.items[0].folded, 'renamed: nothing else changes')
    assert.equal(applyOpen(s2, { op: 'rename', id: 'win:term:z', names: { en: 'Terminal (Zellij)', zh: '终端（Zellij）' } }, 4), s2, 'the same name: no change')
    s2 = applyOpen(s2, { op: 'add', item: item('run:r9', 'run', { of: 'run:r9', title: 'Brief', names: { zh: '简报', en: 'Brief' } }) }, 5)
    assert.deepEqual(groupsOf(s2).find(g => g.key === 'run:r9').names, { zh: '简报', en: 'Brief' }, 'a group named by its own item: in both languages')
    s2 = applyOpen(s2, { op: 'add', item: item('run:r9', 'run', { of: 'run:r9', title: 'Brief' }) }, 6)
    assert.equal(s2.items.find(x => x.id === 'run:r9').names, undefined, 'added again without names: none')
  }
  // in the box: ops in, the state kept
  const { createOpen } = await import('./open.js'), { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'ruyix-open-'))
  const box = createOpen({ home: tmp })
  box.apply({ ops: [{ op: 'add', item: item('page:wb', 'page', { hint: 'workbench' }) }] })
  assert.deepEqual(createOpen({ home: tmp }).state().items.map(x => x.id), ['page:wb'], 'kept in open.json')
  assert.throws(() => box.apply({ ops: [{ op: 'add', item: item('ok', 'page') }, { op: 'boom' }] }), /no op/)
  assert.equal(box.state().items.length, 1, 'one that does not apply: none of them')
  // the page: its change at once, then to the box; a look takes another page's
  const { openRegistry } = await import('./src/open.js')
  const events = [], fired = [], sent = []
  const heard = {}
  const w = { dispatchEvent: e => (e.type === 'ruyix:open-things' ? events.push(1) : fired.push([e.type, e.detail])), addEventListener: (k, f) => { heard[k] = f } }
  let boxState = box.state()
  const fake = async (url, o) => {
    if (o?.method === 'POST') { const { ops } = JSON.parse(o.body); sent.push(...ops.map(x => x.op)); boxState = box.apply({ ops }) }
    return { ok: true, json: async () => boxState }
  }
  const reg = openRegistry(w, fake)
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(reg.list().map(x => x.id), ['page:wb'], 'what the box has')
  reg.add(item('session:s1', 'session', { of: 'session:s1' }))
  assert.equal(reg.list().length, 2, 'at once on the page')
  await new Promise(r => setTimeout(r, 400))
  assert.deepEqual([sent, box.state().items.length], [['add'], 2])
  w.__ruyixWork = { get: () => [{ id: 'session:s1', title: '查一下竞品' }] }
  heard['ruyix:work']()
  assert.equal(reg.groups().find(g => g.key === 'session:s1').title, '查一下竞品')
  w.__ruyixWork = { get: () => [] } // (looked at: out of the work list)
  assert.equal(reg.groups().find(g => g.key === 'session:s1').title, '查一下竞品', 'the name kept')
  reg.open('session:s1')
  assert.deepEqual(fired.at(-1), ['x:open', { id: 'session:s1' }], 'opening one: its reopen event')
  assert.equal(openRegistry(w, fake), reg, 'one registry, whoever asks first')
  {
    // an answer that is no state (an error page, an empty one): the page keeps what it has
    const w2 = { dispatchEvent() {} }
    const odd = openRegistry(w2, async () => ({ ok: true, json: async () => ({}) }))
    await new Promise(r => setTimeout(r, 20))
    odd.add(item('x:1', 'web'))
    await new Promise(r => setTimeout(r, 400))
    assert.deepEqual([odd.list().map(x => x.id), odd.groups().length], [['x:1'], 1], 'still drawn from what it had')
  }
  // the main agent's tools: see by group, put one in a group (with the way back), close (a window: the page closes it)
  const { openTools } = await import('./open.js')
  const asked = [], tools = Object.fromEntries(openTools({ open: box, page: (e, d) => asked.push([e, d]) }).map(x => [x.name, x]))
  box.apply({ ops: [{ op: 'add', item: item('web:x', 'web', { hint: 'news.example', win: 'web-x' }) }] })
  assert.match((await tools.open_list.run({})).text, /## kind:web — Web pages\n- web:x \| web \| web:x/)
  const moved = await tools.open_group.run({ id: 'web:x', group: 'g:读的' })
  assert.deepEqual(moved.undo, { tool: 'open_group', args: { id: 'web:x', group: null } })
  assert.match((await tools.open_list.run({})).text, /## g:读的 — 读的\n- web:x/)
  const closed = await tools.open_close.run({ id: 'web:x' })
  assert.deepEqual([asked.at(-1), closed.undo.tool], [['ruyix:close-window', { win: 'web-x' }], 'open_reopen'])
  await tools.open_reopen.run({ id: 'web:x' })
  assert.deepEqual(asked.at(-1), ['x:open', { id: 'web:x' }])
  await assert.rejects(tools.open_focus.run({ id: 'nope' }), /open_list/)
  // arranging the windows: an open thing's window by its id, the page window, a page shown first, side by side
  const maxed = await tools.desk_window.run({ action: 'max', id: 'web:x' })
  assert.deepEqual(asked.at(-1), ['ruyix:desk-window', { action: 'max', win: 'web-x' }])
  assert.equal(maxed.summary.zh, '铺满桌面：web:x', 'the record in plain words')
  assert.equal((await tools.desk_window.run({ action: 'front', id: 'main' })).summary.zh, '拿到前面：页面窗口')
  await tools.desk_window.run({ action: 'front', page: 'ruyix-tasks' })
  assert.deepEqual(asked.at(-1), ['ruyix:desk-window', { action: 'front', page: 'ruyix-tasks' }])
  await tools.desk_window.run({ action: 'tile', ids: ['main', 'web:x'] })
  assert.deepEqual(asked.at(-1), ['ruyix:desk-window', { action: 'tile', wins: ['main', 'web-x'] }])
  await assert.rejects(tools.desk_window.run({ action: 'min' }), /which window/)
}
console.log('ruyix shell check: ok')

// ruyix config export/import (its own file: it builds homes and git repositories)
await import('./config-check.mjs')

// what an agent may change in this Ruyix, and its journal (its own file: it builds a home)
await import('./surfaces-check.mjs')

// voice input: the speech engine through a connection, and the page's WAV (its own file)
await import('./voice-check.mjs')

// the desk's notes: by widget id, an empty text removes one, a bad id or too many is refused
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createNotes, MAX } = await import('./notes.js')
  const n = createNotes({ home: mkdtempSync(join(tmpdir(), 'ruyix-notes-')) })
  assert.deepEqual(n.all(), { notes: {} })
  n.save({ id: 'a1', text: '买牛奶' })
  assert.deepEqual(n.all().notes, { a1: '买牛奶' })
  n.save({ id: 'a1', text: '' })
  assert.deepEqual(n.all().notes, {}, 'an empty note is gone')
  assert.throws(() => n.save({ id: '../x', text: 'y' }), e => e.code === 'badNote')
  for (let i = 0; i < MAX; i++) n.save({ id: `n${i}`, text: 'x' })
  assert.throws(() => n.save({ id: 'more', text: 'x' }), e => e.code === 'tooMany')
  assert.equal(n.save({ id: 'n0', text: 'y'.repeat(9000) }).notes.n0.length, 8000, 'cut to its length')
  console.log('ruyix notes check: ok')
}

{
  // the open things' groups laid out side by side (src/desktop/store.js tileRects): inside the area, not overlapping
  const { tileRects } = await import('./src/desktop/store.js')
  const area = { x: 226, y: 44, w: 1200, h: 760 }
  const inside = r => r.x >= area.x && r.y >= area.y && r.x + r.w <= area.x + area.w && r.y + r.h <= area.y + area.h
  const apart = (a, b) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
  for (let n = 0; n <= 9; n++) {
    const rs = tileRects(n, area)
    assert.equal(rs.length, n, `${n} windows, ${n} places`)
    assert.ok(rs.every(inside), `${n}: all inside the area`)
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(apart(rs[i], rs[j]), `${n}: ${i} and ${j} apart`)
    assert.ok(rs.every(r => r.w >= 200 && r.h >= 150), `${n}: each large enough to use`)
  }
  console.log('ruyix tiles check: ok')
}

{
  // the scenes' GLSL: no pow of 0.5 + 0.5·sin/cos unguarded — rounding takes it a hair below 0 where it should be 0, and
  // pow of a negative is NaN: black dots in a line across the picture (the core's rings looked cut by them)
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./src/desktop/wallpaper.js', import.meta.url), 'utf8')
  assert.deepEqual(src.match(/pow\(0\.5 \+ 0\.5 \* (sin|cos)\(/g) || [], [], 'guard it: pow(max(0.5 + 0.5 * sin(…), 0.0), n)')
  console.log('ruyix scenes check: ok')
}
