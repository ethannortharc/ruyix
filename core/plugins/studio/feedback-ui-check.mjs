// Real FeedbackBlock/useFeedback/FeedbackForm in React + Chromium. Only HTTP replies are deterministic fixtures;
// no real user's feedback or files are accessed. Exercises polling, rating revisions and delayed mutations.
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
if (!runtime || !existsSync(join(reactDir, 'react-dom'))) console.log('feedback UI check: skipped — React host or Playwright is not installed')
else {
  const req = createRequire(join(realpathSync(join(reactDir, 'react-dom')), 'package.json'))
  const { chromium } = createRequire(join(runtime, 'package.json'))('playwright')
  const { outputFiles } = await build({
    stdin: { contents: `
      import React from 'react'
      import { createRoot } from 'react-dom/client'
      import { FeedbackBlock } from './src/feedback.jsx'
      import { wordsOf } from './src/text.js'
      const profile = { revision: 1, enabled: true, profile: null, sampleCount: 0, rules: [], candidates: [] }
      const view = run => ({ run, runs: [{ id: 'r1', title: 'First issue', status: 'waiting' }, { id: 'r2', title: 'Second issue', status: 'done' }],
        targets: run ? [{ stage: 'research', title: 'Research', status: 'passed', revision: 'v1', summary: 'Source evidence' }] : [], feedback: [], profile: {...profile},
        options: { tone: { label: { en: 'Tone' }, values: { direct: 'Direct', narrative: 'Narrative' } } } })
      const t = window.feedbackTest = { docs: { '': view(null), r1: view('r1'), r2: view('r2') }, rates: [], reads: [], held: [], hold: false }
      const response = (data, ok = true) => ({ ok, json: async () => data })
      window.fetch = async (_url, init) => {
        const args = JSON.parse(init.body)
        if (args.op === 'revs') return response({ revs: { letters: 1 } })
        if (args.op === 'feedback') {
          const data = structuredClone(t.docs[args.run || '']); t.reads.push(args)
          if (t.hold) return new Promise(resolve => t.held.push({ args, data, resolve }))
          return response(data)
        }
        if (args.op === 'rate') return new Promise(resolve => t.rates.push({ args, resolve }))
        if (args.op === 'removeFeedback') {
          for (const d of Object.values(t.docs)) { d.feedback = d.feedback.filter(f => f.id !== args.id); d.profile.revision++ }
          return response({ removed: true })
        }
        throw new Error('Unexpected op ' + args.op)
      }
      t.reload = () => window.dispatchEvent(new CustomEvent('ruyix:studio', { detail: { studio: 'letters' } }))
      t.reply = (i, fail) => {
        const call = t.rates[i], d = t.docs[call.args.run]
        if (fail) return call.resolve(response({ error: 'The result changed since you opened it', code: 'feedbackChanged' }, false))
        const f = { ...call.args, id: 'saved-' + i, at: Date.now(), title: 'Issue', seq: i + 1 }
        d.feedback = [f]; d.profile = { ...d.profile, revision: d.profile.revision + 1, sampleCount: 1 }
        call.resolve(response({ feedback: f, profile: d.profile }))
      }
      t.answerRead = i => t.held[i].resolve(response(t.held[i].data))
      createRoot(document.getElementById('root')).render(<FeedbackBlock studio="letters" lang="en" W={wordsOf('en')} />)
    `, resolveDir: root, loader: 'jsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic',
    loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'host-react', setup(b) { b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, a => ({ path: req.resolve(a.path) })) } }],
  })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage(), errors = []
  page.setDefaultTimeout(5000)
  page.on('pageerror', e => errors.push(e.message))
  const input = () => page.getByLabel('Specific feedback (optional)', { exact: true })
  const save = () => page.getByRole('button', { name: 'Save rating', exact: true })
  const rates = n => page.waitForFunction(n => feedbackTest.rates.length === n, n)
  const reload = update => page.evaluate(update => { update && Object.assign(feedbackTest.docs.r1, update); feedbackTest.reload() }, update)
  const start = async (saved = false) => {
    await page.goto('about:blank'); await page.setContent('<div id="root"></div>'); await page.addScriptTag({ content: outputFiles[0].text })
    await page.waitForFunction(() => window.feedbackTest?.reads.length > 0)
    assert.deepEqual(errors, [], 'feedback component loaded without browser errors')
    await page.getByLabel('Run', { exact: true }).selectOption('r1'); await input().waitFor()
    if (saved) {
      await page.evaluate(() => { feedbackTest.docs.r1.feedback = [{ id: 'old', run: 'r1', stage: 'research', revision: 'v0', score: 3, choices: { tone: 'direct' }, note: 'Earlier saved opinion' }]; feedbackTest.docs.r1.profile.revision = 2; feedbackTest.reload() })
      await page.waitForFunction(() => document.querySelector('textarea')?.value === 'Earlier saved opinion')
    }
  }
  const type = async text => { await page.getByRole('radio', { name: '4', exact: true }).check(); await input().fill(text) }
  const currentTarget = revision => ({ targets: [{ stage: 'research', title: 'Research', status: 'passed', revision, summary: 'Updated evidence' }] })
  const confirmVersion = () => page.getByRole('button', { name: 'I reviewed this version', exact: true }).click()
  try {
    await start(); await type('Unsaved polling draft')
    await page.getByText('Preferences for next time (optional)', { exact: true }).click(); await page.getByLabel('Tone', { exact: true }).selectOption('narrative')
    await reload(currentTarget('v2')); await page.getByRole('alert').filter({ hasText: 'The result changed' }).waitFor()
    assert.equal(await input().inputValue(), 'Unsaved polling draft'); assert.equal(await page.getByLabel('Tone', { exact: true }).inputValue(), 'narrative')
    assert.equal(await save().isDisabled(), true)
    await confirmVersion(); await save().click(); await rates(1)
    assert.deepEqual(await page.evaluate(() => ({ revision: feedbackTest.rates[0].args.revision, note: feedbackTest.rates[0].args.note, choices: feedbackTest.rates[0].args.choices })), { revision: 'v2', note: 'Unsaved polling draft', choices: { tone: 'narrative' } })
    await page.evaluate(() => feedbackTest.reply(0)); await page.getByRole('status').filter({ hasText: 'Saved; preferences recalculated' }).waitFor()

    await start(true); await page.getByText('The saved rating refers to an earlier version.', { exact: true }).waitFor()
    assert.equal(await page.getByRole('radio', { name: '3', exact: true }).isChecked(), true)
    assert.equal(await save().isDisabled(), true)
    await confirmVersion(); await input().fill('Newer opinion'); await save().click(); await rates(1)
    await input().fill('Still typing while saving'); await page.evaluate(() => feedbackTest.reply(0))
    await page.getByRole('status').filter({ hasText: 'Draft not saved' }).waitFor()
    assert.equal(await input().inputValue(), 'Still typing while saving')
    await save().click(); await rates(2)
    assert.equal(await page.evaluate(() => feedbackTest.rates[1].args.note), 'Still typing while saving')
    await page.evaluate(() => feedbackTest.reply(1)); await page.getByRole('status').filter({ hasText: 'Saved; preferences recalculated' }).waitFor()

    await start(); await type('Do not switch me to final')
    await reload({ targets: [{ stage: '$final', title: 'Final result', revision: 'f1' }, ...currentTarget('v1').targets] })
    await page.waitForFunction(() => document.querySelector('select option[value="$final"]'))
    assert.equal(await page.getByLabel('Review target', { exact: true }).inputValue(), 'research')
    assert.equal(await input().inputValue(), 'Do not switch me to final')
    await reload({ targets: [] }); await page.getByRole('alert').filter({ hasText: 'not currently reviewable' }).waitFor()
    assert.equal(await input().inputValue(), 'Do not switch me to final'); assert.equal(await save().isDisabled(), true)
    await reload(currentTarget('v3')); await page.getByRole('alert').filter({ hasText: 'The result changed' }).waitFor()

    await start(); await type('Keep after rejected save'); await save().click(); await rates(1)
    await page.evaluate(() => { feedbackTest.docs.r1.targets[0].revision = 'v2'; feedbackTest.reply(0, true) })
    await page.getByRole('alert').filter({ hasText: 'The result changed.' }).waitFor()
    assert.equal(await input().inputValue(), 'Keep after rejected save'); assert.equal(await save().isDisabled(), true)

    await start(true); await confirmVersion(); await type('Local draft during remote correction')
    await page.evaluate(() => { feedbackTest.docs.r1.feedback = [{ id: 'remote', run: 'r1', stage: 'research', revision: 'v1', score: 2, note: 'Remote opinion', choices: {} }]; feedbackTest.docs.r1.profile.revision++; feedbackTest.reload() })
    await page.getByRole('alert').filter({ hasText: 'changed elsewhere' }).waitFor()
    assert.equal(await input().inputValue(), 'Local draft during remote correction')
    page.once('dialog', d => d.dismiss()); await page.getByRole('button', { name: 'Load saved rating', exact: true }).click()
    assert.equal(await input().inputValue(), 'Local draft during remote correction')
    page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Load saved rating', exact: true }).click()
    assert.equal(await input().inputValue(), 'Remote opinion')
    await page.getByText('Rating history (retractable)', { exact: true }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click(); await page.getByRole('button', { name: 'Click again to delete', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('textarea')?.value === '')

    await start(); await type('Keep on cancelled navigation')
    page.once('dialog', d => d.dismiss()); await page.getByLabel('Run', { exact: true }).selectOption('r2')
    assert.equal(await input().inputValue(), 'Keep on cancelled navigation'); assert.equal(await page.getByLabel('Run', { exact: true }).inputValue(), 'r1')
    page.once('dialog', d => d.accept()); await page.getByLabel('Run', { exact: true }).selectOption('r2')
    await page.waitForFunction(() => document.querySelector('textarea')?.value === '')

    await start(); await page.evaluate(() => { feedbackTest.hold = true; feedbackTest.docs.r1.targets[0].revision = 'old'; feedbackTest.reload() })
    await page.waitForFunction(() => feedbackTest.held.length === 1)
    await page.evaluate(() => { feedbackTest.docs.r1.targets[0].revision = 'new'; feedbackTest.reload() })
    await page.waitForFunction(() => feedbackTest.held.length === 2)
    await page.evaluate(() => feedbackTest.answerRead(1)); await page.getByRole('alert').filter({ hasText: 'The result changed' }).waitFor()
    await confirmVersion(); await page.evaluate(() => feedbackTest.answerRead(0)); await type('Latest reply only'); await save().click(); await rates(1)
    assert.equal(await page.evaluate(() => feedbackTest.rates[0].args.revision), 'new')

    await start()
    await page.evaluate(() => {
      const d = feedbackTest.docs
      d.r1.options.detail = { label: { en: 'Detail' }, values: { concise: 'Concise' } }
      d.r1.profile.workflow = 'newsletter.issue'
      d.r2.options = { ...d.r1.options, pacing: { label: { en: 'Pacing' }, values: { brisk: 'Brisk' } }, captions: { label: { en: 'Captions' }, values: { minimal: 'Minimal' } } }
      d.r2.profile.workflow = 'video.edit'
      d[''].profile.sampleCount = 2
      feedbackTest.reload()
    })
    await page.getByText('Scoped to workflow: newsletter.issue', { exact: true }).waitFor()
    await page.getByText('Preferences for next time (optional)', { exact: true }).click()
    assert.equal(await page.getByLabel('Detail', { exact: true }).count(), 1)
    assert.equal(await page.getByLabel('Pacing', { exact: true }).count(), 0)
    assert.equal(await page.getByLabel('Sources', { exact: true }).count(), 0)
    assert.equal(await page.getByText('For video, enable', { exact: false }).count(), 0)
    await page.getByLabel('Run', { exact: true }).selectOption('r2')
    await page.getByText('Scoped to workflow: video.edit', { exact: true }).waitFor()
    await page.getByText('Preferences for next time (optional)', { exact: true }).click()
    assert.equal(await page.getByLabel('Pacing', { exact: true }).count(), 1)
    assert.equal(await page.getByLabel('Captions', { exact: true }).count(), 1)
    await page.getByText('For video, enable', { exact: false }).waitFor()
    await page.getByLabel('Run', { exact: true }).selectOption('')
    await page.getByText('Choose a run to view its workflow’s preferences; feedback from different workflows is kept separate.', { exact: true }).waitFor()
    assert.deepEqual(errors, [], 'real React components rendered without browser errors')
    console.log('feedback UI check: ok (8 browser scenarios; real components, deferred HTTP replies)')
  } catch (err) { console.error('Browser diagnostics:', errors, await page.locator('body').innerText()); throw err }
  finally { await browser.close() }
}
