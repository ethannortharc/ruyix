// The connectors service: the connections (data, no secrets: ~/.ruyix/connectors/connections.json), their credentials
// (dsh's credential store, one record per connection), and the only ways out — a request client that adds the
// credential itself, a command with exactly the variables it needs, a file for the tools that read one. Nothing else
// in ruyix reads a credential.
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run as defaultRun } from './run.js'
import { TYPES, fieldsOf, slotFor } from './types.js'
import { TARGETS, canShare } from './share.js'
import { DRIVES, isDrive } from './drive.js'
import { exportConnections, secretName } from './export.js'
import { PLACEHOLDER } from './vault.js'
import { READS } from './reads.js'

export const HOME = join(homedir(), '.ruyix/connectors')
export const ID = /^[a-z][a-z0-9-]{0,40}$/
const coded = (code, params, message) => Object.assign(new Error(message), { code, params })
const hostOf = url => { try { return new URL(url).hostname } catch { return '' } }
const write = (file, text, mode = 0o600) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, text, { mode }); renameSync(tmp, file) }

/** The credential store over dsh's: a record `connectors/<id>` holds a connection's slots; a `ref` slot is a dsh reference. */
export function dshCredentials(c) {
  const key = id => `connectors/${id}`
  const slotsOf = r => (r?.kind === 'grant' && r.payload && typeof r.payload.slots === 'object' ? r.payload.slots : {})
  return {
    async get(id) { return { ...slotsOf(await c.readRecord(key(id))) } },
    async set(id, slot, value) { await c.modifyRecord(key(id), async r => ({ kind: 'grant', payload: { slots: { ...slotsOf(r), [slot]: value } } })) },
    async clear(id, slot) {
      const rest = { ...await this.get(id) }
      delete rest[slot]
      if (Object.keys(rest).length) await c.modifyRecord(key(id), async () => ({ kind: 'grant', payload: { slots: rest } }))
      else await c.deleteRecord(key(id))
    },
    remove: id => c.deleteRecord(key(id)),
    getRef: async ref => (await c.resolve(ref))?.value || '',
    setRef: (ref, v) => c.set(ref, v),
    clearRef: ref => c.unset(ref),
  }
}

/** The same store in memory (the self-check; a composition without dsh's credential store). */
export function memoryCredentials() {
  const records = new Map(), refs = new Map()
  return {
    async get(id) { return { ...records.get(id) } },
    async set(id, slot, value) { records.set(id, { ...records.get(id), [slot]: value }) },
    async clear(id, slot) { const r = { ...records.get(id) }; delete r[slot]; records.set(id, r) },
    async remove(id) { records.delete(id) },
    getRef: async ref => refs.get(ref) || '',
    setRef: async (ref, v) => { refs.set(ref, v) },
    clearRef: async ref => { refs.delete(ref) },
  }
}

/** A request body that is not JSON: a form, a blob, bytes. */
const isRaw = body => body instanceof FormData || body instanceof Blob || body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body)

