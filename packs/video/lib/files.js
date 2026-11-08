import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const folderOf = run => run.folder || run.dir
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')

/** Local regular files only. Reject traversal, hidden metadata and every symlink component, including leaf links. */
export function inside(root, name, { file = false } = {}) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.includes('\0') || name.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw new Error('Use a relative file path inside the selected folder; traversal and symlinks are not allowed')
  const top = realpathSync(root), full = resolve(top, name)
  if (!full.startsWith(top + sep)) throw new Error('File is outside the selected folder')
  let at = top
  for (const part of relative(top, full).split(sep)) {
    at = join(at, part)
    if (existsSync(at) || lstatSync(at, { throwIfNoEntry: false })) {
      const stat = lstatSync(at)
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${name}`)
      if (at !== full && !stat.isDirectory()) throw new Error(`Not a folder: ${name}`)
    }
  }
  if (file && !lstatSync(full, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing regular file: ${name}`)
  return full
}
export const readJson = (run, name) => {
  const path = inside(folderOf(run), name, { file: true })
  if (lstatSync(path).size > 2 * 1024 * 1024) throw new Error(`${name} is larger than 2 MiB`)
  return JSON.parse(readFileSync(path, 'utf8'))
}
export function writeFile(run, name, bytes) {
  const path = inside(folderOf(run), name)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try { writeFileSync(tmp, bytes, { flag: 'wx' }); renameSync(tmp, path) } finally { rmSync(tmp, { force: true }) }
  return path
}
export const writeJson = (run, name, value) => writeFile(run, name, `${JSON.stringify(value, null, 2)}\n`)
export async function hashFile(path, signal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}
