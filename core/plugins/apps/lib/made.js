// The person's own apps, made by an agent from what they asked (docs/design/agent-control.md; Ethan: "创建一个 app …
// 在这个 Agent OS 上可以工作的各种东西"): one web page each — HTML with its script and style in it — kept in
// ~/.ruyix/made/<id>/: app.json (its name, icon, what it does, its version), index.html, and every earlier version in
// versions/<n>.html (the last 20). The page opens one in a window of the desk, in an iframe with only scripts allowed
// (sandbox="allow-scripts", no same origin: it never reaches Ruyix's sign-in), in the dock and the App Center's 「我做的」.
// Removing one puts it aside (removed/<id>-<time>/), so it can come back.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_HTML = 512 * 1024
const KEEP = 20
const ID = /^[a-z][a-z0-9-]{1,31}$/
const fail = (code, message) => Object.assign(new Error(message), { code })
const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** An id from a name: its latin words, else made-<time> (a name in Chinese only). */
export function idOf(name, taken = () => false, now = Date.now) {
  const base = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  let id = ID.test(base) ? base : `app-${now().toString(36)}`
  for (let n = 2; taken(id); n++) id = `${(ID.test(base) ? base : 'app').slice(0, 26)}-${n}`
  return id
}

export function createMade({ home, now = Date.now }) {
  const root = join(home, 'made')
  const dir = id => join(root, id)
  const must = id => { if (!ID.test(String(id)) || !existsSync(join(dir(id), 'app.json'))) throw fail('noMade', `no app of the person's own called ${id} (made_list)`); return String(id) }
  const meta = id => JSON.parse(readFileSync(join(dir(id), 'app.json'), 'utf8'))
  const html = id => readFileSync(join(dir(id), 'index.html'), 'utf8')
  const check = h => {
    const s = String(h ?? '')
    if (!s.trim()) throw fail('noHtml', 'an app is a web page: give its HTML (with its script and style in it)')
    if (Buffer.byteLength(s) > MAX_HTML) throw fail('tooBig', `at most ${MAX_HTML / 1024} KB of HTML`)
    return s
  }
  const write = (id, m, h) => {
    mkdirSync(join(dir(id), 'versions'), { recursive: true })
    writeFileSync(join(dir(id), 'index.html'), h)
    writeFileSync(join(dir(id), 'app.json'), `${JSON.stringify(m, null, 2)}\n`)
  }
  const keep = (id, m) => {
    // (the version being replaced, kept; the oldest beyond KEEP go)
    writeFileSync(join(dir(id), 'versions', `${m.version}.html`), html(id))
    writeFileSync(join(dir(id), 'versions', `${m.version}.json`), `${JSON.stringify(m)}\n`)
    const old = readdirSync(join(dir(id), 'versions')).filter(f => f.endsWith('.html')).map(f => Number(f.slice(0, -5))).sort((a, b) => a - b)
    for (const v of old.slice(0, Math.max(0, old.length - KEEP))) for (const ext of ['html', 'json']) rmSync(join(dir(id), 'versions', `${v}.${ext}`), { force: true })
  }
  const view = m => ({ id: m.id, name: m.name, icon: m.icon || 'AppWindow', summary: m.summary || '', version: m.version, createdAt: m.createdAt, updatedAt: m.updatedAt, by: m.by || null })
  return {
    list: () => (existsSync(root) ? readdirSync(root).filter(id => ID.test(id) && existsSync(join(dir(id), 'app.json'))).map(id => view(meta(id))).sort((a, b) => b.updatedAt - a.updatedAt) : []),
    /** One app: its record and its page (a version of it, when asked). */
    get(id, { version } = {}) {
      must(id)
      const m = meta(id)
      if (version == null || Number(version) === m.version) return { app: view(m), html: html(id) }
      const f = join(dir(id), 'versions', `${Number(version)}.html`)
      if (!existsSync(f)) throw fail('noVersion', `${id} has no version ${version} (it keeps the last ${KEEP})`)
      return { app: { ...view(m), version: Number(version) }, html: readFileSync(f, 'utf8') }
    },
    make({ name, icon, summary, html: h, by = null, id: want }) {
      const n = text(name, 60)
      if (!n) throw fail('noName', 'an app needs a name')
      const id = want && ID.test(want) && !existsSync(dir(want)) ? want : idOf(n, x => existsSync(dir(x)), now)
      const m = { id, name: n, icon: text(icon, 40) || 'AppWindow', summary: text(summary, 300), version: 1, createdAt: now(), updatedAt: now(), by: by && text(by, 200) }
      write(id, m, check(h))
      return view(m)
    },
    /** A change (a new page, a new name …): the version before it kept → { app, was } (was: the version to go back to). */
    edit(id, { name, icon, summary, html: h, by = null } = {}) {
      must(id)
      const m = meta(id), next = { ...m }
      if (name !== undefined) next.name = text(name, 60) || m.name
      if (icon !== undefined) next.icon = text(icon, 40) || m.icon
      if (summary !== undefined) next.summary = text(summary, 300)
      const page = h === undefined ? html(id) : check(h)
      keep(id, m)
      Object.assign(next, { version: m.version + 1, updatedAt: now(), by: by ? text(by, 200) : m.by })
      write(id, next, page)
      return { app: view(next), was: m.version }
    },
    /** Back to an earlier version — as a new version (nothing is lost going back). */
    restore(id, version) {
      const { html: h } = this.get(id, { version })
      const old = JSON.parse(readFileSync(join(dir(id), 'versions', `${Number(version)}.json`), 'utf8'))
      return this.edit(id, { name: old.name, icon: old.icon, summary: old.summary, html: h })
    },
    /** Put aside → where it went (bring it back with unremove). */
    remove(id) {
      must(id)
      mkdirSync(join(root, '.removed'), { recursive: true })
      const aside = `${id}-${now()}`
      renameSync(dir(id), join(root, '.removed', aside))
      return aside
    },
    unremove(aside) {
      const m = /^([a-z][a-z0-9-]{1,31})-\d+$/.exec(String(aside || ''))
      if (!m || !existsSync(join(root, '.removed', aside))) throw fail('noMade', `nothing put aside as ${aside}`)
      if (existsSync(dir(m[1]))) throw fail('taken', `there is an app ${m[1]} again: rename that one first`)
      renameSync(join(root, '.removed', aside), dir(m[1]))
      return view(meta(m[1]))
    },
  }
}

