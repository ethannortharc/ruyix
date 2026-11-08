// A run's versions: a shadow Git repository per run (runs/<id>/versions.git) whose work tree is the run's folder — the
// run's own (runs/<id>/work) or the one a person named. The folder gets no .git of its own, and a folder that is a Git
// repository already keeps its own untouched (Git never takes in a `.git`). A commit when the run starts, before a step
// when something changed meanwhile, and after every step; going back writes an earlier version's files back and commits
// that too — nothing is ever taken out of the history. What has no version (a file the folder's .gitignore hides, one
// too big, a repository nested in the folder) is never lost by going back: what the way back would overwrite or delete
// of it is moved aside first (runs/<id>/kept/<when>/), and the preview says so. Docs: docs/design/run-versions.md.
import { execFile } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { dirOf } from './subject.js'

/** A file this big gets no versions (it is listed as such); a folder with more files than this, none at all. */
export const BIG = 20 << 20
export const MAX_FILES = 20000
const MAX_LIST = 300 // the files a step's version names on the run (the rest: counted)
const TEXT_MAX = 400000
const EXCLUDE = ['# what a run\'s versions leave out (besides the folder\'s own .gitignore)', 'node_modules/', '.DS_Store', '__pycache__/', '*.pyc', '.venv/', '.cache/']
const LEFT_OUT = '# left out by Ruyix (too big, a repository of its own) — rewritten at each version'
const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' }
/** A file's content as the page shows it: an image as a data URL, text (cut past TEXT_MAX), else "binary". */
export function renderFile(p, size, read) {
  const ext = p.split('.').pop().toLowerCase()
  if (IMAGE[ext] && size <= 8 << 20) return { size, image: `data:${IMAGE[ext]};base64,${read().toString('base64')}` }
  if (size > 4 << 20) return { size, binary: true }
  const bytes = read()
  if (bytes.subarray(0, 8000).includes(0)) return { size, binary: true }
  const text = bytes.toString('utf8')
  return { size, text: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) : text, ...(text.length > TEXT_MAX && { cut: true }) }
}
const MARK = 'ruyix:' // a commit's last line: what it is, as JSON (the page words it, in the person's language)
const bad = (code, message, params) => Object.assign(new Error(message), { code, ...(params && { params }) })

// a name a file system may take for `.git`: any case, trailing dots or spaces, characters some systems ignore, an 8.3 short name
const IGNORABLE = /[­​-‏‪-‮⁠-⁤﻿]/g
const isGitName = x => { const n = String(x).replace(IGNORABLE, '').replace(/[. ]+$/, '').toLowerCase(); return n === '.git' || /^git~\d+$/.test(n) }

/** A path inside a run's folder, as the person or an agent gives it → the normalized relative path, or null when it leaves the folder or names a `.git`. */
export function relPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (!s || isAbsolute(s) || /^[A-Za-z]:/.test(s)) return null
  const n = normalize(s).split(sep).join('/')
  if (n === '.' || n.startsWith('../') || n === '..' || n.split('/').some(x => x === '' || isGitName(x))) return null
  return n
}

/** `git diff --name-status -z` (with renames) → [{ status: A|M|D|R|T, path, from? }]. */
export function parseNameStatus(out) {
  const parts = String(out).split('\0'), list = []
  for (let i = 0; i < parts.length && parts[i];) {
    const code = parts[i++]
    const st = code[0]
    if (st === 'R' || st === 'C') { list.push({ status: st, from: parts[i], path: parts[i + 1] }); i += 2 } else { list.push({ status: st, path: parts[i] }); i += 1 }
  }
  return list
}

/** What a commit's message carries: { kind, step?, status?, by?, … } (its subject line when it has none). */
export function markOf(body) {
  const line = String(body || '').split('\n').reverse().find(l => l.startsWith(MARK))
  try { return line ? JSON.parse(line.slice(MARK.length)) : null } catch { return null }
}

