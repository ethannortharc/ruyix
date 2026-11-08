// Shared helpers for the README captures: a signed-in page on a demo Ruyix (a throwaway home), DSH's key prompt put
// aside, desktop.json written in that home (the page reads it again every 3 s).
//   DEMO_DIR        where the demo homes and sign-in links are (see ../../runbook.md)
//   PLAYWRIGHT_DIR  a folder whose node_modules has playwright (and its Chromium installed)
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

for (const v of ['DEMO_DIR', 'PLAYWRIGHT_DIR']) if (!process.env[v]) throw new Error(`${v} is not set (see .demo-studio/runbook.md)`)
const require = createRequire(`${process.env.PLAYWRIGHT_DIR}/`)
export const { chromium } = require('playwright')
export const S = process.env.DEMO_DIR
export const HOMES = { en: { home: `${S}/home-en`, link: `${S}/link-en.txt`, locale: 'en-US' }, zh: { home: `${S}/home-zh`, link: `${S}/link-zh.txt`, locale: 'zh-CN' } }
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export function setDesk(lang, patch) {
  const f = `${HOMES[lang].home}/.ruyix/desktop.json`
  let d = {}
  try { d = JSON.parse(readFileSync(f, 'utf8')) } catch {}
  const next = { ...d, ...patch }
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k]
  writeFileSync(f, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return next
}

export async function open(lang, { width = 1600, height = 1000, scale = 2, video = null } = {}) {
  const h = HOMES[lang]
  const link = readFileSync(h.link, 'utf8').trim()
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] })
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: scale, locale: h.locale, timezoneId: 'America/Los_Angeles',
    ...(video && { recordVideo: { dir: video, size: { width, height } } }),
  })
  const page = await context.newPage()
  page.on('pageerror', e => console.log('pageerror:', e.message.slice(0, 160)))
  await page.goto(link, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  await dismissKeyPrompt(page)
  return { browser, context, page, origin: new URL(link).origin }
}

/** DSH's own "Add an API key" prompt (a fresh home has no model key): "Configure later". */
export async function dismissKeyPrompt(page) {
  for (const name of ['Configure later', '稍后配置']) {
    const b = page.getByRole('button', { name, exact: true })
    if (await b.count()) { await b.first().click().catch(() => {}); await page.waitForTimeout(500) }
  }
}
