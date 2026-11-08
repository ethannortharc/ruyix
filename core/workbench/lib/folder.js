// A folder's files that an agent's session made or changed (docs/design/agent-work.md §4: the viewer shows them) — found
// by when they changed, the latest first; never outside the folder, never through a link, not in the folders tools fill
// (dependencies, caches, version control, hidden ones).
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SKIP = new Set(['node_modules', 'Library', 'dist', 'build', 'target', 'vendor', '__pycache__', 'venv', 'coverage'])

/** The files under `dir` changed since `since` (ms) → [{ path, size, at }], the latest first, at most `max`. */
export function changedFiles(dir, since = 0, { max = 200, scan = 8000, depth = 6 } = {}) {
  const out = []
  let seen = 0, root
  try { root = realpathSync(dir) } catch { return out }
  const walk = (abs, rel, d) => {
    if (d > depth) return
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (++seen > scan) return
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const p = rel ? `${rel}/${e.name}` : e.name
      // (a link is neither: not followed)
      if (e.isDirectory()) walk(join(abs, e.name), p, d + 1)
      else if (e.isFile()) { try { const st = statSync(join(abs, e.name)); if (st.mtimeMs >= since) out.push({ path: p, size: st.size, at: Math.round(st.mtimeMs) }) } catch { /* gone meanwhile */ } }
    }
  }
  walk(root, '', 0)
  return out.sort((a, b) => b.at - a.at).slice(0, max)
}
