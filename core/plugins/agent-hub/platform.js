// What differs on Windows, in one place: how a command is found and started (npm's .cmd shims cannot be spawned
// directly), how a folder or a file is linked without administrator rights, and how a task's whole process tree stops.
import { spawn } from 'node:child_process'
import { copyFileSync, linkSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

export const WIN = process.platform === 'win32'
/** The names a command may have on disk: itself, and on Windows with each of PATHEXT's endings (codex.cmd, claude.exe). */
export const commandNames = name => (WIN && !extname(name) ? [...String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map(e => name + e.toLowerCase()), name] : [name])

/**
 * How to start `bin` with `args` → [command, args]. On Windows a .cmd/.bat file only runs through cmd.exe, which
 * mangles arguments with newlines or quotes (a prompt); an npm shim ("%dp0%\node_modules\…\cli.js" %*) is started as
 * `node <its script>` instead, and anything else through cmd.exe.
 */
export function launch(bin, args = [], win = WIN, depth = 0) {
  if (!win || !/\.(cmd|bat)$/i.test(bin)) return [bin, args]
  try {
    const text = readFileSync(bin, 'utf8')
    const m = /"%~?dp0%?\\?([^"%]+\.[cm]?js)"/i.exec(text)
    if (m) return [process.execPath, [join(dirname(bin), ...m[1].split('\\')), ...args]]
    // a .cmd that only calls another (the agent installer's own, in ~/.local/bin): that one
    const next = /^@"([^"]+\.(?:cmd|bat))" %\*$/i.exec(text.trim())
    if (next && depth < 3) return launch(next[1], args, win, depth + 1)
  } catch { /* unreadable: through cmd.exe */ }
  return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', bin, ...args]]
}

/** A folder linked at `path` — a junction on Windows (no administrator rights or developer mode needed). */
export const linkDir = (target, path) => symlinkSync(target, path, WIN ? 'junction' : 'dir')

/** A file at `path` that is `target`: a symlink; on Windows (where one needs rights) a hard link, else a copy. */
export function linkFile(target, path) {
  try { symlinkSync(target, path, 'file') } catch (err) {
    if (!WIN) throw err
    try { linkSync(target, path) } catch { copyFileSync(target, path) }
  }
}

/** Stop a child started with `detached: !WIN` and everything it started: its process group, or on Windows its tree. */
export function stopTree(child, signal = 'SIGTERM') {
  if (WIN) {
    if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    return
  }
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* gone */ } }
}
