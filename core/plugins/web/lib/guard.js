// Fetching a page an agent named, safely (docs/design/search.md): only http(s), never this machine, its network, or a
// cloud's metadata address. The check is on the address actually connected to (the lookup the connection uses), so a name
// that resolves to a private address — or changes to one between a check and the connection — is refused; each
// redirect is a new request checked the same way. A size and a time limit; the agent never chooses either.
import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

const fail = (code, message) => Object.assign(new Error(message), { code })
const MAX_REDIRECTS = 5, MAX_BYTES = 4_000_000

/** An address no fetch for an agent may reach: loopback, private, link-local (the metadata service), CGNAT, multicast, unspecified. */
export function blockedAddress(ip) {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (v === 6) {
    const s = new URL(`http://[${ip.split('%')[0]}]/`).hostname.slice(1, -1)
    // Block IPv4-mapped and compatible ranges too, in every spelling the URL parser accepts.
    return s === '::' || /^::(?:ffff:)?[\da-f]{1,4}(?::[\da-f]{1,4})?$/.test(s) || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('100::')
  }
  return true
}
/** A name that is this machine's or a private network's by its look alone. */
const blockedName = host => /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host) || host === ''

/** A URL an agent may fetch: http(s), no credentials in it, a host that is not private. → the URL (throws WEB_FETCH_BLOCKED) */
export function checkUrl(raw) {
  let u
  try { u = new URL(raw) } catch { throw fail('WEB_FETCH_INVALID_URL', `not a web address: ${String(raw).slice(0, 200)}`) }
  if (!['http:', 'https:'].includes(u.protocol)) throw fail('WEB_FETCH_BLOCKED', `only http(s) addresses (${u.protocol})`)
  if (u.username || u.password) throw fail('WEB_FETCH_BLOCKED', 'an address with a user name or password in it')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (blockedName(host) || (isIP(host) && blockedAddress(host))) throw fail('WEB_FETCH_BLOCKED', `${host} is this machine or a private network`)
  return u
}
/** The connection's own lookup: every address it would use, checked. */
const safeLookup = (hostname, options, cb) => dnsLookup(hostname, { ...options, all: true }, (err, list) => {
  if (err) return cb(err)
  const bad = list.find(a => blockedAddress(a.address))
  if (bad) return cb(fail('WEB_FETCH_BLOCKED', `${hostname} resolves to ${bad.address}, a private address`))
  if (options?.all) return cb(null, list)
  cb(null, list[0].address, list[0].family)
})

function once(u, { headers = {}, signal }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request(u, { method: 'GET', headers, lookup: safeLookup, signal, timeout: 20000 }, res => {
      const chunks = []
      let size = 0
      res.on('data', c => { size += c.length; if (size <= MAX_BYTES) chunks.push(c); else res.destroy() })
      res.on('close', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), cut: size > MAX_BYTES }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(fail('WEB_FETCH_TIMEOUT', 'the page did not answer in time')))
    req.on('error', reject)
    req.end()
  })
}

/** GET a page an agent named, safely; redirects followed and checked hop by hop. → a small Response-like object */
export async function guardedFetch(raw, { headers, signal } = {}) {
  let u = checkUrl(raw)
  for (let hop = 0; ; hop++) {
    const r = await once(u, { headers, signal })
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      if (hop >= MAX_REDIRECTS) throw fail('WEB_FETCH_REDIRECTS', 'too many redirects')
      u = checkUrl(new URL(r.headers.location, u).href)
      continue
    }
    return {
      status: r.status, url: u.href, ok: r.status >= 200 && r.status < 300, truncated: r.cut,
      headers: { get: k => { const v = r.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null } },
      arrayBuffer: async () => r.body, text: async () => r.body.toString('utf8'),
    }
  }
}
