// Drives: a connection whose type keeps files — list a folder, put files up in a batch, take files (or whole folders)
// down in a batch. What a pack's step calls ("upload these videos", "fetch this drama's episodes"), the same for any
// pack. Every request with a credential goes through the connection's client (its hosts only, audited, scrubbed); the
// bytes of a download come from the address the drive hands out, which carries no credential (`get`, audited).
import { createHash } from 'node:crypto'
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const clean = s => String(s || '').replace(/["\\/:*?|<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
const slice = (path, start, size) => {
  const fd = openSync(path, 'r'), buf = Buffer.alloc(size)
  try { const n = readSync(fd, buf, 0, size, start); return buf.subarray(0, n) } finally { closeSync(fd) }
}
/** A local path for a drive path under `dir`: its own name, made safe; nothing climbs out of `dir`. Pure. */
export function localPath(dir, rel) {
  const parts = String(rel).split('/').map(clean).filter(p => p && p !== '.' && p !== '..')
  const out = join(dir, ...(parts.length ? parts : ['file']))
  if (relative(dir, out).split(sep)[0] === '..') throw new Error(`not inside ${dir}: ${rel}`)
  return out
}

// ── 百度网盘 (open platform: xpan) ──
const BLOCK = 4 * 1024 * 1024 // the slice every member level accepts
const WHY = {
  '-6': '授权失效，到连接器页重新扫码授权', 111: '授权失效，到连接器页重新扫码授权', '-7': '文件名不合规，或这个应用不能访问这个位置（上传只能放在「我的应用数据/应用名称」里）',
  '-8': '已经有同名的文件或文件夹', '-9': '文件或文件夹不存在', 2: '参数错误', 6: '这个应用没有被允许访问网盘数据', 10: '转存或创建文件失败',
  31034: '调用太频繁，被百度限流了，过一会儿再试', 31024: '没有权限访问', 31066: '文件不存在', 31299: '第一个分片太小', 31364: '超出分片大小限制', 31023: '参数错误', 31326: '下载被防盗链拦下（User-Agent）', 31360: '下载地址过期了',
}
const explain = (data, status) => {
  const no = data?.errno ?? data?.error_code
  const why = no !== undefined ? WHY[String(no)] : ''
  return `${why || data?.errmsg || data?.show_msg || data?.error_msg || `HTTP ${status}`}${no !== undefined ? `（errno ${no}）` : ''}`
}
async function call(client, path, { method = 'GET', query = {}, form, body, signal, timeout = 60000, what = '', level = 'read' } = {}) {
  const q = new URLSearchParams(query).toString()
  const res = await client.request(`${path}${q ? `${path.includes('?') ? '&' : '?'}${q}` : ''}`, { method, level, timeout, signal, ...(form || body ? { body: form ? new URLSearchParams(form) : body } : {}) })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || Number(data.errno ?? 0) !== 0) throw Object.assign(new Error(`百度网盘${what ? `${what}失败` : ''}：${explain(data, res.status)}`), { code: 'driveFailed', errno: data?.errno ?? null, status: res.status })
  return data
}
/** The MD5 of each 4 MB slice of a file (one, of nothing, for an empty file). */
async function blocks(path) {
  const fh = await open(path, 'r'), out = [], buf = Buffer.alloc(BLOCK)
  try {
    for (;;) {
      let got = 0
      while (got < BLOCK) { const { bytesRead } = await fh.read(buf, got, BLOCK - got, null); if (!bytesRead) break; got += bytesRead }
      if (!got && out.length) break
      out.push(createHash('md5').update(buf.subarray(0, got)).digest('hex'))
      if (got < BLOCK) break
    }
  } finally { await fh.close() }
  return out
}
const entry = f => ({ id: String(f.fs_id), name: f.server_filename || basename(f.path || ''), path: f.path, size: Number(f.size) || 0, dir: Number(f.isdir) === 1, mtime: (Number(f.server_mtime) || 0) * 1000 })

const baidu = {
  /** The folder a connection's uploads go into: the application's own (in the app: 我的应用数据/<app name>). */
  root: conn => `/apps/${clean(conn.fields?.appName) || 'Ruyix'}`,
  /** One folder's entries (folders first). path: '/' is the whole drive. → { path, items: [{ id, name, path, size, dir, mtime }] } */
  async list(client, path = '/', { signal } = {}) {
    const items = []
    for (let start = 0; ; start += 1000) {
      const d = await call(client, '/rest/2.0/xpan/file', { query: { method: 'list', dir: path || '/', order: 'name', start, limit: 1000, web: 0 }, signal, what: '列文件' })
      items.push(...(d.list || []).map(entry))
      if ((d.list || []).length < 1000) break
    }
    return { path: path || '/', items: items.sort((a, b) => Number(b.dir) - Number(a.dir)) }
  },
  /** Every file under a folder, at any depth. → [{ id, name, path, size, rel (path inside the folder) }] */
  async files(client, path, { signal } = {}) {
    const out = []
    for (let start = 0, more = true; more;) {
      const d = await call(client, '/rest/2.0/xpan/multimedia', { query: { method: 'listall', path, recursion: 1, start, limit: 1000 }, signal, what: '列文件' })
      for (const f of d.list || []) if (Number(f.isdir) !== 1) out.push({ ...entry(f), rel: String(f.path).slice(path.replace(/\/$/, '').length + 1) })
      more = !!d.has_more && (d.list || []).length > 0
      start = Number(d.cursor) || start + (d.list || []).length
    }
    return out
  },
  /** A folder (made when it is not there). → { path, id } */
  async mkdir(client, path, { signal } = {}) {
    try {
      const d = await call(client, '/rest/2.0/xpan/file', { method: 'POST', query: { method: 'create' }, form: { path, isdir: 1, rtype: 0 }, signal, what: '建文件夹', level: 'write' })
      return { path: d.path || path, id: String(d.fs_id) }
    } catch (err) {
      if (String(err.errno) !== '-8') throw err
      const parent = path.replace(/\/[^/]*$/, '') || '/'
      const found = (await baidu.list(client, parent, { signal })).items.find(x => x.dir && x.path === path)
      if (!found) throw err
      return { path, id: found.id }
    }
  },
  /**
   * Files up into a folder of the application's (`folder` under its root; '' = the root): each in 4 MB slices (only the
   * slices the drive does not have yet), a name that is taken gets a new one. → { dir: { path, id }, files: [{ name, path, id, size }] }
   */
  async upload(client, files, folder, { signal, note, endpoints } = {}) {
    const root = baidu.root(client.conn)
    const dir = await baidu.mkdir(client, folder ? `${root}/${clean(folder) || 'Ruyix'}` : root, { signal })
    const out = []
    for (const f of files) {
      const name = clean(f.name || basename(f.path)) || 'file', remote = `${dir.path}/${name}`, size = statSync(f.path).size
      note?.(`上传 ${name}`)
      const md5s = await blocks(f.path)
      const pre = await call(client, '/rest/2.0/xpan/file', { method: 'POST', query: { method: 'precreate' }, form: { path: remote, size, isdir: 0, autoinit: 1, rtype: 1, block_list: JSON.stringify(md5s) }, signal, what: '预上传', level: 'write' })
      // the slices it asks for (none: it has the file already — 秒传)
      const need = Number(pre.return_type) === 2 ? [] : pre.block_list?.length ? pre.block_list.map(Number) : md5s.map((_, i) => i)
      for (const n of need) {
        const form = new FormData()
        form.append('file', new Blob([slice(f.path, n * BLOCK, Math.min(BLOCK, size - n * BLOCK))]), name)
        const up = await call(client, `${endpoints?.pcs || 'https://d.pcs.baidu.com'}/rest/2.0/pcs/superfile2`, { method: 'POST', query: { method: 'upload', type: 'tmpfile', path: remote, uploadid: pre.uploadid, partseq: n }, body: form, signal, timeout: 600000, what: `上传第 ${n + 1} 片`, level: 'write' })
        if (up.md5 && up.md5 !== md5s[n]) throw Object.assign(new Error(`百度网盘上传失败：${name} 第 ${n + 1} 片校验不对`), { code: 'driveFailed' })
      }
      const made = await call(client, '/rest/2.0/xpan/file', { method: 'POST', query: { method: 'create' }, form: { path: remote, size, isdir: 0, rtype: 1, uploadid: pre.uploadid || '', block_list: JSON.stringify(md5s) }, signal, what: '合并文件', level: 'write' })
      out.push({ name: basename(made.path || remote), path: made.path || remote, id: String(made.fs_id ?? ''), size })
    }
    return { dir, files: out }
  },
  /**
   * Files down into a local folder, by drive id: a file already there with the same size is kept. items: [{ id, rel?,
   * name?, size? }] (rel: where under `dir`; else the name). `get(url, headers, signal)`: a request without the credential
   * (the address the drive hands out). → [{ name, path, size, kept? }]
   */
  async download(client, items, dir, { signal, note, get } = {}) {
    const out = [], destinations = new Map()
    for (let i = 0; i < items.length; i += 100) {
      const group = items.slice(i, i + 100)
      const meta = await call(client, '/rest/2.0/xpan/multimedia', { query: { method: 'filemetas', fsids: JSON.stringify(group.map(x => Number(x.id))), dlink: 1 }, signal, what: '取下载地址' })
      const byId = new Map((meta.list || []).map(m => [String(m.fs_id), m]))
      for (const it of group) {
        const m = byId.get(String(it.id))
        if (!m?.dlink) throw Object.assign(new Error(`百度网盘：拿不到 ${it.name || it.id} 的下载地址`), { code: 'driveFailed' })
        const dest = localPath(dir, it.rel || m.filename || it.name), size = Number(m.size) || 0
        const key = process.platform === 'linux' ? dest : dest.toLowerCase()
        if (destinations.has(key)) throw Object.assign(new Error(`百度网盘：${destinations.get(key)} 与 ${it.rel || m.filename || it.name} 的本地文件名冲突`), { code: 'driveFailed' })
        destinations.set(key, it.rel || m.filename || it.name)
        if (existsSync(dest) && statSync(dest).size === size) { out.push({ name: basename(dest), path: dest, size, kept: true }); continue }
        note?.(`下载 ${it.rel || m.filename}`)
        mkdirSync(dirname(dest), { recursive: true })
        // the link with the token; the platform answers with the address of the bytes (or the bytes)
        const ua = { 'user-agent': 'pan.baidu.com' }
        const first = await client.request(m.dlink, { headers: ua, redirect: 'manual', timeout: 3600000, signal })
        let body
        if (first.status >= 300 && first.status < 400 && first.headers.get('location')) {
          const res = await get(new URL(first.headers.get('location'), m.dlink).href, ua, signal)
          if (!res.ok) throw Object.assign(new Error(`百度网盘下载 ${m.filename} 失败（HTTP ${res.status}）`), { code: 'driveFailed' })
          body = res.body
        } else if (first.ok) body = first.stream()
        else throw Object.assign(new Error(`百度网盘下载 ${m.filename} 失败：${explain(await first.json().catch(() => null), first.status)}`), { code: 'driveFailed' })
        const part = `${dest}.part`
        try { await pipeline(Readable.fromWeb(body), createWriteStream(part), { signal }) } catch (err) { rmSync(part, { force: true }); throw err }
        renameSync(part, dest)
        out.push({ name: basename(dest), path: dest, size: statSync(dest).size })
      }
    }
    return out
  },
  /** A share link for drive ids (an enterprise developer's paid service: without it this throws). → { url, password } */
  async share(client, ids, { expireDays = 7, password, signal } = {}) {
    const form = new FormData()
    form.append('fsid_list', JSON.stringify(ids.map(String)))
    form.append('period', String(expireDays))
    form.append('pwd', password)
    const d = await call(client, '/apaas/1.0/share/set', { method: 'POST', query: { product: 'netdisk', appid: client.conn.fields?.appId || '' }, body: form, signal, what: '生成分享链接', level: 'write' })
    return { url: d.data?.link || (d.data?.short_url ? `https://pan.baidu.com/s/${d.data.short_url}` : ''), password: d.data?.pwd || password }
  },
}

export const DRIVES = { baidupan: baidu }
/** Does a connection of this type keep files (its `drive` names one of DRIVES)? */
export const isDrive = type => !!DRIVES[type?.drive]
/** A 4-character code of digits and lower-case letters (what Baidu's share links take). */
export const baiduCode = () => Array.from(createHash('sha256').update(String(Math.random()) + Date.now()).digest()).slice(0, 4).map(b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('')
