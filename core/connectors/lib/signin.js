// Signing in to a site through a browser this machine runs, shown in the panel: screenshots go up, clicks and keys come
// down, so SAML, MFA and whatever else the site asks for work from any browser that opens dsh — on a host, in a
// nookbox box, over Tailscale. When the site's session appears, what the connection's type keeps of it (the cookies a
// browser would send, the user it shows) goes to that connection — when the type cannot tell the session is there
// (`manual`), the person says so ("done" input) once signed in. A site that signs in by OAuth (a redirect to the app's
// own callback address) gets that redirect caught: the browser is never sent there, the full address goes to the type.
// One sign-in at a time; it ends by itself after 10 minutes.
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const fail = (code, params, message) => Object.assign(new Error(message), { code, params })
const VIEW = { width: 1100, height: 720 }
const TICK_MS = 400
const LIMIT_MS = 10 * 60e3
const CAUGHT = '<!doctype html><meta charset="utf-8"><title>OK</title><body style="font:16px system-ui;margin:48px;color:#333"><p>Authorized — you can close this window.</p><p>已授权，可以关闭。</p>'
const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

// The CAs Node is told to trust (a nookbox box's gateway, a company's TLS inspection) the browser trusts too: Chromium
// keeps its own list, so their keys go on its command line.
export function extraCaArgs(file = process.env.NODE_EXTRA_CA_CERTS) {
  try {
    const keys = (readFileSync(file, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [])
      .map(pem => createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'))
    return keys.length ? [`--ignore-certificate-errors-spki-list=${keys.join(',')}`] : []
  } catch { return [] }
}

/**
 * runtimeDir: where Playwright is installed (the workbench's UI runtime); home: the profile directories (a site's SSO
 * remembered between sign-ins); save(key, kept): stores what a site keeps for that connection.
 */
export function createSignin({ runtimeDir, home, save, log = () => {}, forget = false }) {
  let s = null // the current sign-in
  const load = () => {
    try { return createRequire(join(runtimeDir, 'package.json'))('playwright') } catch {
      throw fail('noBrowser', {}, 'the browser for sign-ins is not installed here: run ruyix setup (it installs Playwright and Chromium)')
    }
  }
  const owns = owner => !owner || (s?.key === owner.id && s.attempt === owner.attempt)
  const finish = (cur, status, extra = {}) => {
    if (!cur || cur.status !== 'running') return cur?.closing
    Object.assign(cur, { status, ...extra })
    clearTimeout(cur.timer)
    cur.closing = (async () => {
      try { await cur.context?.close() } catch { /* gone already */ }
      // A box keeps sessions in the host vault; finish removing this profile before a new start uses it.
      try { if (forget) rmSync(join(home, cur.key), { recursive: true, force: true }) } finally { cur.closing = null }
    })()
    return cur.closing
  }
  /** A new frame of the page as it is now. */
  const snap = async cur => {
    cur.frame = `data:image/jpeg;base64,${(await cur.page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64')}`
    // the callback address carries the authorization code: the panel shows where it points, not the code
    const now = cur.page.url()
    cur.url = cur.intercept && now.startsWith(cur.intercept) ? cur.intercept : now
    cur.seq++
  }
  const loop = async cur => {
    while (s === cur && cur.status === 'running') {
      try {
        await snap(cur)
        const cookies = await cur.context.cookies(cur.base)
        if (s !== cur || cur.status !== 'running') return
        const extra = { callbackUrl: cur.callbackUrl || '', state: cur.state }
        if (cur.done && cookies.length || cur.site.ready(cur.url, cookies, cur.base, extra)) {
          let values
          // a type that cannot keep what it was given (a refused authorization, a code the site would not take) says why:
          // the sign-in ends as failed, with a message that holds no token
          try { values = await cur.site.keep(cookies, await cur.page.content().catch(() => ''), extra) } catch (err) {
            log(`sign-in to ${new URL(cur.base).host} failed: ${err?.message || err}`)
            await finish(cur, 'failed', { error: String(err?.message || err) })
            return
          }
          if (s !== cur || cur.status !== 'running') return
          // signed in, but the session could not be kept (a box's vault refused it): say so, do not sign in again
          try { await save(cur.key, values, cur.ticket) } catch (err) {
            log(`signed in to ${new URL(cur.base).host}, but the session was not kept: ${err?.message || err}`)
            await finish(cur, 'failed', { error: `signed in, but the session could not be kept: ${err?.message || err}` })
            return
          }
          const kept = [...Object.keys(values.slots || {}), ...Object.keys(values.fields || {})]
          log(`signed in to ${new URL(cur.base).host}; kept ${kept.join(', ')}`)
          await finish(cur, 'done', { kept })
          return
        }
      } catch (err) {
        if (cur.status === 'running' && cur.page.isClosed()) await finish(cur, 'failed', { error: 'the browser closed' })
        else if (cur.status === 'running') log(`sign-in: ${err?.message || err}`)
      }
      await new Promise(r => setTimeout(r, TICK_MS))
    }
  }
  return {
    /**
     * key: the connection; base: the target API URL whose cookies may be kept; url: its sign-in entry; site: its type's { ready, keep, manual?, intercept? }.
     * begun: what the type's `begin` made — { url?, state? }: the address to open instead of base, and the sign-in's
     * private state (kept here, given to `ready` and `keep`, never shown); intercept: the callback address prefix to catch.
     * prepare(): builds {base, url, site, ticket, intercept} only after taking the browser slot.
     */
    async start(key, base, site, { url, state, attempt, ticket, prepare, intercept = typeof site?.intercept === 'string' ? site.intercept : '' } = {}) {
      if (!site && !prepare) throw fail('noSignin', { key }, `${key} has no sign-in`)
      if (s?.closing) await s.closing
      if (s?.status === 'running' || s?.status === 'starting') throw fail('signinBusy', {}, 'a sign-in is open already')
      const { chromium } = load()
      // the place is taken before anything is awaited: a second start (a double click) finds this one and is refused
      const cur = s = { key, site, base, attempt, ticket, status: 'starting', frame: '', url: url || base, seq: 0, startedAt: Date.now(), state, intercept, callbackUrl: '' }
      const dir = join(home, key)
      let context, page
      try {
        // Admission happens before prepare: a refused start must not invalidate the active credential ticket.
        cur.launching = (async () => {
          if (prepare) {
            const begun = await prepare()
            Object.assign(cur, { site: begun.site, base: begun.base, url: begun.url || begun.base, ticket: begun.ticket, intercept: begun.intercept || '' })
            intercept = cur.intercept
          }
          if (cur.status !== 'starting') return null
          if (!cur.site) throw fail('noSignin', { key }, `${key} has no sign-in`)
          mkdirSync(dir, { recursive: true })
          const opts = { headless: true, viewport: VIEW, deviceScaleFactor: 1, locale: 'en-US', args: extraCaArgs() }
          // the full browser's headless mode where there is one: a site's sign-in treats it like any Chrome
          return chromium.launchPersistentContext(dir, { ...opts, channel: 'chromium' }).catch(() => chromium.launchPersistentContext(dir, opts))
        })()
        context = await cur.launching
        if (cur.status !== 'starting') { await cur.closing; return { status: cur.status, view: VIEW } }
        page = context.pages()[0] || await context.newPage()
      } catch (err) {
        if (cur.status !== 'starting') { await cur.closing; return { status: cur.status, view: VIEW } }
        Object.assign(cur, { status: 'failed', error: String(err?.message || err) })
        await context?.close().catch(() => {})
        throw err
      }
      // stopped while the browser was starting: it is not kept
      if (cur.status !== 'starting') { await cur.closing; return { status: cur.status, view: VIEW } }
      Object.assign(cur, { context, page, status: 'running' })
      cur.timer = setTimeout(() => finish(cur, 'timeout'), LIMIT_MS)
      if (intercept) {
        // The redirect to the app's callback address is answered here and never requested (nothing may spend the code).
        // Chromium's own request interception, not Playwright's `route`: that does not see a redirect (a 302 from the
        // site's authorize step lands on the callback address without it).
        const pattern = `${intercept.replace(/[\\*?]/g, '\\$&')}*`
        const hook = async pg => {
          const cdp = await context.newCDPSession(pg)
          cdp.on('Fetch.requestPaused', e => {
            const nav = e.resourceType === 'Document'
            if (nav) cur.callbackUrl ||= e.request.url
            cdp.send('Fetch.fulfillRequest', nav
              ? { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }], body: Buffer.from(CAUGHT).toString('base64') }
              : { requestId: e.requestId, responseCode: 204 }).catch(() => {})
          })
          await cdp.send('Fetch.enable', { patterns: [{ urlPattern: pattern, requestStage: 'Request' }] })
        }
        context.on('page', pg => hook(pg).catch(() => {}))
        await hook(page).catch(err => finish(cur, 'failed', { error: `the browser could not be set up: ${err?.message || err}` }))
        if (cur.status !== 'running') return { status: cur.status, view: VIEW }
      }
      page.on('close', () => finish(cur, 'failed', { error: 'the browser closed' }))
      page.goto(cur.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => log(`sign-in: ${err?.message || err}`))
      loop(cur)
      return { status: cur.status, view: VIEW }
    },
    /** What the panel shows; the frame only when it is newer than the one the panel has. */
    state({ since = -1, id, attempt } = {}) {
      if ((id !== undefined || attempt !== undefined) && !owns({ id, attempt })) return { status: 'idle' }
      if (!s) return { status: 'idle' }
      return { key: s.key, status: s.status, url: s.url, seq: s.seq, view: VIEW, error: s.error, kept: s.kept, manual: !!s.site?.manual, ...(s.seq > since && { frame: s.frame }) }
    },
    async input({ type, x, y, key, text, dy, id, attempt }) {
      if (((id !== undefined || attempt !== undefined) && !owns({ id, attempt })) || s?.status !== 'running') throw fail('noSignin', {}, 'no sign-in is open')
      const cur = s
      const m = cur.page.mouse, k = cur.page.keyboard
      const at = v => Math.max(0, Math.min(Number(v) || 0, 4000))
      if (type === 'click') await m.click(at(x), at(y))
      else if (type === 'wheel') { await m.move(at(x), at(y)); await m.wheel(0, Math.max(-2000, Math.min(Number(dy) || 0, 2000))) }
      else if (type === 'key' && KEYS.has(key)) await k.press(key)
      else if (type === 'text' && typeof text === 'string') await k.type(text.slice(0, 2000))
      else if (type === 'back') await cur.page.goBack().catch(() => null)
      else if (type === 'done' && cur.site.manual) cur.done = true // the person says the session is there
      else throw fail('badInput', {}, 'unknown input')
      // the frame right away: what was typed shows without waiting for the next round
      await snap(cur).catch(() => {})
      return { ok: true, seq: cur.seq, url: cur.url, frame: cur.frame }
    },
    async stop(owner) {
      if (!owns(owner)) return { status: 'idle' }
      const cur = s
      if (cur?.status === 'starting') {
        cur.status = 'cancelled'
        cur.closing = (async () => {
          try { const context = await cur.launching; await context?.close() } catch { /* launch failed or already closed */ }
          try { if (forget) rmSync(join(home, cur.key), { recursive: true, force: true }) } finally { cur.closing = null }
        })()
        await cur.closing
      }
      else await finish(cur, 'cancelled')
      return { status: s?.status || 'idle' }
    },
  }
}
