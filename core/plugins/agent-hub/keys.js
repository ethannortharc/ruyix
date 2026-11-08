// The other way to sign a CLI runtime in (Agents → Runtimes): an API key, changed or let go whenever. Claude Code's is
// kept in dsh's credential store under a name of its own (RUYIX_CLAUDE_API_KEY: not dsh's own Anthropic key, which stays
// dsh's) and handed to each run as ANTHROPIC_API_KEY; Codex keeps its key in its own auth.json (`codex login
// --with-api-key`). In a nookbox box the value goes to the host's vault (a connector credential named for this box,
// CONN_<box>_…, bound to the provider's host) and the box keeps only its placeholder: the gateway puts the value back on
// the way out. A new key is checked under a name of its own first, so a refused one leaves the key in use as it was.
// Signing out: the CLI's own logout, and its key let go (store and vault).
import { spawn as defaultSpawn } from 'node:child_process'
import { launch } from './platform.js'

const fail = (code, params, message) => Object.assign(new Error(message), { code, params })
export const KEYS = {
  claude: { name: 'Claude Code', env: 'ANTHROPIC_API_KEY', stored: 'RUYIX_CLAUDE_API_KEY', vault: 'ANTHROPIC_KEY', host: 'api.anthropic.com',
    check: k => ['https://api.anthropic.com/v1/models', { 'x-api-key': k, 'anthropic-version': '2023-06-01' }] },
  codex: { name: 'Codex', env: 'OPENAI_API_KEY', vault: 'OPENAI_KEY', host: 'api.openai.com',
    check: k => ['https://api.openai.com/v1/models', { authorization: `Bearer ${k}` }] },
}

/** A CLI run to its end, its input on stdin: → { code, out }. */
function run(spawn, bin, args, input = '') {
  return new Promise(resolve => {
    let out = ''
    const [cmd, argv] = launch(bin, args)
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NO_COLOR: '1' } })
    child.stdout?.on('data', d => { out += d })
    child.stderr?.on('data', d => { out += d })
    child.on('error', err => resolve({ code: -1, out: err.message }))
    child.on('close', code => resolve({ code: code ?? -1, out }))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

// credentials: () => dsh's credential store (it comes and goes with dsh's service)
export function createKeys({ which, credentials = () => null, box = process.env.NOOKBOX_API || null, boxName = process.env.NOOKBOX_NAME || 'box', spawn = defaultSpawn, fetchFn = globalThis.fetch }) {
  // the host's vault is the host's: each box's names are its own (another box's are not this one's to set)
  const vaultName = (k, next = false) => `CONN_${String(boxName).toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 40)}_${k.vault}${next ? '_NEXT' : ''}`
  const vault = async (method, name, body) => {
    const res = await fetchFn(new URL(`/v1/secrets/${name}`, box), { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw fail('vault', { detail: data.error || `HTTP ${res.status}` }, `nookbox vault: ${data.error || `HTTP ${res.status}`}`)
    return data
  }
  const of = runtime => KEYS[runtime] || (() => { throw fail('noKeyLogin', { runtime }, `${runtime} does not sign in with a key here`) })()
  const store = () => credentials() || (() => { throw fail('noCredentials', {}, 'dsh\'s credential store is not here') })()
  /** Claude Code's key out of the store (a run's, a status probe's). */
  const claudeKey = () => credentials()?.resolve?.(KEYS.claude.stored).then(r => r?.value || '', () => '') ?? Promise.resolve('')
  return {
    /** Sign a CLI in with a key, checked with its provider first (a key it refuses is not kept): → { verified, tail }. */
    async set(runtime, raw) {
      const k = of(runtime), value = String(raw ?? '').trim()
      if (!/^[\x21-\x7e]{20,512}$/.test(value)) throw fail('badKey', {}, 'a key is one line of 20 to 512 characters, no spaces')
      const bin = which(runtime)
      if (!bin) throw fail('cliNotInstalled', { cli: runtime }, `${runtime} is not installed (Agents → Runtimes installs it)`)
      if (runtime === 'claude') store()
      // in a box the host's vault keeps it; the check goes out with a placeholder (the gateway puts the value in) — a
      // name of its own for the check, so a refused key leaves the one in use as it was
      const placeholder = async next => (await vault('PUT', vaultName(k, next), { value, hosts: [k.host] })).placeholder || (() => { throw fail('vault', { detail: 'no placeholder' }, 'nookbox vault: no placeholder') })()
      const trial = box ? await placeholder(true) : value
      const [url, headers] = k.check(trial)
      const status = await fetchFn(url, { headers, signal: AbortSignal.timeout(10000) }).then(r => r.status, () => 0)
      if (box) await vault('DELETE', vaultName(k, true)).catch(() => {})
      if (status === 401 || status === 403) throw fail('keyRejected', { runtime: k.name }, `${k.name}'s provider refused this key`)
      const kept = box ? await placeholder(false) : value
      if (runtime === 'claude') await store().set(k.stored, kept)
      else {
        const r = await run(spawn, bin, ['login', '--with-api-key'], `${kept}\n`)
        if (r.code !== 0) throw fail('loginFailed', { detail: r.out.trim().split('\n').at(-1)?.slice(0, 300) || `exit ${r.code}` }, 'codex login --with-api-key failed')
      }
      return { verified: status === 200, tail: value.slice(-4) }
    },
    /** Sign a CLI out: its own logout, and its key let go. */
    async signOut(runtime) {
      of(runtime)
      const bin = which(runtime)
      if (bin) await run(spawn, bin, runtime === 'claude' ? ['auth', 'logout'] : ['logout'])
      await this.drop(runtime)
    },
    /** An account sign-in took over (or a sign-out): the key let go, so it does not shadow the account. */
    async drop(runtime) {
      const k = of(runtime)
      if (runtime === 'claude' && (await claudeKey())) await store().unset(k.stored) // only the key set here
      if (box) await vault('DELETE', vaultName(k)).catch(() => {})
    },
    /** A run's (and a status probe's) environment: Claude Code's key; Codex reads its own auth.json. */
    async env(runtime) {
      if (runtime !== 'claude') return null
      const v = await claudeKey()
      return v ? { ANTHROPIC_API_KEY: v } : null
    },
  }
}