/** The API server a kubeconfig names (its first cluster). */
const serverOf = kubeconfig => kubeconfig.match(/(?:^|[\s{,])server:\s*["']?(https?:\/\/[^\s"',}]+)/m)?.[1]?.replace(/\/+$/, '') || null

export function createConnectors({ home = HOME, creds, run = defaultRun, fetch = globalThis.fetch, now = Date.now, types: builtIn = TYPES, vault = null } = {}) {
  const types = { ...builtIn } // the built-in types, and the ones adapters register
  const file = join(home, 'connections.json')
  const runDir = join(home, 'run')
  const defaultBase = c => {
    const base = c && types[c.type]?.baseUrl?.default
    if (base && !String(c.baseUrl ?? '').trim()) c.baseUrl = String(base).trim().replace(/\/+$/, '')
    return c
  }
  const read = () => { try { const d = JSON.parse(readFileSync(file, 'utf8')); return { version: 1, connections: Array.isArray(d.connections) ? d.connections.map(defaultBase) : [] } } catch { return { version: 1, connections: [] } } }
  let data = read()
  const save = () => { mkdirSync(home, { recursive: true }); write(file, `${JSON.stringify(data, null, 2)}\n`) }
  const statusEpochs = new Map(), statusTests = new Map()
  const clearStatus = id => { statuses.delete(id); statusEpochs.set(id, (statusEpochs.get(id) || 0) + 1) }
  const statuses = new Map() // id → { ok, detail, at, expiresIn }
  const owners = new Map() // who needs which connections: owner → () => [need]
  const files = new Map() // id.slot → hash of what is on disk

  const conn = id => {
    const c = data.connections.find(x => x.id === id)
    if (!c) throw coded('noConnection', { id }, `no connection "${id}" (add it on the Connectors page)`)
    return c
  }
  const typeOf = c => types[c.type] || (() => { throw coded('noType', { type: c.type }, `unknown connector type ${c.type}`) })()
  const hostsOf = c => [...new Set([hostOf(c.baseUrl), ...(c.hosts || []), ...(typeOf(c).hosts || [])].filter(Boolean))]
  /**
   * In a nookbox box (`vault`): whether a slot's value goes to the host's vault — a header or a cookie the gateway can put
   * back in place of the placeholder. A file (kubeconfig, key), a user name, a dsh reference, a basic-auth password
   * (base64 hides the placeholder from the gateway) stay in the box. So do all the slots of an OAuth type (X): a refresh
   * needs the real refresh token (and client secret) here, to ask the site for a new access token — with only
   * placeholders the box could never refresh, and the gateway puts a value back only into requests, not into this one.
   */
  const toVault = (c, s) => !!vault && !typeOf(c).oauth && !s.file && !s.plain && !s.ref && !(c.type === 'http' && fieldsOf(typeOf(c), c.fields).auth === 'basic')
  /**
   * A file slot's own secrets (`vaulted`: where they sit, a kubeconfig's token) go to the host's vault too once the box's
   * gateway sees the connection's TLS — every host of it on a CA the box's policy trusts, none passed through; the file
   * keeps the placeholders and takes the type's `trust` edit (kubectl then trusts the gateway). Otherwise: unchanged.
   */
  const hostMatch = (p, h) => p === '*' || p === h || (p.startsWith('*.') && h.endsWith(p.slice(1))) || (p.startsWith('.') && (h === p.slice(1) || h.endsWith(p)))
  let policy = null
  const boxPolicy = async () => {
    if (!policy || now() - policy.at > 60e3) policy = { at: now(), value: await vault.policy?.().catch(() => null) }
    return policy.value
  }
  const intercepted = (c, p) => !!p && hostsOf(c).length > 0 && hostsOf(c).every(h => Object.keys(p.trust || {}).some(x => hostMatch(x, h)) && !(p.passthrough || []).some(x => hostMatch(x, h)))
  /** A kubeconfig names its cluster: the connection's address and host follow it. */
  function followServer(c, name, v) {
    const server = c.type === 'k8s' && name === 'kubeconfig' && serverOf(v)
    if (server && server !== c.baseUrl) { c.baseUrl = server; c.updatedAt = now(); save() }
  }
  async function vaultFile(c, s, text) {
    if (!vault || !s.file || !s.vaulted) return text
    const found = [...text.matchAll(s.vaulted.secrets)]
    if (!(found.length || PLACEHOLDER.test(text)) || !intercepted(c, await boxPolicy())) return text
    const edits = []
    for (const [i, m] of found.entries()) {
      if (PLACEHOLDER.test(m[2])) continue
      const { placeholder } = await vault.put(secretName(c.id, i ? `${s.name}_${i + 1}` : s.name), { value: m[2], hosts: hostsOf(c), body: false })
      edits.push({ at: m.index, length: m[0].length, text: m[1] + placeholder })
    }
    let out = text
    for (const e of edits.reverse()) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.length)
    return s.vaulted.trust ? s.vaulted.trust(out) : out
  }
  /** The type's browser sign-in when it applies to this connection (an http connection's only with auth "cookie"). */
  const signinOf = c => { const site = typeOf(c).signin; return site && (!site.applies || site.applies(fieldsOf(typeOf(c), c.fields))) ? site : null }
  const slotDef = (c, name) => typeOf(c).slots.find(s => s.name === name) || (() => { throw coded('noSlot', { id: c.id, slot: name }, `${c.id} has no credential "${name}"`) })()
  async function slots(c) {
    const out = await creds.get(c.id)
    for (const s of typeOf(c).slots.filter(x => x.ref)) { const v = await creds.getRef(s.ref); if (v) out[s.name] = v }
    return out
  }
  const fileSecrets = (s, value) => s.vaulted ? [...String(value || '').matchAll(s.vaulted.secrets)].length : 1
  async function clearVault(c, s, value, from = 1) {
    if (!(toVault(c, s) || (vault && s.vaulted))) return
    for (let i = from; i <= fileSecrets(s, value); i++) await vault.remove(secretName(c.id, i === 1 ? s.name : `${s.name}_${i}`))
  }
  // every value a connection holds is taken out of anything shown (responses, errors, command output)
  const scrubWith = values => text => Object.values(values).filter(v => typeof v === 'string' && v.length >= 6).reduce((t, v) => t.split(v).join('«secret»'), String(text ?? ''))
  const audit = entry => { try { mkdirSync(home, { recursive: true }); appendFileSync(join(home, 'audit.jsonl'), `${JSON.stringify({ at: now(), ...entry })}\n`, { mode: 0o600 }) } catch { /* audit is best effort */ } }

  const refreshing = new Map() // id → the refresh under way (requests that come together share it)
  const devices = new Map() // id → a sign-in by code under way: { device, until, interval }
  const deviceStarts = new Map(), deviceWrites = new Map(), credentialVersions = new Map(), signinVersions = new Map()
  const advanceCredentials = (id, { automatic = false } = {}) => {
    credentialVersions.set(id, (credentialVersions.get(id) || 0) + 1)
    if (!automatic) signinVersions.set(id, (signinVersions.get(id) || 0) + 1)
  }
  const connectionChanged = id => coded('changedMeanwhile', { id }, `${id}: the connection or its sign-in changed; try the operation again`)
  // Generation changes and credential writes share one owner; polling network requests stay outside the queue.
  const deviceWrite = async (id, fn) => {
    const job = (deviceWrites.get(id) || Promise.resolve()).catch(() => {}).then(fn)
    deviceWrites.set(id, job)
    try { return await job } finally { if (deviceWrites.get(id) === job) deviceWrites.delete(id) }
  }

  const driveOf = id => { const c = conn(id), d = DRIVES[typeOf(c).drive]; if (!d) throw coded('noDrive', { id, type: c.type }, `${id} (${typeOf(c).label.en}) does not keep files`); return d }
  const SOON = 60e3 // an access token this close to its end is already renewed

  /** The slot values of an OAuth connection with a usable access token: refreshed first when it has (nearly) expired. */
  async function fresh(c, by) {
    const snapshot = await deviceWrite(c.id, async () => {
      if (!data.connections.includes(c)) throw connectionChanged(c.id)
      return { values: await slots(c), version: credentialVersions.get(c.id) || 0 }
    })
    const values = snapshot.values
    const o = typeOf(c).oauth
    if (!o || (values[o.access] && Number(values[o.expiresAt]) - now() > SOON)) return values
    if (!values[o.access] && !o.clientCredentials) return values
    let row = refreshing.get(c.id)
    if (!row || row.connection !== c || row.version !== snapshot.version) {
      row = { connection: c, version: snapshot.version }
      row.promise = refresh(c, by, snapshot).finally(() => { if (refreshing.get(c.id) === row) refreshing.delete(c.id) })
      refreshing.set(c.id, row)
    }
    // A superseded refresh rejects: it cannot silently send an approved request as a different account.
    return { ...values, ...await row.promise }
  }

  /**
   * Trade the refresh token for new tokens — or, for a type that has no refresh token (`clientCredentials`), its own
   * credentials — keep them (a refresh token the site does not send again stays), audit it.
   */
  async function refresh(c, by, snapshot) {
    const type = typeOf(c), o = type.oauth, id = c.id
    const values = snapshot.values
    if (Number(values[o.expiresAt]) - now() > SOON) return values
    const scrub = scrubWith(values)
    const lost = detail => coded('reconnect', { id, name: type.label.en, detail }, `${id}: the ${type.label.en} authorization has ended (${detail}) — connect it again on the Connectors page`)
    // the site could not be asked (network, its own trouble, rate limit): the authorization may well stand — try later
    const later = detail => coded('refreshLater', { id, name: type.label.en, detail }, `${id}: the ${type.label.en} token could not be renewed just now (${detail}) — try again in a while`)
    const req = (o.clientCredentials || values[o.refresh]) && o.refreshRequest({ ...c, fields: fieldsOf(type, c.fields) }, values)
    const path = req ? new URL(req.url).pathname : ''
    const started = now()
    if (!req) { audit({ id, level: 'write', method: 'REFRESH', path, failed: true, by }); throw lost(o.clientCredentials ? 'its credentials are not set' : 'there is no refresh token') }
    let res, body = null
    try {
      res = await fetch(req.url, { method: req.method || 'POST', headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(30000) })
      body = await res.json().catch(() => null)
    } catch (err) {
      audit({ id, level: 'write', method: 'REFRESH', path, failed: true, ms: now() - started, by })
      throw later(scrub(`the token endpoint could not be reached: ${err.cause?.message || err.message}`).slice(0, 200))
    }
    return deviceWrite(id, async () => {
      if (!data.connections.includes(c) || (credentialVersions.get(id) || 0) !== snapshot.version) throw connectionChanged(id)
      const t = res.ok ? o.tokens(body, now()) : null
      audit({ id, level: 'write', method: 'REFRESH', path, status: res.status, ms: now() - started, by, ...(!t && { failed: true }) })
      if (!t) throw (res.status === 429 || res.status >= 500 ? later : lost)(scrub(o.why(res.status, body)).slice(0, 300))
      advanceCredentials(id, { automatic: true })
      // Keep all token slots under one owner, before a later sign-in/removal can run.
      if (t.refresh && o.refresh) await creds.set(id, o.refresh, t.refresh)
      await creds.set(id, o.access, t.access)
      await creds.set(id, o.expiresAt, t.expiresAt)
      return { [o.access]: t.access, ...(o.refresh && { [o.refresh]: t.refresh || values[o.refresh] }), [o.expiresAt]: t.expiresAt }
    })
  }

  /** A private copy of a file slot (a kubeconfig, a key), rewritten when the credential changes. */
  async function fileOf(c, name) {
    return deviceWrite(c.id, async () => {
      if (!data.connections.includes(c)) throw connectionChanged(c.id)
      return materializeFile(c, name, (await slots(c))[name])
    })
  }
  // Called only while the connection owner is held (including environment assembly).
  async function materializeFile(c, name, value) {
    if (!value) throw coded('notSet', { id: c.id, slot: name }, `${c.id}: the ${slotDef(c, name).label.en} is not set`)
    // one kept from before its host's CA was trusted: moved to the vault now, on its first use
    followServer(c, name, value)
    const moved = await vaultFile(c, slotDef(c, name), value)
    if (moved !== value) { await creds.set(c.id, name, moved); value = moved; audit({ kind: 'vaulted', id: c.id, slot: name }) }
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    const path = join(runDir, `${c.id}.${name}`), hash = createHash('sha256').update(value).digest('hex')
    if (files.get(path) !== hash || !existsSync(path)) { write(path, value); chmodSync(path, 0o600); files.set(path, hash) }
    return path
  }

  /** A client for one connection: the type's credential header added here, only the connection's hosts. */
  function client(id, { by = '' } = {}) {
    const c = conn(id), type = typeOf(c)
    return {
      conn: c, baseUrl: c.baseUrl, host: hostOf(c.baseUrl),
      async request(path, { method = 'GET', body, headers = {}, level = 'read', slot, timeout = 30000, signal, redirect = 'manual' } = {}) {
        const base = c.baseUrl.replace(/\/?$/, '/')
        const url = new URL(/^https?:\/\//.test(path) ? path : String(path).replace(/^\//, ''), base)
        if (!hostsOf(c).includes(url.hostname)) throw coded('badHost', { id, host: url.hostname }, `${url.hostname} is not a host of ${id} (${hostsOf(c).join(', ')})`)
        const values = await fresh(c, by)
        const name = slot || slotFor(type, level, n => !!values[n])
        if (level === 'write' && name && !values[name]) throw coded('noWrite', { id, slot: name }, `${id}: writing needs the ${slotDef(c, name).label.en.toLowerCase()} (Connectors page)`)
        if (name && !values[name] && slotDef(c, name).required) throw coded('notSet', { id, slot: name }, `${id}: the ${slotDef(c, name).label.en.toLowerCase()} is not set (Connectors page)`)
        const auth = Object.entries(type.headers?.(values[name] || '', { ...c, fields: fieldsOf(type, c.fields) }, values) || {}).filter(([, v]) => v)
        // a type that takes its credential in the query string (Baidu): added here, never in what is shown or audited
        const shown = url.href
        for (const [k, v] of Object.entries(type.query?.(values[name] || '', { ...c, fields: fieldsOf(type, c.fields) }, values) || {})) if (v) url.searchParams.set(k, v)
        const started = now()
        // a form (multipart: an upload, an audio file) or bytes go as they are, with the type fetch gives them
        const raw = isRaw(body)
        const res = await fetch(url, {
          method, redirect, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
          headers: { accept: 'application/json', ...Object.fromEntries(auth), ...(body !== undefined && !raw && { 'content-type': 'application/json' }), ...headers },
          body: body === undefined ? undefined : raw || typeof body === 'string' ? body : JSON.stringify(body),
        })
        audit({ id, level, method, path: url.pathname, status: res.status, ms: now() - started, by })
        const scrub = scrubWith(values)
        // the body once, as bytes (audio, images) or as text with every credential value taken out
        let bytes = null, text = null
        const bytes$ = async () => (bytes ??= Buffer.from(await res.arrayBuffer()))
        const body$ = async () => (text ??= scrub((await bytes$()).toString('utf8')))
        // stream(): the body as it comes (a big download), instead of text / json / bytes
        return { ok: res.ok, status: res.status, headers: res.headers, url: shown, text: body$, json: async () => JSON.parse(await body$()), bytes: bytes$, stream: () => res.body }
      },
    }
  }

  /**
   * The cookies a browser needs to be this connection's signed-in session — for a plugin's own browser (a publish the
   * person watches), never a command's environment. Only a type that keeps a site's session says what they are
   * (`cookies(conn, slots)`). Audited as handed out.
   */
  async function browserCookies(id, { by = '' } = {}) {
    const c = conn(id), type = typeOf(c)
    if (typeof type.cookies !== 'function') throw coded('noCookies', { id }, `${id} keeps no browser session`)
    return deviceWrite(id, async () => {
      if (!data.connections.includes(c)) throw connectionChanged(id)
      const values = await slots(c)
      audit({ id, level: 'write', method: 'COOKIES', path: '', by })
      return type.cookies({ ...c, fields: fieldsOf(type, c.fields) }, values) || []
    })
  }

  /** The variables a command gets for this connection (and the files it reads), audited as handed out. */
  async function environment(c, { write: w = false, by = '' } = {}) {
    if (w) await fresh(c, by) // renew outside the owner; its network call must not block sign-in/removal
    return deviceWrite(c.id, async () => {
      if (!data.connections.includes(c)) throw connectionChanged(c.id)
      const type = typeOf(c), values = await slots(c), files$ = {}
      for (const s of type.slots.filter(x => x.file && values[x.name])) files$[s.name] = await materializeFile(c, s.name, values[s.name])
      audit({ id: c.id, level: w ? 'write' : 'read', method: 'ENV', path: '', by })
      const vars = type.env ? type.env({ ...c, fields: fieldsOf(type, c.fields) }, values, { write: w, file: name => files$[name] || '' }) : {}
      return { values, vars }
    })
  }
  async function env(id, opts = {}) { return (await environment(conn(id), opts)).vars }

  /**
   * The type's own command (an adapter's) with exactly this connection's variables — writes only when
   * asked for; it prints one JSON document. → that document.
   */
  async function command(id, args, { write: w = false, timeout = 120000, by = '' } = {}) {
    const c = conn(id), type = typeOf(c)
    if (!type.command) throw coded('noCommand', { id, type: c.type }, `${id} (${type.label.en}) has no command`)
    const { values, vars } = await environment(c, { write: w, by }), missing = type.slots.find(x => x.required && !values[x.name])
    if (missing) throw coded('notSet', { id, slot: missing.name }, `${id}: ${missing.name} is not set (Connectors page${missing.signin || type.signin ? ' → Sign in' : ''})`)
    const r = await run(type.command.cmd, [...type.command.args, ...args.map(String)], { env: { ...vars, ...type.command.env }, timeout })
    const scrub = scrubWith(values), said = scrub(r.stderr || r.stdout).trim().split('\n')
    if (r.code !== 0) throw coded('commandFailed', { id, name: type.label.en, detail: said.at(-1) || '' }, `${type.label.en} (${id}): ${said.slice(-2).join(' ') || `exit ${r.code}`}`)
    return JSON.parse(r.stdout)
  }

  /** A dataset's read: the read op of the connection's type (lib/reads.js) with these params → the op's rows. */
  async function readOp(id, op, params = {}, { by = '' } = {}) {
    const c = conn(id), fn = READS[c.type]?.[op]
    if (!fn) throw coded('noRead', { id, op }, `${id} (${c.type}) has no read "${op}"`)
    const api = {
      conn: { ...c, fields: fieldsOf(typeOf(c), c.fields) }, command: a => command(id, a, { by }), kubectl: a => kubectl(id, a, { timeout: 30000 }),
      request: (p, o = {}) => client(id, { by }).request(p, { ...o, level: 'read' }),
    }
    try { return await fn(api, params) } catch (err) {
      if (err.code) throw err
      throw coded('readFailed', { id, op, detail: scrubWith(await slots(c))(err.message).slice(0, 300) }, `${id} could not read "${op}": ${err.message}`)
    }
  }

  async function kubectl(id, args, opts = {}) {
    const c = conn(id)
    return run('kubectl', ['--kubeconfig', await fileOf(c, 'kubeconfig'), ...args], opts)
  }

  async function test(name) {
    const c = conn(name), id = c.id, type = typeOf(c), epoch = statusEpochs.get(id) || 0, attempt = {}
    statusTests.set(id, attempt)
    const values = await slots(c)
    const missing = type.slots.filter(s => s.required && !values[s.name]).map(s => s.name)
    let status
    if (missing.length) status = { ok: false, unset: true, detail: `not set: ${missing.join(', ')}` }
    else {
      try {
        const api = { conn: { ...c, fields: fieldsOf(type, c.fields) }, has: n => !!values[n], command: a => command(id, a, { timeout: 30000, by: 'test' }), request: (p, o) => client(id, { by: 'test' }).request(p, o), kubectl: a => kubectl(id, a, { timeout: 20000 }) }
        status = type.test ? await type.test(api) : { ok: true, detail: '' }
      } catch (err) { status = { ok: false, detail: scrubWith(values)(err.cause?.message || err.message).slice(0, 300) } }
    }
    status.at = now()
    if (data.connections.includes(c) && (statusEpochs.get(id) || 0) === epoch && statusTests.get(id) === attempt) statuses.set(id, status)
    return status
  }

  function validate(input, existing) {
    const id = String(input.id || '').trim()
    if (!ID.test(id)) throw coded('badId', { id }, 'the id is lowercase letters, digits and dashes, starting with a letter')
    const type = types[input.type]
    if (!type) throw coded('noType', { type: input.type }, `unknown connector type ${input.type}`)
    if (existing && existing.type !== input.type) throw coded('typeFixed', { id }, `${id} is a ${existing.type} connection; remove it to make another kind`)
    let baseUrl = String(input.baseUrl ?? existing?.baseUrl ?? '').trim() || String(type.baseUrl.default || '').trim()
    if (baseUrl && !/^https?:\/\/[^\s/]+/.test(baseUrl)) throw coded('badUrl', { value: baseUrl }, 'the address is http(s)://host[/path]')
    if (!baseUrl && type.baseUrl.required) throw coded('needUrl', { id }, `${type.label.en} needs its address`)
    baseUrl = baseUrl.replace(/\/+$/, '')
    const fields = {}
    for (const f of type.fields) {
      const v = String(input.fields?.[f.name] ?? existing?.fields?.[f.name] ?? f.default ?? '').trim()
      if (f.options && v && !f.options.includes(v)) throw coded('badField', { field: f.name, value: v }, `${f.name} is one of ${f.options.join(', ')}`)
      if (f.required && !v) throw coded('needField', { field: f.name }, `${f.label.en} is required`)
      fields[f.name] = v
    }
    const hosts = [...new Set((Array.isArray(input.hosts) ? input.hosts : existing?.hosts || []).map(h => String(h).trim().toLowerCase()).filter(Boolean))]
    if (hosts.some(h => !/^[a-z0-9.-]+$/.test(h))) throw coded('badHosts', {}, 'hosts are names like api.example.com')
    return { id, type: input.type, name: String(input.name || existing?.name || id).trim().slice(0, 80), baseUrl, hosts, fields }
  }

  const writeSlot = async (c, name, value) => {
    const id = c.id, s = slotDef(c, name)
    const v = s.file ? String(value ?? '') : String(value ?? '').trim()
    if (!v.trim()) throw coded('emptyValue', {}, 'the value is empty')
    if (!s.file && /[\r\n]/.test(v)) throw coded('oneLine', {}, 'the value must be one line')
    advanceCredentials(id); devices.delete(id); deviceStarts.delete(id)
    // in a box: the value to the host's vault, the placeholder here (an imported placeholder is one already)
    let kept = v
    if (toVault(c, s) && !PLACEHOLDER.test(v)) kept = (await vault.put(secretName(id, name), { value: v, hosts: hostsOf(c), body: name === 'password' })).placeholder
    followServer(c, name, v)
    kept = await vaultFile(c, s, kept)
    if (vault && s.vaulted) await clearVault(c, s, (await slots(c))[name], fileSecrets(s, kept) + 1)
    if (s.ref) await creds.setRef(s.ref, kept)
    else await creds.set(id, name, kept)
    clearStatus(id)
  }
  const writeFields = (c, fields) => {
    const type = typeOf(c)
    for (const [k, v] of Object.entries(fields || {})) if (type.fields.some(f => f.name === k)) c.fields = { ...c.fields, [k]: String(v) }
    c.updatedAt = now(); save(); clearStatus(c.id)
  }
  function saveConnection(input) {
    const existing = data.connections.find(x => x.id === String(input.id || '').trim())
    const c = validate(input, existing)
    advanceCredentials(c.id); devices.delete(c.id); deviceStarts.delete(c.id)
    const at = now()
    data.connections = existing ? data.connections.map(x => (x.id === c.id ? { ...x, ...c, updatedAt: at } : x)) : [...data.connections, { ...c, createdAt: at, updatedAt: at }]
    save()
    clearStatus(c.id)
    return service.get(c.id)
  }
  const ownsSignin = (id, ticket) => ticket?.connection?.id === id && data.connections.includes(ticket.connection) && (signinVersions.get(id) || 0) === ticket.version

  let takingImport = null
  const readImport = async () => {
    const stagedFile = join(home, 'import.json'), f = join(home, 'import.active.json')
    // Own this snapshot before awaiting credentials; a later CLI import keeps its own staged file.
    // A newer configuration supersedes an interrupted retry, as replacing import.json did before.
    if (existsSync(stagedFile)) renameSync(stagedFile, f)
    if (!existsSync(f)) return null
    let staged
    staged = JSON.parse(readFileSync(f, 'utf8'))
    const report = []
    for (const c of staged.connections || []) {
      try {
        if (!service.has(c.id)) await service.save(c)
        for (const [name, v] of Object.entries(staged.values?.[c.id] || {})) if (v) await service.setSlot(c.id, name, v)
        report.push({ id: c.id, ok: true })
      } catch (err) { report.push({ id: c.id, ok: false, error: err.message }) }
    }
    const failed = new Set(report.filter(r => !r.ok).map(r => r.id))
    if (failed.size) {
      const kept = { ...staged, connections: (staged.connections || []).filter(c => failed.has(c.id)), values: Object.fromEntries(Object.entries(staged.values || {}).filter(([id]) => failed.has(id))) }
      writeFileSync(`${f}.tmp`, JSON.stringify(kept), { mode: 0o600 }); chmodSync(`${f}.tmp`, 0o600); renameSync(`${f}.tmp`, f)
    } else rmSync(f, { force: true })
    return report
  }
  const service = {
    types: () => Object.entries(types).map(([id, t]) => ({ id, label: t.label, blurb: t.blurb, baseUrl: t.baseUrl, fields: t.fields, hosts: t.hosts || [], signin: t.signin ? { slot: t.signin.slot || '', manual: !!t.signin.manual, label: t.signin.label || null } : null, slots: t.slots.map(({ name, label, hint, level, required, signin, file: f, plain, ref, auto, device }) => ({ name, label, hint, level, required: !!required, signin: !!signin, file: !!f, plain: !!plain, ref: !!ref, auto: !!auto, device: !!device })), share: canShare(t), drive: isDrive(t) })),
    has: id => data.connections.some(x => x.id === id),
    /** The sign-in a connection offers (its type's { ready, keep, … }, the page to open), or null. */
    signinOf(id) { const c = conn(id), site = signinOf(c); return site ? { site, url: site.url ? site.url({ ...c, fields: fieldsOf(typeOf(c), c.fields) }) : c.baseUrl } : null },
    /**
     * Start a sign-in: the type's `begin` gets the connection and its credentials (a client secret) and makes the address to
     * open and the sign-in's private state. The state stays here — the `ready` and `keep` returned get it in `extra.state` —
     * so nothing that holds a value leaves the service. → { site, base, url, intercept }
     */
    async beginSignin(id) {
      const { c, site, values, ticket } = await deviceWrite(id, async () => {
        const c = conn(id), site = signinOf(c)
        if (!site) throw coded('noSignin', { id }, `${id} has no sign-in`)
        advanceCredentials(id); devices.delete(id); deviceStarts.delete(id)
        return { c, site, values: await slots(c), ticket: { connection: c, version: signinVersions.get(id) || 0 } }
      })
      const view = { ...c, fields: fieldsOf(typeOf(c), c.fields) }
      const begun = site.begin ? await site.begin(view, values) : {}
      if (!ownsSignin(id, ticket)) throw connectionChanged(id)
      // Only cookies the target API would receive may become its credential.
      const loginUrl = begun.url || (site.url ? site.url(view) : c.baseUrl)
      const base = c.baseUrl || loginUrl
      const given = extra => ({ ...extra, state: begun.state })
      return {
        ticket,
        site: { ...site, ready: (url, cookies, at, extra) => site.ready(url, cookies, at, given(extra)), keep: (cookies, html, extra) => site.keep(cookies, html, given(extra)) },
        base, url: loginUrl, intercept: typeof site.intercept === 'function' ? site.intercept(view) || '' : site.intercept || '',
      }
    },
    async keepSignin(id, ticket, kept) {
      return deviceWrite(id, async () => {
        if (!ownsSignin(id, ticket)) throw connectionChanged(id)
        const c = ticket.connection
        for (const name of Object.keys(kept.slots || {})) slotDef(c, name)
        advanceCredentials(id); devices.delete(id); deviceStarts.delete(id)
        for (const [name, value] of Object.entries(kept.slots || {})) await writeSlot(c, name, value)
        if (Object.keys(kept.fields || {}).length) writeFields(c, kept.fields)
      })
    },
    get(id) { const c = conn(id); return { ...c, fields: fieldsOf(typeOf(c), c.fields), hosts: hostsOf(c), host: hostOf(c.baseUrl), signin: signinOf(c) ? signinOf(c).slot || '' : null, share: canShare(typeOf(c)), drive: isDrive(typeOf(c)), device: !!typeOf(c).device } },
    /**
     * Sign in by a code (OAuth device code): the code to scan or type in, the picture of it (fetched here, as data). The
     * device code stays in the service; devicePoll asks whether the person has agreed. → { userCode, verifyUrl, qr, expiresIn, interval }
     */
    async deviceStart(id) {
      const c = conn(id), type = typeOf(c), d = type.device
      if (!d) throw coded('noDevice', { id }, `${id} (${type.label.en}) does not sign in by a code`)
      const attempt = {}
      const admitted = await deviceWrite(id, () => { if (!data.connections.includes(c)) return false; advanceCredentials(id); deviceStarts.set(id, attempt); devices.delete(id); return true })
      if (!admitted) return { state: 'stale' }
      const fields = fieldsOf(type, c.fields), values = await slots(c), scrub = scrubWith(values)
      const req = d.start({ ...c, fields }, values)
      let res, body = null
      try {
        res = await fetch(req.url, { method: req.method || 'GET', headers: req.headers, redirect: 'manual', signal: AbortSignal.timeout(30000) })
        body = await res.json().catch(() => null)
      } catch (err) { throw coded('deviceFailed', { id }, scrub(`${type.label.en}: the sign-in code could not be had (${err.cause?.message || err.message})`).slice(0, 300)) }
      audit({ id, level: 'write', method: 'DEVICE', path: new URL(req.url).pathname, status: res.status, by: 'device' })
      const code = res.ok ? d.code(body) : null
      if (!code) throw coded('deviceFailed', { id }, scrub(`${type.label.en}: the sign-in code could not be had (${d.why(res.status, body)})`).slice(0, 300))
      const current = await deviceWrite(id, () => {
        if (deviceStarts.get(id) !== attempt || !data.connections.includes(c)) return false
        devices.set(id, { connection: c, device: code.device, until: now() + code.expiresIn * 1000, interval: code.interval })
        return true
      })
      if (!current) return { state: 'stale' }
      let qr = ''
      if (code.qrcodeUrl) {
        try { const r = await fetch(code.qrcodeUrl, { signal: AbortSignal.timeout(15000) }); if (r.ok) qr = `data:${r.headers.get('content-type') || 'image/png'};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}` } catch { /* the code to type in still works */ }
      }
      if (deviceStarts.get(id) !== attempt || !data.connections.includes(c)) return { state: 'stale' }
      return { userCode: code.userCode, verifyUrl: code.verifyUrl, qr, expiresIn: code.expiresIn, interval: code.interval }
    },
    /** Has the person agreed? → { state: 'pending' | 'done' | 'expired' | 'failed' | 'none', detail?, test? } (done: the tokens are kept). */
    async devicePoll(id) {
      const c = conn(id), type = typeOf(c), d = type.device, o = type.oauth, p = devices.get(id)
      if (!d || !p) return { state: 'none' }
      if (p.connection !== c) { devices.delete(id); return { state: 'stale' } }
      if (now() > p.until) { devices.delete(id); return { state: 'expired' } }
      const values = await slots(c), scrub = scrubWith(values)
      const req = d.poll({ ...c, fields: fieldsOf(type, c.fields) }, values, p.device)
      let res, body = null
      try {
        res = await fetch(req.url, { method: req.method || 'POST', headers: req.headers, body: req.body, redirect: 'manual', signal: AbortSignal.timeout(30000) })
        body = await res.json().catch(() => null)
      } catch { return { state: 'pending', interval: p.interval } }
      return deviceWrite(id, async () => {
        if (devices.get(id) !== p || !data.connections.includes(c)) return { state: 'stale' }
        if (d.pending(body)) return { state: 'pending', interval: p.interval }
        const t = res.ok ? d.tokens(body, now()) : null
        audit({ id, level: 'write', method: 'DEVICE', path: new URL(req.url).pathname, status: res.status, by: 'device', ...(!t && { failed: true }) })
        devices.delete(id)
        if (!t) return { state: 'failed', detail: scrub(d.why(res.status, body)).slice(0, 300) }
        advanceCredentials(id)
        if (t.refresh && o.refresh) await creds.set(id, o.refresh, t.refresh)
        await creds.set(id, o.access, t.access)
        await creds.set(id, o.expiresAt, t.expiresAt)
        return { state: 'done' }
      }).then(async result => result.state === 'done' ? { ...result, test: await service.test(id) } : result)
    },
    /** A drive's folder: { path, items: [{ id, name, path, size, dir, mtime }] } (lib/drive.js). */
    async driveList(id, path = '/', { by = '' } = {}) { return driveOf(id).list(client(id, { by }), path) },
    /** Every file under a drive folder, at any depth: [{ id, name, path, size, rel }]. */
    async driveFiles(id, path, { by = '' } = {}) { return driveOf(id).files(client(id, { by }), path) },
    /** Files up into a drive folder (under the connection's own place there). → { dir, files } */
    async driveUpload(id, files, folder = '', { by = '', signal, note } = {}) {
      if (!Array.isArray(files) || !files.length) throw coded('badInput', {}, 'nothing to upload')
      return driveOf(id).upload(client(id, { by }), files, folder, { signal, note, endpoints: typeOf(conn(id)).endpoints })
    },
    /** Files (by drive id) down into a local folder; one there with the same size is kept. → [{ name, path, size, kept? }] */
    async driveDownload(id, items, dir, { by = '', signal, note } = {}) {
      if (!Array.isArray(items) || !items.length) throw coded('badInput', {}, 'nothing to download')
      const get = async (url, headers, sig) => {
        const started = now()
        const res = await fetch(url, { headers, redirect: 'follow', signal: sig ? AbortSignal.any([sig, AbortSignal.timeout(3600000)]) : AbortSignal.timeout(3600000) })
        audit({ id, level: 'read', method: 'GET', path: `${new URL(url).hostname} (download)`, status: res.status, ms: now() - started, by })
        return res
      }
      return driveOf(id).download(client(id, { by }), items, dir, { signal, note, get })
    },
    /**
     * Share files through a connection whose type is a share target (lib/share.js): they go into a folder of their own
     * there and a link comes back. files: [{ path, name? }]; opts: { folder, expireDays, password, by, signal, note(text) }.
     * → { url, password, expireDays, folder, files }. Credentialed calls go through the connection's client; the bytes go to
     * the upload addresses the target hands out (no credential), audited as PUT.
     */
    async share(id, files, { folder, expireDays, password = '', by = '', signal, note } = {}) {
      const c = conn(id), target = TARGETS[typeOf(c).shareTarget]
      if (!target) throw coded('noShare', { id, type: c.type }, `${id} (${typeOf(c).label.en}) cannot share files`)
      if (!Array.isArray(files) || !files.length) throw coded('badInput', {}, 'nothing to share')
      const put = async (url, bytes, sig) => {
        const started = now()
        const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes, signal: sig ? AbortSignal.any([sig, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000) })
        audit({ id, level: 'write', method: 'PUT', path: `${new URL(url).hostname} (upload, ${bytes.length} bytes)`, status: res.status, ms: now() - started, by })
        return res
      }
      return target.share(client(id, { by }), files, { folder, expireDays, password, signal, put, note, endpoints: typeOf(c).endpoints })
    },
    async list() {
      const needs = service.needs()
      return Promise.all(data.connections.map(async c => {
        // a connection whose adapter is not loaded (its plugin off): shown, not usable, nothing else lost
        if (!types[c.type]) return { id: c.id, type: c.type, name: c.name, baseUrl: c.baseUrl || '', hosts: c.hosts || [], ownHosts: c.hosts || [], fields: c.fields || {}, typeLabel: { en: c.type, zh: c.type }, howTo: '', slots: [], unknownType: true,
          status: { ok: false, detail: `the ${c.type} connector type is not loaded (its plugin is off)` }, usedBy: needs.filter(n => n.connection === c.id).map(n => ({ owner: n.owner, label: n.label, levels: n.levels })) }
        const type = typeOf(c), values = await slots(c), site = signinOf(c)
        return {
          ...service.get(c.id), ownHosts: c.hosts || [], typeLabel: type.label, howTo: c.baseUrl || !type.baseUrl.required ? type.howTo?.(c) || '' : '',
          // a token's last four characters tell two apart; a password's or a session's tell nothing and are not shown
          // in a box: a value in the host's vault shows as such (the placeholder's tail tells nothing)
          slots: type.slots.map(s => ({ name: s.name, set: !!values[s.name], ...(PLACEHOLDER.test(values[s.name] || '') && { vault: true }), ...(s.plain && values[s.name] && { value: values[s.name] }), ...(!s.plain && !s.file && !s.signin && !s.auto && s.name !== site?.slot && !/password/i.test(s.name) && values[s.name] && !PLACEHOLDER.test(values[s.name]) && { tail: values[s.name].length > 12 ? values[s.name].slice(-4) : '' }) })),
          status: statuses.get(c.id) || null,
          usedBy: needs.filter(n => n.connection === c.id).map(n => ({ owner: n.owner, label: n.label, levels: n.levels })),
        }
      }))
    },
    /** Add or change a connection (fields only; credentials through setSlot). */
    async save(input) { return deviceWrite(String(input.id || '').trim(), () => saveConnection(input)) },
    async remove(id) {
      return deviceWrite(id, async () => {
        const c = conn(id), values = await slots(c)
        advanceCredentials(id); devices.delete(id); deviceStarts.delete(id)
        for (const s of typeOf(c).slots) {
          await clearVault(c, s, values[s.name])
          rmSync(join(runDir, `${id}.${s.name}`), { force: true })
        }
        await creds.remove(id)
        data.connections = data.connections.filter(x => x.id !== id)
        save()
        clearStatus(id)
      })
    },
    async setSlot(id, name, value) { return deviceWrite(id, () => writeSlot(conn(id), name, value)) },
    async clearSlot(id, name) {
      return deviceWrite(id, async () => {
        const c = conn(id), s = slotDef(c, name)
        advanceCredentials(id); devices.delete(id); deviceStarts.delete(id)
        await clearVault(c, s, (await slots(c))[name])
        if (s.ref) await creds.clearRef(s.ref)
        else await creds.clear(id, name)
        rmSync(join(runDir, `${id}.${name}`), { force: true })
        clearStatus(id)
      })
    },
    /** Fields a sign-in learned (the user it showed): kept with the connection. */
    async setFields(id, fields) {
      return deviceWrite(id, () => {
        const c = conn(id)
        advanceCredentials(id); devices.delete(id); deviceStarts.delete(id)
        writeFields(c, fields)
      })
    },
    /**
     * Make a connection if it is not there and fill the credentials it does not have yet — how a product moves its old
     * settings in, and how an import lands. Never overwrites what a person set.
     */
    async adopt(input, values = {}) {
      const id = String(input.id || '').trim()
      return deviceWrite(id, async () => {
        const created = !service.has(id)
        if (created) saveConnection(input)
        const c = conn(id), have = await slots(c), filled = []
        for (const [name, v] of Object.entries(values)) {
          if (!v || have[name]) continue
          await writeSlot(c, name, v)
          filled.push(name)
        }
        return { created, filled }
      })
    },
    client, env, command, kubectl, test, read: readOp,
    /**
     * An adapter's connector type (another plugin's): { label, blurb, baseUrl, fields, slots,
     * headers?, hosts?, signin?, command?: { cmd, args, env }, test?(api), env?(conn, slots, opts), howTo? }.
     * → how it leaves (connections of that type stay; they read as unknown until it is back).
     */
    registerType(id, def) {
      if (!/^[a-z][a-z0-9-]{1,31}$/.test(id) || !def?.label || !Array.isArray(def.slots) || !Array.isArray(def.fields) || !def.baseUrl) throw coded('badType', { type: id }, `not a connector type: ${id}`)
      if (types[id] && types[id] !== def) throw coded('typeTaken', { type: id }, `the connector type ${id} is registered already`)
      types[id] = def
      for (const c of data.connections) if (c?.type === id) {
        const before = c.baseUrl
        defaultBase(c)
        if (c.baseUrl !== before) clearStatus(c.id)
      }
      return () => { if (types[id] === def) delete types[id] }
    },
    /** A type by its id (null: none registered). */
    type: id => types[id] || null,
    /** In a nookbox box: credentials go to the host's vault (where they are is shown on the page). */
    inBox: !!vault,
    file: (id, name) => fileOf(conn(id), name),
    browserCookies,
    async testAll() { for (const c of data.connections) await test(c.id).catch(() => {}) },
    /**
     * What needs a person (the inbox's System tab), from the last tests: a connection that fails or has no credentials,
     * a token that runs out within two weeks, a need no connection meets. tone — now: broken for what uses it; soon:
     * breaks within three days; later: a while yet, or nothing uses it. → [{ key, kind, tone, id?, name?, type, … }]
     */
    attention() {
      const needs = service.needs(), out = []
      for (const c of data.connections) {
        const s = statuses.get(c.id), type = types[c.type]
        if (!s || !type) continue // not tested yet; its adapter off (nothing to do here)
        const usedBy = needs.filter(n => n.connection === c.id).map(n => ({ owner: n.owner, label: n.label || null }))
        const one = { id: c.id, name: c.name, type: c.type, usedBy, at: s.at, signin: !!(type.signin || type.login || type.oauth) }
        if (!s.ok) out.push({ key: `${c.id}:${s.unset ? 'unset' : 'failed'}`, kind: s.unset ? 'unset' : 'failed', tone: usedBy.length ? 'now' : 'later', detail: s.detail, ...one })
        else if (s.expiresIn != null && s.expiresIn <= 14) out.push({ key: `${c.id}:expiring`, kind: 'expiring', tone: s.expiresIn <= 3 ? 'soon' : 'later', days: s.expiresIn, ...one })
      }
      for (const n of needs) {
        if (n.optional || !['missing', 'wrongType'].includes(n.state)) continue
        out.push({ key: `need:${n.owner}:${n.type}:${n.name || ''}`, kind: n.state, tone: 'now', type: n.type, owner: n.owner, label: n.label || null, ...(n.connection && { id: n.connection }) })
      }
      return out
    },
    status: id => statuses.get(id) || null,
    /** Who needs which connection: a product registers a function returning its needs. */
    require(owner, fn) { owners.set(owner, fn); return () => { if (owners.get(owner) === fn) owners.delete(owner) } },
    needs() {
      return [...owners.entries()].flatMap(([owner, fn]) => {
        let list = []
        try { list = fn() || [] } catch { /* that owner is mid-reload */ }
        return list.map(n => {
          const c = n.connection && data.connections.find(x => x.id === n.connection)
          const s = c && statuses.get(c.id)
          const state = !n.connection || !c ? 'missing' : c.type !== n.type ? 'wrongType' : s?.unset ? 'unset' : s && !s.ok ? 'failed' : s?.ok ? 'ok' : 'untested'
          return { owner, ...n, ...(c && { connection: c.id }), state }
        })
      })
    },
    /** What `ruyix config import` left for the next start: connections and their values (box mode: the placeholders). */
    importing: () => !!takingImport,
    takeImport() {
      if (!takingImport) takingImport = readImport().finally(() => { takingImport = null })
      return takingImport
    },
    reload() { data = read() },
    /**
     * What a configuration file carries: the connections and the slots each has set, and — only when a person asked
     * for the values file — the values by secret name (audited).
     */
    async exportData({ values = false, by = 'export' } = {}) {
      const list = [], out = {}
      for (const id of data.connections.map(c => c.id)) {
        await deviceWrite(id, async () => {
          const c = data.connections.find(c => c.id === id)
          if (!c || !types[c.type]) return // removed, or its adapter is not loaded
          const v = await slots(c)
          // an OAuth type's tokens are made in the box by its own sign-in: none go with a file
          const set = typeOf(c).oauth ? [] : typeOf(c).slots.filter(s => v[s.name]).map(s => s.name)
          list.push({ ...service.get(c.id), ownHosts: c.hosts || [], slots: set })
          if (!values) return
          for (const s of set) out[secretName(c.id, s)] = v[s]
          audit({ id: c.id, level: 'read', method: 'EXPORT', path: '', by })
        })
      }
      return exportConnections(list, values ? out : null, types)
    },
    /** The newest audit lines (one connection, or all). */
    audit(id, limit = 100) {
      let lines = []
      try { lines = readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n') } catch { return [] }
      return lines.slice(-5000).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(e => e && (!id || e.id === id)).slice(-limit).reverse()
    },
  }
  return service
}
