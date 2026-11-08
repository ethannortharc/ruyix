// Skill packs: versioned sets of skills (folders with a SKILL.md), so a member's skills mean the same thing on every
// machine and a run can say which version it used.
//  - bundled: shipped inside a plugin (its skills/ folder), versioned with the plugin, registered through agentHub;
//  - git: a team repository pinned to a commit, kept as an immutable snapshot <home>/skills/<pack>/<sha>; "update"
//    moves the pin (the previous one stays for a rollback);
//  - workspace: the job's own .claude/skills / .dsh/skills (they go with the code at that version);
//  - local: only in this machine's ~/.claude|.dsh|.codex/skills — usable, but a team naming one is not portable.
// A member names a skill "<pack>/<skill>" (portable) or by its bare name (looked up: packs, workspace, local).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

export const PACK_ID = /^[a-z0-9][a-z0-9-]{1,40}$/
const fail = (code, params, message) => Object.assign(new Error(message), { code, params })
const TEXT_MAX = 256 << 10, FILES_MAX = 200
/** A file to show: its text (cut past TEXT_MAX), or that it is binary. */
function textOf(file) {
  const size = statSync(file).size
  const buf = readFileSync(file).subarray(0, TEXT_MAX)
  return buf.includes(0) ? { binary: true, size } : { text: buf.toString('utf8'), size, ...(size > TEXT_MAX && { cut: true }) }
}
/** The files of a skill's folder (its SKILL.md first), each with its size; tool folders left out. */
function filesOf(dir) {
  const out = []
  const walk = (d, depth) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out.length >= FILES_MAX || ['.git', 'node_modules', '__pycache__', '.venv'].includes(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1) } else if (e.isFile()) out.push({ path: relative(dir, p).split(sep).join('/'), size: statSync(p).size })
    }
  }
  walk(dir, 0)
  return out.sort((a, b) => (b.path === 'SKILL.md') - (a.path === 'SKILL.md') || a.path.localeCompare(b.path))
}
const short = sha => String(sha || '').slice(0, 10)

