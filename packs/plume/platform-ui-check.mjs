// The actual Studio extension, platform knowledge, and saved-version audit controls in React/Chromium.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(fileURLToPath(import.meta.url))
const reactDir = process.env.RUYIX_REACT_DIR || join(homedir(), '.dsh/profiles/node_modules')
const runtime = [process.env.RUYIX_UI_RUNTIME, join(homedir(), '.ruyix/workbench/ui-runtime'), join(homedir(), '.aviary/workbench/ui-runtime')].find(d => d && existsSync(join(d, 'node_modules/playwright')))
if (!runtime || !existsSync(join(reactDir, 'react-dom'))) console.log('plume platform UI check: skipped — React host or Playwright is not installed')
else {
  const req = createRequire(join(realpathSync(join(reactDir, 'react-dom')), 'package.json'))
  const { chromium } = createRequire(join(runtime, 'package.json'))('playwright')
  const { outputFiles } = await build({
    stdin: { contents: `
      import React, { useState, useEffect } from 'react'
      import { createRoot } from 'react-dom/client'
      import { PlatformKnowledge } from './src/knowledge.jsx'
      import { PostsEditor } from './src/editor.jsx'
      import { PublishBody } from './src/publish.jsx'
      import { OwnView } from '../../core/plugins/studio/src/page.jsx'
      import tokens from '@ruyix/shell/tokens.css'
      import plumeCss from './src/styles.css'
      import studioCss from '../../core/plugins/studio/src/styles.css'
      import workbenchCss from '../../core/workbench/src/styles.css'
      const test = window.platformTest = { requests: [], events: [], unmounted: 0 }
      window.addEventListener('ruyix-workbench:open', event => test.events.push(event.detail))
      const call = (op, args = {}) => new Promise((resolve, reject) => test.requests.push({ op, args, resolve, reject, done: false }))
      test.answer = (i, value) => { test.requests[i].done = true; test.requests[i].resolve(value) }
      test.fail = (i, value) => { test.requests[i].done = true; test.requests[i].reject(new Error(value)) }
      function Knowledge() { useEffect(() => () => { ++test.unmounted }, []); return <PlatformKnowledge lang="en" call={call} tasksCall={call} /> }
      test.install = () => { window.__ruyixWorkbenchExt = { plume: { studioViews: { knowledge: Knowledge }, css: '' } }; window.dispatchEvent(new Event('ruyix-workbench-ext')) }
      test.remove = () => { delete window.__ruyixWorkbenchExt.plume; window.dispatchEvent(new Event('ruyix-workbench-ext')) }
      function App() {
        const [mode, setMode] = useState('own'), [run, setRun] = useState({ id: 'r1', status: 'waiting', contentRevision: 0 })
        test.mode = setMode
        test.revision = () => setRun(run => ({ ...run, contentRevision: run.contentRevision + 1 }))
        const content = mode === 'own' ? <OwnView studio="plume" block={{view:'own:knowledge'}} lang="en" /> : mode === 'editor'
          ? <PostsEditor run={run} open lang="en" call={call} onBlocked={value => test.blocked = value} />
          : <PublishBody run={run} a={{status:'pending',payload:{platform:mode === 'publish-x' ? 'x' : 'wechat_mp',fields:mode === 'publish-x' ? {tweets:['Pending']} : {title:'Pending',body:'',digest:''}}}} open lang="en" call={call} onBlocked={value => test.blocked = value} />
        return <div className={mode === 'own' ? 'st-page' : 'wb-page'} style={{padding:20,height:'auto',containerType:'inline-size',boxSizing:'border-box'}}><style>{tokens + plumeCss + studioCss + workbenchCss + 'body { margin: 0; font-family: var(--ruyix-font); }'}</style>{content}</div>
      }
      createRoot(document.getElementById('root')).render(<App />)
    `, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', loader: { '.css': 'text' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'host-react', setup(b) {
      b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, a => ({ path: req.resolve(a.path) }))
      b.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export function MarkdownText() { return null }', loader: 'js' }))
    } }],
  })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage(), errors = []
  page.setDefaultTimeout(10000)
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://ruyix.test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }))
  const profile = (platform = 'x', revision = 1) => ({
    platform, revision, digest: `${platform}-${revision}`, source: 'reviewed', auditContract: 2, researchedAt: '2026-10-22', expiresAt: '2026-11-22', stale: false,
    summary: 'Lead with a useful, standalone point.',
    observations: [{ id: 'opening', dimension: 'opening', statement: 'A reader should understand the first post on its own.', authority: 'editorial', sourceIds: ['s1'], limitations: 'A writing choice, not a ranking guarantee.' }],
    sources: [{ id: 's1', title: 'Official posting guidance', url: 'https://help.x.com/en/using-x/types-of-posts', authority: 'official', publisher: 'X', availability: 'read', accessedAt: '2026-10-22' }], conflicts: [], unknowns: ['No verified reach guarantee.'],
  })
  const legacyProfile = () => {
    const { auditContract, ...legacy } = profile()
    return { ...legacy, revision: 'legacy-pinned', summary: 'Unaudited legacy summary must not render.', observations: [{ ...legacy.observations[0], statement: 'Unaudited legacy advice must not render.' }], sources: [{ ...legacy.sources[0], title: 'Legacy UGC falsely labelled official' }] }
  }
  const request = async op => {
    await page.waitForFunction(op => window.platformTest.requests.some(r => r.op === op && !r.done), op)
    return page.evaluate(op => platformTest.requests.findIndex(r => r.op === op && !r.done), op)
  }
  const answer = (i, value) => page.evaluate(({ i, value }) => platformTest.answer(i, value), { i, value })
  const reply = async (op, value) => answer(await request(op), value)
  const fail = async (op, value) => { const i = await request(op); await page.evaluate(({ i, value }) => platformTest.fail(i, value), { i, value }) }
  const args = i => page.evaluate(i => platformTest.requests[i].args, i)
  const screenshot = async name => {
    if (!process.env.RUYIX_UI_SCREENSHOTS) return
    mkdirSync(process.env.RUYIX_UI_SCREENSHOTS, { recursive: true })
    await page.screenshot({ path: join(process.env.RUYIX_UI_SCREENSHOTS, `${name}.png`), fullPage: true })
  }
  const start = async mode => {
    await page.goto('http://ruyix.test/'); await page.addScriptTag({ content: outputFiles[0].text })
    if (mode) await page.evaluate(mode => platformTest.mode(mode), mode)
  }
  const post = (digest = 'v1', extra = {}) => ({ platforms: [{ id: 'x', digest, fields: { tweets: ['A useful point.'] }, images: [], issues: [], limits: [{ key: 'tweetMax', value: 280 }], knowledge: profile(), adaptation: { current: true, passed: true, summary: 'Keeps the source meaning.', checkedAt: '2026-10-22', checks: [{ dimension: 'facts', verdict: 'pass', reason: 'All statements preserve the master draft.' }] }, ...extra }] })
  const schedule = { id: 't1', title: 'Weekly platform research', enabled: true, schedule: { kind: 'daily', days: [1], at: '09:00' }, fields: { platforms: ['xhs', 'x', 'wechat_mp'] }, tz: 'America/Los_Angeles', nextAt: '2026-10-26' }
  try {
    await start()
    assert.equal(await page.locator('.pl-knowledge').count(), 0)
    await page.evaluate(() => platformTest.install())
    await reply('knowledge', { profiles: [profile()] }); await reply('knowledgeSchedules', { tasks: [] })
    await page.getByRole('heading', { name: 'Platform knowledge' }).waitFor()
    assert.match(await page.locator('.pl-knowledge-meta').innerText(), /Oct 22, 2026/, 'date-only source dates do not shift with local timezone')
    await screenshot('platform-knowledge')
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'knowledge fits a narrow viewport')
    await screenshot('platform-knowledge-mobile')
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.getByLabel('Search knowledge').fill('opening')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    const searchRequest = await request('knowledge'); assert.equal((await args(searchRequest)).query, 'opening')
    await answer(searchRequest, { profiles: [profile()] })
    await reply('knowledgeSchedules', { tasks: [] })
    await page.getByText('View sources (1)', { exact: true }).click()
    assert.equal(await page.getByRole('link', { name: 'Official posting guidance', exact: true }).getAttribute('href'), 'https://help.x.com/en/using-x/types-of-posts')
    await page.getByRole('button', { name: 'Version history', exact: true }).click()
    await reply('knowledgeHistory', { platform: 'x', versions: [profile('x', 0)] })
    await page.locator('.pl-knowledge-history summary').first().click()
    assert.equal(await page.locator('.pl-knowledge-history article').count(), 1)
    await page.getByRole('button', { name: 'Search', exact: true }).click(); await fail('knowledge', 'Knowledge service unavailable')
    await page.getByRole('alert').filter({ hasText: 'Knowledge service unavailable' }).waitFor()
    assert.equal(await page.locator('.pl-knowledge-results > article').count(), 1, 'a failed search preserves readable knowledge')

    // Synchronous double clicks make one server-deduplicated request; weekly creation never uses taskCreate.
    await page.getByRole('button', { name: 'Update every Monday', exact: true }).evaluate(button => { button.click(); button.click() })
    const create = await request('ensureKnowledgeSchedule')
    assert.deepEqual(await args(create), { tz: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) })
    assert.equal(await page.evaluate(() => platformTest.requests.filter(r => r.op === 'ensureKnowledgeSchedule').length), 1)
    assert.equal(await page.evaluate(() => platformTest.requests.filter(r => r.op === 'taskCreate').length), 0)
    await answer(create, { task: schedule, created: true }); await reply('knowledgeSchedules', { tasks: [schedule] })
    await reply('knowledge', { profiles: [profile()] }); await reply('knowledgeSchedules', { tasks: [schedule] })
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Update every Monday', exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Pause', exact: true }).click()
    const pause = await request('taskUpdate'); assert.deepEqual(await args(pause), { id: 't1', enabled: false })
    await answer(pause, { task: { ...schedule, enabled: false } }); await reply('knowledgeSchedules', { tasks: [{ ...schedule, enabled: false }] })
    await reply('knowledge', { profiles: [profile()] }); await reply('knowledgeSchedules', { tasks: [{ ...schedule, enabled: false }] })
    await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
    await page.getByLabel('Platform', { exact: true }).selectOption('x')
    await reply('knowledge', { profiles: [profile()] }); await reply('knowledgeSchedules', { tasks: [{ ...schedule, enabled: false }] })
    await page.getByRole('button', { name: 'Research updates now', exact: true }).click()
    const refresh = await request('taskCreate'); assert.deepEqual((await args(refresh)).fields, { platforms: ['x'] }); assert.equal((await args(refresh)).schedule.kind, 'once')
    await fail('taskCreate', 'Research agent unavailable')
    await page.getByRole('alert').filter({ hasText: 'Research agent unavailable' }).waitFor()
    assert.equal(await page.locator('.pl-knowledge-results > article').count(), 1)
    await page.evaluate(() => platformTest.remove())
    await page.waitForFunction(() => platformTest.unmounted === 1)
    assert.equal(await page.locator('.pl-knowledge').count(), 0, 'removing the extension unmounts its own view')

    // An older tab can show no schedules while another tab creates one. The server returns the existing task.
    await start(); await page.evaluate(() => platformTest.install())
    await reply('knowledge', { profiles: [profile()] }); await reply('knowledgeSchedules', { tasks: [] })
    await page.getByRole('button', { name: 'Update every Monday', exact: true }).click()
    await reply('ensureKnowledgeSchedule', { task: schedule, created: false })
    await reply('knowledgeSchedules', { tasks: [schedule] })
    await reply('knowledge', { profiles: [profile()] }); await reply('knowledgeSchedules', { tasks: [schedule] })
    await page.getByRole('status').filter({ hasText: 'A platform research schedule already exists. Manage it below.' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Update every Monday', exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => platformTest.requests.some(r => r.op === 'taskCreate')), false)
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await reply('knowledge', { profiles: [legacyProfile()] })
    await page.getByText('Excluded from automatic guidance', { exact: true }).waitFor()
    assert.match(await page.locator('.pl-knowledge-meta').innerText(), /^Pinned historical version/)
    assert.equal(await page.getByText('Version legacy-pinned', { exact: true }).count(), 1)
    assert.doesNotMatch(await page.locator('.pl-knowledge-results').innerText(), /Unaudited legacy|Legacy UGC|Reviewed knowledge|Within refresh period/)
    assert.equal(await page.locator('.pl-knowledge-sources').count(), 0, 'old unaudited provenance cannot retain an official source badge')

    await start('editor'); await reply('posts', post())
    await page.getByText('The current version passed the content and platform check', { exact: true }).waitFor()
    await screenshot('platform-adaptation')
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the review editor fits a narrow viewport')
    await screenshot('platform-adaptation-mobile')
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.locator('.pl-form textarea').fill('Unsaved edits')
    assert.equal(await page.getByRole('button', { name: 'Check platform fit again', exact: true }).isDisabled(), true)
    await page.getByText('The results below belong to the previous saved version; they do not approve these changes.', { exact: true }).waitFor()
    await page.evaluate(() => platformTest.revision()); await reply('posts', post('v1', { adaptation: { current: true, passed: false, checkedAt: '2026-10-22', summary: 'An added claim needs removal.', checks: [{ dimension: 'tone', verdict: 'pass', reason: 'Voice fits.' }], units: [{ id: 'u1', verdict: 'unsupported', text: 'Invented achievement', reason: 'The master draft gives no such achievement.' }] } }))
    assert.equal(await page.locator('.pl-form textarea').inputValue(), 'Unsaved edits', 'audit updates preserve dirty drafts')
    await page.getByText('The master draft gives no such achievement.', { exact: true }).waitFor()
    await page.locator('.pl-form textarea').fill('A useful point.')
    await page.getByRole('button', { name: 'Check platform fit again', exact: true }).click()
    const recheck = await request('recheckAdaptation'); assert.deepEqual(await args(recheck), { run: 'r1', platform: 'x', expectedDigest: 'v1' })
    await answer(recheck, { run: { id: 'audit-1', status: 'running' } })
    await page.getByRole('button', { name: 'View check progress', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => platformTest.events.at(-1)), { run: 'audit-1' })
    await page.getByRole('button', { name: 'Check platform fit again', exact: true }).click(); await fail('recheckAdaptation', 'Audit agent unavailable')
    await page.getByRole('alert').filter({ hasText: 'Audit agent unavailable' }).waitFor()
    assert.equal(await page.locator('.pl-form textarea').inputValue(), 'A useful point.')
    const historicalReview = { ...post().platforms[0].adaptation, current: false }
    await page.evaluate(() => platformTest.revision()); await reply('posts', post('v1', { frozen: true, adaptation: historicalReview, knowledge: { ...profile(), stale: false, expiresAt: '2020-01-01' } }))
    await page.getByText('Knowledge used for this draft · Version 1 · Refresh due', { exact: true }).waitFor()
    await page.getByText('Published or handed-off version', { exact: true }).waitFor()
    assert.doesNotMatch(await page.locator('.pl-adaptation').innerText(), /has not passed|previous saved version|Audit agent unavailable|independent check has started/)
    await page.getByText('View historical review', { exact: true }).click()
    await page.getByText('All statements preserve the master draft.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Check platform fit again', exact: true }).count(), 0)
    await page.evaluate(() => platformTest.revision()); await reply('posts', post('v1', { frozen: true, adaptation: historicalReview, knowledge: legacyProfile() }))
    await page.getByText('Knowledge retained with this draft · Version legacy-pinned · Excluded from automatic guidance', { exact: true }).click()
    await page.getByText('This pinned research has not been verified against the current review requirements and is excluded from automatic guidance. The version is retained for traceability; new research applies to future drafts.', { exact: true }).waitFor()
    assert.doesNotMatch(await page.locator('.pl-adaptation-knowledge').innerText(), /Unaudited legacy summary|Knowledge used for this draft/)
    assert.doesNotMatch(await page.locator('.pl-adaptation').innerText(), /has not passed|previous saved version/)
    await page.evaluate(() => platformTest.revision()); await reply('posts', post('v1', { frozen: true, knowledge: { ...profile(), source: 'seed', auditContract: null } }))
    await page.getByText('Knowledge used for this draft · Version 1', { exact: true }).waitFor()
    assert.equal(await page.locator('.pl-adaptation-knowledge p').textContent(), profile().summary, 'the checked-in seed remains usable without a research audit contract')
    const emptyReview = { current: false, passed: false, summary: '', checks: [] }
    await page.evaluate(() => platformTest.revision()); await reply('posts', post('v1', { frozen: true, adaptation: emptyReview, knowledge: legacyProfile() }))
    await page.getByText('No adaptation review was saved for this historical version.', { exact: true }).waitFor()
    assert.equal(await page.locator('.pl-adaptation-history').count(), 0)
    assert.doesNotMatch(await page.locator('.pl-adaptation').innerText(), /has not passed|previous saved version/)
    await start('editor'); await reply('posts', post('v1', { adaptation: emptyReview }))
    await page.getByText('The current version has not passed the platform check', { exact: true }).waitFor()
    assert.doesNotMatch(await page.locator('.pl-adaptation').innerText(), /previous saved version|Published or handed-off version/)
    assert.equal(await page.getByRole('button', { name: 'Check platform fit again', exact: true }).isEnabled(), true)

    // Recording an uncertain X receipt is independent of the still-blocked publication approval.
    const uncertainX = () => post('x-pending', { adaptation: emptyReview, published: { partial: true, uncertain: { attempt: 'attempt-1', text: 'A useful point.' } }, issues: [{ code: 'adaptation.review', level: 'error', en: 'Platform fit needs review', zh: '需要检查适配' }] })
    await start('publish-x'); await reply('posts', uncertainX())
    const outcome = () => page.getByRole('button', { name: 'Record outcome', exact: true })
    const postIdField = () => page.getByPlaceholder('Published post’s numeric ID', { exact: true })
    assert.equal(await outcome().isDisabled(), true)
    await postIdField().fill('not-a-post-id'); assert.equal(await outcome().isDisabled(), true)
    await postIdField().fill('12345'); assert.equal(await outcome().isEnabled(), true)
    assert.equal(await page.evaluate(() => platformTest.blocked), true)
    await outcome().evaluate(button => { button.click(); button.click() })
    const record = await request('resolveXOutcome')
    assert.deepEqual(await args(record), { run: 'r1', expectedDigest: 'x-pending', attempt: 'attempt-1', postId: '12345', notPosted: false })
    assert.equal(await page.evaluate(() => platformTest.requests.filter(r => r.op === 'resolveXOutcome').length), 1)
    assert.equal(await postIdField().isDisabled(), true)
    await fail('resolveXOutcome', 'The receipt changed; check again')
    await page.getByRole('alert').filter({ hasText: 'The receipt changed; check again' }).waitFor()
    assert.equal(await postIdField().inputValue(), '12345', 'failed receipt recording preserves the checked ID')
    assert.equal(await page.evaluate(() => platformTest.blocked), true)
    await outcome().click(); await reply('resolveXOutcome', { resolved: true, published: { partial: true, ids: ['12345'] } })
    const remainingX = uncertainX(); remainingX.platforms[0].published = { partial: true, ids: ['12345'] }
    await reply('posts', remainingX)
    await page.getByRole('status').filter({ hasText: 'Checked outcome recorded.' }).waitFor()
    assert.equal(await outcome().count(), 0)
    assert.equal(await page.evaluate(() => platformTest.blocked), true, 'receipt recovery never bypasses adaptation approval errors')
    assert.deepEqual(await page.evaluate(() => [...new Set(platformTest.requests.map(r => r.op))]), ['posts', 'resolveXOutcome'], 'recording a receipt never requests publication')
    await start('publish-x'); await reply('posts', uncertainX())
    await page.getByLabel('I checked X: this post was not published', { exact: true }).check()
    await outcome().click()
    const notPostedRequest = await request('resolveXOutcome')
    assert.deepEqual(await args(notPostedRequest), { run: 'r1', expectedDigest: 'x-pending', attempt: 'attempt-1', postId: '', notPosted: true })
    await answer(notPostedRequest, { resolved: true, published: { partial: true, ids: [] } }); await reply('posts', remainingX)
    assert.equal(await page.evaluate(() => platformTest.blocked), true)

    await start('publish')
    const mp = blocked => ({ platforms: [{ ...post().platforms[0], id: 'wechat_mp', fields: { title: 'Article title', digest: 'Article summary', body: 'Article body' }, creator: 'https://mp.weixin.qq.com/', issues: blocked ? [{ code: 'adaptation.pending', level: 'error', en: 'Platform fit needs review', zh: '需要检查适配' }] : [] }] })
    await reply('posts', mp(true)); await page.locator('.pl-steps').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Copy', exact: true }).count(), 0, 'WeChat copying is withheld until platform checks pass')
    assert.equal(await page.getByRole('link', { name: 'Open', exact: true }).count(), 0)
    await page.evaluate(() => platformTest.revision()); await reply('posts', mp(false))
    await page.getByRole('button', { name: 'Copy', exact: true }).first().waitFor()
    assert.equal(await page.getByRole('button', { name: 'Copy', exact: true }).count(), 3)
    assert.deepEqual(errors, [], 'React and the extension lifecycle have no runtime errors')
    console.log('plume platform UI check: ok (knowledge/search/schedules/extension lifecycle/editor and publish audit)')
  } finally { await browser.close() }
}
