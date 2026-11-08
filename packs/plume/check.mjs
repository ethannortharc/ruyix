// The Plume pack's own check: the platforms' rules (X's weighted length, 小红书's limits, 公众号's), the article's HTML,
// the cards, image sizes — then a whole run on a fake Agent Hub (research off, a draft, its review, each platform's
// version, a person's edit on the review card, the publish cards; X posted through a fake X API, 公众号 approved with its
// link, 小红书 refused while its session has ended) — and the 小红书 fill on a local imitation of the creator page in a
// real browser (skipped where Playwright is not installed). No network.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORMS, charCount, check, errorsOf, fieldsOf, limitsOf, weighted } from './lib/platforms.js'
import { adaptationInput, FIT_DIMENSIONS } from './lib/adaptation.js'
import { knowledgeAuditMetadata, readKnowledgeCandidate } from './lib/platform-knowledge.js'
import { renderArticle } from './lib/article.js'
import { cardsFor } from './lib/cards.js'
import { imageSize } from './lib/images.js'
import { XHS, fillNote, keepCookies, xhsType } from './lib/xhs.js'

const tmp = mkdtempSync(join(tmpdir(), 'ruyix-plume-check-'))
const png = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b }


{
  const { postThread } = await import('./lib/x.js')
  let progress, calls = 0
  const client = { request: async () => { calls++; assert.ok(progress.uncertain?.attempt, 'intent persisted before network'); throw new Error('timeout after acceptance') } }
  await assert.rejects(postThread(client, { tweets: ['once'] }, () => {}, p => { progress = p }), e => !!e.uncertain && e.ids.length === 0)
  assert.equal(calls, 1); assert.equal(progress.uncertain.text, 'once')
}

// ── the rules ──
assert.equal(weighted('hello'), 5)
assert.equal(weighted('中文'), 4, 'a CJK character weighs 2')
assert.equal(weighted('看 https://example.com/a/very/long/path?x=1'), 2 + 1 + 23, 'a link weighs 23 whatever its length')
assert.equal(weighted('see example.com'), 4 + 23, 'a bare domain is a link too')
assert.equal(weighted('👍🏽'), 2, 'an emoji weighs 2')
assert.equal(charCount('👍🏽好'), 2)
const s0 = {}
{
  const input = { platform: 'x', fields: { tweets: ['A scoped statement.'] }, draft: 'A scoped statement.', settings: {}, audience: 'Creators', intent: 'Explain the sample limits' }
  const digest = adaptationInput(input).digest
  assert.notEqual(adaptationInput({ ...input, audience: 'First-time users' }).digest, digest, 'the target audience is bound to adaptation approval')
  assert.notEqual(adaptationInput({ ...input, intent: 'Announce the release' }).digest, digest, 'the author intent is bound to adaptation approval')
}
{
  const f = fieldsOf('xhs', { title: '一二三四五六七八九十一二三四五六七八九十多', body: '看这里 https://a.com', tags: ['#话题', '  ', 'b'], cards: [{ heading: 'h', points: ['p', 3] }] })
  assert.deepEqual(f.tags, ['话题', 'b'], 'a topic loses its #, an empty one goes')
  assert.deepEqual(f.cards, [{ heading: 'h', points: ['p'] }])
  const issues = check('xhs', f, [], s0)
  assert.deepEqual(issues.map(i => i.code).sort(), ['body.link', 'images.empty', 'title.max'])
  const tall = [{ name: 'a.png', size: 1000, width: 1080, height: 1440 }, { name: 'b.png', size: 1000, width: 1080, height: 1440 }]
  assert.deepEqual(errorsOf(check('xhs', { title: '好标题', body: '正文' }, tall, s0)), [])
  assert.ok(check('xhs', { title: '好标题', body: '正文' }, [...tall, { name: 'c.png', size: 1, width: 100, height: 100 }], s0).some(i => i.code === 'images.ratio.mixed'))
  assert.equal(limitsOf('xhs', { limits: { xhs: { titleMax: 30 } } }).titleMax, 30, 'a measured limit wins over the default')
  assert.deepEqual(errorsOf(check('xhs', { title: '一二三四五六七八九十一二三四五六七八九十多', body: 'x' }, tall, { limits: { xhs: { titleMax: 30 } } })), [])
}
{
  const long = '中'.repeat(141)
  const issues = check('x', { tweets: ['short', long, ''] }, [], s0)
  assert.deepEqual(issues.filter(i => i.level === 'error').map(i => i.field), ['tweets.1', 'tweets.2'])
  assert.deepEqual(errorsOf(check('x', { tweets: [long] }, [], { x: { premium: true } })), [], 'Premium: a long post is not an error')
  assert.ok(check('x', { tweets: ['a', 'b'] }, [], s0).find(i => i.code === 'cost').zh.includes('$0.030'))
}
{
  const issues = check('wechat_mp', { title: 'T', digest: 'x'.repeat(121), body: '[a](https://a.com)' }, [{ name: 'c.png', size: 1, width: 900, height: 383 }], s0)
  assert.deepEqual(issues.map(i => i.code).sort(), ['body.link', 'digest.max'])
  assert.equal(fieldsOf('wechat_mp', { bodyMd: '# x' }).body, '# x', 'Plume\'s field name is read too')
}
for (const p of Object.values(PLATFORMS)) assert.ok(p.guide(limitsOf(p.id, {}), {}).length > 100 && p.template, `${p.id} has a guide and a template`)

