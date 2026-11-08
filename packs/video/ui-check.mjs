// Mount the real timeline editor with React in Chromium. Deferred RPC responses exercise the Viewer-save event,
// draft preservation and request races without a server, media files, or network access.
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { validateTimeline } from './lib/timeline.js'

const root = dirname(fileURLToPath(import.meta.url))
const reactDir = process.env.RUYIX_REACT_DIR || join(homedir(), '.dsh/profiles/node_modules')
const runtime = [process.env.RUYIX_UI_RUNTIME, join(homedir(), '.ruyix/workbench/ui-runtime'), join(homedir(), '.aviary/workbench/ui-runtime')].find(d => d && existsSync(join(d, 'node_modules/playwright')))
if (!runtime || !existsSync(join(reactDir, 'react-dom'))) {
  console.log('video UI check: skipped — React host or Playwright is not installed')
} else {
  const req = createRequire(join(realpathSync(join(reactDir, 'react-dom')), 'package.json'))
  const { chromium } = createRequire(join(runtime, 'package.json'))('playwright')
  const { outputFiles } = await build({
    stdin: { contents: `
      import React, { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import { TimelineEditor } from './src/main.jsx'
      const test = window.videoTest = { requests: [], blocked: null, dirty: null, payload: null }
      const call = (op, args) => new Promise((resolve, reject) => test.requests.push({ op, args, resolve, reject }))
      test.answer = (i, data) => test.requests[i].resolve(data)
      test.fail = (i, message) => test.requests[i].reject(new Error(message))
      function App() {
        const [gate, setGate] = useState('review')
        test.gate = setGate
        const [run, setRun] = useState({ id: 'run-1', stage: 'review', edits: [] })
        test.edit = version => setRun(r => ({ ...r, edits: [...r.edits, { path: 'timeline.json', version }] }))
        test.switchRun = id => setRun({ id, stage: 'review', edits: [] })
        return <TimelineEditor a={{ payload: { stage: gate } }} run={run} open lang="en" call={call} onBlocked={v => test.blocked = v} onDirty={v => test.dirty = v} onPayload={v => test.payload = v} />
      }
      createRoot(document.getElementById('root')).render(<App />)
    `, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'host-react', setup(b) { b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, a => ({ path: req.resolve(a.path) })) } }],
  })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  // A local secure context exposes the same crypto.randomUUID API used by Add clip in the app.
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }))
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const doc = (digest, title = digest) => ({ digest, editable: true, sources: [], timeline: {
    version: 1, title, clips: [{ id: 'clip-1', source: 'source-1', in: 0, out: 3, speed: 1, volume: 1, reason: '' }], captions: [],
    output: { width: 1920, height: 1080, fps: 30, fit: 'contain', normalizeAudio: true },
  } })
  const count = n => page.waitForFunction(n => window.videoTest.requests.length === n, n)
  const answer = (i, data) => page.evaluate(({ i, data }) => window.videoTest.answer(i, data), { i, data })
  const edit = v => page.evaluate(v => window.videoTest.edit(v), v)
  const shown = title => page.waitForFunction(title => document.querySelector('.vid-summary strong')?.textContent === title, title)
  const snapshot = () => page.evaluate(() => ({ dirty: window.videoTest.dirty, blocked: window.videoTest.blocked, digest: window.videoTest.payload?.videoDigest }))
  const start = async (data = doc('r0')) => {
    await page.goto('http://localhost/video-check')
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: outputFiles[0].text })
    assert.deepEqual(errors, [], 'the browser test bundle loaded')
    await count(1); await answer(0, data); await shown(data.timeline.title)
  }
  const mark = async (key, time) => {
    await page.locator('video').evaluate((video, time) => Object.defineProperty(video, 'currentTime', { configurable: true, value: time }), time)
    await page.getByRole('button', { name: `Set ${key} at playhead` }).click()
  }
  const range = async () => ({ in: Number(await page.getByLabel('In (s)', { exact: true }).inputValue()), out: Number(await page.getByLabel('Out (s)', { exact: true }).inputValue()) })
  const saveMarked = async sources => {
    await page.getByRole('button', { name: 'Validate & save timeline' }).click(); await count(2)
    const timeline = await page.evaluate(() => videoTest.requests[1].args.timeline)
    assert.doesNotThrow(() => validateTimeline(timeline, sources))
    return timeline
  }
  const reload = async accept => {
    page.once('dialog', dialog => accept ? dialog.accept() : dialog.dismiss())
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
  }
  try {
    await start()
    await edit('viewer-1'); await count(2)
    assert.equal((await snapshot()).blocked, true, 'approval is blocked until the refreshed file is known')
    await answer(1, doc('r1')); await shown('r1')
    assert.deepEqual(await snapshot(), { dirty: false, blocked: false, digest: 'r1' }, 'a clean editor follows the generic Viewer save')

    await start()
    await page.getByLabel('Cut rationale').fill('my unsaved cut')
    await edit('viewer-1'); await count(2); await answer(1, doc('remote'))
    await page.getByRole('alert').filter({ hasText: 'Your draft is preserved' }).waitFor()
    assert.equal(await page.getByLabel('Cut rationale').inputValue(), 'my unsaved cut')
    assert.deepEqual(await snapshot(), { dirty: true, blocked: true, digest: 'r0' }, 'a stale draft keeps the digest of its original base')
    assert.equal(await page.getByRole('button', { name: 'Validate & save timeline' }).isDisabled(), true)
    await reload(false)
    await count(2)
    assert.equal(await page.getByLabel('Cut rationale').inputValue(), 'my unsaved cut', 'declining reload keeps every local change')
    await reload(true); await count(3)
    await page.getByLabel('Cut rationale').fill('typed while reloading')
    await answer(2, doc('remote')); await page.waitForFunction(() => !document.querySelector('.vid-error button').disabled)
    assert.equal(await page.getByLabel('Cut rationale').inputValue(), 'typed while reloading', 'confirmation does not consent to discard edits made afterward')
    assert.equal((await snapshot()).digest, 'r0')
    await reload(true); await count(4); await answer(3, doc('remote')); await shown('remote')
    assert.deepEqual(await snapshot(), { dirty: false, blocked: false, digest: 'remote' })

    await start()
    await page.getByRole('button', { name: 'Edit captions / timeline JSON' }).click()
    await page.getByRole('textbox', { name: 'Timeline JSON' }).fill('{ incomplete local JSON')
    await edit('viewer-json'); await count(2); await answer(1, doc('remote-json'))
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('textbox', { name: 'Timeline JSON' }).inputValue(), '{ incomplete local JSON', 'even invalid JSON is retained for copying or repair')
    await reload(false); await count(2)
    assert.equal((await snapshot()).dirty, true)

    await start()
    await edit('first'); await count(2); await edit('second'); await count(3)
    await answer(2, doc('newest')); await shown('newest'); await answer(1, doc('older'))
    assert.equal((await snapshot()).digest, 'newest', 'a late response cannot rewind a newer revision')

    await start()
    await page.getByLabel('Cut rationale').fill('saved locally')
    await edit('refresh-before-save'); await count(2)
    await page.getByRole('button', { name: 'Validate & save timeline' }).click(); await count(3)
    assert.deepEqual(await page.evaluate(() => ({ op: videoTest.requests[2].op, digest: videoTest.requests[2].args.expectedDigest, reason: videoTest.requests[2].args.timeline.clips[0].reason })), { op: 'saveTimeline', digest: 'r0', reason: 'saved locally' })
    await edit('viewer-during-save'); await answer(1, doc('obsolete-refresh'))
    assert.equal((await snapshot()).digest, 'r0', 'starting a save invalidates a pending refresh')
    await count(3)
    const saved = doc('saved'); saved.timeline.clips[0].reason = 'saved locally'
    await answer(2, saved); await count(4); await answer(3, doc('latest-after-save')); await shown('latest-after-save')
    assert.deepEqual(await snapshot(), { dirty: false, blocked: false, digest: 'latest-after-save' }, 'an update received during saving is refreshed after the save completes')

    await start()
    await page.getByLabel('Cut rationale').fill('keep on failure')
    await page.getByRole('button', { name: 'Validate & save timeline' }).click(); await count(2)
    await page.evaluate(() => videoTest.fail(1, 'Another view saved first'))
    await count(3); await answer(2, doc('r0')); await page.getByRole('alert').waitFor()
    await reload(false); await count(3)
    assert.equal(await page.getByLabel('Cut rationale').inputValue(), 'keep on failure', 'error recovery also requires confirmation before discarding')

    await start()
    await edit('old-run-request'); await count(2)
    await page.evaluate(() => videoTest.switchRun('run-2')); await count(3)
    await answer(2, doc('new-run')); await shown('new-run'); await answer(1, doc('old-run'))
    assert.equal((await snapshot()).digest, 'new-run', 'switching runs invalidates the previous run response')
    const withMedia = doc('both-media')
    withMedia.sources = [{ id: 'source-1', name: 'Phone video', duration: 10, width: 1920, height: 1080, audio: true }]
    withMedia.preview = { seq: 11, sha256: 'preview-sha', manifestSeq: 12 }
    withMedia.export = { seq: 21, sha256: 'export-sha', manifestSeq: 22 }
    await start(withMedia)
    assert.match(await page.locator('video').getAttribute('src'), /ruyix-video\/source/)
    assert.equal(await page.evaluate(() => videoTest.payload.videoArtifactSha256), null)
    assert.equal(await page.getByRole('button', { name: 'Set out at playhead' }).isVisible(), true)
    await page.evaluate(() => videoTest.gate('preview-review'))
    await page.getByText('Rendered preview · full decode verified', { exact: true }).waitFor()
    assert.match(await page.locator('video').getAttribute('src'), /seq=11$/)
    assert.equal(await page.evaluate(() => videoTest.payload.videoArtifactSha256), 'preview-sha', 'the approval card gate wins over run.stage and retained exports')
    await page.evaluate(() => videoTest.gate('final-review'))
    await page.getByText('Final export · full decode verified', { exact: true }).waitFor()
    assert.match(await page.locator('video').getAttribute('src'), /seq=21$/)
    assert.equal(await page.evaluate(() => videoTest.payload.videoArtifactSha256), 'export-sha')

    const longSource = doc('long-source')
    longSource.sources = [{ ...withMedia.sources[0], duration: 60 }]
    await start(longSource)
    await page.getByRole('button', { name: 'Add clip', exact: true }).click()
    assert.deepEqual(errors, [], 'Add clip mounted without browser API errors')
    assert.deepEqual(await range(), { in: 0, out: 10 })
    await mark('in', 30)
    assert.equal((await range()).in, 30, 'mark-in is the playhead even beyond the previous out-point')
    assert.ok((await range()).out >= 30 + 2 / 30 - 1e-8)
    await mark('out', 40)
    assert.deepEqual(await range(), { in: 30, out: 40 })
    const movedLater = (await saveMarked(longSource.sources)).clips.at(-1)
    assert.equal(movedLater.in, 30); assert.equal(movedLater.out, 40)

    const reverse = structuredClone(longSource)
    reverse.timeline.clips[0] = { ...reverse.timeline.clips[0], in: 30, out: 40 }
    await start(reverse)
    await mark('out', 8)
    assert.equal((await range()).out, 8, 'mark-out is the playhead even before the previous in-point')
    assert.ok((await range()).in <= 8 - 2 / 30 + 1e-8)
    await mark('in', 5)
    assert.deepEqual(await range(), { in: 5, out: 8 })
    const movedEarlier = await saveMarked(reverse.sources)
    assert.equal(movedEarlier.clips[0].in, 5); assert.equal(movedEarlier.clips[0].out, 8)

    await start(withMedia)
    await mark('out', 10.043)
    assert.deepEqual(await range(), { in: 0, out: 10 }, 'the video stream, not the longer audio track, bounds the playhead')
    for (const time of [10.043, 9.99]) {
      await mark('in', time)
      await page.getByRole('alert').filter({ hasText: 'at least two output frames before the source ends' }).waitFor()
      assert.deepEqual(await range(), { in: 0, out: 10 }, 'an impossible end mark is reported, not silently moved to another time')
    }
    await mark('in', 9.9)
    assert.deepEqual(await range(), { in: 9.9, out: 10 })
    assert.equal(await page.getByRole('alert').count(), 0, 'a valid mark clears its boundary notice')
    await saveMarked(withMedia.sources)

    await start(reverse)
    for (const time of [-0.043, 0.01]) {
      await mark('out', time)
      await page.getByRole('alert').filter({ hasText: 'at least two output frames after the source begins' }).waitFor()
      assert.deepEqual(await range(), { in: 30, out: 40 }, 'an impossible start mark leaves both endpoints unchanged')
    }
    await mark('out', 0.1)
    assert.equal((await range()).out, 0.1)
    assert.equal(await page.getByRole('alert').count(), 0)
    await saveMarked(reverse.sources)
    assert.deepEqual(errors, [], 'React mounted and updated without runtime errors')
    console.log('video UI check: ok (12 browser scenarios)')
  } finally { await browser.close() }
}
