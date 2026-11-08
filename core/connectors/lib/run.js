// A command with exactly the environment it is given — the inherited secrets are dropped first (the same rule as dsh
// uses for the MCP servers it starts) — and never a rejection: `code` -1 = could not start, 124 = timed out.
import { spawn } from 'node:child_process'

const SECRETISH = /KEY|PASSWORD|SECRET|TOKEN|COOKIE|CREDENTIAL/i
export const scrubbedEnv = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([k]) => !SECRETISH.test(k) && !k.startsWith('DSH_')))

export function run(cmd, args, { cwd, env = {}, input, timeout = 120000, signal, max = 8 << 20 } = {}) {
  return new Promise(resolve => {
    const started = Date.now()
    let stdout = '', stderr = '', timedOut = false, settled = false, child
    try { child = spawn(cmd, args, { cwd, env: { ...scrubbedEnv(), ...env }, signal }) } catch (err) { return resolve({ code: -1, stdout, stderr: err.message, ms: 0 }) }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
    const finish = (code, extra = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: timedOut ? 124 : code, stdout, stderr: stderr + extra + (timedOut ? `\n(timed out after ${timeout / 1000}s)` : ''), ms: Date.now() - started })
    }
    child.stdout.on('data', d => { if (stdout.length < max) stdout += d })
    child.stderr.on('data', d => { if (stderr.length < max) stderr += d })
    child.on('error', err => finish(-1, err.message))
    child.on('close', (code, sig) => finish(code ?? (sig ? 128 : -1)))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}
