// The real multi-platform form in React/Chromium, with deferred RPC replies. No network or user files are used.
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = dirname(fileURLToPath(import.meta.url))
const reactDir = process.env.RUYIX_REACT_DIR || join(homedir(), '.dsh/profiles/node_modules')
const runtime = [process.env.RUYIX_UI_RUNTIME, join(homedir(), '.ruyix/workbench/ui-runtime'), join(homedir(), '.aviary/workbench/ui-runtime')].find(d => d && existsSync(join(d, 'node_modules/playwright')))
if (!runtime || !existsSync(join(reactDir, 'react-dom'))) console.log('plume UI check: skipped — React host or Playwright is not installed')
else {
  const req = createRequire(join(realpathSync(join(reactDir, 'react-dom')), 'package.json'))
  const { chromium } = createRequire(join(runtime, 'package.json'))('playwright')
  const { outputFiles } = await build({
    stdin: { contents: `
      import React, { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { PostsEditor } from './src/editor.jsx'
      import { PublishBody } from './src/publish.jsx'
      const test = window.postTest = { requests: [], dirty: null, blocked: null, payload: null }
      const call = (op, args) => new Promise((resolve, reject) => test.requests.push({ op, args, resolve, reject }))
      test.answer = (i, data) => test.requests[i].resolve(data)
      test.fail = (i, message) => test.requests[i].reject(new Error(message))
      function App() {
        const [run, setRun] = useState({ id: 'run-1', status: 'waiting', edits: [], contentRevision: 0 })
        const [hidden, setHidden] = useState(false)
        const [publishing, setPublishing] = useState(false)
        test.publish = () => { setRun(r => ({ ...r, status: 'done' })); setPublishing(true) }
        test.hide = setHidden
        test.edit = version => setRun(r => ({ ...r, edits: [...r.edits, { path: 'posts/x.json', version }], contentRevision: r.contentRevision + 1 }))
        test.revision = () => setRun(r => ({ ...r, contentRevision: r.contentRevision + 1 }))
        test.switchRun = id => setRun({ id, status: 'waiting', edits: [], contentRevision: 0 })
        return publishing ? <PublishBody a={{ id: 'publish-card', status: 'pending', payload: { platform: 'wechat_mp', fields: {} } }} run={run} open lang="en" call={call} onBlocked={v => test.blocked = v} onPayload={v => test.payload = v} /> : <div hidden={hidden}><PostsEditor run={run} open lang="en" visible={!hidden} call={call} onBlocked={v => test.blocked = v} onDirty={v => test.dirty = v} onPayload={v => test.payload = v} /></div>
      }
      createRoot(document.getElementById('root')).render(<App />)
    `, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'host-react', setup(b) { b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, a => ({ path: req.resolve(a.path) })) } }],
  })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('http://ruyix.test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }))
  const doc = (version, issues = []) => ({ platforms: [
    { id: 'x', fields: { tweets: [version] }, digest: version, issues, images: [], limits: [{ key: 'tweetMax', value: 280 }] },
    { id: 'xhs', fields: { title: 'XHS', body: '', tags: [], cover: {}, cards: [] }, digest: 'xhs-base', issues: [], images: [], limits: [] },
  ] })
  const count = n => page.waitForFunction(n => window.postTest.requests.length === n, n)
  const answer = (i, data) => page.evaluate(({ i, data }) => window.postTest.answer(i, data), { i, data })
  const edit = v => page.evaluate(v => window.postTest.edit(v), v)
  const baseIs = v => page.waitForFunction(v => window.postTest.payload?.plumeDigests.x === v, v)
  const snapshot = () => page.evaluate(() => ({ dirty: postTest.dirty, blocked: postTest.blocked, digest: postTest.payload?.plumeDigests.x }))
  const postField = () => page.locator('.pl-form textarea').first()
  const save = () => page.getByRole('button', { name: 'Save as a new version', exact: true })
  const tab = name => page.getByRole('tab', { name, exact: true }).click()
  const start = async () => {
    await page.goto('http://ruyix.test/'); await page.evaluate(() => localStorage.clear()); await page.addScriptTag({ content: outputFiles[0].text })
    assert.deepEqual(errors, [], 'the browser test bundle loaded')
    await count(1); await answer(0, doc('r0')); await baseIs('r0')
  }
  const reload = async consent => {
    page.once('dialog', dialog => consent ? dialog.accept() : dialog.dismiss())
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
  }
  try {
    await start()
    await edit('image-limit'); await count(2)
    await answer(1, doc('image-limit', [{ code: 'image.size', level: 'error', en: 'Image exceeds X limit' }, { code: 'images.max', level: 'error', en: 'Too many XHS images' }]))
    await baseIs('image-limit')
    assert.equal((await snapshot()).blocked, false, 'attachment errors remain visible but only block their own publish cards')
    await page.locator('.pl-issues li').filter({ hasText: 'Image exceeds X limit' }).waitFor()
    await edit('text-limit'); await count(3); await answer(2, doc('text-limit', [{ code: 'tweet.max', level: 'error', en: 'Shorten the post' }])); await baseIs('text-limit')
    assert.equal((await snapshot()).blocked, true, 'editable text errors still block the shared preview')

    await start()
    await page.evaluate(() => postTest.hide(true)); await edit('raw-edit'); await count(2)
    assert.equal((await snapshot()).blocked, true)
    const unrendered = doc('raw-file', [{ level: 'error', code: 'render.changed', en: 'Rebuild cards', zh: '重做卡片' }])
    await answer(1, unrendered); await baseIs('raw-file'); await page.evaluate(() => postTest.hide(false))
    assert.equal(await postField().inputValue(), 'raw-file', 'a hidden mounted editor follows a raw Viewer save')
    assert.equal(await save().isEnabled(), true, 'the refreshed render check exposes the rebuild action without forcing a field edit')
    assert.deepEqual(await snapshot(), { dirty: false, blocked: true, digest: 'raw-file' })
    await save().click(); await count(3)
    assert.equal(await page.evaluate(() => postTest.requests[2].args.expectedDigest), 'raw-file')
    await answer(2, doc('rebuilt').platforms[0]); await count(4); await answer(3, doc('rebuilt')); await baseIs('rebuilt')
    await page.waitForFunction(() => !postTest.blocked)

    await start()
    await postField().fill('my X draft'); await tab('Xiaohongshu'); await page.getByLabel('Title', { exact: true }).fill('my XHS draft')
    await edit('other-window'); await count(2); await answer(1, doc('remote'))
    await page.getByRole('alert').filter({ hasText: 'Your drafts are preserved' }).waitFor()
    await reload(false); await count(2)
    assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'my XHS draft')
    await tab('X'); assert.equal(await postField().inputValue(), 'my X draft')
    assert.deepEqual(await snapshot(), { dirty: true, blocked: true, digest: 'r0' })
    assert.equal(await save().isDisabled(), true)
    await reload(true); await count(3); await postField().fill('typed after confirmation')
    await answer(2, doc('remote')); await page.waitForFunction(() => !document.querySelector('[role=alert] button').disabled)
    assert.equal(await postField().inputValue(), 'typed after confirmation', 'reload preserves edits made after its confirmation')
    await tab('Xiaohongshu'); assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'my XHS draft')
    await reload(true); await count(4); await answer(3, doc('remote')); await baseIs('remote')
    assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'XHS')
    assert.deepEqual(await snapshot(), { dirty: false, blocked: false, digest: 'remote' })

    await start()
    await page.evaluate(() => postTest.revision()); await count(2)
    await page.evaluate(() => postTest.revision()); await count(3)
    await answer(2, doc('newest')); await baseIs('newest'); await answer(1, doc('older'))
    assert.equal((await snapshot()).digest, 'newest', 'contentRevision alone refreshes, and late replies cannot replace newer data')

    await start()
    await postField().fill('submitted draft'); await edit('before-save'); await count(2)
    await save().click(); await count(3)
    await edit('during-save'); await answer(1, doc('old-request'))
    assert.equal((await snapshot()).digest, 'r0', 'a save invalidates pending loads and defers version events')
    await postField().fill('typed during save')
    const saved = doc('saved'); saved.platforms[0].fields.tweets = ['submitted draft']
    await answer(2, saved.platforms[0]); await count(4); await answer(3, saved); await baseIs('saved')
    assert.equal(await postField().inputValue(), 'typed during save', 'saving acknowledges only the submitted draft')
    assert.equal((await snapshot()).dirty, true)
    await save().click(); await count(5)
    assert.deepEqual(await page.evaluate(() => ({ digest: postTest.requests[4].args.expectedDigest, tweets: postTest.requests[4].args.fields.tweets })), { digest: 'saved', tweets: ['typed during save'] })
    await answer(4, doc('second-save').platforms[0]); await count(6); await answer(5, doc('second-save')); await baseIs('second-save')

    await start()
    await postField().fill('keep after CAS failure'); await save().click(); await count(2)
    await page.evaluate(() => postTest.fail(1, 'Another window saved first'))
    await count(3); await answer(2, doc('remote-after-failure'))
    await page.getByRole('alert').filter({ hasText: 'Your drafts are preserved' }).waitFor()
    assert.deepEqual(await snapshot(), { dirty: true, blocked: true, digest: 'r0' }, 'failed save recovery never silently rebases a local draft onto unseen bytes')
    await reload(false); await count(3)
    assert.equal(await postField().inputValue(), 'keep after CAS failure')

    await start()
    await edit('needs-rebuild'); await count(2); await answer(1, unrendered); await baseIs('raw-file')
    await save().click(); await count(3); await page.evaluate(() => postTest.fail(2, 'Renderer unavailable'))
    await count(4); await answer(3, unrendered)
    await page.getByRole('alert').filter({ hasText: 'Renderer unavailable' }).waitFor()
    assert.equal((await snapshot()).blocked, true, 'refreshing a failed rebuild retains its actionable error')

    await start()
    await edit('old-run-request'); await count(2); await page.evaluate(() => postTest.switchRun('run-2')); await count(3)
    await answer(2, doc('new-run')); await baseIs('new-run'); await answer(1, doc('old-run'))
    assert.equal((await snapshot()).digest, 'new-run')

    // The still-mounted WeChat card refreshes its copied fields and digest after a raw edit or PostsEditor save.
    await start()
    await page.evaluate(() => {
      postTest.copied = []
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { postTest.copied.push(text) },
        write: async items => { postTest.copied.push(await items[0].types['text/html'].text()) },
      } })
      window.ClipboardItem = class { constructor(types) { this.types = types } }
      postTest.publish()
    })
    const mp = n => ({ platforms: [{ id: 'wechat_mp', digest: `mp-${n}`, fields: { title: `Title ${n}`, digest: `Summary ${n}`, body: `Body ${n}` }, images: [], issues: [], limits: [], creator: 'https://mp.weixin.qq.com/' }] })
    const mpBase = v => page.waitForFunction(v => postTest.payload?.digest === v, v)
    const copyStep = n => page.locator('.pl-steps li').nth(n - 1).getByRole('button', { name: /Copy|Copied/, exact: true }).click()
    await count(2); await answer(1, mp(0)); await mpBase('mp-0')
    await copyStep(2); await copyStep(3)
    assert.deepEqual(await page.evaluate(() => postTest.copied), ['Title 0', 'Summary 0'])
    await page.locator('.pl-url').fill('https://mp.weixin.qq.com/s/in-progress')
    await edit('wechat-edit'); await count(3)
    assert.equal(await page.locator('.pl-steps').count(), 0, 'stale copy buttons are unavailable while a new version loads')
    await answer(2, mp(1)); await mpBase('mp-1')
    assert.equal(await page.locator('.pl-steps .pl-done').count(), 0, 'a new digest resets the old version’s copied steps')
    assert.equal(await page.locator('.pl-url').inputValue(), 'https://mp.weixin.qq.com/s/in-progress', 'a refresh preserves the person’s publication URL')
    await copyStep(2); await copyStep(3); await copyStep(4); await count(4)
    assert.deepEqual(await page.evaluate(() => ({ op: postTest.requests[3].op, digest: postTest.requests[3].args.digest, copied: postTest.copied.slice(-2) })), { op: 'article', digest: 'mp-1', copied: ['Title 1', 'Summary 1'] })
    await page.evaluate(() => postTest.fail(3, 'The article changed: reload the current version before copying'))
    await page.getByRole('alert').filter({ hasText: 'The article changed' }).waitFor()
    await page.getByRole('button', { name: 'Reload', exact: true }).click(); await count(5); await answer(4, mp(1)); await mpBase('mp-1')
    assert.equal(await page.locator('.pl-steps .pl-done').count(), 2, 'retrying the same digest retains completed copy steps')
    await copyStep(4); await count(6); await answer(5, { html: '<p>Updated article</p>' })
    await page.waitForFunction(() => document.querySelectorAll('.pl-steps .pl-done').length === 3)
    assert.match(await page.evaluate(() => postTest.copied.at(-1)), /Updated article/)
    await page.evaluate(() => postTest.revision()); await count(7); await page.evaluate(() => postTest.revision()); await count(8)
    await answer(7, mp(3)); await mpBase('mp-3'); await answer(6, mp(2))
    assert.equal(await page.evaluate(() => postTest.payload.digest), 'mp-3', 'late publish-card loads cannot revive an old digest')
    assert.deepEqual(errors, [], 'React mounted and updated without runtime errors')
    console.log('plume UI check: ok (9 browser scenarios)')
  } finally { await browser.close() }
}
