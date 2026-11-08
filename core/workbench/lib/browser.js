// A browser a run uses that the person can watch and take over: a step or an approved card opens it (a site's session
// handed in as cookies), drives it (Playwright's page), and the run's page shows it live — screenshots go up, clicks and
// keys come down — so the person checks what was filled in and does the last click themselves (a site's own "publish"),
// on a host, in a nookbox box or over Tailscale. Each is a run's; it closes when told, when the run's page closes it, or
// after an hour of nobody touching it. Its frames are not kept; a moment worth keeping goes into the ledger (`shot`).
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const fail = (code, params, message) => Object.assign(new Error(message), { code, params })
export const VIEW = { width: 1280, height: 860 }
const TICK_MS = 500
const IDLE_MS = 60 * 60e3
const MAX_OPEN = 3
const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

// The CAs Node is told to trust (a nookbox box's gateway) the browser trusts too: Chromium keeps its own list.
function extraCaArgs(file = process.env.NODE_EXTRA_CA_CERTS) {
  try {
    const keys = (readFileSync(file, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [])
      .map(pem => createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'))
    return keys.length ? [`--ignore-certificate-errors-spki-list=${keys.join(',')}`] : []
  } catch { return [] }
}

/** Cookies as a site gave them (Playwright's, a browser export's) → what a new context takes: the fields it knows, the rest left out. */
export function cookiesFor(list, url) {
  const host = url ? new URL(url).hostname : ''
  return (Array.isArray(list) ? list : []).filter(c => c && typeof c.name === 'string' && typeof c.value === 'string').map(c => {
    const out = { name: c.name, value: c.value, path: c.path || '/' }
    if (c.domain) out.domain = c.domain; else out.url = url || `https://${host}/`
    if (Number.isFinite(c.expires) && c.expires > 0) out.expires = c.expires
    if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly
    if (typeof c.secure === 'boolean') out.secure = c.secure
    if (['Strict', 'Lax', 'None'].includes(c.sameSite)) out.sameSite = c.sameSite
    return out
  })
}

/**
 * runtimeDir: where Playwright is (the workbench's UI runtime); load: Playwright itself (a check hands in a fake);
 * record(runId, entry): a ledger entry (a shot). Sessions: { id, run, stage, title, status, url, seq, frame, … }.
 */
export function createBrowsers({ runtimeDir, load, record = () => {}, logger = null } = {}) {
  const sessions = new Map()
  let renders = 0
  let renderer = null, rendererIdle = null // one headless browser for render(), closed after two quiet minutes
  const playwright = () => {
    if (load) return load()
    try { return createRequire(join(runtimeDir, 'package.json'))('playwright') } catch {
      throw fail('noBrowser', {}, 'the browser is not installed here: run ruyix setup (it installs Playwright and Chromium)')
    }
  }
  const snap = async s => {
    s.frame = `data:image/jpeg;base64,${(await s.page.screenshot({ type: 'jpeg', quality: 62 })).toString('base64')}`
    s.url = s.page.url()
    s.seq++
  }
  const close = async (s, status = 'closed', why = '') => {
    if (!s || ['closed', 'failed'].includes(s.status)) return
    s.status = status
    if (why) s.note = why
    clearInterval(s.timer)
    try { await s.context?.close() } catch { /* gone already */ }
    try { await s.browser?.close() } catch { /* gone already */ }
    s.endedAt = Date.now()
    s.onClose?.(s)
  }
  const tick = async s => {
    if (s.status !== 'open' || s.busy) return
    if (Date.now() - s.touched > IDLE_MS) return close(s, 'closed', 'nobody looked at it for an hour')
    s.busy = true
    try { await snap(s); await s.watch?.(s) } catch (err) { if (s.page?.isClosed()) await close(s, 'closed', 'the page closed'); else logger?.debug?.(`browser ${s.id}: ${err?.message || err}`) } finally { s.busy = false }
  }
  const view = s => ({ id: s.id, run: s.run, stage: s.stage, title: s.title, status: s.status, url: s.url, seq: s.seq, view: VIEW, note: s.note || '', step: s.step || '', openedAt: s.openedAt, endedAt: s.endedAt || null, done: s.done || null })

  const browsers = {
    /**
     * Open one for a run: { run, stage, title, url, cookies? (a site's session), watch?(session) (each tick, e.g. "the
     * page left the form": it may set session.done) } → { id, page, context, session }. At most three open at a time.
     */
    async open({ run, stage = 'approval', title = '', url = 'about:blank', cookies = [], watch } = {}) {
      if ([...sessions.values()].filter(s => ['starting', 'open'].includes(s.status)).length >= MAX_OPEN) throw fail('browserBusy', {}, 'three browsers are open already: close one first')
      const { chromium } = playwright()
      const s = { id: `b${randomUUID().slice(0, 8)}`, run, stage, title: String(title).slice(0, 200), status: 'starting', url, seq: 0, frame: '', openedAt: Date.now(), touched: Date.now(), watch }
      sessions.set(s.id, s)
      const starting = () => { if (s.status !== 'starting') throw fail('noBrowser', {}, 'this browser was closed while starting') }
      try {
        const opts = { headless: true, args: extraCaArgs() }
        s.browser = await chromium.launch({ ...opts, channel: 'chromium' }).catch(() => chromium.launch(opts))
        starting()
        s.context = await s.browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, locale: 'zh-CN' })
        starting()
        if (cookies.length) await s.context.addCookies(cookiesFor(cookies, url))
        starting()
        s.page = await s.context.newPage()
        starting()
      } catch (err) {
        // close() may already have run before launch returned: dispose the handles acquired later too.
        await s.context?.close().catch(() => {})
        await s.browser?.close().catch(() => {})
        await close(s, 'failed', String(err?.message || err))
        throw err
      }
      s.status = 'open'
      s.page.on('close', () => close(s, 'closed', 'the page closed'))
      if (url && url !== 'about:blank') await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => { s.note = `could not open ${url}: ${err?.message || err}` })
      if (s.status !== 'open') throw fail('noBrowser', {}, 'this browser was closed')
      s.timer = setInterval(() => tick(s), TICK_MS)
      await snap(s).catch(() => {})
      return { id: s.id, page: s.page, context: s.context, session: s }
    },
    /** What the page shows of one: the frame only when newer than `since`. */
    state(id, { since = -1 } = {}) {
      const s = sessions.get(String(id))
      if (!s) throw fail('noBrowser', { id }, 'this browser is not open any more')
      s.touched = Date.now() // someone is watching it: it stays open
      return { ...view(s), ...(s.seq > since && s.frame && { frame: s.frame }) }
    },
    /** A run's browsers (open ones first). */
    list: run => [...sessions.values()].filter(s => !run || s.run === run).map(view).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.openedAt - a.openedAt),
    /** The person's click, scroll, key or text. */
    async input(id, { type, x, y, key, text, dy }) {
      const s = sessions.get(String(id))
      if (s?.status !== 'open') throw fail('noBrowser', { id }, 'this browser is not open any more')
      s.touched = Date.now()
      const m = s.page.mouse, k = s.page.keyboard
      const at = v => Math.max(0, Math.min(Number(v) || 0, 4000))
      if (type === 'click') await m.click(at(x), at(y))
      else if (type === 'wheel') { await m.move(at(x), at(y)); await m.wheel(0, Math.max(-2000, Math.min(Number(dy) || 0, 2000))) }
      else if (type === 'key' && KEYS.has(key)) await k.press(key)
      else if (type === 'text' && typeof text === 'string') await k.type(text.slice(0, 2000))
      else if (type === 'back') await s.page.goBack().catch(() => null)
      else if (type === 'reload') await s.page.reload().catch(() => null)
      else throw fail('badInput', { errors: 'type' }, 'unknown input')
      await snap(s).catch(() => {})
      return { ...view(s), frame: s.frame }
    },
    /** What the page shows now, into the run's ledger (an image the report and the reviewer can see). */
    async shot(id, title) {
      const s = sessions.get(String(id))
      if (s?.status !== 'open') throw fail('noBrowser', { id }, 'this browser is not open any more')
      const png = await s.page.screenshot({ type: 'png' })
      return record(s.run, { stage: s.stage, kind: 'file', actor: 'system', title: String(title || `browser: ${s.title}`).slice(0, 200), input: { url: s.page.url(), browser: s.id }, output: `(screenshot, ${png.length} bytes)`, ok: true, full: png, name: 'browser.png' })
    },
    /** What the browser is doing now, in a line the page shows ("filling in the title"). */
    step(id, text) { const s = sessions.get(String(id)); if (s) s.step = String(text || '').slice(0, 200) },
    async close(id, why = '') { const s = sessions.get(String(id)); if (!s) return { status: 'closed' }; await close(s, 'closed', why); return view(s) },
    /** The agents' shared browser (Chromium's DevTools endpoint, docs/design/browser.md): Playwright on it, to drive a tab of its own. */
    attach: endpoint => playwright().chromium.connectOverCDP(endpoint),
    /** A run that ended or was taken out: its browsers close. */
    async closeRun(run) { for (const s of sessions.values()) if (s.run === run) await close(s, 'closed', 'the run ended') },
    /**
     * A piece of HTML as a PNG (a card, a cover): { html, width, height, scale? } → Buffer. The fonts are the machine's
     * (the box has Noto CJK). Nobody sees it: one shared headless browser, a page each time.
     */
    async render({ html, width, height, scale = 1 }) {
      const w = Math.max(16, Math.min(Number(width) || 0, 4096)), h = Math.max(16, Math.min(Number(height) || 0, 4096))
      clearTimeout(rendererIdle)
      renders++
      let page
      const pending = renderer ||= (async () => { const { chromium } = playwright(); return chromium.launch({ headless: true, channel: 'chromium', args: extraCaArgs() }).catch(() => chromium.launch({ headless: true })) })()
      try {
        let b
        try { b = await pending } catch (err) { if (renderer === pending) renderer = null; throw err }
        page = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: Math.max(1, Math.min(Number(scale) || 1, 3)) })
        await page.setContent(`<!doctype html><meta charset="utf-8">${String(html)}`, { waitUntil: 'load' })
        await page.evaluate(() => document.fonts.ready)
        return await page.screenshot({ type: 'png' })
      } finally {
        await page?.close().catch(() => {})
        clearTimeout(rendererIdle)
        if (--renders === 0 && renderer) rendererIdle = setTimeout(() => { const r = renderer; renderer = null; r?.then(x => x.close()).catch(() => {}) }, 120e3)
      }
    },
    async dispose() {
      for (const s of sessions.values()) await close(s, 'closed', 'dsh stopped')
      clearTimeout(rendererIdle)
      await renderer?.then(x => x.close()).catch(() => {})
      renderer = null
    },
  }
  return browsers
}
