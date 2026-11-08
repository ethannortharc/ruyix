// Actual Results/Viewer controls in React and Chromium; HTTP is a deterministic local fixture. The host Markdown
// primitive is stubbed (this test opens plain text); rendering Markdown is outside these restart checks.
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
if (!runtime || !existsSync(join(reactDir, 'react-dom'))) console.log('results UI check: skipped — React host or Playwright is not installed')
else {
  const req = createRequire(join(realpathSync(join(reactDir, 'react-dom')), 'package.json'))
  const { chromium } = createRequire(join(runtime, 'package.json'))('playwright')
  const { outputFiles } = await build({ stdin: { contents: `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { ResultsTab, useResults } from './src/results.jsx'
    const t = window.resultsTest = { calls: [], saves: [], loads: [], run: { id: 'first', status: 'done' }, data: {
      files: ['result.txt'], comments: [], revision: 'a', steps: [{ key: 'compose', title: 'Compose' }, { key: 'polish', title: 'Polish' }],
      defaultFrom: 'compose', restarts: [], declared: true
    } }
    window.fetch = async (_url, init) => {
      const args = JSON.parse(init.body); t.calls.push(args)
      if (args.op === 'resultsOf') return new Promise(resolve => t.loads.push(data => resolve({ ok: true, json: async () => data })))
      if (args.op === 'fileAt') return { ok: true, json: async () => ({ text: 'Created result', blob: 'a' }) }
      if (args.op === 'resultsSave') return new Promise(resolve => t.saves.push(() => resolve({ ok: true, json: async () => ({ comments: args.comments, revision: 'b' }) })))
      if (args.op === 'resultsRestart') return { ok: true, json: async () => ({ run: t.run }) }
      throw new Error('Unexpected op ' + args.op)
    }
    const app = createRoot(document.getElementById('root'))
    function Loaded({ run }) { const [data, reload] = useResults(run); return <ResultsTab run={run} data={data} reload={reload} track={false} /> }
    t.render = () => app.render(t.hookMode ? <Loaded run={t.run} /> : <ResultsTab run={t.run} data={t.data} reload={() => {}} track={false} />)
    t.render()
  `, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'host-react', setup(b) {
      b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, a => ({ path: req.resolve(a.path) }))
      b.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'markdown', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const MarkdownText = ({text}) => text', loader: 'js' }))
    } }],
  })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage(), errors = []
  page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept())
  const select = () => page.getByLabel('res.goOnFrom', { exact: true })
  const render = fn => page.evaluate(fn)
  try {
    await page.setContent('<div id="root"></div>'); await page.addScriptTag({ content: outputFiles[0].text })
    await select().waitFor(); assert.equal(await select().inputValue(), 'compose', 'API default wins over the last eligible step')
    await page.getByPlaceholder('rv.wholeHint').fill('Shorten the introduction')
    await page.getByRole('button', { name: 'rv.add', exact: true }).click()
    await page.getByRole('button', { name: 'res.restartWith', exact: true }).click()
    await page.waitForFunction(() => resultsTest.saves.length === 1)
    assert.equal(await page.evaluate(() => resultsTest.calls.filter(c => c.op === 'resultsRestart').length), 0, 'restart waits for comment persistence')
    await page.evaluate(() => resultsTest.saves[0]())
    await page.waitForFunction(() => resultsTest.calls.some(c => c.op === 'resultsRestart'))
    assert.deepEqual(await page.evaluate(() => resultsTest.calls.find(c => c.op === 'resultsRestart')), { op: 'resultsRestart', id: 'first', from: 'compose' })
    assert.equal(await page.evaluate(() => resultsTest.calls.find(c => c.op === 'resultsSave').comments[0].text), 'Shorten the introduction')

    await select().selectOption('polish')
    await render(() => { resultsTest.data = { ...resultsTest.data, revision: 'c' }; resultsTest.render() })
    assert.equal(await select().inputValue(), 'polish', 'polling preserves a valid explicit selection')
    await render(() => { resultsTest.run = { id: 'second', status: 'done' }; resultsTest.render() })
    await page.waitForFunction(() => document.querySelector('select').value === 'compose')
    await select().selectOption('polish')
    await render(() => { resultsTest.data = { ...resultsTest.data, steps: [{ key: 'compose', title: 'Compose' }] }; resultsTest.render() })
    await page.waitForFunction(() => document.querySelector('select').value === 'compose')
    await render(() => { resultsTest.run = { id: 'legacy', status: 'done' }; delete resultsTest.data.defaultFrom; resultsTest.data.steps.push({ key: 'last', title: 'Last' }); resultsTest.render() })
    await page.waitForFunction(() => document.querySelector('select').value === 'last')
    await render(() => { resultsTest.hookMode = true; resultsTest.render() })
    await page.waitForFunction(() => resultsTest.loads.length === 1)
    await render(() => resultsTest.loads[0](resultsTest.data)); await select().waitFor()
    await render(() => { resultsTest.run = { id: 'loading-next', status: 'done' }; resultsTest.render() })
    await page.waitForFunction(() => resultsTest.loads.length === 2)
    assert.equal(await select().count(), 0, 'a new run cannot restart with the previous run\'s files, comments or default')
    await render(() => resultsTest.loads[1]({ ...resultsTest.data, defaultFrom: 'compose' }))
    await select().waitFor(); assert.equal(await select().inputValue(), 'compose')
    assert.deepEqual(errors, [])
    console.log('results UI check: ok (default entry, persisted comments, refresh, run change, legacy fallback, loading isolation)')
  } finally { await browser.close() }
}