/** Folders with a SKILL.md directly under `root` → [{ name, description, dir }]. */
export async function scanSkills(root) {
  let entries = []
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!(e.isDirectory() || e.isSymbolicLink())) continue
    const dir = join(root, e.name)
    try {
      const head = (await readFile(join(dir, 'SKILL.md'), 'utf8')).slice(0, 4000)
      const description = head.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '').trim() || ''
      out.push({ name: e.name, description: description.slice(0, 300), dir })
    } catch { /* not a skill folder */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function createSkills({ home, log = () => {}, run = runGit }) {
  const root = join(home, 'skills')
  const file = join(home, 'skill-packs.json')
  // policy.local: whether members may use skills that are only on this machine or in a workspace (off: packs only, as in
  // a sandbox — nothing local is read or shown to them)
  let state = { git: {}, policy: { local: false } }
  try { state = { git: {}, policy: { local: false }, ...JSON.parse(readFileSync(file, 'utf8')) } } catch { /* none yet */ }
  const save = () => { mkdirSync(home, { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${file}.tmp`, file) }
  const bundled = new Map() // id → { id, title, dir, version, by }
  // a bundled pack that pins its skills itself (each skill at a version of its own): its hooks —
  // pin(names) → what a workflow carries for those skills; check(name, pin) → ok | fetch | missing; ensure(pin) → true
  // when it installed something; dirOf(name, pin) → the folder holding that skill at the pin (a folder of skill folders)
  const hooks = new Map()
  const fetching = new Map() // id → promise: one fetch per pack at a time

  const repo = id => join(root, id, 'repo.git')
  const snapshot = (id, sha) => join(root, id, sha)
  const gitPack = id => state.git[id]
  const packDir = p => (p.kind === 'bundled' ? p.dir : p.sha ? join(snapshot(p.id, p.sha), p.path || '') : null)

  /** Fetch the repository and make sure `sha`'s snapshot exists (sha: a commit, or the ref's tip). → the commit. */
  async function fetchTo(id, want, refresh = false) {
    const p = gitPack(id)
    if (!p) throw fail('noSkillPack', { id }, `no skill pack ${id}`)
    const cached = () => !refresh && /^[a-f0-9]{40}$/.test(want || '') && existsSync(snapshot(id, want))
    if (cached()) return want
    while (fetching.has(id)) await fetching.get(id).catch(() => {})
    if (cached()) return want
    const job = (async () => {
      mkdirSync(join(root, id), { recursive: true })
      if (!existsSync(repo(id))) await run(['clone', '--bare', '--quiet', p.git, repo(id)])
      else await run(['--git-dir', repo(id), 'fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'])
      const sha = (await run(['--git-dir', repo(id), 'rev-parse', `${want || p.ref}^{commit}`])).trim()
      if (!existsSync(snapshot(id, sha))) {
        const tmp = `${snapshot(id, sha)}.tmp`
        rmSync(tmp, { recursive: true, force: true })
        mkdirSync(tmp, { recursive: true })
        const tar = join(root, id, `${sha}.tar`)
        await run(['--git-dir', repo(id), 'archive', '--format=tar', '-o', tar, sha, ...(p.path ? [p.path] : [])])
        await untar(tar, tmp)
        rmSync(tar, { force: true })
        renameSync(tmp, snapshot(id, sha))
      }
      return sha
    })()
    fetching.set(id, job)
    try { return await job } finally { fetching.delete(id) }
  }

  /** A git pack without a pin yet (declared by a plugin, or imported with a team) gets its ref's tip now. */
  async function ensure(id) {
    const p = gitPack(id)
    if (!p || (p.sha && existsSync(snapshot(id, p.sha)))) return p
    let sha
    // a fetch that fails is kept with the pack (the Skills page and the setup check show why), until one succeeds
    try { sha = await fetchTo(id, p.sha || p.pin || p.ref) } catch (err) {
      if (state.git[id] === p) { Object.assign(p, { error: String(err.message || err).split('\n').filter(Boolean).at(-1)?.slice(0, 300) || 'fetch failed', errorAt: Date.now() }); save() }
      throw err
    }
    if (gitPack(id) !== p) throw fail('skillPackChanged', { id }, `skill pack ${id} changed while fetching; try again`)
    Object.assign(p, { sha, at: Date.now(), pin: undefined, error: undefined, errorAt: undefined })
    save()
    log(`skill pack ${id} pinned at ${short(sha)}`)
    return state.git[id]
  }

  const all = () => [
    ...[...bundled.values()].map(p => ({ ...p, kind: 'bundled' })),
    ...Object.values(state.git).map(p => ({ ...p, kind: 'git', version: p.sha ? short(p.sha) : null })),
  ]

  const api = {
    /** Only the live owner writes skill-packs.json; config imports wait here until it can adopt them. */
    takeImport() {
      const staged = join(home, 'import/skill-packs.json'), active = `${staged}.processing`
      if (!existsSync(staged) && !existsSync(active)) return []
      try {
        if (existsSync(staged)) renameSync(staged, active)
        const input = JSON.parse(readFileSync(active, 'utf8'))
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || (input.git != null && (typeof input.git !== 'object' || Array.isArray(input.git)))
          || (input.policy != null && (typeof input.policy !== 'object' || Array.isArray(input.policy)))
          || (input.policy?.local != null && typeof input.policy.local !== 'boolean')) throw new Error('invalid skill pack configuration')
        const sources = Object.entries(input.git || {}).map(([id, p]) => {
          if (!PACK_ID.test(id) || id === 'constructor' || !p || typeof p !== 'object'
            || (p.id != null && p.id !== id) || typeof p.git !== 'string' || !/^(https?:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(p.git)
            || (p.title != null && typeof p.title !== 'string') || (p.ref != null && typeof p.ref !== 'string') || (p.path != null && typeof p.path !== 'string')
            || (p.path && (/^[\/\\]/.test(p.path) || /(^|[\/\\])\.\.($|[\/\\])/.test(p.path)))
            || [p.sha, p.pin].some(sha => sha != null && (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)))) throw new Error(`invalid skill pack ${id}`)
          const source = { id, title: p.title, git: p.git.trim(), ref: p.ref || 'main', path: p.path ?? 'skills', sha: p.sha || p.pin || null }
          const old = gitPack(id)
          if (bundled.has(id) || (old && (old.git !== source.git || (old.ref || 'main') !== source.ref
            || (old.path ?? 'skills') !== source.path || (source.sha && (old.sha || old.pin) !== source.sha)))) throw new Error(`skill pack ${id}: source or pin conflicts with the installed pack`)
          return source
        })
        // Validate everything before changing shared state; existing packs (including any active fetch) stay owned here.
        api.adopt(sources)
        if (input.policy?.local != null) api.setPolicy({ local: input.policy.local })
        mkdirSync(join(home, 'import/done'), { recursive: true })
        renameSync(active, join(home, 'import/done/skill-packs.json'))
        return [{ ok: true, text: `Agent Hub skill packs: ${sources.length} received` }]
      } catch (err) { return [{ ok: false, text: `Agent Hub skill packs: ${err?.message || err}` }] }
    },
    /** A plugin's own skills (bundled), or a git pack it needs (declared: added unpinned when this machine has none). */
    register(pack) {
      if (!PACK_ID.test(pack.id)) throw new Error(`bad skill pack id ${pack.id}`)
      if (pack.git) {
        if (!state.git[pack.id]) { state.git[pack.id] = { id: pack.id, title: pack.title || pack.id, git: pack.git, ref: pack.ref || 'main', path: pack.path ?? 'skills', sha: null, by: pack.by || null }; save() }
        return () => {}
      }
      bundled.set(pack.id, { id: pack.id, title: pack.title || pack.id, dir: pack.dir, version: String(pack.version || ''), by: pack.by || null })
      const own = { pin: pack.pin, check: pack.check, ensure: pack.ensure, dirOf: pack.dirOf }
      if (Object.values(own).some(Boolean)) hooks.set(pack.id, own)
      else hooks.delete(pack.id)
      return () => { bundled.delete(pack.id); hooks.delete(pack.id) }
    },

    /** Every pack with its skills (git packs without a pin list none until fetched). */
    async list() {
      return Promise.all(all().map(async p => ({ ...p, dir: packDir(p), skills: packDir(p) ? await scanSkills(packDir(p)) : [] })))
    },

    /** The skills a member can pick from here: packs first (as pack/skill), then the workspace's and this machine's. */
    async catalog(cwds) {
      const out = []
      for (const p of await api.list()) for (const s of p.skills) out.push({ ref: `${p.id}/${s.name}`, name: s.name, description: s.description, pack: p.id, kind: p.kind, version: p.version || null, dir: s.dir })
      const seen = new Set(out.map(s => s.name))
      for (const [kind, roots] of [['workspace', [cwds].flat().filter(Boolean).flatMap(c => [join(c, '.claude', 'skills'), join(c, '.dsh', 'skills')])], ['local', localRoots()]]) {
        for (const r of roots) for (const s of await scanSkills(r)) if (!seen.has(s.name)) { seen.add(s.name); out.push({ ref: s.name, name: s.name, description: s.description, pack: null, kind, version: null, dir: s.dir }) }
      }
      return out
    },

    /** One skill to read (the Skills page's detail): its SKILL.md and the files beside it. ref: pack/skill, or a local one's name. */
    async show(ref, cwds) {
      const s = await api.skillOf(ref, cwds)
      return { ref: s.ref, name: s.name, pack: s.pack, kind: s.kind, version: s.version, description: s.description || '', doc: textOf(join(s.dir, 'SKILL.md')).text || '', files: filesOf(s.dir) }
    },
    /** A file of a skill (a script it runs, a reference it reads), as text; a path out of its folder is refused. */
    async file(ref, path, cwds) {
      const s = await api.skillOf(ref, cwds)
      const base = resolve(s.dir), to = resolve(base, String(path || ''))
      if (!to.startsWith(base + sep)) throw fail('badPath', { path: String(path) }, `${path} is not in the skill's folder`)
      if (!existsSync(to)) throw fail('noFile', { path: String(path) }, `the skill has no ${path}`)
      return { path: String(path), ...textOf(to) }
    },
    async skillOf(ref, cwds) {
      const hit = (await api.catalog(cwds)).find(s => s.ref === String(ref || '') && s.dir)
      if (!hit) throw fail('noSkill', { ref: String(ref) }, `no skill ${ref} here`)
      return hit
    },

    async add({ id, git, ref = 'main', path = 'skills', title }) {
      const pid = String(id || '').trim()
      if (!PACK_ID.test(pid)) throw fail('badPackId', {}, 'a pack id is 2–41 lowercase letters, digits or dashes')
      if (bundled.has(pid) || state.git[pid]) throw fail('packExists', { id: pid }, `skill pack ${pid} exists already`)
      if (!/^(https?:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(String(git || ''))) throw fail('badPackGit', {}, 'give the git repository URL (https://, ssh:// or git@)')
      state.git[pid] = { id: pid, title: String(title || pid).slice(0, 80), git: String(git).trim(), ref: String(ref || 'main').trim(), path: String(path ?? '').replace(/^\/+|\/+$/g, ''), sha: null, by: null }
      save()
      try { await ensure(pid) } catch (err) { delete state.git[pid]; save(); throw fail('skillGit', { error: err.message }, err.message) }
      return (await api.list()).find(p => p.id === pid)
    },

    /** What the ref's tip would change: commits and skills touched since the pin. */
    async checkUpdate(id) {
      const p = await ensure(id)
      if (!p) throw fail('noSkillPack', { id }, `no git skill pack ${id}`)
      await fetchTo(id, p.sha, true) // refreshes the clone
      const tip = (await run(['--git-dir', repo(id), 'rev-parse', `${p.ref}^{commit}`])).trim()
      if (tip === p.sha) return { id, current: p.sha, tip, upToDate: true, commits: [], skills: [] }
      const scope = p.path ? ['--', p.path] : []
      const commits = (await run(['--git-dir', repo(id), 'log', '--format=%h %cs %an: %s', '-20', `${p.sha}..${tip}`, ...scope])).trim().split('\n').filter(Boolean)
      const files = (await run(['--git-dir', repo(id), 'diff', '--name-only', p.sha, tip, ...scope])).trim().split('\n').filter(Boolean)
      const skills = [...new Set(files.map(f => (p.path ? f.slice(p.path.length + 1) : f).split('/')[0]).filter(Boolean))]
      return { id, current: p.sha, tip, upToDate: false, commits, skills }
    },

    /** Move the pin (to the ref's tip, or a given commit — the previous pin for a rollback). */
    async update(id, to) {
      const p = await ensure(id)
      if (!p) throw fail('noSkillPack', { id }, `no git skill pack ${id}`)
      const sha = await fetchTo(id, to || p.ref)
      if (gitPack(id) !== p) throw fail('skillPackChanged', { id }, `skill pack ${id} changed while fetching; try again`)
      if (sha !== p.sha) { state.git[id] = { ...p, prev: p.sha, sha, at: Date.now() }; save(); log(`skill pack ${id}: ${short(p.sha)} → ${short(sha)}`) }
      return (await api.list()).find(x => x.id === id)
    },

    remove(id) {
      if (fetching.has(id)) throw fail('skillGitBusy', { id }, `skill pack ${id} is being fetched; wait for it to finish`)
      if (!state.git[id]) throw fail('noSkillPack', { id }, `no git skill pack ${id}`)
      delete state.git[id]
      save()
      rmSync(join(root, id), { recursive: true, force: true })
      return { ok: true }
    },

    /** A git pack at a commit (a workflow's pin): adopted from `pin.git` when this machine lacks the pack, that commit fetched. */
    async dirAt(id, pin) {
      if (!gitPack(id)) {
        if (!pin.git) throw fail('noSkillPack', { id }, `no skill pack ${id} here, and no source to fetch it from`)
        api.adopt([{ id, git: pin.git, ref: pin.ref, path: pin.path, sha: pin.sha }])
      }
      const sha = await fetchTo(id, pin.sha)
      return packDir({ ...gitPack(id), kind: 'git', sha })
    },
    /**
     * How a step's skills stand here, without fetching: ok (here, at the pin) | fetch (its source is known: fetched when
     * needed, or by ensure) | missing. → [{ ref, status, error? }]
     */
    async check(refs, pins = {}) {
      const out = []
      for (const ref of refs || []) {
        const [pack, name] = ref.includes('/') ? ref.split('/') : [null, ref]
        if (!pack) { out.push({ ref, status: (await api.resolve([ref])).every(x => !x.missing) ? 'ok' : 'missing' }); continue }
        const pin = pins?.[pack], b = bundled.get(pack), g = gitPack(pack), h = hooks.get(pack)
        if (b && h?.check) { out.push({ ref, status: await h.check(name, pin) }); continue }
        if (b) { out.push({ ref, status: (await scanSkills(b.dir)).some(x => x.name === name) ? 'ok' : 'missing', ...(pin?.version && pin.version !== b.version && { drift: b.version }) }); continue }
        const want = pin?.sha || g?.sha
        const sha = g && want && existsSync(snapshot(pack, want)) ? want : null
        if (sha && g) { out.push({ ref, status: (await scanSkills(join(snapshot(pack, sha), g.path || ''))).some(x => x.name === name) ? 'ok' : 'missing' }); continue }
        out.push({ ref, status: g || pin?.git ? 'fetch' : 'missing', ...(g?.error && { error: g.error }) })
      }
      return out
    },
    /** A workflow's git packs, each at its commit (adopted and fetched now). → { fetched: [id], failed: [{ id, error }] } */
    async ensurePins(pins = {}) {
      const fetched = [], failed = []
      for (const [id, pin] of Object.entries(pins || {})) {
        const h = hooks.get(id)
        if (bundled.has(id) && h?.ensure) {
          try { if (await h.ensure(pin)) fetched.push(id) } catch (err) { failed.push({ id, error: String(err.message || err).split('\n').filter(Boolean).at(-1)?.slice(0, 300) }) }
          continue
        }
        if (!pin?.sha || bundled.has(id)) continue
        try { await api.dirAt(id, pin); fetched.push(id) } catch (err) { failed.push({ id, error: String(err.message || err).split('\n').filter(Boolean).at(-1)?.slice(0, 300) }) }
      }
      return { fetched, failed }
    },
    /** Where a pack's skills are now (fetched when it has no pin yet). */
    async dirOf(id) {
      const b = bundled.get(id)
      if (b) return b.dir
      const p = await ensure(id)
      if (!p) throw fail('noSkillPack', { id }, `no skill pack ${id}`)
      return packDir({ ...p, kind: 'git' })
    },
    version: id => (bundled.get(id)?.version || (gitPack(id)?.sha ? short(gitPack(id).sha) : null)),
    /** The source of git packs a team names (for its export). */
    sources: ids => ids.map(id => gitPack(id)).filter(Boolean).map(({ id, title, git, ref, path, sha }) => ({ id, title, git, ref, path, sha })),
    /**
     * What a workflow carries for its packs: a git pack's source and pinned commit, a bundled pack's version — and, for a
     * pack that pins its skills itself, what its hook says for the skills the workflow names (`refs`: pack/skill).
     */
    pins: (ids, refs = []) => ids.map(id => {
      if (bundled.has(id)) {
        const pin = hooks.get(id)?.pin
        const names = (refs || []).map(String).filter(r => r.startsWith(`${id}/`)).map(r => r.slice(id.length + 1))
        return { id, version: bundled.get(id).version || '', ...(pin && pin(names)) }
      }
      return gitPack(id) ? { id, git: gitPack(id).git, ref: gitPack(id).ref, path: gitPack(id).path ?? 'skills', ...(gitPack(id).sha && { sha: gitPack(id).sha }) } : null
    }).filter(Boolean),
    /** An imported team's packs this machine lacks: added, pinned at the exporter's commit (fetched on first use). */
    adopt(sources) {
      const added = []
      for (const s of Array.isArray(sources) ? sources : []) {
        if (!PACK_ID.test(String(s?.id)) || bundled.has(s.id) || state.git[s.id] || !s.git) continue
        state.git[s.id] = { id: s.id, title: String(s.title || s.id).slice(0, 80), git: String(s.git), ref: String(s.ref || 'main'), path: String(s.path ?? 'skills'), sha: null, pin: s.sha || null, by: null }
        added.push(s.id)
      }
      if (added.length) save()
      return added
    },

    /**
     * A member's skill names → what each is, here: { ref, name, kind, pack, version, dir, description } or
     * { ref, missing }. "pack/skill" only from that pack; a bare name from the packs, then the workspace, then local.
     */
    policy: () => ({ ...state.policy }),
    setPolicy({ local }) { state.policy = { ...state.policy, local: !!local }; save(); return api.policy() },

    /**
     * pins: a workflow's packs ({ [pack]: { sha, git, ref, path } | { version } }): a git pack at that commit (this
     * machine's pin otherwise; a pack it lacks is adopted from the source given), a bundled one as it is here.
     */
    async resolve(refs, cwd, pins = {}) {
      const out = []
      for (const ref of refs || []) {
        const [pack, name] = ref.includes('/') ? ref.split('/') : [null, ref]
        let hit = null
        if (pack) {
          try {
            const pin = pins?.[pack], h = bundled.has(pack) && hooks.get(pack)
            const dir = h?.dirOf ? (await h.dirOf(name, pin)) || await api.dirOf(pack) : pin?.sha && !bundled.has(pack) ? await api.dirAt(pack, pin) : await api.dirOf(pack)
            const s = (await scanSkills(dir)).find(x => x.name === name)
            if (s) hit = { ...s, kind: bundled.has(pack) ? 'bundled' : 'git', pack, version: pin?.sha && !bundled.has(pack) ? short(pin.sha) : api.version(pack) }
          } catch (err) { out.push({ ref, name, missing: true, error: err.message }); continue }
        } else {
          for (const p of all()) {
            const dir = packDir(p)
            const s = dir && (await scanSkills(dir)).find(x => x.name === name)
            if (s) { hit = { ...s, kind: p.kind, pack: p.id, version: p.version || null }; break }
          }
          for (const [kind, roots] of [['workspace', cwd ? [join(cwd, '.claude', 'skills'), join(cwd, '.dsh', 'skills')] : []], ['local', localRoots()]]) {
            if (hit || !state.policy.local) break // packs only: a local skill does not count
            for (const r of roots) { const s = (await scanSkills(r)).find(x => x.name === name); if (s) { hit = { ...s, kind, pack: null, version: null }; break } }
          }
        }
        out.push(hit ? { ref, ...hit } : { ref, name, missing: true })
      }
      return out
    },
  }
  return api
}

const localRoots = () => [join(homedir(), '.claude', 'skills'), join(homedir(), '.dsh', 'skills'), join(homedir(), '.codex', 'skills'), join(homedir(), '.agents', 'skills')]

function runGit(args) {
  return new Promise((resolve, reject) => execFile('git', args, { timeout: 300000, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(-600))) : resolve(stdout))))
}

const untar = (file, dir) => new Promise((resolve, reject) => execFile('tar', ['-xf', file, '-C', dir], { timeout: 120000 },
  (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(-400))) : resolve())))