const said = (zh, en) => ({ zh, en })
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

/** The tools: make one (it opens for the person), change it, go back a version, put it aside; `page`: the page's actions. */
export function madeTools({ made, page }) {
  const stamp = id => createHash('sha256').update(JSON.stringify(made.get(String(id)))).digest('hex')
  const unchanged = (id, after) => { if (!after || stamp(id) !== after) throw fail('appChanged', 'this app changed since: look at its current version before undoing') }
  const show = id => page('ruyix-apps:made', { id })
  return [
    {
      name: 'app_make',
      title: said('做一个小应用', 'Make an app'),
      effect: 'direct',
      description: 'Make the person a small app of their own — a tool, a board, a calculator, a game, a page that shows something: ONE self-contained web page (HTML with its <script> and <style> inside; libraries only from a CDN by full https URL; at most 512 KB). '
        + 'It opens at once in a window on their desk and stays in their dock and the App Center under 「我做的」. It runs in a sandbox: scripts yes, but no cookies or storage of Ruyix\'s, no pop-ups, no forms posting elsewhere — keep its data in memory or ask the person to copy it out. '
        + 'For a kind of records to keep and work on (ideas, notes, posts) make a studio instead (studio_create); for something done on a schedule, a workflow. icon: one of Calendar, CheckSquare, Clock, Cloud, Gamepad2, Heart, ListTodo, Map, Music, NotebookPen, Star, Sun, Timer, Wallet (or an App Center app\'s icon name; else a plain window).',
      parameters: schema({ name: { type: 'string', description: 'its name, as the person would call it' }, summary: { type: 'string', description: 'what it does, in a line (the person\'s language)' }, icon: { type: 'string' }, html: { type: 'string' } }, ['name', 'summary', 'html']),
      async run(args, { by } = {}) {
        const a = made.make({ ...args, by })
        show(a.id)
        return { text: `Made "${a.name}" (${a.id}); it opens on the person's desk. Change it with app_edit { id: "${a.id}", html }.`, summary: said(`做了小应用：${a.name}`, `Made an app: ${a.name}`), undo: { tool: 'app_drop', args: { id: a.id, after: stamp(a.id) } } }
      },
    },
    {
      name: 'app_edit',
      title: said('改小应用', 'Change an app'),
      effect: 'direct',
      description: 'Change one of the person\'s own apps (made_list / find): its whole page (html: the full new page, not a part), or its name, summary, icon. The version before stays (app_get with version: the last 20); its window shows the change.',
      parameters: schema({ id: { type: 'string' }, html: { type: 'string' }, name: { type: 'string' }, summary: { type: 'string' }, icon: { type: 'string' } }, ['id']),
      async run({ id, ...change }, { by } = {}) {
        const { app, was } = made.edit(String(id), { ...change, by })
        show(app.id)
        return { text: `"${app.name}" is now version ${app.version}.`, summary: said(`改了小应用：${app.name}`, `Changed the app ${app.name}`), undo: { tool: 'app_back', args: { id: app.id, version: was, after: stamp(app.id) } } }
      },
    },
    {
      name: 'made_list',
      title: said('看我做的小应用', 'The person\'s own apps'),
      effect: 'read',
      description: 'The apps made for the person (app_make): id, name, what it does, version, when last changed. app_get gives one\'s page.',
      parameters: schema({}),
      async run() {
        const list = made.list()
        return { text: list.length ? list.map(a => `- ${a.id} | ${a.name} | ${a.summary} | v${a.version} | ${new Date(a.updatedAt).toISOString().slice(0, 16)}Z`).join('\n') : 'No apps of the person\'s own yet (app_make makes one).' }
      },
    },
    {
      name: 'app_get',
      title: said('看小应用的页面', 'An app\'s page'),
      effect: 'read',
      description: 'One of the person\'s own apps: its page (HTML) — before changing it — and, with version, an earlier one. Its versions: the last 20.',
      parameters: schema({ id: { type: 'string' }, version: { type: 'integer' } }, ['id']),
      async run({ id, version }) { const r = made.get(String(id), { version }); return { text: `${r.app.id} v${r.app.version} — ${r.app.name}: ${r.app.summary}\n\n${r.html}` } },
    },
    {
      name: 'app_remove',
      title: said('收起小应用', 'Put an app away'),
      effect: 'direct',
      description: 'Take one of the person\'s own apps out of the dock and the App Center — when they say so. It is put aside, not deleted: the undo brings it back.',
      parameters: schema({ id: { type: 'string' } }, ['id']),
      async run({ id }) {
        const a = made.get(String(id)).app, aside = made.remove(a.id)
        page('ruyix-apps:made-gone', { id: a.id })
        return { text: `"${a.name}" is put away.`, summary: said(`收起了小应用：${a.name}`, `Put away the app ${a.name}`), undo: { tool: 'app_unremove', args: { aside } } }
      },
    },
    // the undo ones (offered to no agent)
    { name: 'app_drop', effect: 'undo', description: 'Undo app_make.', parameters: schema({ id: { type: 'string' }, after: { type: 'string' } }, ['id', 'after']), async run({ id, after }) { unchanged(id, after); made.remove(String(id)); page('ruyix-apps:made-gone', { id }); return { text: `${id} is gone again.` } } },
    { name: 'app_back', effect: 'undo', description: 'Undo app_edit.', parameters: schema({ id: { type: 'string' }, version: { type: 'integer' }, after: { type: 'string' } }, ['id', 'version', 'after']), async run({ id, version, after }) { unchanged(id, after); const { app } = made.restore(String(id), version); show(app.id); return { text: `${app.name} is as it was (now v${app.version}).` } } },
    { name: 'app_unremove', effect: 'undo', description: 'Undo app_remove.', parameters: schema({ aside: { type: 'string' } }, ['aside']), async run({ aside }) { const a = made.unremove(aside); page('ruyix-apps:made-back', { id: a.id }); return { text: `${a.name} is back.` } } },
  ]
}
