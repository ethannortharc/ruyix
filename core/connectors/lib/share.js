// Share targets: a connection whose type can take files and give back a link that others open (a cloud drive, later a
// bucket with a share page). share(service, id, files, opts) puts the files into a folder of their own there and returns
// the link — what a pack's approved action calls ("share these videos"), the same for any pack. Every request with a
// credential goes through the connection's client (its hosts only, audited, scrubbed); bytes go to the upload addresses
// the target itself hands out, which carry no credential.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, openSync, readSync, closeSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { DRIVES, baiduCode } from './drive.js'

const md5File = path => new Promise((resolve, reject) => {
  const h = createHash('md5')
  createReadStream(path).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
})
const slice = (path, start, size) => {
  const fd = openSync(path, 'r'), buf = Buffer.alloc(size)
  try { const n = readSync(fd, buf, 0, size, start); return buf.subarray(0, n) } finally { closeSync(fd) }
}
const clean = s => String(s || '').replace(/["\\/:*?|<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Ruyix'

// ── 123 云盘 (open platform, v1 upload: presigned slices) ──
async function api(client, path, { method = 'POST', body, query, signal } = {}) {
  const q = query ? `?${new URLSearchParams(query)}` : ''
  const res = await client.request(`${path}${q}`, { method, ...(body !== undefined && { body }), level: 'write', timeout: 120000, signal })
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.code !== 0) throw Object.assign(new Error(`123 云盘 ${path}：${data?.message || `HTTP ${res.status}`}`), { code: 'shareFailed', params: { path, status: res.status, code: data?.code ?? null } })
  return data.data
}
/** A folder by name under parent (made when it is not there). → its id */
async function folder(client, parent, name, signal) {
  const list = await api(client, '/api/v2/file/list', { method: 'GET', query: { parentFileId: parent, limit: 100 }, signal })
  const found = (list?.fileList || []).find(f => f.type === 1 && f.filename === name && !f.trashed)
  if (found) return found.fileId
  return (await api(client, '/upload/v1/file/mkdir', { body: { name, parentID: parent }, signal })).dirID
}
/** One file into a folder → its file id. */
async function upload(client, path, name, parent, { signal, put }) {
  const size = statSync(path).size, etag = await md5File(path)
  const made = await api(client, '/upload/v1/file/create', { body: { parentFileID: parent, filename: name, etag, size, duplicate: 1 }, signal })
  if (made.reuse) return made.fileID
  const step = Number(made.sliceSize) || 16 * 1024 * 1024
  for (let n = 1, at = 0; at < size; n++, at += step) {
    const { presignedURL } = await api(client, '/upload/v1/file/get_upload_url', { body: { preuploadID: made.preuploadID, sliceNo: n }, signal })
    const res = await put(presignedURL, slice(path, at, Math.min(step, size - at)), signal)
    if (!res.ok) throw Object.assign(new Error(`123 云盘：第 ${n} 片上传失败（HTTP ${res.status}）`), { code: 'shareFailed' })
  }
  let done = await api(client, '/upload/v1/file/upload_complete', { body: { preuploadID: made.preuploadID }, signal })
  for (let i = 0; done.async && !done.completed && i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000))
    done = await api(client, '/upload/v1/file/upload_async_result', { body: { preuploadID: made.preuploadID }, signal })
  }
  if (!done.completed && !done.fileID) throw Object.assign(new Error('123 云盘：上传没有完成（服务端还在合并）'), { code: 'shareFailed' })
  return done.fileID
}

export const TARGETS = {
  pan123: {
    label: { en: '123 Cloud Drive', zh: '123 云盘' },
    expiries: [1, 7, 30, 0], // days; 0: never
    /**
     * files: [{ path, name? }]; folder: the share's folder name (under "Ruyix"); expireDays: 1 | 7 | 30 | 0; password: '' or
     * 4–8 letters/digits. → { url, password, expireDays, folder, files: [{ name, fileId, size }] }
     */
    async share(client, files, { folder: name, expireDays = 7, password = '', signal, put, note }) {
      const root = await folder(client, 0, 'Ruyix', signal)
      const dir = await folder(client, root, `${clean(name).slice(0, 75)}-${randomUUID()}`, signal)
      const out = []
      for (const f of files) {
        const fileName = clean(f.name || basename(f.path))
        note?.(`上传 ${fileName}`)
        out.push({ name: fileName, fileId: await upload(client, f.path, fileName, dir, { signal, put }), size: statSync(f.path).size })
      }
      const expire = [1, 7, 30, 0].includes(Number(expireDays)) ? Number(expireDays) : 7
      const made = await api(client, '/api/v1/share/create', { body: { shareName: clean(name), shareExpire: expire, fileIDList: String(dir), ...(password && { sharePwd: password }) }, signal })
      const info = await api(client, '/api/v1/user/info', { method: 'GET', signal }).catch(() => null)
      const url = info?.uid ? `https://${info.uid}.share.123pan.cn/123pan/${made.shareKey}` : `https://www.123pan.com/s/${made.shareKey}`
      return { url, password, expireDays: expire, folder: clean(name), files: out }
    },
  },
}
TARGETS.baidupan = {
  label: { en: 'Baidu Netdisk', zh: '百度网盘' },
  expiries: [1, 7, 30, 0],
  /**
   * The files up into a folder of the application's (我的应用数据/<app name>/<folder>), then a share link for the folder —
   * which the platform gives only to enterprise developers who bought the service: without it the files are up and
   * `manual` says where, for the person to share from the app. → { url, password, expireDays, folder, files, place, manual?, why? }
   */
  async share(client, files, { folder: name, expireDays = 7, password = '', signal, note, endpoints }) {
    const drive = DRIVES.baidupan
    const up = await drive.upload(client, files, `${clean(name).slice(0, 75)}-${randomUUID()}`, { signal, note, endpoints })
    const place = `我的应用数据${up.dir.path.replace(/^\/apps/, '')}`
    const expire = [1, 7, 30, 0].includes(Number(expireDays)) ? Number(expireDays) : 7
    const code = /^[0-9a-z]{4}$/.test(password) ? password : baiduCode()
    const base = { folder: clean(name), place, files: up.files.map(f => ({ name: f.name, fileId: f.id, size: f.size })) }
    try {
      const made = await drive.share(client, [up.dir.id], { expireDays: expire, password: code, signal })
      return { ...base, url: made.url, password: made.password, expireDays: expire }
    } catch (err) {
      if (err.code !== 'driveFailed') throw err
      return { ...base, url: '', password: '', expireDays: 0, manual: true, why: err.message }
    }
  },
}
/** Can a connection of this type share (its `shareTarget` names one of TARGETS)? */
export const canShare = type => !!TARGETS[type?.shareTarget]
