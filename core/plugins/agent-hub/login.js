// Signing a CLI runtime in from Agents → Runtimes: the CLI's own login, run here and shown in the page — Claude Code's
// link and a pasted code (`claude auth login`, through a pty: it asks for the code only on a terminal), Codex's device
// code (`codex login --device-auth`: a link and a code to confirm in any browser). In a nookbox box the login's tokens
// are captured at the gateway into the host's vault: the box binds that capture first (nookbox.internal/v1/logins/<cli>),
// and afterwards the CLI's own credential file must hold placeholders only — said plainly when it does not.
import { spawn as defaultSpawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WIN, launch } from './platform.js'

const fail = (code, params, message) => Object.assign(new Error(message), { code, params })
const LIMIT_MS = 15 * 60e3
// OSC sequences (a terminal hyperlink wraps the URL) and CSI codes out of a terminal's output
export const plain = t => String(t).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`
export const loginCommand = (runtime, bin, platform = process.platform) => runtime !== 'claude' ? launch(bin, ['login', '--device-auth'])
  : platform === 'win32' ? launch(bin, ['auth', 'login'])
    : ['script', platform === 'darwin' ? ['-q', '/dev/null', bin, 'auth', 'login'] : ['-q', '-c', `${quote(bin)} auth login`, '/dev/null']]

/** Where each CLI keeps its sign-in (to tell a vault placeholder from a real token after a box login). */
export const CREDENTIAL_FILES = {
  claude: home => join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json'),
  codex: home => join(process.env.CODEX_HOME || join(home, '.codex'), 'auth.json'),
}

export function createLogin({ which, spawn = defaultSpawn, box = process.env.NOOKBOX_API || null, fetchFn = globalThis.fetch, home = homedir(), linkMs = 30000 } = {}) {
  let s = null // the current sign-in
  const view = (cur = s) => (cur ? { runtime: cur.runtime, status: cur.status, url: cur.url || '', code: cur.code || '', needsCode: cur.runtime === 'claude', error: cur.error || '', kept: cur.kept || null } : { status: 'idle' })
  const end = (cur, status, extra = {}) => {
    if (!cur || ['done', 'failed', 'cancelled'].includes(cur.status)) return
    Object.assign(cur, { status, ...extra })
    clearTimeout(cur.timer)
    if (cur.exited == null) cur.child?.kill()
    if (status === 'cancelled') cur.reject?.(fail('loginFailed', { detail: 'cancelled' }, 'sign-in cancelled'))
  }
  /** In a box: the gateway's capture for this CLI bound to the box first, else the tokens would land in the box. */
  async function capture(runtime) {
    if (!box) return
    const res = await fetchFn(new URL(`/v1/logins/${runtime}`, box), { method: 'POST', signal: AbortSignal.timeout(10000) }).catch(() => null)
    if (!res?.ok) throw fail('needLoginCapture', { runtime }, `this box's nookbox cannot keep a ${runtime} login on the host (update nookbox, or sign in from the host: nookbox login ${runtime} <box>)`)
  }
  /** After a box login: the CLI's credential file names placeholders (the host's vault has the tokens), real tokens, or none
   *  (a CLI that exits 0 with empty tokens has not signed in). */
  const keptWhere = runtime => {
    if (!box) return 'here'
    let text
    try { text = readFileSync(CREDENTIAL_FILES[runtime](home), 'utf8') } catch { return 'unknown' }
    if (/NKB[A-Za-z0-9]{32}/.test(text)) return 'vault'
    return /"\w*(?:token|key)"\s*:\s*"[^"]+"/i.test(text) ? 'box' : 'none'
  }
  return {
    state: () => view(),
    /** Starts the CLI's login: resolves once the page has something to show (a link; Codex's code too). */
    async start(runtime) {
      if (runtime !== 'claude' && runtime !== 'codex') throw fail('noLogin', { runtime }, `${runtime} signs in with a provider key, not a login`)
      const bin = which(runtime)
      if (!bin) throw fail('cliNotInstalled', { cli: runtime }, `${runtime} is not installed (Agents → Runtimes installs it)`)
      end(s, 'cancelled')
      const cur = s = { runtime, out: '', status: 'starting', exited: null }
      try { await capture(runtime) } catch (err) { end(cur, 'failed', { error: err.message }); throw err }
      if (s !== cur || cur.status !== 'starting') throw fail('loginFailed', { detail: 'cancelled' }, 'sign-in cancelled')
      // Claude Code's login wants a terminal: script(1) gives it one; Windows has none to give, and its CLI asks no less
      const [cmd, args] = loginCommand(runtime, bin)
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, BROWSER: WIN ? 'none' : 'true', NO_COLOR: '1' } })
      cur.child = child
      cur.timer = setTimeout(() => { if (s === cur) end(cur, 'failed', { error: 'the sign-in was not finished within 15 minutes' }) }, LIMIT_MS)
      return new Promise((resolve, reject) => {
        cur.reject = err => { clearTimeout(linkTimer); reject(err) }
        const linkTimer = setTimeout(() => { if (s === cur && !cur.url) { end(cur, 'failed', { error: 'the CLI printed no sign-in link' }); reject(fail('loginFailed', { detail: plain(cur.out).trim().slice(-300) }, 'the CLI printed no sign-in link')) } }, linkMs)
        const seen = d => {
          cur.out += d
          const text = plain(cur.out)
          cur.url ||= (runtime === 'claude' ? text.match(/https:\/\/claude\.(?:com|ai)\/\S+/) : text.match(/https:\/\/auth\.openai\.com\/\S+/))?.[0]
          if (runtime === 'codex') cur.code ||= text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0]
          if (cur.url && (runtime === 'claude' || cur.code) && cur.status === 'starting') { clearTimeout(linkTimer); cur.status = 'waiting'; resolve(view(cur)) }
        }
        child.stdout.on('data', seen)
        child.stderr.on('data', seen)
        child.stdin.on('error', () => {})
        child.on('error', err => { clearTimeout(linkTimer); cur.exited = -1; end(cur, 'failed', { error: err.message }); reject(err.code === 'ENOENT' ? fail('noPty', { cmd }, `${cmd} is not available here`) : err) })
        child.on('close', code => {
          cur.exited = code ?? -1
          clearTimeout(linkTimer)
          if (cur.status === 'cancelled') return
          const starting = cur.status === 'starting'
          const kept = code === 0 && !starting ? keptWhere(runtime) : null
          if (kept === 'none') { end(cur, 'failed', { kept }); return }
          if (kept) { Object.assign(cur, { status: 'done', kept }); clearTimeout(cur.timer); return }
          const error = plain(cur.out).trim().split('\n').filter(Boolean).at(-1)?.slice(0, 300) || `exit ${code}`
          end(cur, 'failed', { error })
          if (starting) reject(fail('loginFailed', { detail: error }, error))
        })
      })
    },
    /** Claude Code's code from the page Anthropic showed. */
    code(text) {
      if (!s || s.runtime !== 'claude' || s.status !== 'waiting') throw fail('noLogin', {}, 'no Claude Code sign-in is waiting for a code')
      const code = String(text || '').trim()
      if (!/^[\w#./~-]{8,512}$/.test(code)) throw fail('badCode', {}, 'paste the whole code the page showed')
      s.child.stdin.write(`${code}\n`)
      return view()
    },
    stop() { end(s, 'cancelled'); return view() },
  }
}