// ── the article: every style inline, what was written escaped ──
{
  const html = renderArticle('# 标题\n\n第一行\n第二行 **重点** 和 *斜体* `代码`\n\n## 小节\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n\n> 引用\n\n```\nconst a = 1 < 2\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[链接](https://example.com) <script>alert(1)</script>\n\n---', { accent: '#123456' })
  assert.match(html, /^<section style="[^"]+">/)
  assert.ok(!/<style|class=/.test(html), 'no <style>, no classes: the editor drops them')
  assert.match(html, /<h1 style="[^"]+">标题<\/h1>/)
  assert.match(html, /<p style="margin:0 0 1em;">第一行第二行 <strong style="color:#123456;font-weight:bold;">重点<\/strong> 和 <em[^>]*>斜体<\/em> <code[^>]*>代码<\/code><\/p>/, 'CJK lines join without a space')
  assert.match(html, /<h2 style="[^"]*border-left:4px solid #123456;[^"]*">小节<\/h2>/)
  assert.match(html, /<ul [^>]*><li [^>]*>一<\/li><li [^>]*>二<\/li><\/ul><ol [^>]*><li [^>]*>甲<\/li><li [^>]*>乙<\/li><\/ol>/)
  assert.match(html, /<blockquote [^>]*><p style="margin:0;">引用<\/p><\/blockquote>/)
  assert.match(html, /<pre [^>]*><code [^>]*>const a = 1 &lt; 2<\/code><\/pre>/)
  assert.match(html, /<table [^>]*><thead><tr><th [^>]*>a<\/th><th [^>]*>b<\/th><\/tr><\/thead><tbody><tr><td [^>]*>1<\/td><td [^>]*>2<\/td><\/tr><\/tbody><\/table>/)
  assert.match(html, /<a href="https:\/\/example\.com" style="[^"]+">链接<\/a> &lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'markup an agent wrote is text')
  assert.match(html, /<hr style="[^"]+">/)
  assert.ok(!/javascript:/.test(renderArticle('[x](javascript:alert(1))').replace(/&[a-z#0-9]+;/g, '').replace(/>[^<]*</g, '><')), 'only http(s) links')
  // what an agent writes never becomes markup: nested image and link, quotes, an attribute smuggled in a URL
  for (const md of ['![a [b](https://e.invalid/x) c](https://img.invalid/onerror=document.title=1337;//)', '[x](https://a.invalid/"onmouseover="alert(1))', "![x](https://a.invalid/'onerror='alert(1))", '**[a](https://a.invalid/x)**<img src=x onerror=alert(1)>']) {
    const h = renderArticle(md)
    const tags = [...h.matchAll(/<([a-z0-9]+)((?:\s[a-z-]+="[^"]*")*)\s*>/g)]
    assert.ok(tags.every(m => [...m[2].matchAll(/\s([a-z-]+)=/g)].every(a => ['style', 'href', 'src', 'alt'].includes(a[1]))), `no attribute of its own: ${h}`)
    assert.ok(!/<img[^>]*onerror|<[^>]+\son[a-z]+=/i.test(h), h)
  }
}

// ── the cards, the sizes ──
{
  const cards = cardsFor('xhs', { title: 'T', cover: { title: '封面 <b>', subtitle: '副' }, cards: [{ heading: '一', points: ['**重点**'] }, { heading: '二', points: ['b'] }] }, { brand: { accent: '#ff0000' }, signature: '@me' })
  assert.deepEqual(cards.map(c => [c.name, c.width, c.height]), [['xhs-01.png', 1080, 1440], ['xhs-02.png', 1080, 1440], ['xhs-03.png', 1080, 1440]])
  assert.match(cards[0].html, /封面 &lt;b&gt;/, 'what was written is escaped')
  assert.match(cards[0].html, /共 3 页/)
  assert.match(cards[1].html, /<b>重点<\/b>/)
  assert.equal(cardsFor('wechat_mp', { title: 'T', digest: 'd' }, {})[0].scale, 2)
  assert.match(cardsFor('x', { tweets: ['第一句。第二句'] }, { brand: { accent: 'javascript:x' } })[0].html, /第一句<\/span>/, 'the X cover takes the first sentence; a colour that is not one falls back')
  assert.deepEqual(imageSize(png(1080, 1440)), { width: 1080, height: 1440 })
  assert.equal(imageSize(Buffer.from('nope')), null)
}

// ── 小红书's connection type ──
{
  const kept = JSON.parse(keepCookies([{ name: 'a', value: '1', domain: '.xiaohongshu.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }, { name: 'b', value: '2', domain: 'evil.com' }]))
  assert.deepEqual(kept, [{ name: 'a', value: '1', domain: '.xiaohongshu.com', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }], 'only the site\'s own cookies are kept')
  assert.equal(xhsType.signin.ready('https://creator.xiaohongshu.com/login', [1, 2, 3]), false)
  assert.equal(xhsType.signin.ready('https://creator.xiaohongshu.com/new/home', [1, 2, 3]), true)
  assert.deepEqual(xhsType.headers(JSON.stringify(kept)), { cookie: 'a=1' })
  assert.deepEqual(xhsType.env({}, { session: 'S' }, { write: true }), {}, 'the session is never a command\'s environment')
  assert.deepEqual(xhsType.cookies({}, { session: JSON.stringify(kept) }), kept, 'a browser gets it')
}

// ── a whole run, on a fake Agent Hub ──
process.env.RUYIX_WORKBENCH_HOME = join(tmp, 'home')
const { createWorkbench } = await import('@ruyix/workbench')
const { toolsPost } = await import('../../core/workbench/lib/mcp-client.mjs')
const { createPack } = await import('./pack.js')
const { createStudios } = await import('../../core/plugins/studio/index.js')
const { studio } = await import('./studio.js')
let wb
const studios = createStudios({ home: join(tmp, 'studios'), workbench: () => wb?.service }).studios
studios.register(studio)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (what, fn, ms = 10000) => { for (const t = Date.now(); ; await sleep(20)) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error(`timed out: ${what}`) } }
const tasks = new Map(), members = {}
let n = 0
const hub = {
  list: new Map([['sonnet', { id: 'sonnet', runtime: 'claude' }], ['codex', { id: 'codex', runtime: 'codex' }]]),
  ensureAgents: defs => { for (const d of defs) if (!hub.list.has(d.id)) hub.list.set(d.id, d) },
  agents: () => [...hub.list.values()], agent: id => hub.list.get(id) || null, defaultAgent: () => null,
  registerSkillPack: () => () => {}, registerAgentUses: () => () => {}, registerSkillUses: () => () => {}, skillPackVersion: () => null, skills: async () => [],
  startJob: async ({ cwd }) => ({ id: 'j1', leadId: 'lead', status: 'running', cwd }), job: () => ({ status: 'running' }),
  assign(jobId, { role, task }, extra) {
    const t = { id: `t${++n}`, role, task, status: 'running', runtime: 'claude', mcp: extra.mcp }
    t.done = new Promise(r => { t.finish = r })
    tasks.set(t.id, t)
    setTimeout(async () => { try { t.output = await members[role](t); t.status = 'done' } catch (err) { t.status = 'failed'; t.error = err.stack } t.finish(t) }, 5)
    return { ...t }
  },
  whenTaskDone: id => tasks.get(id).done, task: () => undefined, cancelTask: id => { tasks.get(id).status = 'cancelled' }, finishJob: () => {}, stopJob: () => {},
}
const xCalls = []
const clients = [], uploaded = []
let onUpload = null
let failAt = 0 // the n-th post the fake X refuses once
let unknownAt = 0 // the n-th POST loses its receipt once; the request reached the fake provider
const conns = {
  has: id => ['x', 'x-b', 'xhs'].includes(id),
  client: id => (clients.push(id), {
    async request(path, { method = 'GET', body } = {}) {
      if (path === '/tweets' && failAt && xCalls.filter(c => c.path === '/tweets').length + 1 === failAt) { failAt = 0; return { ok: false, status: 429, text: async () => 'over capacity' } }
      xCalls.push({ path, method, body: body instanceof FormData ? 'form' : body })
      if (path === '/tweets' && unknownAt && xCalls.filter(c => c.path === '/tweets').length === unknownAt) { unknownAt = 0; throw new Error('connection closed after the provider may have accepted the post') }
      if (path === '/media/upload/initialize') await onUpload?.()
      if (body instanceof FormData) uploaded.push(Buffer.from(await body.get('media').arrayBuffer()))
      const json = path === '/media/upload/initialize' ? { data: { id: 'm1' } } : path === '/tweets' ? { data: { id: `p${xCalls.filter(c => c.path === '/tweets').length}` } } : path === '/users/me' ? { data: { username: 'me' } } : {}
      return { ok: true, status: 200, text: async () => JSON.stringify(json) }
    },
  }),
  env: async () => ({}),
  browserCookies: async () => [{ name: 'a', value: '1', domain: '.xiaohongshu.com', path: '/' }],
  require: () => () => {}, needs: () => [], list: async () => [],
}
// a browser that renders a tiny PNG, and whose 小红书 page says the session ended
const opened = [], closedRuns = []
const browsers = {
  render: async ({ width, height, scale = 1 }) => png(width * scale, height * scale),
  open: async opts => { opened.push(opts); const page = { goto: async () => {}, url: () => XHS.login, locator: () => ({ first: () => ({}) }) }; return { id: 'b1', page, session: {} } },
  step() {}, shot: async () => {}, close: async () => {}, closeRun: async id => { closedRuns.push(id) }, list: () => [], dispose: async () => {},
}
const routes = {}
const ctx = {
  logger: { warn: () => {}, info: () => {}, debug: () => {} },
  provide: (k, v) => { ctx[`_${k}`] = v },
  inject: (deps, cb) => cb({ ...Object.fromEntries(deps.map(d => [d, { agentHub: hub, connectors: conns, ruyixStudio: studios, ruyixShell: { part: () => () => {} } }[d]])), effect: fn => fn() }),
  sessionController: { modelCatalog: async () => ({ providers: [] }) },
  sessionProjections: { register: () => () => {}, snapshot: () => ({ values: {} }) },
  llm: null, agents: { list: () => [], get: () => null }, effect: fn => fn(), on: () => {},
  connection: { fetch: { register: r => { routes[r.path] = r } } },
}
wb = createWorkbench(ctx, { toolbox: null, browsers, engineOptions: { settleMs: 20, resumeDelayMs: 1e9 } })
wb.registerPack(createPack())
const op = async (name, args = {}) => {
  const res = await routes['/api/ruyix-workbench'].fetch(new Request('http://x/api/ruyix-workbench', { method: 'POST', body: JSON.stringify({ op: name, ...args }) }))
  const body = await res.json()
  if (!res.ok) throw Object.assign(new Error(body.error), { code: body.code })
  return body
}
const tool = (t, name, args) => toolsPost(t.mcp.env.RUYIXWB_URL, t.mcp.env.RUYIXWB_TOKEN, '/call', { name, args })
const folder = t => /Your working folder is (\S+?):/.exec(t.task)[1]
let writerTurns = 0
members.writer = async t => {
  writerTurns++
  writeFileSync(join(folder(t), 'outline.md'), '# 提纲\n\n读者：创业者。问题：为什么做 Ruyix？结论来自参考资料。\n')
  writeFileSync(join(folder(t), 'draft.md'), '# 为什么做 Ruyix\n\n## 为什么\n\n因为……\n')
  return (await tool(t, 'stage_result', { result: { title: '为什么做 Ruyix', keyPoints: ['一', '二', '三', '四', '五'], summary: 'drafted' } })).text
}
members.researcher = async t => {
  assert.match(t.task, /https:\/\/example.com\/source/); assert.match(t.task, /创业者/); assert.match(t.task, /reference.md/)
  writeFileSync(join(folder(t), 'research.md'), '# 调研\n\n' + '这是给创业者的参考材料，确认已有功能和仍需检验的假设，不把假设作为事实。'.repeat(3) + ' [1]\n\n## 来源\n[1] 原始资料 https://example.com/source\n')
  return (await tool(t, 'stage_result', { result: { summary: '已检查原始资料', sources: [{ title: '原始资料', url: 'https://example.com/source', evidence: '功能证据' }] } })).text
}
let adaptTurns = 0, adapterHook = null
members.adapter = async t => {
  adaptTurns++
  await adapterHook?.(t)
  const dir = join(folder(t), 'posts')
  ;(await import('node:fs')).mkdirSync(dir, { recursive: true })
  // first a title that is too long: stage_result says so, the agent fixes it in the same task
  writeFileSync(join(dir, 'xhs.json'), JSON.stringify({ title: '这是一个特别特别特别特别特别特别长的标题啊', body: '正文', tags: ['a'], cover: { title: '封面', subtitle: '副' }, cards: [{ heading: '一', points: ['甲'] }] }))
  writeFileSync(join(dir, 'x.json'), JSON.stringify({ tweets: ['first', 'second'] }))
  writeFileSync(join(dir, 'wechat_mp.json'), JSON.stringify({ title: '标题', digest: '摘要', body: '## 一\n\n正文' }))
  const first = (await tool(t, 'stage_result', { result: { platforms: ['xhs', 'x', 'wechat_mp'], summary: 'written' } }).catch(e => ({ text: e.message })))
  assert.match(first.text || first.error || '', /标题 \d+ 字，超过 20 字/, 'the platform rules come back to the agent')
  writeFileSync(join(dir, 'xhs.json'), JSON.stringify({ title: '短标题', body: '正文', tags: ['a'], cover: { title: '封面', subtitle: '副' }, cards: [{ heading: '一', points: ['甲'] }] }))
  return (await tool(t, 'stage_result', { result: { platforms: ['xhs', 'x', 'wechat_mp'], summary: 'written' } })).text
}
// The fixture models an independent read-only auditor, never writes its own approval state.
// Editorial verdicts here describe synthetic test strings; real factual claims need source excerpts.
let auditHook = null, auditResult = null, auditSubmittedHook = null, auditorTurns = 0
const correctedInvalidAudits = new Map()
members.auditor = async t => {
  auditorTurns++
  assert.match(t.task, /READ ONLY/)
  const item = JSON.parse(t.task.split('INPUT DATA:\n').at(-1).split('\nEND INPUT DATA')[0])
  await auditHook?.(item, t)
  const result = { summary: 'Synthetic fixture: each format and text unit inspected',
    checks: FIT_DIMENSIONS.map(dimension => ({ dimension, verdict: 'pass', reason: `Fixture ${dimension} is compatible with the selected platform` })),
    units: item.units.map(unit => ({ ...unit, verdict: 'editorial', sourceExcerpt: '', reason: 'Synthetic fixture text, not a claim about real-world facts' })) }
  const context = (await tool(t, 'wb_context', {})).text
  const auditRun = wb.engine.get(/^Run (\S+) ·/m.exec(context)?.[1])
  assert.ok(auditRun, 'the auditor is executing inside a registered workflow run')
  if (!correctedInvalidAudits.has(auditRun.template)) {
    const invalid = structuredClone(result)
    invalid.units[0] = { ...invalid.units[0], verdict: 'supported', sourceExcerpt: 'INVALID EXCERPT: this exact string does not occur in the master draft' }
    await assert.rejects(tool(t, 'stage_result', { result: invalid }), /exact supporting excerpt/, 'ADAPT-1: the auditor receives the full validation error before its task completes')
    correctedInvalidAudits.set(auditRun.template, auditRun.id)
  }
  await auditResult?.(result, item)
  const submitted = await tool(t, 'stage_result', { result })
  await auditSubmittedHook?.(item, t)
  return submitted.text
}
let platformResearchTurns = 0, platformAuditTurns = 0
members.platformResearcher = async t => {
  platformResearchTurns++
  assert.match(t.task, /Research these platforms: x/)
  assert.match(t.task, /Earlier profiles/)
  const dir = folder(t), path = 'platform-research/sources/x-counting.md', quote = 'All URLs count as 23 characters.'
  ;(await import('node:fs')).mkdirSync(join(dir, 'platform-research/sources'), { recursive: true })
  // Synthetic retrieval fixture: no real external requests. The production validator captures and hashes these bytes.
  writeFileSync(join(dir, path), `Source: https://docs.x.com/fundamentals/counting-characters\n${quote}\nThis synthetic test capture models the surrounding context: a URL is transformed for the standard post counter; no ranking or reach conclusion follows from its counting weight.\n`)
  const profile = { platform: 'x', summary: `Scheduled evidence fixture ${platformResearchTurns}: text counting and bounded editorial advice.`, sources: [{ id: 'count', url: 'https://docs.x.com/fundamentals/counting-characters', title: 'Counting characters', publisher: 'X', authority: 'official', availability: 'read', accessedAt: new Date().toISOString(), publishedAt: null, summary: 'Synthetic fixture of documented URL counting.', evidencePath: path, quotes: [quote] }], observations: [{ id: 'url-weight', dimension: 'format', statement: 'For the standard post counter, account for a URL as 23 characters.', authority: 'official', sourceIds: ['count'], limitations: 'A counting rule, not a promise about recommendations.' }, { id: 'opening', dimension: 'opening', statement: 'State the main point before supporting detail.', authority: 'editorial', sourceIds: [], limitations: 'Optional editorial default for this fixture.' }], conflicts: [], unknowns: ['No live account or exposure data is measured by this test.'] }
  writeFileSync(join(dir, 'platform-research/research.json'), JSON.stringify({ profiles: [profile] }))
  return (await tool(t, 'stage_result', { result: { summary: 'Synthetic retrieval and manifest prepared.' } })).text
}
members.platformAuditor = async t => {
  platformAuditTurns++
  assert.match(t.task, /Read-only: do not alter/)
  const manifest = JSON.parse(readFileSync(join(folder(t), 'platform-research/research.json'), 'utf8'))
  for (const p of manifest.profiles) for (const source of p.sources) {
    const capture = readFileSync(join(folder(t), source.evidencePath), 'utf8')
    for (const quote of source.quotes) assert.ok(capture.includes(quote))
  }
  const checks = manifest.profiles.flatMap(p => p.observations.map(o => ({ platform: p.platform, id: o.id, statement: o.statement, authority: o.authority, sourceIds: o.sourceIds, classification: o.authority === 'editorial' ? 'recommendation' : 'fact', verdict: o.authority === 'editorial' ? 'editorial' : 'supported', reason: 'Synthetic independent auditor matched the exact observation, source and scope.' })))
  const run = wb.store.list('run').find(r => r.template === 'plume.platform-research' && r.dir === folder(t))
  assert.ok(run, 'the metadata audit is bound to the real registered research run')
  const profileChecks = knowledgeAuditMetadata(readKnowledgeCandidate(run)).map(({ platform, metadataDigest }) => ({ platform, metadataDigest, verdict: 'supported', reason: 'Synthetic independent auditor checked source identity, dates, summaries and limitations against the captures.' }))
  return (await tool(t, 'stage_result', { result: { summary: 'Every fixture observation and its complete profile metadata independently inspected.', checks, profileChecks, warnings: [] } })).text
}
const postView = async (run, platform) => (await op('plume.posts', { run })).platforms.find(p => p.id === platform)
const recheck = async (run, platform, expectedStatus = 'done') => {
  const before = await postView(run, platform)
  const { run: audit } = await op('plume.recheckAdaptation', { run, platform, expectedDigest: before.digest })
  await until(`adaptation review ${audit.id} completes`, () => ['done', 'failed', 'cancelled'].includes(wb.engine.get(audit.id).status))
  const finished = wb.engine.get(audit.id)
  assert.equal(finished.status, expectedStatus, JSON.stringify(finished.stages.map(s => [s.key, s.status, s.note])))
  const current = await postView(run, platform)
  if (expectedStatus === 'done') {
    assert.equal(current.adaptation.current, true)
    assert.equal(current.adaptation.passed, true)
    assert.equal(current.adaptation.auditRun, audit.id)
    assert.ok(!current.issues.some(i => i.code === 'adaptation.review'))
  }
  return current
}
const decide = async (title, choice = 0) => {
  const card = await until(`the card "${title}"`, () => wb.store.list('approval').find(a => a.title === title && a.status === 'pending'))
  const plumeDigests = card.payload.stage === 'preview' ? Object.fromEntries((await op('plume.posts', { run: card.runId })).platforms.map(p => [p.id, p.digest])) : undefined
  return op('approve', { id: card.id, payload: { choice, ...(plumeDigests && { plumeDigests }) } })
}
// Every product restart route must refuse before closing a handoff browser or changing the Studio/task lifecycle.
const assertRestartRefused = async (id, error) => {
  const before = wb.engine.get(id), idea = studios.get('plume', 'ideas', before.studio.record), task = wb.store.get('task', before.taskId), closes = closedRuns.length
  const routes = [
    () => wb.engine.continueRun(id, { from: 'adapt' }),
    () => op('resumeRun', { id, from: 'adapt' }),
    () => op('resultsRestart', { id, from: 'adapt' }),
    () => op('taskRevise', { id: before.taskId, run: id, text: 'Rewrite this post' }),
  ]
  for (const restart of routes) {
    await assert.rejects(restart(), error)
    assert.equal(closedRuns.length, closes, 'a refused restart cannot close the filled-in browser')
    assert.deepEqual(wb.engine.get(id), before, 'status, stages, results and publication evidence remain untouched')
    assert.deepEqual(studios.get('plume', 'ideas', before.studio.record), idea, 'the Studio record remains in its current managed state')
    assert.deepEqual(wb.store.get('task', before.taskId), task, 'refused task revision has no lifecycle side effects')
  }
}
try {
  const account = studios.put('plume', 'accounts', { name: 'Account B', xConnection: 'x-b', xPremium: true, accent: '#123456' })
  const material = studios.addMaterial('plume', 'photo.png', png(1080, 1440))
  const reference = studios.addMaterial('plume', 'reference.md', Buffer.from('# 原始资料\n\n这是参考资料。'))
  const referenceImage = studios.addMaterial('plume', 'reference.png', png(300, 300))
  assert.equal(createPack().workflows.post.roles.researcher.access, 'write', 'research must be able to write its evidence files')
  const idea = studios.put('plume', 'ideas', { title: '为什么做 Ruyix', notes: '写一篇', account: account.id, images: [material.id], audience: '创业者', research: true, references: 'https://example.com/source', materials: [reference.id, referenceImage.id] })
  const r = await studios.start('plume', 'write', idea.id)
  assert.equal(wb.engine.get(r.id).subject.fields.audience, '创业者')
  assert.deepEqual(wb.engine.get(r.id).subject.attachments.map(a => a.field), ['images', 'materials', 'materials'])
  const accountTweet = 'e'.repeat(400)
  await until('master draft waits for the person', () => wb.store.list('approval').some(a => a.runId === r.id && a.payload?.stage === 'review' && a.status === 'pending'))
  const settingsAtDraftReview = await op('settings')
  const liveStyle = 'ADAPT-2: use the current account voice saved while the master draft review is waiting.'
  const updatedStyleSettings = structuredClone(settingsAtDraftReview.settings)
  updatedStyleSettings.packs.plume.style.guide = liveStyle
  await op('saveSettings', { settings: updatedStyleSettings, revision: settingsAtDraftReview.revision })
  let adapterSawLiveStyle = false
  adapterHook = t => { assert.ok(t.task.includes(liveStyle), 'ADAPT-2: adaptation brief uses settings changed after run start'); adapterSawLiveStyle = true }
  await decide('看原稿')
  // the review card of each platform's version: its editor reads them; the person changes X's posts there
  let card = await until('the preview card', () => wb.store.list('approval').find(a => a.title === '看各平台的稿子' && a.status === 'pending'))
  adapterHook = null
  assert.equal(adapterSawLiveStyle, true)
  assert.equal(correctedInvalidAudits.get('plume.post'), r.id, 'ADAPT-1: correcting the rejected excerpt lets the main workflow reach preview')
  assert.ok((await op('plume.posts', { run: r.id })).platforms.every(p => p.adaptation.current && p.adaptation.passed), 'ADAPT-2: automatic audits already approve the current settings at preview, without manual rechecks')
  const taskRunCount = wb.store.get('task', r.taskId).runCount
  for (let restart = 0; restart < 2; restart++) {
    const previousPreview = card.id
    await wb.engine.rewindRun(r.id, { from: 'preview' })
    card = await until('a fresh Studio-bound review after rewind', () => wb.store.list('approval').find(a => a.runId === r.id && a.title === '看各平台的稿子' && a.id !== previousPreview && a.status === 'pending'))
    assert.equal(studios.get('plume', 'ideas', idea.id).status, 'writing', 'rewinding a Studio run restores its managed writing state')
    assert.equal(wb.store.get('task', r.taskId).runCount, taskRunCount, 'resuming the same run never increments task runCount')
  }
  assert.equal(card.payload.editor, 'workbench.review') // the review's own page, with the pack's display inside
  assert.equal(card.payload.review.display, 'plume.posts')
  assert.ok(!card.payload.options.some(o => o.action === 'amend'), 'the posts are not revised in place: changes go back to their step')
  const posts = await op('plume.posts', { run: r.id })
  assert.deepEqual(posts.platforms.map(p => [p.id, p.images.length]), [['xhs', 3], ['x', 1], ['wechat_mp', 1]], '小红书: two cards and the photo; X: the photo; 公众号: its cover')
  assert.deepEqual(posts.platforms.map(p => errorsOf(p.issues).length), [0, 0, 0])
  const x = await op('plume.savePost', { run: r.id, platform: 'x', fields: { tweets: [accountTweet, 'second', 'third'] } })
  assert.deepEqual(x.fields.tweets, [accountTweet, 'second', 'third'])
  assert.deepEqual(errorsOf(x.issues).map(i => i.code), ['adaptation.review'], 'Premium passes length checks, but changed text requires another independent audit')
  await assert.rejects(op('plume.savePost', { run: r.id, platform: 'x', fields: { tweets: ['stale overwrite'] }, expectedDigest: posts.platforms.find(p => p.id === 'x').digest }), /another window/)
  assert.deepEqual((await op('plume.posts', { run: r.id })).platforms.find(p => p.id === 'x').fields.tweets, x.fields.tweets)
  const run1 = wb.engine.get(r.id)
  assert.ok((await op('fileAt', { id: r.id, path: 'posts/x.json' })).text.includes(accountTweet), 'the edit is a version of the folder')
  assert.ok(run1.guidance.some(g => g.edit === 'posts/x.json'), 'the steps after it are told')
  const originalXhs = (await op('plume.posts', { run: r.id })).platforms.find(p => p.id === 'xhs').fields
  const oldRender = browsers.render, rendered = []
  browsers.render = async spec => { rendered.push(spec.html); await new Promise(r => setTimeout(r, 2)); return oldRender(spec) }
  try {
    const a = { title: 'First save', cards: [{ heading: 'A1', points: ['one'] }, { heading: 'A2', points: ['two'] }] }
    const b = { title: 'Second save', cards: [{ heading: 'B1', points: ['three'] }] }
    const saved = await Promise.all([a, b].map(fields => op('plume.savePost', { run: r.id, platform: 'xhs', fields })))
    assert.equal(saved[1].fields.title, 'Second save')
    assert.equal(JSON.parse(readFileSync(join(r.dir, 'posts/xhs.json'), 'utf8')).title, 'Second save')
    assert.deepEqual(wb.engine.get(r.id).plume.images.xhs.map(i => i.name), saved[1].images.filter(i => i.name.startsWith('xhs-')).map(i => i.name))
    assert.ok(rendered.findIndex(h => h.includes('B1')) > rendered.findIndex(h => h.includes('A2')), 'the second render waits for the complete first save')
  } finally { browsers.render = oldRender }
  await op('plume.savePost', { run: r.id, platform: 'xhs', fields: originalXhs })
  // Preconditions may refuse an edit before writing. Its last good cards and preview must remain usable.
  const beforeRefusedSave = wb.engine.get(r.id).plume.rendered.x
  const beforeRefusedFields = (await op('plume.posts', { run: r.id })).platforms.find(p => p.id === 'x')
  const availableEdit = wb.engine.versions.edit
  for (const code of ['noVersions', 'runBusy']) {
    wb.engine.versions.edit = async () => { throw Object.assign(new Error(code), { code }) }
    try { await assert.rejects(op('plume.savePost', { run: r.id, platform: 'x', fields: { tweets: ['refused new draft'] } }), new RegExp(code)) }
    finally { wb.engine.versions.edit = availableEdit }
    assert.equal(wb.engine.get(r.id).plume.rendered.x, beforeRefusedSave)
    const unchanged = (await op('plume.posts', { run: r.id })).platforms.find(p => p.id === 'x')
    assert.equal(unchanged.digest, beforeRefusedFields.digest)
    assert.ok(!unchanged.issues.some(i => i.code === 'render.changed'))
  }
  assert.match((await op('approve', { id: card.id, payload: { choice: 0 } })).approval.error, /changed since you looked/)
  wb.store.put('approval', { ...wb.store.get('approval', card.id), status: 'pending' })
  const unaudited = await decide('看各平台的稿子')
  assert.match(unaudited.approval.error, /fix the platform checks/, 'a saved version cannot skip independent review')
  writeFileSync(join(r.dir, 'adaptation-x.json'), JSON.stringify({ passed: true, digest: x.digest, checks: [] }))
  assert.ok((await postView(r.id, 'x')).issues.some(i => i.code === 'adaptation.review'), 'forging an audit artifact cannot change server approval state')
  await recheck(r.id, 'x')
  assert.ok(correctedInvalidAudits.has('plume.adaptation-review'), 'ADAPT-1: an invalid excerpt is corrected inside the independent recheck, which finishes normally')
  await recheck(r.id, 'xhs')
  await op('approve', { id: card.id, payload: { choice: 0, plumeDigests: Object.fromEntries((await op('plume.posts', { run: r.id })).platforms.map(p => [p.id, p.digest])) } })
  await until('the run ends', () => ['done', 'failed'].includes(wb.engine.get(r.id).status))
  assert.equal(wb.engine.get(r.id).status, 'done', JSON.stringify(wb.engine.get(r.id).stages.map(s => [s.key, s.status, s.note])))
  assert.equal(adaptTurns, 1, 'one task: the fix happened inside it')
  assert.equal(studios.get('plume', 'ideas', idea.id).status, 'ready', 'no platform has been published yet')
  // Rechecks run through the real engine; artifacts and optimistic client flags cannot approve a post.
  {
    const publishGate = wb.store.list('approval').find(a => a.runId === r.id && a.action === 'plume_publish_x')
    assert.match((await op('approve', { id: publishGate.id })).approval.error, /look at what goes out first/, 'a publish card needs the displayed digest before its first approval')
    const assertBlocked = async message => {
      const current = await postView(r.id, 'x')
      assert.ok(current.issues.some(i => i.code === 'adaptation.review'), message)
      const calls = xCalls.length
      const refused = await op('approve', { id: publishGate.id, payload: { digest: current.digest } })
      assert.equal(refused.approval.status, 'failed')
      assert.match(refused.approval.error, /适配审核|adaptation review/)
      assert.equal(xCalls.length, calls, 'adaptation refusal precedes external API calls')
    }
    const canonical = readFileSync(join(r.dir, 'draft.md'), 'utf8')
    await wb.engine.editFile(r.id, { path: 'draft.md', content: canonical + '\n\nA changed source qualifier.' })
    await assertBlocked('master edits invalidate previous platform audits')
    await recheck(r.id, 'x')
    await wb.engine.editFile(r.id, { path: 'draft.md', content: canonical })
    await recheck(r.id, 'x')

    const initialSettings = await op('settings')
    const changedSettings = structuredClone(initialSettings.settings)
    changedSettings.packs.plume.style.guide = 'A changed account-default voice for this test'
    await op('saveSettings', { settings: changedSettings, revision: initialSettings.revision })
    await assertBlocked('current voice settings invalidate previous platform audits')
    await recheck(r.id, 'x')
    await op('saveSettings', { settings: initialSettings.settings })
    await recheck(r.id, 'x')

    const auditBefore = wb.engine.get(r.id).plume.adaptation.x
    let entered = false, releaseAudit
    const auditWait = new Promise(resolve => { releaseAudit = resolve })
    auditHook = async () => { entered = true; await auditWait }
    const before = await postView(r.id, 'x')
    const { run: pendingAudit } = await op('plume.recheckAdaptation', { run: r.id, platform: 'x', expectedDigest: before.digest })
    await until('the independent auditor is reading', () => entered)
    const duplicate = await op('plume.recheckAdaptation', { run: r.id, platform: 'x', expectedDigest: before.digest })
    assert.equal(duplicate.run.id, pendingAudit.id, 'identical concurrent review requests reuse the active audit')
    const editedFields = { tweets: [...before.fields.tweets, 'Concurrent synthetic edit'] }
    await op('plume.savePost', { run: r.id, platform: 'x', fields: editedFields, expectedDigest: before.digest })
    releaseAudit(); auditHook = null
    await until('stale independent audit ends', () => ['done', 'failed'].includes(wb.engine.get(pendingAudit.id).status))
    assert.equal(wb.engine.get(pendingAudit.id).status, 'failed')
    assert.deepEqual(wb.engine.get(r.id).plume.adaptation.x, auditBefore, 'a stale result cannot attach to the edited version')
    await assertBlocked('content changed during read-only review')
    await op('plume.savePost', { run: r.id, platform: 'x', fields: before.fields })

    auditResult = result => { result.checks.find(c => c.dimension === 'tone').verdict = 'fail' }
    const failedFit = await recheck(r.id, 'x', 'failed')
    assert.equal(failedFit.adaptation.current, true)
    assert.equal(failedFit.adaptation.passed, false)
    await assertBlocked('a failed fit dimension cannot publish')
    const lastComplete = wb.engine.get(r.id).plume.adaptation.x
    auditResult = result => { result.units.pop() }
    await recheck(r.id, 'x', 'failed')
    assert.deepEqual(wb.engine.get(r.id).plume.adaptation.x, lastComplete, 'incomplete unit coverage cannot replace the last complete audit')
    await assertBlocked('incomplete text coverage cannot publish')
    auditResult = null
    await recheck(r.id, 'x')
    for (const platform of ['xhs', 'wechat_mp']) await recheck(r.id, platform)
    assert.ok(auditorTurns >= 10, 'workflow assertions used actual independent auditor turns')
  }
  const beforeHandoff = wb.engine.get(r.id)
  wb.store.put('run', { ...beforeHandoff, plume: { ...beforeHandoff.plume, handoffs: { xhs: { digest: 'filled-version', at: Date.now() } } } })
  await assertRestartRefused(r.id, /create a new idea/)
  wb.store.put('run', beforeHandoff)
  // Plain runs bind their connection even when settings change after the card is created.
  {
    const { actions, DEFAULTS } = await import('./pack.js')
    let clients = 0
    for (const platform of ['x', 'xhs']) for (const account of ['new-account', 'shown-account']) {
      await assert.rejects(actions[`plume_publish_${platform}`]({
        run: { ...wb.engine.get(r.id), account: null },
        currentPackSettings: () => ({ ...DEFAULTS, x: { premium: true, cover: false }, accounts: { [platform]: account } }),
        packSettings: { ...DEFAULTS, accounts: { [platform]: 'shown-account' } },
        approval: { payload: { connection: 'new-account', digest: (await op('plume.posts', { run: r.id })).platforms.find(p => p.id === platform).digest } },
        services: { connectors: () => { clients++; throw new Error('must not reach a client') } },
      }), e => e.code === 'changedMeanwhile' && /account changed/.test(e.message))
    }
    assert.equal(clients, 0, 'no client is acquired for an account the card did not show')
  }
  const cards = wb.store.list('approval').filter(a => a.runId === r.id && a.action.startsWith('plume_publish_'))
  assert.deepEqual(cards.map(a => a.action).sort(), ['plume_publish_wechat_mp', 'plume_publish_x', 'plume_publish_xhs'])
  // Failed renders never turn a new body + old cover into an approvable version; recovery is a normal save.
  const mpCard = cards.find(a => a.action === 'plume_publish_wechat_mp')
  const originalMp = (await op('plume.posts', { run: r.id })).platforms.find(p => p.id === 'wechat_mp').fields
  const normalRender = browsers.render
  browsers.render = async () => { throw new Error('renderer unavailable') }
  await assert.rejects(op('plume.savePost', { run: r.id, platform: 'wechat_mp', fields: { ...originalMp, body: 'New body' } }), /renderer unavailable/)
  const invalidMp = (await op('plume.posts', { run: r.id })).platforms.find(p => p.id === 'wechat_mp')
  assert.ok(invalidMp.issues.some(i => i.code === 'render.changed'))
  assert.equal((await op('approve', { id: mpCard.id, payload: { digest: invalidMp.digest } })).approval.status, 'failed')
  assert.ok(!wb.engine.get(r.id).plume.published?.wechat_mp)
  browsers.render = async spec => { writeFileSync(join(r.dir, 'posts/wechat_mp.json'), JSON.stringify({ ...originalMp, title: 'Changed outside the editor' })); return normalRender(spec) }
  await assert.rejects(op('plume.savePost', { run: r.id, platform: 'wechat_mp', fields: originalMp }), /changed during rendering/)
  assert.ok((await op('plume.posts', { run: r.id })).platforms.find(p => p.id === 'wechat_mp').issues.some(i => i.code === 'render.changed'))
  browsers.render = normalRender
  let rendering = false, release
  const gate = new Promise(resolve => { release = resolve })
  browsers.render = async spec => { rendering = true; await gate; return normalRender(spec) }
  const pendingSave = op('plume.savePost', { run: r.id, platform: 'wechat_mp', fields: originalMp })
  await until('save is rendering', () => rendering)
  // (the save holds the folder until its cards and their version are made: the engine refuses in its own words)
  await assertRestartRefused(r.id, /in progress|still being saved/)
  const mpBeforeBusy = wb.store.get('approval', mpCard.id)
  await assert.rejects(op('approve', { id: mpCard.id, payload: { digest: invalidMp.digest } }), /still being saved/)
  assert.deepEqual(wb.store.get('approval', mpCard.id), mpBeforeBusy, 'a refused approval leaves its card as it was')
  await assert.rejects(wb.engine.editFile(r.id, { path: 'draft.md', content: '# conflicting raw edit' }), /save or publication is in progress|still being saved/)
  for (const action of ['accept', 'revise', 'stop']) await assert.rejects((await import('./pack.js')).actions.decision({ run: wb.engine.get(r.id), store: wb.store, approval: { payload: { stage: 'preview', choice: 0, options: [{ action }] } } }), /save or publication is in progress/)
  release(); await pendingSave; browsers.render = normalRender
  const freshMp = await recheck(r.id, 'wechat_mp')
  assert.equal(errorsOf(freshMp.issues).length, 0)
  await assert.rejects(op('plume.article', { run: r.id, digest: 'stale' }), /article changed/)
  // A Files tab edit holds the same run lock until its version write finishes, in both directions.
  const realEdit = wb.engine.versions.edit
  let editing = false, releaseEdit
  const editGate = new Promise(resolve => { releaseEdit = resolve })
  wb.engine.versions.edit = async (...args) => { editing = true; await editGate; return realEdit(...args) }
  const rawEdit = wb.engine.editFile(r.id, { path: 'editor-note.txt', content: 'An ordinary unpublished note' })
  await until('raw edit holds its mutation lock', () => editing)
  try {
    await assert.rejects(op('plume.savePost', { run: r.id, platform: 'wechat_mp', fields: originalMp }), /in progress/)
    await assert.rejects(wb.engine.editFile(r.id, { path: 'draft.md', content: '# concurrent raw edit' }), /in progress|still being saved/)
    // (refused by the engine's edit hold before the card is touched, or by the pack's lock on the card)
    assert.match(await op('approve', { id: mpCard.id, payload: { digest: freshMp.digest } }).then(x => x.approval.error, e => e.message), /in progress|still being saved/)
    const { actions } = await import('./pack.js')
    await assert.rejects(actions.decision({ run: wb.engine.get(r.id), store: wb.store, approval: { payload: {} } }), /in progress/)
    await assert.rejects(createPack().workflows.post.stages.find(s => s.key === 'adapt').run({ run: wb.engine.get(r.id), store: wb.store }), /in progress/)
  } finally { releaseEdit(); await rawEdit; wb.engine.versions.edit = realEdit }
  assert.equal(readFileSync(join(r.dir, 'editor-note.txt'), 'utf8'), 'An ordinary unpublished note')
  const { actions: plumeActions } = await import('./pack.js')
  for (const status of ['queued', 'running', 'waiting', 'interrupted']) await assert.rejects(plumeActions.plume_publish_wechat_mp({ run: { ...wb.engine.get(r.id), status }, store: wb.store }), /still producing/)
  // X: the photo up, then a thread of three — each answering the one before; cut short after the first, it goes on from
  // there when approved again (nothing posted twice)
  const xc = cards.find(a => a.action === 'plume_publish_x')
  assert.equal(xc.payload.connection, 'x-b')
  const seen = async p => (await op('plume.posts', { run: r.id })).platforms.find(x => x.id === p).digest
  assert.equal((await op('approve', { id: xc.id, payload: { digest: 'stale' } })).approval.error.includes('changed since you looked'), true)
  const beforeImage = (await op('plume.posts', { run: r.id })).platforms.find(x => x.id === 'x')
  const photo = wb.engine.get(r.id).subject.attachments[0].path, changedPhoto = png(1080, 1440)
  changedPhoto[32] = 1
  writeFileSync(photo, changedPhoto)
  const staleImage = await op('approve', { id: xc.id, payload: { digest: beforeImage.digest } })
  assert.match(staleImage.approval.error, /changed since you looked|适配审核|adaptation review/, 'changed pixels cannot use the previously displayed version or audit')
  assert.equal(xCalls.length, 0, 'same-size changed pixels cannot use an old approval')
  const afterImage = (await op('plume.posts', { run: r.id })).platforms.find(x => x.id === 'x')
  assert.ok(afterImage.issues.some(i => i.code === 'adaptation.review'), 'changed pixels still require an independent adaptation review after refreshing the preview')
  assert.notEqual(afterImage.images[0].seq, beforeImage.images[0].seq, 'the refreshed preview points at the changed bytes')
  assert.deepEqual(wb.store.readArtifact(wb.store.evidenceAt(r.id, afterImage.images[0].seq).artifact, null), changedPhoto)
  await recheck(r.id, 'x')
  onUpload = async () => { await assert.rejects(wb.engine.editFile(r.id, { path: 'draft.md', content: '# changed during publication' }), /in progress/); await assert.rejects((await import('./pack.js')).actions.plume_publish_x({ run: wb.engine.get(r.id), store: wb.store, approval: { payload: {} } }), /in progress/, 'another publish card of the run cannot send while this one does'); await assert.rejects(op('plume.savePost', { run: r.id, platform: 'wechat_mp', fields: originalMp }), /publication is in progress/); const late = png(1080, 1440); late[32] = 2; writeFileSync(photo, late) }
  failAt = 2
  const cut = await op('approve', { id: xc.id, payload: { digest: await seen('x') } })
  onUpload = null
  assert.deepEqual(uploaded[0], changedPhoto, 'upload uses the bytes captured at approval, even after the file changes during a network await')
  assert.ok(clients.every(id => id === 'x-b'), 'publishing uses the account shown on the card')
  assert.equal(studios.get('plume', 'ideas', idea.id).status, 'ready', 'partial publishing still needs attention')
  assert.ok(!wb.engine.get(r.id).posted?.some(p => p.platform === 'x'), 'an incomplete or unknown thread is not a published output')
  assert.equal(cut.approval.status, 'failed')
  assert.match(cut.approval.error, /1 post\(s\) were out already: p1/)
  // the thread changed meanwhile: what is out is no longer its start — refused, nothing posted
  const was = (await op('plume.posts', { run: r.id })).platforms.find(x => x.id === 'x').fields
  await op('plume.savePost', { run: r.id, platform: 'x', fields: { tweets: ['rewritten first', ...was.tweets.slice(1)] } }).catch(() => {})
  await assert.rejects(recheck(r.id, 'x'), /no longer starts with them/, 'an immutable published prefix cannot be submitted for a new adaptation approval')
  const changed = await op('approve', { id: xc.id, payload: { digest: await seen('x') } })
  assert.match(changed.approval.error || '', /no longer starts with them/)
  await op('plume.savePost', { run: r.id, platform: 'x', fields: was }).catch(() => {})
  await recheck(r.id, 'x')
  const changedMedia = await op('approve', { id: xc.id, payload: { digest: await seen('x') } })
  assert.match(changedMedia.approval.error, /its images changed/, 'resuming cannot replace an image already published with the first post')
  writeFileSync(photo, changedPhoto)
  await recheck(r.id, 'x')
  const done = await op('approve', { id: xc.id, payload: { digest: await seen('x') } })
  assert.ok(wb.engine.get(r.id).posted.some(p => p.platform === 'x' && p.url), 'only the confirmed complete thread enters published outputs')
  assert.equal(done.approval.status, 'done', done.approval.error)
  assert.equal(done.approval.result.url, 'https://x.com/me/status/p1')
  const tweets = xCalls.filter(c => c.path === '/tweets').map(c => c.body)
  assert.deepEqual(tweets.map(t => t.text), [accountTweet, 'second', 'third'], 'what goes out is what the folder holds now')
  assert.deepEqual(tweets[0].media, { media_ids: ['m1'] })
  assert.equal(xCalls.filter(c => c.path === '/media/upload/initialize').length, 1, 'the image went up once')
  assert.deepEqual(tweets.slice(1).map(t => t.reply.in_reply_to_tweet_id), ['p1', 'p2'])
  assert.equal(studios.get('plume', 'ideas', idea.id).status, 'ready')
  await assertRestartRefused(r.id, /create a new idea/)

  const mpWithXPublished = { ...originalMp, body: `${originalMp.body}\n\nStill editable before publication.` }
  await wb.engine.editFile(r.id, { path: 'posts/wechat_mp.json', content: JSON.stringify(mpWithXPublished) })
  const otherPlatform = await op('plume.savePost', { run: r.id, platform: 'wechat_mp', fields: originalMp })
  assert.ok(otherPlatform.issues.every(i => i.level !== 'error' || i.code === 'adaptation.review'), 'publishing X does not freeze the unpublished WeChat platform')
  await recheck(r.id, 'wechat_mp')
  // The final post was accepted but its receipt was lost: another approval cannot resend it.
  const unknown = { attempt: 'lost-receipt', index: 2, text: was.tweets[2] }
  const runNow = wb.engine.get(r.id)
  wb.store.put('run', { ...runNow, plume: { ...runNow.plume, published: { ...runNow.plume.published, x: { ids: ['p1', 'p2'], texts: was.tweets.slice(0, 2), images: runNow.plume.published.x.images, uncertain: unknown, partial: true } } } })
  wb.store.put('approval', { ...wb.store.get('approval', xc.id), status: 'failed' })
  const sentBefore = xCalls.filter(c => c.path === '/tweets').length
  assert.match((await op('approve', { id: xc.id, payload: { digest: await seen('x') } })).approval.error, /outcome unknown/)
  assert.equal(xCalls.filter(c => c.path === '/tweets').length, sentBefore)
  const recovered = await op('approve', { id: xc.id, payload: { digest: await seen('x'), xResolution: { attempt: unknown.attempt, postId: '123456789' } } })
  assert.equal(recovered.approval.status, 'done', recovered.approval.error)
  assert.equal(xCalls.filter(c => c.path === '/tweets').length, sentBefore, 'recovered final receipt completes without a second POST')
  assert.deepEqual(wb.engine.get(r.id).plume.published.x.ids, ['p1', 'p2', '123456789'])
  // 公众号: approved with its link; a link elsewhere is refused
  const mp = cards.find(a => a.action === 'plume_publish_wechat_mp')
  assert.equal((await op('approve', { id: mp.id, payload: { url: 'https://evil.example/x', digest: await seen('wechat_mp') } })).approval.status, 'failed')
  assert.equal((await op('approve', { id: mp.id, payload: { url: 'https://mp.weixin.qq.com/s/abc', digest: await seen('wechat_mp') } })).approval.status, 'done')
  assert.match((await op('plume.article', { run: r.id })).html, /<h2 style=/)
  // 小红书: the session has ended — said, nothing filled
  await recheck(r.id, 'xhs')
  const xhs = cards.find(a => a.action === 'plume_publish_xhs')
  const failed = (await op('approve', { id: xhs.id, payload: { digest: await seen('xhs') } })).approval
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /session has ended/)
  assert.equal(opened[0].cookies[0].name, 'a', 'the browser was handed the session')
  await assert.rejects(op('plume.markPublished', { run: r.id, platform: 'xhs' }), /approve its publish card first/)
  assert.equal(studios.get('plume', 'ideas', idea.id).status, 'ready', 'unpublished 小红书 keeps the idea pending')
  wb.store.put('approval', { ...wb.store.get('approval', xhs.id), status: 'done' }) // the person has completed the card's browser steps
  await assert.rejects(op('plume.markPublished', { run: r.id, platform: 'wechat_mp', url: 'https://example.invalid' }), /only for Xiaohongshu/)
  const approvedXhs = wb.store.get('approval', xhs.id)
  wb.store.put('approval', { ...approvedXhs, payload: { ...approvedXhs.payload, digest: 'stale' } })
  await assert.rejects(op('plume.markPublished', { run: r.id, platform: 'xhs' }), /version changed/)
  wb.store.put('approval', approvedXhs)
  await op('plume.markPublished', { run: r.id, platform: 'xhs' })
  assert.ok(wb.engine.get(r.id).posted.some(p => p.platform === 'xhs'), 'manual confirmation is a published task output')
  assert.equal(studios.get('plume', 'ideas', idea.id).status, 'posted', 'all selected platforms have confirmed publication')
  assert.ok(existsSync(join(r.dir, 'cards', 'xhs-01.png')) && existsSync(join(r.dir, 'posts', 'wechat_mp.html')))
  for (const platform of ['x', 'xhs', 'wechat_mp']) await assert.rejects(op('plume.savePost', { run: r.id, platform, fields: {} }), /published or handed/)
  const publishedFiles = ['posts/x.json', './posts/../posts/xhs.json', 'posts/wechat_mp.html', 'cards/xhs-01.png', 'cards/wechat_mp-cover.png', wb.engine.get(r.id).subject.attachments[0].path.slice(r.dir.length + 1)]
  for (const path of publishedFiles) {
    const before = readFileSync(join(r.dir, path))
    await assert.rejects(wb.engine.editFile(r.id, { path, content: 'should never overwrite published bytes' }), /belongs to a published or handed-off/)
    assert.deepEqual(readFileSync(join(r.dir, path)), before)
  }
  ;(await import('node:fs')).symlinkSync(join(r.dir, 'posts'), join(r.dir, 'post-alias'))
  await assert.rejects(wb.engine.editFile(r.id, { path: 'post-alias/x.json', content: '{}' }), /belongs to a published or handed-off/, 'an in-folder alias cannot bypass the published file guard')
  rmSync(join(r.dir, 'post-alias'))
  const postBeforeRewind = readFileSync(join(r.dir, 'posts/x.json'))
  const stateBeforeRewind = wb.engine.get(r.id)
  await assert.rejects(wb.engine.rewindRun(r.id, { from: 'adapt' }), /create a new idea instead of rewinding/)
  assert.deepEqual(readFileSync(join(r.dir, 'posts/x.json')), postBeforeRewind)
  assert.equal(wb.engine.get(r.id).status, stateBeforeRewind.status, 'rejected rewind never stops or restarts the run')
  assert.deepEqual(wb.engine.get(r.id).plume.published, stateBeforeRewind.plume.published)
  // Reference documents are not published media and remain editable without touching the published assets.
  const referencePath = wb.engine.get(r.id).subject.attachments.find(a => a.name === 'reference.md').path.slice(r.dir.length + 1)
  await wb.engine.editFile(r.id, { path: referencePath, content: '# Updated reference notes' })
  const originalIdea = studios.get('plume', 'ideas', idea.id)
  const reused = (await op('plume.reuse', { run: r.id })).idea
  assert.equal(reused.status, 'idea'); assert.equal(reused.account, account.id); assert.equal(reused.audience, '创业者')
  assert.equal(reused.images.length, 1); assert.equal(reused.materials.length, 3)
  assert.notEqual(reused.images[0], material.id, 'reused images are independent material snapshots')
  assert.equal(studios.material('plume', reused.materials[0]).bytes.toString(), readFileSync(join(r.dir, 'draft.md'), 'utf8'))
  assert.deepEqual(studios.get('plume', 'ideas', idea.id), originalIdea, 'reuse leaves the original idea and publications intact')
  const frozen = wb.engine.get(r.id)
  const turnsBeforeRestart = writerTurns
  await assertRestartRefused(frozen.id, /create a new idea/)
  assert.equal(writerTurns, turnsBeforeRestart, 'engine-level continue never rewrites a published draft')
  assert.deepEqual(wb.engine.get(frozen.id).plume.published, frozen.plume.published)
  for (const stage of createPack().workflows.post.stages.filter(s => ['research', 'draft', 'review', 'adapt', 'visuals', 'preview', 'publish'].includes(s.key))) await assert.rejects(stage.run({ run: frozen }), /create a new idea/)
  // A request image valid for Studio can exceed X's own limit: review and the other platforms must remain usable.
  const bigPhoto = studios.addMaterial('plume', 'six-megabyte.png', Buffer.concat([png(1080, 1440), Buffer.alloc(6 * 1048576)]))
  const limitIdea = studios.put('plume', 'ideas', { title: 'Image limits apply per platform', account: account.id, images: [bigPhoto.id] })
  const limitRun = await studios.start('plume', 'write', limitIdea.id)
  const reviewFor = title => until(`image-limit run: ${title}`, () => wb.store.list('approval').find(a => a.runId === limitRun.id && a.title === title && a.status === 'pending'))
  const acceptPosts = async a => op('approve', { id: a.id, payload: { choice: 0, plumeDigests: Object.fromEntries((await op('plume.posts', { run: limitRun.id })).platforms.map(p => [p.id, p.digest])) } })
  await op('approve', { id: (await reviewFor('看原稿')).id, payload: { choice: 0 } })
  const limitReview = await reviewFor('看各平台的稿子')
  let limitPosts = await op('plume.posts', { run: limitRun.id })
  assert.ok(limitPosts.platforms.find(p => p.id === 'x').issues.some(i => i.code === 'image.size'))
  const validX = limitPosts.platforms.find(p => p.id === 'x').fields
  await op('plume.savePost', { run: limitRun.id, platform: 'x', fields: { tweets: [''] } })
  assert.match((await acceptPosts(limitReview)).approval.error, /fix the platform checks/, 'editable text errors still block preview acceptance')
  await op('plume.savePost', { run: limitRun.id, platform: 'x', fields: validX })
  await recheck(limitRun.id, 'x')
  wb.store.put('approval', { ...wb.store.get('approval', limitReview.id), status: 'pending' })
  assert.equal((await acceptPosts(limitReview)).approval.status, 'done', 'attachment errors cannot block the shared text review')
  await until('image-limit run is ready', () => wb.engine.get(limitRun.id).status === 'done')
  const oldCards = wb.store.list('approval').filter(a => a.runId === limitRun.id && a.action.startsWith('plume_publish_'))
  const oldMp = oldCards.find(a => a.action === 'plume_publish_wechat_mp')
  // Actual regeneration waits for review. The previous manual publication must be refused in that waiting state.
  const draftsBeforeRevise = writerTurns
  await op('taskRevise', { id: limitRun.taskId, run: limitRun.id, text: 'Rewrite the draft and review the new version' })
  const revisedDraft = await reviewFor('看原稿')
  assert.equal(writerTurns, draftsBeforeRevise + 1, 'the task’s 再改 action rewrites the draft before recreating publish cards')
  await op('approve', { id: revisedDraft.id, payload: { choice: 0 } })
  const regenerated = await reviewFor('看各平台的稿子')
  assert.equal(wb.engine.get(limitRun.id).status, 'waiting')
  const oldAttempt = await op('approve', { id: oldMp.id, payload: { digest: (await op('plume.posts', { run: limitRun.id })).platforms.find(p => p.id === 'wechat_mp').digest } })
  assert.match(oldAttempt.approval.error, /still producing/)
  assert.ok(!wb.engine.get(limitRun.id).plume.published?.wechat_mp)
  const regeneratedPosts = (await op('plume.posts', { run: limitRun.id })).platforms
  for (const platform of ['x', 'xhs']) {
    const fields = regeneratedPosts.find(p => p.id === platform).fields
    await op('plume.savePost', { run: limitRun.id, platform, fields: platform === 'x' ? { tweets: ['Reviewed again'] } : { ...fields, title: '重新审核的标题' } })
  }
  await recheck(limitRun.id, 'x')
  await recheck(limitRun.id, 'xhs')
  await acceptPosts(regenerated)
  await until('regenerated image-limit run is ready', () => wb.engine.get(limitRun.id).status === 'done')
  assert.ok(oldCards.filter(a => a.id !== oldMp.id).every(a => wb.store.get('approval', a.id).status === 'superseded'), 'pending cards for changed posts are superseded')
  // (refused, then replaced by the regenerated run's own card: a failed card of the same action is superseded too)
  assert.equal(wb.store.get('approval', oldMp.id).status, 'superseded', 'the refused attempt never became a publication')
  assert.equal(studios.get('plume', 'ideas', limitIdea.id).status, 'ready')
  limitPosts = await op('plume.posts', { run: limitRun.id })
  const limitCards = wb.store.list('approval').filter(a => a.runId === limitRun.id && a.action.startsWith('plume_publish_') && a.status === 'pending')
  const publishLimit = p => op('approve', { id: limitCards.find(a => a.payload.platform === p).id, payload: { digest: limitPosts.platforms.find(x => x.id === p).digest } })
  const callsBeforeLimit = xCalls.length
  assert.match((await publishLimit('x')).approval.error, /超过 5MB/)
  assert.equal(xCalls.length, callsBeforeLimit, 'X refuses its oversized image before any network request')
  assert.equal((await publishLimit('wechat_mp')).approval.status, 'done', 'the unaffected manual platform still publishes')
  const openedBeforeLimit = opened.length
  assert.match((await publishLimit('xhs')).approval.error, /session has ended/, 'XHS passes its own checks and reaches its browser session')
  assert.equal(opened.length, openedBeforeLimit + 1)
  // An unpublished run without a Studio binding can still rewind and create a fresh review.
  const rewindDir = join(tmp, 'unpublished-rewind')
  ;(await import('node:fs')).cpSync(r.dir, rewindDir, { recursive: true })
  const rewindFixture = { ...wb.engine.get(r.id), id: 'plume-unpublished-rewind', dir: rewindDir, studio: null, posted: [], subject: { ...wb.engine.get(r.id).subject, attachments: wb.engine.get(r.id).subject.attachments.map(a => ({ ...a, path: a.path.replace(r.dir, rewindDir) })) }, plume: { ...wb.engine.get(r.id).plume, published: {}, handoffs: {} } }
  wb.store.put('run', rewindFixture)
  ;(await import('node:fs')).cpSync(wb.engine.versions.gitDir(wb.engine.get(r.id)), wb.engine.versions.gitDir(rewindFixture), { recursive: true })
  await wb.engine.rewindRun(rewindFixture.id, { from: 'preview' })
  await until('a fresh unpublished review after rewind', () => wb.store.list('approval').find(a => a.runId === rewindFixture.id && a.title === '看各平台的稿子' && a.status === 'pending'))
  assert.equal(wb.engine.get(rewindFixture.id).status, 'waiting', 'rewind releases the mutation lease before the content stage resumes')
  const safetyDir = join(tmp, 'path-fixture')
  ;(await import('node:fs')).cpSync(r.dir, safetyDir, { recursive: true })
  const safety = { ...wb.engine.get(r.id), id: 'plume-path-fixture', dir: safetyDir, studio: null, posted: [], subject: { ...wb.engine.get(r.id).subject, attachments: wb.engine.get(r.id).subject.attachments.map(a => ({ ...a, path: a.path.replace(r.dir, safetyDir) })) }, plume: { ...wb.engine.get(r.id).plume, published: {}, handoffs: {} } }
  wb.store.put('run', safety)
  await wb.engine.versions.snapshot(safety, 'Isolated path safety fixture', { kind: 'test' })
  // Rendering derived cards is still part of the file edit: another writer or restart waits (on the editable copy:
  // the run itself is published by now).
  {
    const xhsBefore = readFileSync(join(safety.dir, 'posts/xhs.json'), 'utf8')
    const render = browsers.render; let release, first = true
    browsers.render = async spec => { if (first) { first = false; await new Promise(r => { release = r }) } return render(spec) }
    const fields = { title: 'Owned cards', cards: [{ heading: 'Owned', points: ['one'] }] }
    const saving = op('plume.savePost', { run: safety.id, platform: 'xhs', fields })
    try {
      await until('card rendering holds the file edit', () => release)
      await assert.rejects(wb.engine.editFile(safety.id, { path: 'posts/xhs.json', content: JSON.stringify({ title: 'Newer write' }) }), e => e.code === 'runBusy', 'a later file edit cannot overtake card rendering')
      await assert.rejects(wb.engine.continueRun(safety.id, { from: 'visuals' }), e => e.code === 'runBusy')
      assert.throws(() => wb.engine.goOn(safety.id, 'visuals'), e => e.code === 'runBusy')
      assert.throws(() => wb.engine.resumeRun(safety.id), e => e.code === 'runBusy')
      assert.equal(wb.engine.active(safety.id),true,'task deletion sees the file edit as busy')
      const card=wb.engine.addApproval(safety.id,{action:'plume_publish_xhs',title:'Owner guard fixture',payload:{}})
      try { await assert.rejects(wb.engine.approve(card.id,{}),e=>e.code==='runBusy'); assert.equal(wb.store.get('approval',card.id).status,'pending') } finally { wb.store.remove('approval',card.id) }
    } finally { release?.(); await saving; browsers.render = render }
    assert.equal(JSON.parse(readFileSync(join(safety.dir, 'posts/xhs.json'), 'utf8')).title, 'Owned cards')
    await wb.engine.editFile(safety.id, { path: 'posts/xhs.json', content: JSON.stringify(fields) })
    await assert.rejects(wb.engine.editFile(safety.id, { path: 'posts/xhs.json', content: JSON.stringify(fields) }, async()=>{throw new Error('fixture render failure')}),/fixture render failure/)
    assert.equal(wb.engine.active(safety.id),false,'a failed derived-file edit releases its owner')
    await wb.engine.editFile(safety.id,{path:'posts/xhs.json',content:JSON.stringify(fields)})
    await wb.engine.editFile(safety.id, { path: 'posts/xhs.json', content: xhsBefore })
  }
  // a link an agent left in the folder: nothing is read or written through it
  const { symlinkSync, mkdirSync: mk } = await import('node:fs')
  mk(join(tmp, 'outside'), { recursive: true })
  rmSync(join(safety.dir, 'cards'), { recursive: true }); symlinkSync(join(tmp, 'outside'), join(safety.dir, 'cards'))
  await assert.rejects(op('plume.savePost', { run: safety.id, platform: 'xhs', fields: (await op('plume.posts', { run: safety.id })).platforms[0].fields }), /leads out of the run's folder/)
  assert.deepEqual((await import('node:fs')).readdirSync(join(tmp, 'outside')), [], 'no card written through the link')
  rmSync(join(safety.dir, 'cards'))
  // A leaf link to a target not there yet must be refused too (existsSync follows it and says false).
  mk(join(safety.dir, 'cards'))
  const missingTarget = join(tmp, 'outside', 'not-created.png')
  symlinkSync(missingTarget, join(safety.dir, 'cards', 'xhs-01.png'))
  assert.equal((await import('./pack.js')).within(safety, 'cards/xhs-01.png'), null)
  await assert.rejects(op('plume.savePost', { run: safety.id, platform: 'xhs', fields: (await op('plume.posts', { run: safety.id })).platforms[0].fields }), /leads out of the run's folder/)
  assert.equal(existsSync(missingTarget), false, 'the host cannot create a card outside the run through a dangling link')
  rmSync(join(safety.dir, 'cards'), { recursive: true })
  const report = (await op('report', { id: r.id })).markdown
  assert.match(report, /## Published\n\n\| Platform \| Where \|\n\|---\|---\|\n\| 小红书 \| published \|\n\| X \| https:\/\/x\.com\/(?:me|i\/web)\/status\/p1 \|\n\| 公众号 \| https:\/\/mp\.weixin\.qq\.com\/s\/abc \|/)
  // Register the real research workflow, create its normal weekly task and execute it via the public workbench API.
  // The Agent Hub supplies synthetic captures only; research cannot call any external publisher.
  {
    const frozenKnowledge = structuredClone(wb.engine.get(r.id).plume.platformKnowledge)
    const beforeKnowledge = (await op('plume.knowledge', { platform: 'x' })).profiles[0]
    const externalCalls = { requests: xCalls.length, clients: clients.length, browsers: opened.length }
    const flow = createPack().workflows['platform-research']
    assert.equal(flow.roles.platformResearcher.access, 'write')
    assert.equal(flow.roles.platformAuditor.access, 'read')
    const ensured = await Promise.all([0, 1].map(() => op('plume.ensureKnowledgeSchedule', { tz: 'America/Los_Angeles' })))
    const { task: scheduled, run: immediate } = ensured[0]
    assert.equal(immediate, undefined)
    assert.equal(ensured[1].task.id, scheduled.id, 'simultaneous windows create only one weekly research task')
    assert.equal((await op('plume.knowledgeSchedules')).tasks.length, 1)
    assert.deepEqual(scheduled.request.fields.platforms, ['xhs', 'x', 'wechat_mp'])
    assert.equal(scheduled.enabled, true)
    assert.ok(scheduled.nextAt > Date.now())
    const repeated = await op('plume.ensureKnowledgeSchedule', { tz: 'America/Los_Angeles' })
    assert.equal(repeated.created, false)
    assert.equal(repeated.task.id, scheduled.id)
    // Restrict this local fixture to X after verifying the production all-platform schedule default.
    await op('taskUpdate', { id: scheduled.id, fields: { platforms: ['x'] } })
    assert.deepEqual((await op('plume.knowledgeSchedules')).tasks.find(t => t.id === scheduled.id).fields, { platforms: ['x'] })
    const { run: refresh } = await op('taskRunNow', { id: scheduled.id })
    await until('registered scheduled platform research completes', () => ['done', 'failed'].includes(wb.engine.get(refresh.id).status))
    const completed = wb.engine.get(refresh.id)
    assert.equal(completed.status, 'done', JSON.stringify(completed.stages.map(s => [s.key, s.status, s.note])))
    assert.equal(platformResearchTurns, 1)
    assert.equal(platformAuditTurns, 1)
    assert.deepEqual(completed.plumeKnowledge.published.map(p => p.platform), ['x'])
    const currentKnowledge = (await op('plume.knowledge', { platform: 'x' })).profiles[0]
    assert.equal(currentKnowledge.source, 'reviewed')
    assert.notEqual(currentKnowledge.revision, beforeKnowledge.revision)
    assert.equal(currentKnowledge.revision, completed.plumeKnowledge.published[0].revision)
    assert.ok(currentKnowledge.sources[0].evidenceSha256)
    assert.equal((await op('plume.knowledgeHistory', { platform: 'x' })).versions[0].revision, currentKnowledge.revision)
    assert.deepEqual(wb.engine.get(r.id).plume.platformKnowledge, frozenKnowledge, 'new global advice cannot rewrite an existing post’s frozen knowledge snapshot')
    assert.equal((await postView(r.id, 'x')).knowledge.revision, frozenKnowledge.platforms.x.revision)
    assert.deepEqual({ requests: xCalls.length, clients: clients.length, browsers: opened.length }, externalCalls)
    assert.ok(!wb.store.list('approval').some(a => a.runId === refresh.id && a.action.startsWith('plume_publish_')))
    assert.equal(wb.store.get('task', scheduled.id).lastRunId, refresh.id)
    assert.equal(wb.store.get('task', scheduled.id).runCount, 1)
    await op('taskUpdate', { id: scheduled.id, enabled: false })
    const paused = (await op('plume.knowledgeSchedules')).tasks.find(t => t.id === scheduled.id)
    assert.equal(paused.enabled, false)
    assert.equal(paused.nextAt, null)
    const stillPaused = await op('plume.ensureKnowledgeSchedule', { tz: 'America/Los_Angeles' })
    assert.equal(stillPaused.created, false)
    assert.equal(stillPaused.task.id, scheduled.id)
    assert.equal(stillPaused.task.enabled, false, 'ensure never silently re-enables the person’s paused research task')
    assert.equal((await op('plume.knowledgeSchedules')).tasks.length, 1)
    console.log('plume registered platform research and weekly task: ok')
  }
  // ADAPT-2/3: current settings and independent repair budgets through the real post workflow.
  // Keep this X-only run separate from all earlier publishing, Studio, image and weekly-research fixtures.
  {
    const originalAdapter = members.adapter
    const tweets = ['Already published context', 'An outcome to reconcile', 'Third continuation', 'Fourth continuation']
    let localAdapts = 0, localAudits = 0
    const voice = 'ADAPT-2 second fixture: precise, calm and concrete; saved during the draft review.'
    const callsBeforeRepair = xCalls.length
    members.adapter = async t => {
      localAdapts++
      assert.ok(t.task.includes(voice), 'ADAPT-2: every automatic repair receives the current voice')
      const dir = join(folder(t), 'posts')
      ;(await import('node:fs')).mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'x.json'), JSON.stringify({ tweets }))
      return (await tool(t, 'stage_result', { result: { platforms: ['x'], summary: `X-only revision ${localAdapts}` } })).text
    }
    auditResult = (result, item) => {
      localAudits++
      assert.equal(item.style.guide, voice, 'ADAPT-2: the automatic auditor shares the current settings used by the adapter and approval gate')
      if ([1, 3, 4].includes(localAudits)) result.checks.find(c => c.dimension === 'tone').verdict = 'fail'
    }
    try {
      const repairIdea = studios.put('plume', 'ideas', { title: 'Independent repair episodes and partial X receipts', account: account.id, platforms: ['x'] })
      const repairRun = await studios.start('plume', 'write', repairIdea.id)
      const pending = (stage, previous) => until(`repair fixture waits at ${stage}`, () => wb.store.list('approval').find(a => a.runId === repairRun.id && a.payload?.stage === stage && a.status === 'pending' && a.id !== previous))
      const review = await pending('review')
      const settings = await op('settings'), nextSettings = structuredClone(settings.settings)
      nextSettings.packs.plume.style.guide = voice
      await op('saveSettings', { settings: nextSettings, revision: settings.revision })
      assert.equal((await op('approve', { id: review.id, payload: { choice: 0 } })).approval.status, 'done')
      const firstPreview = await pending('preview')
      assert.equal(localAdapts, 2, 'the first failed audit gets an automatic repair')
      assert.equal(localAudits, 2)
      assert.equal(wb.engine.get(repairRun.id).plume.adaptationRepairs, 0, 'ADAPT-3: a passing audit ends its repair episode')
      const current = await postView(repairRun.id, 'x')
      assert.equal(current.adaptation.current, true)
      assert.equal(current.adaptation.passed, true)
      const choice = firstPreview.payload.options.findIndex(o => o.action === 'revise')
      assert.ok(choice >= 0)
      assert.equal((await op('approve', { id: firstPreview.id, payload: { choice, from: 'adapt', comment: 'Adjust the platform opening and review the revised version.' } })).approval.status, 'done')
      const secondPreview = await pending('preview', firstPreview.id)
      assert.equal(localAdapts, 5, 'ADAPT-3: the human-requested revision receives two new automatic repairs')
      assert.equal(localAudits, 5)
      assert.equal(wb.engine.get(repairRun.id).plume.adaptationRepairs, 0)
      const repaired = await postView(repairRun.id, 'x')
      assert.equal(repaired.adaptation.current, true)
      assert.equal(repaired.adaptation.passed, true)
      const accepted = await op('approve', { id: secondPreview.id, payload: { choice: 0, plumeDigests: { x: repaired.digest } } })
      assert.equal(accepted.approval.status, 'done', 'ADAPT-2: automatic audits pass the current approval gate without a manual recheck')
      await until('repaired post finishes', () => ['done', 'failed'].includes(wb.engine.get(repairRun.id).status))
      assert.equal(wb.engine.get(repairRun.id).status, 'done')
      assert.equal(xCalls.length, callsBeforeRepair, 'review and repair never invoke an external publisher')
      auditResult = null

      // ADAPT-4: an actual partial send leaves a durable unknown outcome, with a mutable continuation.
      const publishCard = wb.store.list('approval').find(a => a.runId === repairRun.id && a.action === 'plume_publish_x')
      const tweetsBefore = xCalls.filter(c => c.path === '/tweets').length
      unknownAt = tweetsBefore + 2
      const interrupted = await op('approve', { id: publishCard.id, payload: { digest: repaired.digest } })
      assert.equal(interrupted.approval.status, 'failed')
      assert.match(interrupted.approval.error, /outcome unknown/)
      const partial = wb.engine.get(repairRun.id).plume.published.x
      assert.equal(partial.ids.length, 1)
      assert.deepEqual(partial.texts, tweets.slice(0, 1))
      assert.equal(partial.uncertain.index, 1)
      assert.equal(xCalls.filter(c => c.path === '/tweets').length, tweetsBefore + 2)
      const continuedTweets = [...tweets]; continuedTweets[2] = 'A revised third continuation'
      await op('plume.savePost', { run: repairRun.id, platform: 'x', fields: { tweets: continuedTweets } })
      auditResult = (result, item) => {
        assert.equal(item.publishedCount, 1)
        assert.deepEqual(item.fields.tweets, continuedTweets, 'the complete thread remains context')
        assert.deepEqual(item.units.map(u => u.id), ['tweets.1', 'tweets.2', 'tweets.3'], 'ADAPT-4: immutable published text is not requested as an auditable unit')
        result.units.find(u => u.id === 'tweets.2').verdict = 'unsupported'
      }
      await recheck(repairRun.id, 'x', 'failed')
      const callsBeforeResolution = xCalls.length, clientsBeforeResolution = clients.length
      const unresolved = await postView(repairRun.id, 'x')
      assert.equal(unresolved.adaptation.passed, false)
      const unresolvedReceipt = structuredClone(wb.engine.get(repairRun.id).plume.published.x)
      const receiptArgs = { run: repairRun.id, expectedDigest: unresolved.digest, attempt: partial.uncertain.attempt, postId: '987654321' }
      for (const [label, invalid] of [
        ['stale displayed digest', { expectedDigest: 'stale' }],
        ['another uncertain attempt', { attempt: 'another-attempt' }],
        ['conflicting posted/not-posted answers', { notPosted: true }],
        ['numeric rather than textual post ID', { postId: 987654321 }],
      ]) {
        await assert.rejects(op('plume.resolveXOutcome', { ...receiptArgs, ...invalid }), `ADAPT-4: refuse ${label}`)
        assert.deepEqual(wb.engine.get(repairRun.id).plume.published.x, unresolvedReceipt, `${label} cannot alter publication evidence`)
        assert.equal(xCalls.length, callsBeforeResolution)
        assert.equal(clients.length, clientsBeforeResolution)
      }
      const resolution = await op('plume.resolveXOutcome', { run: repairRun.id, expectedDigest: unresolved.digest, attempt: partial.uncertain.attempt, postId: '987654321' })
      assert.equal(resolution.resolved, true)
      assert.deepEqual(resolution.published.ids, [...partial.ids, '987654321'])
      const resolved = wb.engine.get(repairRun.id).plume.published.x
      assert.deepEqual(resolved.ids, [...partial.ids, '987654321'])
      assert.equal(resolved.uncertain, null)
      assert.deepEqual(resolved.texts, continuedTweets.slice(0, 2))
      assert.equal(xCalls.length, callsBeforeResolution, 'ADAPT-4: receipt reconciliation has no external API side effects')
      assert.equal(clients.length, clientsBeforeResolution, 'reconciliation does not even acquire a publisher client')
      const afterResolution = await postView(repairRun.id, 'x')
      assert.equal(afterResolution.adaptation.current, false, 'ADAPT-4: a newly confirmed prefix invalidates the prior continuation audit')
      const blocked = await op('approve', { id: publishCard.id, payload: { digest: afterResolution.digest } })
      assert.equal(blocked.approval.status, 'failed')
      assert.match(blocked.approval.error, /适配审核|adaptation review/)
      assert.equal(xCalls.length, callsBeforeResolution, 'a changed confirmed prefix cannot publish on an old audit')
      auditResult = (result, item) => {
        assert.equal(item.publishedCount, 2)
        assert.deepEqual(item.units.map(u => u.id), ['tweets.2', 'tweets.3'], 'only still-unpublished continuation text can block this audit')
        result.units[0].verdict = 'unsupported'
      }
      const failedSuffix = await recheck(repairRun.id, 'x', 'failed')
      assert.equal((await op('approve', { id: publishCard.id, payload: { digest: failedSuffix.digest } })).approval.status, 'failed')
      assert.equal(xCalls.length, callsBeforeResolution, 'unsupported continuation text remains a publishing blocker')
      auditResult = (result, item) => { assert.deepEqual(item.units.map(u => u.id), ['tweets.2', 'tweets.3']) }
      const safeSuffix = await recheck(repairRun.id, 'x')
      const resumed = await op('approve', { id: publishCard.id, payload: { digest: safeSuffix.digest } })
      assert.equal(resumed.approval.status, 'done', resumed.approval.error)
      const suffixCalls = xCalls.slice(callsBeforeResolution).filter(c => c.path === '/tweets')
      assert.deepEqual(suffixCalls.map(c => c.body.text), continuedTweets.slice(2), 'ADAPT-4: only the unposted continuation is sent, without repeating either confirmed post')
      assert.equal(suffixCalls[0].body.reply.in_reply_to_tweet_id, '987654321')
      assert.equal(wb.engine.get(repairRun.id).plume.published.x.partial, false)
      assert.equal(wb.engine.get(repairRun.id).plume.published.x.ids.length, 4)
      console.log('plume corrected audit, current settings, repair budgets and partial X continuation: ok')
    } finally { members.adapter = originalAdapter; auditResult = null; auditHook = null; unknownAt = 0 }
  }
  // ADAPT-6/7: live editorial settings may change, but publication identity stays bound to the run.
  // Exercise a change during both the first and second platform audit; an earlier platform's pass must refresh too.
  for (const blockedPlatform of ['xhs', 'x']) {
    let entered = false, releaseAudit
    const waiting = new Promise(resolve => { releaseAudit = resolve })
    const inputs = [], acceptedInputs = []
    const changedVoice = `ADAPT-7: current voice after ${blockedPlatform} began auditing.`
    const callsBefore = xCalls.length, clientsBefore = clients.length
    const beforeSettings = await op('settings')
    assert.equal(beforeSettings.settings.packs.plume.accounts.x, 'x')
    let liveRun
    auditHook = async (item, task) => {
      inputs.push({ platform: item.platform, task: task.id, digest: item.digest, guide: item.style.guide })
      if (item.platform === blockedPlatform && !entered) { entered = true; await waiting }
    }
    auditSubmittedHook = (item, task) => { acceptedInputs.push({ platform: item.platform, task: task.id, digest: item.digest, guide: item.style.guide }) }
    try {
      liveRun = await wb.engine.startRun({ workflow: 'plume.post', title: `Live settings change during ${blockedPlatform} audit`, fields: { platforms: ['xhs', 'x', 'wechat_mp'], research: false } })
      assert.ok(!wb.engine.get(liveRun.id).account, 'ADAPT-6: this run inherits its connection from settings without a Studio account override')
      const pending = stage => until(`live-settings fixture waits at ${stage}`, () => {
        const run = wb.engine.get(liveRun.id)
        assert.notEqual(run.status, 'failed', JSON.stringify(run.stages.map(s => [s.key, s.status, s.note])))
        return wb.store.list('approval').find(a => a.runId === liveRun.id && a.payload?.stage === stage && a.status === 'pending')
      })
      await op('approve', { id: (await pending('review')).id, payload: { choice: 0 } })
      await until(`the ${blockedPlatform} auditor is holding its original input`, () => entered)
      const oldInput = inputs.find(item => item.platform === blockedPlatform)
      if (blockedPlatform === 'x') {
        const earlier = (await op('plume.posts', { run: liveRun.id })).platforms.find(p => p.id === 'xhs')
        assert.equal(earlier.adaptation.current, true, 'the first platform already passed before the second audit was interrupted')
      }
      const settings = await op('settings'), next = structuredClone(settings.settings)
      next.packs.plume.style.guide = changedVoice
      await op('saveSettings', { settings: next, revision: settings.revision })
      releaseAudit()
      const preview = await pending('preview')
      auditHook = null; auditSubmittedHook = null
      const posts = (await op('plume.posts', { run: liveRun.id })).platforms
      assert.ok(posts.every(p => p.adaptation.current && p.adaptation.passed), 'ADAPT-7: the whole platform batch is current after changing shared settings')
      assert.ok(acceptedInputs.some(item => item.task === oldInput.task && item.digest === oldInput.digest), 'the original auditor submits its valid captured contract once, even though the result became stale')
      assert.notEqual(wb.engine.get(liveRun.id).plume.adaptation[blockedPlatform].digest, oldInput.digest, 'the stale result is not attached as current approval')
      assert.equal(new Set(inputs.map(item => item.task)).size, inputs.length)
      assert.deepEqual(acceptedInputs.map(item => item.task), inputs.map(item => item.task), 'every auditor task submits once, without a reminder to repair an obsolete brief')
      for (const platform of ['xhs', 'x', 'wechat_mp']) {
        const turns = inputs.filter(item => item.platform === platform)
        assert.ok(turns.length >= 1 && turns.length <= 2, `${platform}: at most two complete-batch attempts`)
        assert.equal(turns.at(-1).guide, changedVoice, `${platform}: final audit uses the current voice`)
      }
      assert.equal(inputs.filter(item => item.platform === blockedPlatform).length, 2)
      if (blockedPlatform === 'x') assert.equal(inputs.filter(item => item.platform === 'xhs').length, 2, 'an earlier platform is re-audited when the second platform discovers global staleness')
      assert.equal(wb.engine.get(liveRun.id).plume.adaptationRepairs, 0, 'discarding a stale batch does not consume content repair budget')
      assert.equal(xCalls.length, callsBefore)
      assert.equal(clients.length, clientsBefore)

      // The second case also reproduces ADAPT-6 after preview, before publish cards exist.
      if (blockedPlatform === 'x') {
        const settings = await op('settings'), next = structuredClone(settings.settings)
        next.packs.plume.accounts.x = 'x-b'
        await op('saveSettings', { settings: next, revision: settings.revision })
      }
      const accepted = await op('approve', { id: preview.id, payload: { choice: 0, plumeDigests: Object.fromEntries(posts.map(p => [p.id, p.digest])) } })
      assert.equal(accepted.approval.status, 'done', accepted.approval.error)
      await until('live-settings workflow creates publication cards', () => ['done', 'failed'].includes(wb.engine.get(liveRun.id).status))
      assert.equal(wb.engine.get(liveRun.id).status, 'done')
      if (blockedPlatform === 'x') {
        const cards = wb.store.list('approval').filter(a => a.runId === liveRun.id && a.action.startsWith('plume_publish_'))
        const xCard = cards.find(a => a.action === 'plume_publish_x'), mpCard = cards.find(a => a.action === 'plume_publish_wechat_mp')
        assert.equal(xCard.payload.connection, 'x', 'ADAPT-6: the newly created card keeps the run-start publishing connection')
        const mp = await postView(liveRun.id, 'wechat_mp')
        assert.equal((await op('approve', { id: mpCard.id, payload: { digest: mp.digest, url: 'https://mp.weixin.qq.com/s/connection-binding' } })).approval.status, 'done')
        assert.ok(wb.engine.get(liveRun.id).plume.published.wechat_mp)
        const beforeRefusal = { calls: xCalls.length, clients: clients.length }
        const x = await postView(liveRun.id, 'x')
        const refused = await op('approve', { id: xCard.id, payload: { digest: x.digest } })
        assert.equal(refused.approval.status, 'failed')
        assert.match(refused.approval.error, /account changed/)
        assert.deepEqual({ calls: xCalls.length, clients: clients.length }, beforeRefusal, 'changed connection is refused before acquiring any publisher client')
        await assert.rejects(wb.engine.rewindRun(liveRun.id, { from: 'publish' }), /create a new idea/, 'a published sibling platform prevents rebuilding the publication cards')
        const settings = await op('settings'), restored = structuredClone(settings.settings)
        restored.packs.plume.accounts.x = 'x'
        await op('saveSettings', { settings: restored, revision: settings.revision })
        const approved = await op('approve', { id: xCard.id, payload: { digest: (await postView(liveRun.id, 'x')).digest } })
        assert.equal(approved.approval.status, 'done', approved.approval.error)
        assert.deepEqual(clients.slice(beforeRefusal.clients), ['x'], 'ADAPT-6: restoring the original settings makes the same card publish through the original connection')
        assert.deepEqual(xCalls.slice(beforeRefusal.calls).filter(c => c.path === '/tweets').map(c => c.body.text), x.fields.tweets)
        assert.equal(wb.store.get('approval', xCard.id).payload.connection, 'x')
        assert.equal(wb.store.list('approval').filter(a => a.runId === liveRun.id && a.action.startsWith('plume_publish_')).length, cards.length, 'no publication card had to be rebuilt')
        assert.ok(wb.engine.get(liveRun.id).plume.published.wechat_mp)
      }
    } finally { releaseAudit(); auditHook = null; auditSubmittedHook = null }
  }
  // Continuous edits cannot make fresh-input retries unbounded or send an obsolete audit back to the agent.
  {
    const inputs = [], submissions = [], callsBefore = xCalls.length
    auditHook = async (item, task) => {
      inputs.push({ task: task.id, guide: item.style.guide })
      const settings = await op('settings'), next = structuredClone(settings.settings)
      next.packs.plume.style.guide = `ADAPT-7 continuous edit ${inputs.length}`
      await op('saveSettings', { settings: next, revision: settings.revision })
    }
    auditSubmittedHook = (item, task) => { submissions.push(task.id) }
    try {
      const run = await wb.engine.startRun({ workflow: 'plume.post', title: 'Bounded freshness retry', fields: { platforms: ['xhs', 'x', 'wechat_mp'], research: false } })
      const review = await until('bounded retry waits for its master draft', () => wb.store.list('approval').find(a => a.runId === run.id && a.payload?.stage === 'review' && a.status === 'pending'))
      await op('approve', { id: review.id, payload: { choice: 0 } })
      await until('continuous changes reach the bounded stop', () => ['done', 'failed'].includes(wb.engine.get(run.id).status))
      assert.equal(wb.engine.get(run.id).status, 'failed')
      assert.equal(inputs.length, 2, 'ADAPT-7: persistent staleness stops after the two complete-batch attempts')
      assert.notEqual(inputs[0].guide, inputs[1].guide, 'the second attempt has a refreshed brief')
      assert.deepEqual(submissions, inputs.map(item => item.task), 'contract-valid old inputs are accepted once and discarded by the server, without engine format retries')
      assert.equal(wb.engine.get(run.id).plume.adaptationRepairs || 0, 0)
      assert.ok(!wb.store.list('approval').some(a => a.runId === run.id && a.action.startsWith('plume_publish_')))
      assert.equal(xCalls.length, callsBefore)
    } finally { auditHook = null; auditSubmittedHook = null }
  }
  console.log('plume live-settings batch retries and stable publication connection: ok')
  console.log('plume run: ok')
} finally { wb.engine.dispose(); studios.close() }

// ── 小红书 in the agents' shared browser (docs/design/browser.md; Ethan 2026-10-18): its turn, a tab of its own, the note
// filled in, the last click handed to the person; published (the site says so) → the run says so, the turn goes back ──
{
  const { publishXhsShared } = await import('./pack.js')
  const calls = [], ev = []
  let url = 'https://creator.xiaohongshu.com/publish/publish', closed = 0
  const page = { url: () => url, isClosed: () => false, locator: () => ({ innerText: async () => '' }) }
  const fakeBrowser = { contexts: () => [{ newPage: async () => page, newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: 'T1' } }), detach: async () => {} }) }], close: async () => { closed++ } }
  const shared = {
    ensure: async () => { calls.push(['ensure']); return 'http://127.0.0.1:9333' },
    waitTurn: async o => { calls.push(['waitTurn', o.who, o.of]) }, give: who => calls.push(['give', who]), handoff: (who, why) => calls.push(['handoff', who, why]),
    own: (id, who) => calls.push(['own', id, who]), connect: async endpoint => { calls.push(['connect', endpoint]); return fakeBrowser },
  }
  const c = { run: { id: 'rX', plume: {} }, evidence: e => ev.push(e.title), update: change => { c.run = typeof change === 'function' ? change(c.run) : { ...c.run, ...change } } }
  const post = { f: { title: 'T', body: 'B', tags: ['a'] }, images: [{ path: '/x/1.png' }] }
  const out = await publishXhsShared(c, shared, post, async (pg, note, say) => { assert.equal(pg, page); assert.deepEqual(note.images, ['/x/1.png']); say('打开发布页'); return { filled: ['打开发布页', '填写标题'], warnings: [] } })
  assert.ok(c.run.plume.handoffs.xhs.digest, 'the handed-off inputs are version bound even before publication')
  assert.equal(out.browser, 'shared'); assert.match(out.note, /智能体浏览器里填好/)
  assert.deepEqual(calls.map(x => x[0]), ['ensure', 'waitTurn', 'connect', 'own', 'handoff'], 'its turn, its tab, then the last click is the person\'s')
  assert.deepEqual(calls[1].slice(1), ['run:rX:xhs', 'run:rX'])
  assert.match(calls[4][2], /内容已填好，检查后点「发布」/)
  assert.ok(ev.includes('小红书: 打开发布页'))
  url = 'https://creator.xiaohongshu.com/publish/success'
  for (const end = Date.now() + 8000; !c.run.plume?.published?.xhs && Date.now() < end;) await new Promise(r => setTimeout(r, 100))
  assert.equal(c.run.plume.published.xhs.by, 'person', 'the site said published: the run says so')
  for (const end = Date.now() + 2000; !calls.some(x => x[0] === 'give') && Date.now() < end;) await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(calls.at(-1), ['give', 'run:rX:xhs']); assert.equal(closed, 1, 'then the turn goes back (the tab stays)')
  // not signed in there: said plainly, the turn given back at once
  calls.length = 0; closed = 0
  let tabClosed = 0
  page.close = async () => { tabClosed++ }
  await assert.rejects(publishXhsShared({ ...c, run: { id: 'rY' } }, shared, post, async () => { throw Object.assign(new Error('session ended'), { code: 'needLogin' }) }), /not signed in in the agents' browser: open it \(App Center → 智能体浏览器\)/)
  assert.deepEqual(calls.at(-1), ['give', 'run:rY:xhs']); assert.equal(closed, 1); assert.equal(tabClosed, 1, 'a failed fill closes its tab, not just the CDP connection')
  console.log('plume 小红书 in the shared browser: ok')
}

// ── 小红书's fill, on a local imitation of the creator page, in a real browser ──
const runtime = [process.env.RUYIX_UI_RUNTIME, join(homedir(), '.ruyix/workbench/ui-runtime'), join(homedir(), '.aviary/workbench/ui-runtime')].find(d => d && existsSync(join(d, 'node_modules', 'playwright')))
if (!runtime) console.log('plume fill: skipped — no Playwright here')
else {
  const page = `<!doctype html><meta charset="utf-8"><body>
    <div class="upload-content"><div class="creator-tab">上传视频</div><div class="creator-tab" onclick="document.body.dataset.tab='img'">上传图文</div>
      <input class="upload-input" type="file" accept="image/*" onchange="add()"><input type="file" accept="image/*" onchange="add()"></div>
    <div class="img-preview-area"></div>
    <div class="d-input"><input id="title"></div>
    <div role="textbox" contenteditable="true" id="body"></div>
    <div id="creator-editor-topic-container"></div>
    <script>
      // (as the site does: after the first image its upload box gives way to the previews and a smaller input)
      function add() { const d = document.createElement('div'); d.className = 'pr'; document.querySelector('.img-preview-area').appendChild(d); document.querySelector('.upload-input')?.remove() }
      document.getElementById('body').addEventListener('input', () => {
        const t = document.getElementById('body').innerText, m = /#([^#\\s]*)$/.exec(t)
        document.getElementById('creator-editor-topic-container').innerHTML = m && m[1].length > 1 ? '<div class="item" onclick="this.parentNode.innerHTML=\\'\\'">#' + m[1] + '</div>' : ''
      })
    </script>`
  const server = createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); s.end(page) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const { chromium } = createRequire(join(runtime, 'package.json'))('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const p = await browser.newPage()
    const at = `http://127.0.0.1:${server.address().port}/publish/publish?source=official`
    const real = p.goto.bind(p)
    p.goto = () => real(at)
    const img = join(tmp, 'a.png'); writeFileSync(img, readFileSync(new URL('./lib/images.js', import.meta.url)))
    const said = []
    const r = await fillNote(p, { title: '标题', body: '第一段\n第二段', tags: ['话题', 'b'], images: [img, img] }, x => said.push(x))
    assert.deepEqual(r.filled, ['切换到「上传图文」', '上传 2 张图片', '填写标题', '填写正文', '添加话题'], JSON.stringify(r))
    assert.equal(await p.inputValue('#title'), '标题')
    assert.match(await p.innerText('#body'), /第一段\n第二段/)
    assert.equal(await p.getAttribute('body', 'data-tab'), 'img')
    assert.equal(await p.locator('.img-preview-area .pr').count(), 2)
    assert.ok(said.includes('上传第 2/2 张图片'), 'the person watching is told what it is doing')
    console.log('plume fill: ok')
  } finally { await browser.close() }
  // the same in the agents' shared browser, for real: Chromium with its DevTools port, as the apps plugin starts it; the
  // pack's tab in it, filled in; published → the run says so; leaving it disconnects, it does not close the browser
  const { spawn } = await import('node:child_process')
  const { publishXhsShared } = await import('./pack.js')
  // (its own port, picked by Chromium and read back from the profile: a fixed or guessed one may be a real agents'
  // browser's on this machine — 9333 and up — and the check would drive that one)
  const profile = join(tmp, 'shared-profile')
  const proc = spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let endpoint = null
  const up = async () => { try { return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) })).ok } catch { return false } }
  try {
    for (const end = Date.now() + 15000; !endpoint && Date.now() < end;) {
      const port = existsSync(join(profile, 'DevToolsActivePort')) && Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0])
      if (port > 0) endpoint = `http://127.0.0.1:${port}`
      else await new Promise(r => setTimeout(r, 100))
    }
    assert.ok(endpoint, 'the check\'s own Chromium said its DevTools port')
    for (const end = Date.now() + 15000; !(await up()) && Date.now() < end;) await new Promise(r => setTimeout(r, 200))
    const at = `http://127.0.0.1:${server.address().port}/publish/publish?source=official`
    const calls = []
    const shared = { ensure: async () => endpoint, waitTurn: async () => {}, give: who => calls.push(['give', who]), handoff: (who, why) => calls.push(['handoff', why]), own: (id, who) => calls.push(['own', id]), connect: e => chromium.connectOverCDP(e) }
    const img = join(tmp, 'b.png'); writeFileSync(img, readFileSync(new URL('./lib/images.js', import.meta.url)))
    const c = { run: { id: 'rS', plume: {} }, evidence: () => {}, update: change => { c.run = change(c.run) } }
    const out = await publishXhsShared(c, shared, { f: { title: '共用浏览器', body: '一段', tags: [] }, images: [{ path: img }] }, (pg, note, say) => { const real = pg.goto.bind(pg); pg.goto = () => real(at); return fillNote(pg, note, say) })
    assert.equal(out.browser, 'shared'); assert.equal(out.stoppedAt, undefined, JSON.stringify(out))
    assert.ok(calls.some(x => x[0] === 'own' && /^[0-9A-F]{16,}$/i.test(x[1])), 'its tab, by the browser\'s own id')
    // the person looks at it in the same browser (another connection) and clicks 发布: the site moves on to its success page
    const person = await chromium.connectOverCDP(endpoint)
    const tab = person.contexts()[0].pages().find(x => x.url().startsWith(at.split('?')[0]))
    assert.ok(tab, 'the filled-in tab is in the shared browser')
    assert.equal(await tab.inputValue('#title'), '共用浏览器')
    await tab.goto(at.replace('/publish/publish', '/publish/success'))
    for (const end = Date.now() + 8000; !c.run.plume?.published?.xhs && Date.now() < end;) await new Promise(r => setTimeout(r, 100))
    assert.equal(c.run.plume.published.xhs.by, 'person')
    assert.deepEqual(c.run.posted.map(x => [x.platform, x.url]), [['xhs', undefined]], 'the run says what it published (the portfolio shows it)')
    for (const end = Date.now() + 3000; !calls.some(x => x[0] === 'give') && Date.now() < end;) await new Promise(r => setTimeout(r, 50))
    assert.ok(calls.some(x => x[0] === 'give'), 'the turn goes back')
    await new Promise(r => setTimeout(r, 500))
    assert.equal(await up(), true, 'leaving it does not close the shared browser')
    assert.ok(person.contexts()[0].pages().some(x => x.url().includes('/publish/success')), 'and the tab stays for the person')
    await person.close().catch(() => {})
    console.log('plume 小红书 in a real shared browser: ok')
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      const closed = new Promise(resolve => proc.once('close', resolve)), kill = setTimeout(() => proc.kill('SIGKILL'), 5000)
      proc.kill(); try { await closed } finally { clearTimeout(kill) }
    }
    server.close()
  }
}
rmSync(tmp, { recursive: true, force: true })
console.log('plume check: ok')
// (the workbench's tool socket and its timers stay open in a fake dsh with nothing to dispose them: done here)
process.exit(0)
