// X: a post or a thread through the X API v2 on the person's X connection (the connectors plugin keeps its OAuth tokens
// and refreshes them): the images go up first (chunked upload), they hang on the first post, each next post answers the
// one before it. Ported from Plume (server/platforms/x/api.ts).
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mimeOf } from './images.js'

const SEG = 4 << 20

/** client: the connection's client (`connectors().client(id)`), every call at the write level. */
async function api(client, path, { method = 'GET', body } = {}) {
  const res = await client.request(path, { method, body, level: 'write', timeout: 60000 })
  if (!res.ok) throw Object.assign(new Error(`X ${method} ${path} → ${res.status}`), { status: res.status })
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

/** One image up: initialize, append its pieces, finalize → its media id. */
export async function uploadImage(client, file) {
  const buf = typeof file === 'string' ? await readFile(file) : file.bytes, mime = mimeOf(typeof file === 'string' ? file : file.name)
  const init = await api(client, '/media/upload/initialize', { method: 'POST', body: { media_type: mime, total_bytes: buf.length, media_category: 'tweet_image' } })
  const id = init?.data?.id
  if (!id) throw new Error('X did not start the upload (no media id)')
  for (let i = 0, n = 0; i < buf.length; i += SEG, n++) {
    const form = new FormData()
    form.set('segment_index', String(n))
    form.set('media', new Blob([buf.subarray(i, i + SEG)], { type: mime }))
    await api(client, `/media/upload/${id}/append`, { method: 'POST', body: form })
  }
  await api(client, `/media/upload/${id}/finalize`, { method: 'POST' })
  return id
}

/**
 * Post the thread: { tweets, images: [paths], done: [ids of the posts already out] } → { ids, url }. said(step) for the
 * record. A post that fails stops it — the ones already out stay (their ids are in the error): the person approves again
 * and it goes on from there. An unknown outcome needs reconciliation before another send.
 */
export async function postThread(client, { tweets, images = [], handle = '', done = [] }, said = () => {}, checkpoint = () => {}) {
  const ids = [...done].slice(0, tweets.length)
  const media = []
  // (the images hang on the first post: once that is out, they are not uploaded again)
  if (!ids.length) for (const f of images.slice(0, 4)) { said(`upload ${typeof f === 'string' ? f.split('/').pop() : f.name}`); media.push(await uploadImage(client, f)) }
  if (ids.length) said(`${ids.length} post(s) were out already: going on after ${ids.at(-1)}`)
  for (let i = ids.length; i < tweets.length; i++) {
    const body = { text: tweets[i], ...(i === 0 && media.length && { media: { media_ids: media } }), ...(ids.length && { reply: { in_reply_to_tweet_id: ids.at(-1) } }) }
    const uncertain = { attempt: randomUUID(), index: i, text: tweets[i] }
    checkpoint({ ids: [...ids], uncertain })
    try {
      const res = await api(client, '/tweets', { method: 'POST', body })
      if (!res.data?.id) throw new Error('X returned no post id; check its outcome before retrying')
      ids.push(res.data.id)
      checkpoint({ ids: [...ids], uncertain: null })
      said(`post ${i + 1}/${tweets.length}: ${res.data.id}`)
    } catch (err) {
      const unknown = !err.status || err.status >= 500
      // HTTP rejections before acceptance can be retried; timeouts and server errors need a person to check X.
      if (!unknown) checkpoint({ ids: [...ids], uncertain: null })
      throw Object.assign(new Error(`${err.message}${ids.length ? ` — ${ids.length} post(s) were out already: ${ids.join(', ')}` : ''}${unknown ? ' — outcome unknown: check X before continuing' : ''}`), { ids, uncertain: unknown ? uncertain : null })
    }
  }
  if (!handle) { try { handle = (await api(client, '/users/me')).data?.username || '' } catch { /* the link without a name */ } }
  return { ids, url: `https://x.com/${handle || 'i/web'}/status/${ids[0]}` }
}
