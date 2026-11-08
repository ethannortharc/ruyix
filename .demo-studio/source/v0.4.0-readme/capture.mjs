// The README captures of one language, from a demo Ruyix in a throwaway home (seed.mjs + seed2.mjs ran there):
// three stills (hero, run, review) at 1600×1000 CSS px ×2, and two clips recorded as video (customize, maps).
//   node capture.mjs <en|zh> <out-dir> [only=hero,run,review,customize,maps]
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { HOMES, open, setDesk, sleep } from './lib.mjs'

const [lang = 'en', out, onlyArg] = process.argv.slice(2)
const only = new Set((onlyArg || 'hero,run,review,customize,maps').split(','))
mkdirSync(out, { recursive: true })
const REPO = process.env.RUYIX_SRC || new URL('../../..', import.meta.url).pathname
const RUNS = { review: process.env.REVIEW_RUN }
if (!RUNS.review) throw new Error('REVIEW_RUN: the id of the run seed2.mjs left at its review (its "now")')
const W = { en: { decide: 'Decide', openReview: 'Open the review', apply: 'Apply', discard: 'Discard', process: 'Process', summary: 'Switch to the Far hills theme' },
  zh: { decide: '去决定', openReview: '打开审阅', apply: '应用', discard: '放弃', process: '过程', summary: '换成古风主题「远山」' } }[lang]
const MOON = { mode: 'desktop', theme: 'moonlit', wallpaper: 'moonlit', accent: 'amber', tint: 'cool', corners: 'small' }

/** A pointer drawn on the page (a recording does not show the system's): follows the mouse, pulses on a click. */
const POINTER = () => {
  const el = document.createElement('div')
  el.id = 'demo-pointer'
  el.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-2.6 1.1-2.9-6.5L5 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  Object.assign(el.style, { position: 'fixed', left: '-40px', top: '-40px', zIndex: 2147483647, pointerEvents: 'none', transition: 'transform .12s', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' })
  document.documentElement.appendChild(el)
  addEventListener('mousemove', e => { el.style.left = `${e.clientX - 3}px`; el.style.top = `${e.clientY - 2}px` }, true)
  addEventListener('mousedown', () => { el.style.transform = 'scale(.82)' }, true)
  addEventListener('mouseup', () => { el.style.transform = '' }, true)
}

const closeWindows = async page => { for (const b of await page.locator('.ad-win .ad-c').all()) await b.click().catch(() => {}); await sleep(700) }
const goTo = async (page, detail, wait = 2500) => { await page.evaluate(d => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: d })), detail); await sleep(wait) }
const zoom = async page => { await page.locator('.ad-win .ad-z').first().click().catch(() => {}); await sleep(1200) }
const glide = async (page, box, steps = 28) => { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps }) }

// ── stills ──
if (['hero', 'run', 'review'].some(k => only.has(k))) {
  setDesk(lang, MOON)
  const { browser, page } = await open(lang)
  await page.emulateMedia({ colorScheme: 'dark' })
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: W.discard, exact: true }).first(); if (!(await b.count())) break; await b.click().catch(() => {}); await sleep(900) }
  await sleep(3500) // (the "discarded" note goes away)
  if (only.has('hero')) {
    await closeWindows(page); await page.mouse.move(800, 980); await sleep(4000)
    await page.screenshot({ path: join(out, 'hero.png') }); console.log('hero')
  }
  if (only.has('run')) {
    await goTo(page, { panel: 'ruyix-tasks', run: RUNS.review }); await zoom(page)
    await page.getByRole('tab', { name: W.process }).or(page.getByRole('button', { name: W.process, exact: true })).first().click().catch(e => console.log('process tab:', e.message.slice(0, 80)))
    await sleep(2500); await page.mouse.move(5, 995)
    await page.screenshot({ path: join(out, 'run.png') }); console.log('run')
  }
  if (only.has('review')) {
    await goTo(page, { panel: 'ruyix-tasks', run: RUNS.review })
    await page.getByRole('button', { name: W.decide }).first().click().catch(e => console.log('decide:', e.message.slice(0, 80)))
    await sleep(1500)
    await page.getByRole('button', { name: W.openReview }).first().click().catch(e => console.log('open review:', e.message.slice(0, 80)))
    await sleep(3000); await page.mouse.move(5, 995)
    await page.screenshot({ path: join(out, 'review.png') }); console.log('review')
  }
  await browser.close()
}

// ── clips: a video each, the pointer drawn ──
async function clip(name, body) {
  const dir = join(out, `${name}-video`)
  rmSync(dir, { recursive: true, force: true })
  const { browser, context, page } = await open(lang, { scale: 1, video: dir })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(POINTER)
  await body(page)
  await context.close(); await browser.close()
  const [webm] = readdirSync(dir).filter(f => f.endsWith('.webm'))
  renameSync(join(dir, webm), join(out, `${name}.webm`)); rmSync(dir, { recursive: true, force: true })
  console.log(name)
}

if (only.has('customize')) {
  setDesk(lang, MOON)
  await clip('customize', async page => {
    await closeWindows(page)
    for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: W.discard, exact: true }).first(); if (!(await b.count())) break; await b.click().catch(() => {}); await sleep(900) }
    await page.mouse.move(700, 600); await sleep(2500)
    // what a CLI agent runs to propose it (the person applies it on the page)
    execFileSync('node', ['core/shell/bin/ruyix-desk.mjs', 'theme', 'hills', '--summary', W.summary], { cwd: REPO, env: { ...process.env, HOME: HOMES[lang].home }, encoding: 'utf8' })
    const apply = page.getByRole('button', { name: W.apply, exact: true }).first()
    await apply.waitFor({ timeout: 15000 }); await sleep(2200)
    await glide(page, await apply.boundingBox()); await sleep(600)
    await apply.click(); await sleep(400); await page.mouse.move(700, 600, { steps: 30 }); await sleep(4500)
  })
}

if (only.has('maps')) {
  setDesk(lang, { ...MOON, mode: 'world', world: 'atlas' })
  await clip('maps', async page => {
    await closeWindows(page); await page.mouse.move(800, 990); await sleep(5000)
    for (const w of ['sky', 'future']) { setDesk(lang, { mode: 'world', world: w }); await sleep(7000) }
  })
  setDesk(lang, MOON)
}
