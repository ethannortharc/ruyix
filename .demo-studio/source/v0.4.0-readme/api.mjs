// Calls a demo Ruyix's ops the way its pages do: sign in with the link (cookie), then POST /api/<plugin> { op, ... }.
//   import { signIn } from './api.mjs'; const api = await signIn(linkFile); await api.op('taskList', {})
import { readFileSync } from 'node:fs'

export async function signIn(linkFile) {
  const link = readFileSync(linkFile, 'utf8').trim()
  const origin = new URL(link).origin
  const res = await fetch(link, { redirect: 'manual' })
  const cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`no sign-in cookie (status ${res.status})`)
  const call = async (path, body) => {
    const r = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin }, body: JSON.stringify(body) })
    const text = await r.text()
    let json; try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
    if (!r.ok) throw Object.assign(new Error(`${body.op}: ${r.status} ${json.error || json.raw}`), { json })
    return json
  }
  return {
    origin, cookie, link,
    op: (op, args = {}) => call('/api/ruyix-workbench', { op, ...args }),
    at: (path, op, args = {}) => call(path, { op, ...args }),
  }
}
