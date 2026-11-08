// An app display's windows (xwin.py, through libX11): their list, and one brought to the front — the desk's open things
// show each folder a file manager has open as a row of its own, and a click shows that one.
import { execFile as nodeExecFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const XWIN = join(dirname(fileURLToPath(import.meta.url)), 'xwin.py')

/** A file manager's window title → its folder (Thunar: «docs - Thunar», «docs - File Manager»; GNOME Files: «docs»). */
export const folderOf = title => String(title || '').replace(/\s+[-–—]\s+(Thunar|File Manager|文件管理器|Files|文件)$/i, '').trim()

export function createWindows({ env = process.env, execFile = nodeExecFile, python = 'python3' } = {}) {
  const run = (display, args) => new Promise((resolve, reject) => execFile(python, ['-I', XWIN, ...args], { env: { ...env, DISPLAY: `:${display}` }, timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(String(out)))))
  return {
    /** The windows on display :n → [{ id, name }] (none when it cannot be read). */
    async list(display) {
      if (!Number.isInteger(display)) return []
      const out = await run(display, ['list']).catch(() => '[]')
      try { const l = JSON.parse(out); return Array.isArray(l) ? l.filter(w => Number.isInteger(w?.id)).map(w => ({ id: w.id, name: String(w.name || '').slice(0, 300) })) : [] } catch { return [] }
    },
    /** One of them to the front → false when it is not there any more. */
    async activate(display, id) {
      if (!Number.isInteger(display) || !Number.isInteger(id) || id <= 0) return false
      return run(display, ['activate', String(id)]).then(() => true, () => false)
    },
  }
}