/**
 * Of what has no version (`loose`: paths, a directory with a trailing /), what going back would overwrite or delete:
 * one the way back writes or removes (`touched`), one inside a directory it writes over, a directory that becomes a file.
 */
export function inTheWay(touched, loose) {
  const t = [...new Set(touched)]
  return loose.filter(u => {
    const p = u.replace(/\/$/, '')
    return t.some(x => x === p || x.startsWith(`${p}/`) || p.startsWith(`${x}/`))
  })
}

/**
 * root: the workbench's home (runs live in <root>/runs/<id>); git: the command. The calls on one folder are serial (one
 * Git at a time; two runs on the same folder take turns). A version that cannot be made — Git missing, a folder too big,
 * a Git that fails — turns the run's versions off and says why (`off`); the run itself goes on.
 */
export function createVersions({ root, git = 'git', logger = null } = {}) {
  const queues = new Map()
  const keyOf = run => { try { return realpathSync(dirOf(run)) } catch { return `run:${run.id}` } }
  const serial = (run, fn) => {
    const id = keyOf(run)
    const prev = queues.get(id) || Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    queues.set(id, next.finally(() => { if (queues.get(id) === next) queues.delete(id) }).catch(() => {}))
    return next
  }
  const gitDir = run => join(root, 'runs', run.id, 'versions.git')
  const offFile = run => join(gitDir(run), 'ruyix-off')
  const peekIndex = run => join(gitDir(run), 'index.peek')
  const env = (run, index) => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
    // the person's own Git settings (hooks, signing, a pager, an fsmonitor) have no say here
    return { ...base, GIT_DIR: gitDir(run), GIT_WORK_TREE: dirOf(run), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C',
      GIT_AUTHOR_NAME: 'Ruyix', GIT_AUTHOR_EMAIL: 'ruyix@localhost', GIT_COMMITTER_NAME: 'Ruyix', GIT_COMMITTER_EMAIL: 'ruyix@localhost', ...(index && { GIT_INDEX_FILE: index }) }
  }
  /** One Git command on a run's repository → { code, stdout, stderr } (stdout a Buffer when `raw`); no hook, no fsmonitor ever runs. */
  const g = (run, args, { raw = false, input, index } = {}) => new Promise(resolve => {
    const child = execFile(git, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { env: env(run, index), cwd: dirOf(run), maxBuffer: 256 << 20, encoding: raw ? 'buffer' : 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 127) : 0, stdout, stderr: String(stderr || err?.message || '') })
    })
    if (input !== undefined) child.stdin.end(input)
  })
  const must = async (run, args, opts) => {
    const r = await g(run, args, opts)
    if (r.code !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim().split('\n').slice(-2).join(' ') || `exit ${r.code}`}`)
    return r.stdout
  }
  const offOf = run => { try { return readFileSync(offFile(run), 'utf8').trim() || 'off' } catch { return null } }
  const turnOff = (run, why) => {
    mkdirSync(gitDir(run), { recursive: true })
    writeFileSync(offFile(run), why)
    logger?.warn?.(`ruyix-workbench: ${run.id}: no versions — ${why}`)
    return null
  }
  const noVersions = run => bad('noVersions', offOf(run) || 'this run has no versions')
  const head = async run => { const r = await g(run, ['rev-parse', '--verify', '-q', 'HEAD']); return r.code === 0 ? r.stdout.trim() : null }
  const treeOf = async (run, commit) => (await must(run, ['rev-parse', `${commit}^{tree}`])).trim()
  const init = async run => {
    if (existsSync(join(gitDir(run), 'HEAD'))) return true
    if (!existsSync(dirOf(run))) return false
    mkdirSync(gitDir(run), { recursive: true })
    const r = await g(run, ['init', '-q'])
    if (r.code !== 0) { turnOff(run, r.code === 127 ? `git is not available here (${r.stderr.trim().slice(0, 200)})` : `git init failed: ${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}`); return false }
    for (const [k, v] of [['core.quotepath', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', '/dev/null'], ['core.fsmonitor', 'false']]) await must(run, ['config', k, v])
    mkdirSync(join(gitDir(run), 'info'), { recursive: true })
    writeFileSync(join(gitDir(run), 'info', 'exclude'), `${EXCLUDE.join('\n')}\n${LEFT_OUT}\n`)
    return true
  }

  /**
   * A path of the run's folder that is safe to read or write: the folder's own (no link on the way leads out of it, the
   * file itself no link, no `.git` on the way in any spelling the file system takes for it). → the absolute path; throws badPath.
   */
  const inside = (run, path) => {
    const p = relPath(path)
    if (!p) throw bad('badPath', 'not a path inside the run\'s folder')
    const top = realpathSync(dirOf(run)), full = join(dirOf(run), p)
    let near = dirname(full)
    while (!existsSync(near)) near = dirname(near)
    const real = realpathSync(near)
    if (real !== top && !real.startsWith(top + sep)) throw bad('badPath', `${p} leads out of the run's folder`)
    if (relative(top, real).split(sep).some(isGitName)) throw bad('badPath', `${p} is inside a .git`)
    let st = null
    try { st = lstatSync(full) } catch { /* not there yet */ }
    if (st?.isSymbolicLink()) throw bad('badPath', `${p} is a link`)
    return { p, full, st }
  }

  /**
   * What is left out of the versions now, written into the repository's exclude list (a file that stops being too big,
   * a repository that goes, come back in): files over BIG and repositories of their own inside the folder. `index`: the
   * index the look-up goes by (a preview's own). → { big, nested, count (files not in the index yet) }
   */
  const leaveOut = async (run, index) => {
    const file = join(gitDir(run), 'info', 'exclude')
    const had = readFileSync(file, 'utf8')
    const at = had.indexOf(LEFT_OUT)
    const base = at >= 0 ? had.slice(0, at) : `${had.replace(/\n?$/, '\n')}`
    const before = at >= 0 ? had.slice(at + LEFT_OUT.length).split('\n').filter(Boolean) : []
    const unpattern = l => l.replace(/^\//, '').replace(/\/$/, '').replace(/\\(.)/g, '$1')
    const loose = (await must(run, ['ls-files', '-z', '-o', '-m', '--exclude-standard'], { index })).split('\0').filter(Boolean)
    const big = [], nested = []
    for (const p of new Set([...loose, ...before.map(unpattern)])) {
      let st
      try { st = lstatSync(join(dirOf(run), p)) } catch { continue }
      if (st.isFile() && st.size > BIG) big.push(p)
      else if (st.isDirectory() && existsSync(join(dirOf(run), p, '.git'))) nested.push(p.replace(/\/$/, ''))
    }
    // a directory with a .git of its own that is new here (`cargo new`, `git init`), and one Git already took as a link
    for (const d of (await must(run, ['ls-files', '-z', '-o', '--directory', '--exclude-standard'], { index })).split('\0').filter(x => x.endsWith('/'))) {
      if (existsSync(join(dirOf(run), d, '.git'))) nested.push(d.replace(/\/$/, ''))
    }
    for (const l of (await must(run, ['ls-files', '-z', '-s'], { index })).split('\0').filter(Boolean)) if (l.startsWith('160000 ')) nested.push(l.slice(l.indexOf('\t') + 1))
    const left = [...new Set([...big, ...nested])]
    const esc = p => p.replace(/([*?[\]\\!# ])/g, '\\$1')
    const lines = [...new Set([...big.map(p => `/${esc(p)}`), ...nested.map(p => `/${esc(p)}/`)])]
    const next = `${base}${LEFT_OUT}\n${lines.join('\n')}${lines.length ? '\n' : ''}`
    if (next !== had) writeFileSync(file, next)
    if (left.length) await g(run, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...left], { index })
    return { big: [...new Set(big)], nested: [...new Set(nested)], count: loose.length }
  }
  const changedIn = async (run, commit) => parseNameStatus(await must(run, ['diff-tree', '-r', '-z', '--root', '--no-commit-id', '--name-status', '-M', commit]))
  const message = (subject, mark) => `${String(subject).slice(0, 200)}\n\n${MARK}${JSON.stringify(mark)}`

  /** The snapshot itself (the caller holds the folder's turn). */
  const snap = async (run, subject, mark = {}) => {
    if (offOf(run)) return null
    try {
      if (!(await init(run))) return null
      // (one Git at a time on a folder, in this process: a lock found now was left by one that crashed)
      rmSync(join(gitDir(run), 'index.lock'), { force: true })
      const before = await head(run)
      const { big, nested, count } = await leaveOut(run)
      if (!before && count > MAX_FILES) return turnOff(run, `the folder has ${count} files (more than ${MAX_FILES}): too many to keep versions of`)
      const add = await g(run, ['add', '-A'])
      // a Git that will not take the folder in: said, not a version quietly missing at every step from here on
      if (add.code !== 0) return turnOff(run, `git add failed: ${add.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)
      const same = before && (await g(run, ['diff', '--cached', '--quiet'])).code === 0
      const left = { ...(big.length && { big: big.slice(0, 20) }), ...(nested.length && { nested: nested.slice(0, 20) }) }
      if (same) return { commit: before, made: false, files: [], more: 0, ...left }
      await must(run, ['commit', '-q', '--no-verify', '--allow-empty', '-m', message(subject, { ...mark, ...left })])
      const commit = await head(run)
      const files = await changedIn(run, commit)
      return { commit, made: true, files: files.slice(0, MAX_LIST), more: Math.max(0, files.length - MAX_LIST), ...left }
    } catch (err) {
      logger?.warn?.(`ruyix-workbench: ${run.id}: version: ${err?.message || err}`)
      return null
    }
  }
  /**
   * Commit what the folder holds now, when it changed (the first version always). mark: { kind: start | step | outside |
   * edit | rewind, step?, status?, … } → { commit, made, files: [{ status, path, from? }], more, big?, nested? } — or null
   * when the run has no versions (off: offOf says why).
   */
  const snapshot = (run, subject, mark = {}) => serial(run, () => snap(run, subject, mark))

  /** What the folder holds now as a tree, without a commit (a preview changes nothing): its own index, by the same rules. */
  const treeNow = async run => {
    const index = peekIndex(run)
    rmSync(index, { force: true })
    const h = await head(run)
    if (h) await must(run, ['read-tree', h], { index })
    await leaveOut(run, index)
    await must(run, ['add', '-A'], { index })
    const tree = (await must(run, ['write-tree'], { index })).trim()
    return { index, tree, head: h }
  }
  /** What has no version in the folder (by `index`): ignored files and directories, what Git cannot take in (a nested repository). */
  const looseOf = async (run, index) => [
    ...(await must(run, ['ls-files', '-z', '-o', '-i', '--directory', '--exclude-standard'], { index })).split('\0'),
    ...(await must(run, ['ls-files', '-z', '-o', '--directory', '--exclude-standard'], { index })).split('\0'),
  ].filter(Boolean)
  const touchedBy = (list) => list.flatMap(f => [f.path, ...(f.from ? [f.from] : [])])

  const versions = {
    gitDir, snapshot, off: offOf,
    /** Whether the run has versions at all (a run from before them has none). */
    has: run => existsSync(join(gitDir(run), 'HEAD')) && !offOf(run),
    /** Every version, oldest first: [{ commit, at, subject, mark, parent }]. */
    async log(run) {
      if (!versions.has(run)) return []
      const r = await g(run, ['log', '--reverse', '--format=%H%x1f%at%x1f%P%x1f%s%x1f%b%x1e'])
      if (r.code !== 0) return []
      return r.stdout.split('\x1e').map(x => x.trim()).filter(Boolean).map(x => {
        const [commit, at, parents, subject, body] = x.split('\x1f')
        return { commit, at: Number(at) * 1000, parent: parents.split(' ')[0] || null, subject, mark: markOf(body) || { kind: 'other' } }
      })
    },
    /** What a version changed against the one before it: [{ status, path, from?, added, removed }] (lines; null for a binary file). */
    async changes(run, commit) {
      const c = await versions.resolve(run, commit)
      const list = await changedIn(run, c)
      const num = await must(run, ['diff-tree', '-r', '-z', '--root', '--no-commit-id', '--numstat', '-M', c])
      const lines = new Map()
      const parts = num.split('\0')
      for (let i = 0; i < parts.length && parts[i];) {
        const [a, d, p] = parts[i].split('\t')
        if (p === '') { lines.set(parts[i + 2], { a, d }); i += 3 } else { lines.set(p, { a, d }); i += 1 }
      }
      return list.map(f => { const n = lines.get(f.path); return { ...f, added: n && n.a !== '-' ? Number(n.a) : null, removed: n && n.d !== '-' ? Number(n.d) : null } })
    },
    /** What changed between two versions (`to`: the latest when not given): [{ status, path, from? }] — what a run made since it began. */
    async between(run, from, to = null) {
      const a = await versions.resolve(run, from), b = to ? await versions.resolve(run, to) : await head(run)
      if (!b || a === b) return []
      return parseNameStatus(await must(run, ['diff', '--name-status', '-z', '-M', a, b]))
    },
    /** A commit the run's repository has (a full or short id) → its full id; anything else throws. */
    async resolve(run, commit) {
      const c = String(commit || '')
      if (!/^[0-9a-f]{4,64}$/.test(c)) throw bad('noVersion', `not a version: ${c || '(none)'}`, { commit: c })
      const r = await g(run, ['rev-parse', '--verify', '-q', `${c}^{commit}`])
      if (r.code !== 0) throw bad('noVersion', `this run has no version ${c}`, { commit: c })
      return r.stdout.trim()
    },
    /** Whether version `a` is `b` or comes before it. */
    async isAncestor(run, a, b) {
      try { return (await g(run, ['merge-base', '--is-ancestor', await versions.resolve(run, a), await versions.resolve(run, b)])).code === 0 } catch { return false }
    },
    /** The files a version holds: [{ path, size }]. */
    async files(run, commit = 'HEAD') {
      const c = commit === 'HEAD' ? await head(run) : await versions.resolve(run, commit)
      if (!c) return []
      const out = await must(run, ['ls-tree', '-r', '-z', '--long', c])
      return out.split('\0').filter(Boolean).slice(0, 5000).map(l => { const [meta, path] = l.split('\t'); const size = meta.trim().split(/\s+/)[3]; return { path, size: size === '-' ? null : Number(size) } })
    },
    /** One file's versions, newest first (across renames): [{ commit, at, subject, mark, status, path }]. */
    async history(run, path) {
      const p = relPath(path)
      if (!p || !versions.has(run)) return []
      const r = await g(run, ['log', '--follow', '-M', '--name-status', '--format=%x1e%H%x1f%at%x1f%s%x1f%b%x1f', '--', p])
      if (r.code !== 0) return []
      return r.stdout.split('\x1e').filter(x => x.trim()).map(x => {
        const [commit, at, subject, body, rest = ''] = x.split('\x1f')
        const st = rest.trim().split('\n').find(l => /^[AMDRTC]\d*\t/.test(l)) || ''
        const cols = st.split('\t')
        return { commit, at: Number(at) * 1000, subject, mark: markOf(body) || { kind: 'other' }, status: (cols[0] || 'M')[0], path: cols.at(-1) || p }
      })
    },
    /**
     * A file as one version holds it — or, `WORK`, as the folder holds it now (what a person edits) → { blob, size, text |
     * image (a data URL) | binary, cut?, work? }. `blob`: the content's id (an edit says which copy it changed).
     */
    async show(run, commit, path) {
      if (commit === 'WORK') {
        const { p, full, st } = inside(run, path)
        if (!st?.isFile()) throw bad('noFile', `${p} is not in the folder`, { path: p })
        const blob = (await must(run, ['hash-object', '--', p])).trim()
        return { ...render(p, st.size, () => readFileSync(full)), blob, work: true }
      }
      const p = relPath(path)
      if (!p) throw bad('badPath', 'not a path inside the run\'s folder')
      const c = commit === 'HEAD' ? await head(run) : await versions.resolve(run, commit)
      const blob = c && await g(run, ['rev-parse', '--verify', '-q', `${c}:${p}`])
      if (!blob || blob.code !== 0) throw bad('noFile', `${p} is not in this version`, { path: p })
      const id = blob.stdout.trim()
      const size = Number((await must(run, ['cat-file', '-s', id])).trim())
      return { ...(await renderAsync(p, size, () => must(run, ['cat-file', 'blob', id], { raw: true }))), blob: id }
    },
    /** The difference between two versions (of one file, or all): unified diff text. */
    async diff(run, from, to, path) {
      const a = from ? await versions.resolve(run, from) : null
      const b = await versions.resolve(run, to)
      const p = path ? relPath(path) : null
      if (path && !p) throw bad('badPath', 'not a path inside the run\'s folder')
      const args = a ? ['diff', '--no-color', '-M', '--no-ext-diff', a, b] : ['show', '--no-color', '-M', '--no-ext-diff', '--format=', b]
      const out = await must(run, [...args, ...(p ? ['--', p] : [])])
      return out.length > TEXT_MAX ? `${out.slice(0, TEXT_MAX)}\n… (cut)` : out
    },
    /**
     * What going back to `commit` would do to the folder as it is now — nothing is committed, nothing changes: { tree (the
     * folder now: going back is refused if it differs then), target, files: [{ path, action: remove | restore | revert,
     * from? }], kept: [paths with no version the way back would overwrite or delete: they are moved aside instead] }.
     */
    async preview(run, commit) {
      if (!versions.has(run)) throw noVersions(run)
      const c = await versions.resolve(run, commit)
      return serial(run, async () => {
        const { index, tree } = await treeNow(run)
        try {
          const list = parseNameStatus(await must(run, ['diff-tree', '-r', '-z', '--name-status', '-M', c, tree]))
          const kept = inTheWay(touchedBy(list), await looseOf(run, index))
          return { tree, target: c, files: list.map(f => ({ path: f.path, ...(f.from && { from: f.from }), action: f.status === 'A' ? 'remove' : f.status === 'D' ? 'restore' : 'revert' })), kept }
        } finally { rmSync(index, { force: true }) }
      })
    },
    /**
     * The folder back to how `commit` had it (what came after it taken out, what it had written back) — then committed, so
     * the versions after it stay where they were. What changed outside the steps first gets a version of its own; what has
     * no version and is in the way is moved aside (`kept`, under `keptDir`). `expect`: the tree the person saw in the
     * preview — a folder that changed since is not touched (`changedMeanwhile`).
     */
    async rewind(run, commit, subject, mark, { expect } = {}) {
      if (!versions.has(run)) throw noVersions(run)
      const c = await versions.resolve(run, commit)
      return serial(run, async () => {
        const now = await snap(run, 'Changes outside the steps', { kind: 'outside' })
        if (!now) throw noVersions(run)
        if (expect && (await treeOf(run, now.commit)) !== expect) throw bad('changedMeanwhile', 'the folder changed since you looked at what going back would do: look again', { path: '' })
        const touched = touchedBy(parseNameStatus(await must(run, ['diff-tree', '-r', '-z', '--name-status', '-M', c, now.commit])))
        const kept = inTheWay(touched, await looseOf(run))
        let keptDir = null
        if (kept.length) {
          keptDir = join(root, 'runs', run.id, 'kept', new Date().toISOString().replace(/[:.]/g, '-'))
          for (const u of kept) {
            const rel = u.replace(/\/$/, ''), src = join(dirOf(run), rel), dst = join(keptDir, rel)
            mkdirSync(dirname(dst), { recursive: true })
            try { renameSync(src, dst) } catch (err) {
              if (err.code !== 'EXDEV') throw err
              cpSync(src, dst, { recursive: true, verbatimSymlinks: true }); rmSync(src, { recursive: true, force: true })
            }
          }
        }
        await must(run, ['read-tree', '-u', '--reset', c])
        await must(run, ['commit', '-q', '--no-verify', '--allow-empty', '-m', message(subject, { ...mark, ...(kept.length && { kept: kept.slice(0, 50) }) })])
        const made = await head(run)
        const files = await changedIn(run, made)
        return { commit: made, from: now.commit, target: c, files: files.slice(0, MAX_LIST), more: Math.max(0, files.length - MAX_LIST), kept, keptDir }
      })
    },
    /** What writing `content` to a file would change, against the folder as it is: { diff, blob (the file now; null: none), added, removed }. */
    async diffTo(run, path, content) {
      if (!versions.has(run)) throw noVersions(run)
      return serial(run, async () => {
        const { p, st } = inside(run, path)
        if (st && !st.isFile()) throw bad('badPath', `${p} is not a file`)
        const now = st ? (await must(run, ['hash-object', '-w', '--', p])).trim() : null
        const next = (await must(run, ['hash-object', '-w', '--stdin'], { input: String(content) })).trim()
        const empty = (await must(run, ['hash-object', '-w', '--stdin'], { input: '' })).trim()
        const diff = await must(run, ['diff', '--no-color', '--no-ext-diff', now || empty, next])
        const lines = diff.split('\n')
        return { diff: diff.length > TEXT_MAX ? `${diff.slice(0, TEXT_MAX)}\n… (cut)` : diff, blob: now, added: lines.filter(l => /^\+(?!\+\+ )/.test(l)).length, removed: lines.filter(l => /^-(?!-- )/.test(l)).length }
      })
    },
    /**
     * A person's edit of one file: what changed outside the steps first gets a version of its own; then the file is
     * written and committed as theirs (that file alone). `blob`: the copy they changed (the folder's, `show(…, 'WORK')`) —
     * when the file changed since, nothing is written. content: text, or { base64 }. → the version, with `path`.
     */
    async edit(run, path, content, { blob, by = 'person' } = {}) {
      if (!versions.has(run)) throw noVersions(run)
      const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(String(content?.base64 || ''), 'base64')
      if (bytes.length > BIG) throw bad('tooBig', 'too big to keep a version of')
      return serial(run, async () => {
        const { p, full, st } = inside(run, path)
        if (st && !st.isFile()) throw bad('badPath', `${p} is not a file`)
        if (blob !== undefined) {
          const was = st ? (await must(run, ['hash-object', '--', p])).trim() : null
          if ((blob || null) !== was) throw bad('changedMeanwhile', `${p} changed since you opened it: open it again`, { path: p })
        }
        await snap(run, 'Changes outside the steps', { kind: 'outside' })
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, bytes)
        const v = await snap(run, `Edited ${p}`, { kind: 'edit', path: p, by })
        return v && { ...v, path: p }
      })
    },
  }
  const render = renderFile
  async function renderAsync(p, size, read) {
    const ext = p.split('.').pop().toLowerCase()
    if ((IMAGE[ext] && size <= 8 << 20) || size <= 4 << 20) { const b = await read(); return render(p, size, () => b) }
    return { size, binary: true }
  }
  return versions
}
