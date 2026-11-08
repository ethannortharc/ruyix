// Each platform's version as its readers would see it: a 小红书 note on a phone (its images to swipe, title, body,
// topics), an X post or thread, a 公众号 article (the HTML the person pastes in, as it will look).
import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Heart, MessageCircle, Repeat2, Star } from 'lucide-react'
import { renderArticle } from '../lib/article.js'
import { weighted } from '../lib/platforms.js'
import { framePage } from './clean.js'

export const API = 'api/ruyix-workbench'
export const imgUrl = (runId, seq) => `${API}/file?run=${encodeURIComponent(runId)}&seq=${seq}`

export function XhsPhone({ run, fields, images, handle }) {
  const [i, setI] = useState(0)
  const shown = images.filter(x => x.seq)
  const at = Math.min(i, Math.max(shown.length - 1, 0))
  return (
    <div className="pl-phone">
      <div className="pl-phone-top"><span className="pl-avatar" /><b className="pl-name">{handle || ''}</b><span className="pl-follow">关注</span></div>
      <div className="pl-xhs-img">
        {shown.length ? <img src={imgUrl(run.id, shown[at].seq)} alt="" /> : <div className="pl-noimg">—</div>}
        {shown.length > 1 && <>
          <button className="pl-nav pl-prev" onClick={() => setI((at - 1 + shown.length) % shown.length)}><ChevronLeft size={16} /></button>
          <button className="pl-nav pl-next" onClick={() => setI((at + 1) % shown.length)}><ChevronRight size={16} /></button>
          <span className="pl-count-pill">{at + 1}/{shown.length}</span>
        </>}
      </div>
      {shown.length > 1 && <div className="pl-dots">{shown.map((_, k) => <i key={k} className={k === at ? 'pl-on' : ''} onClick={() => setI(k)} />)}</div>}
      <div className="pl-xhs-text">
        <h4>{fields.title || '—'}</h4>
        <p>{fields.body}</p>
        {fields.tags?.length > 0 && <p className="pl-tags">{fields.tags.map(x => <span key={x}>#{x} </span>)}</p>}
      </div>
      <div className="pl-phone-bar"><span><Heart size={14} /></span><span><Star size={14} /></span><span><MessageCircle size={14} /></span></div>
    </div>
  )
}

export function XThread({ run, fields, images, limit = 280, handle }) {
  const shown = images.filter(x => x.seq)
  return (
    <div className="pl-xthread">
      {(fields.tweets || []).map((tw, k) => {
        const n = weighted(tw)
        return (
          <div key={k} className="pl-tweet">
            <span className="pl-avatar" />
            <div className="pl-tweet-main">
              <div className="pl-tweet-head"><b>{handle || ''}</b><span className={n > limit ? 'pl-over' : ''}>{n}/{limit}</span></div>
              <p>{tw}</p>
              {k === 0 && shown.length > 0 && <div className={`pl-tweet-imgs pl-n${Math.min(shown.length, 4)}`}>{shown.slice(0, 4).map(x => <img key={x.seq} src={imgUrl(run.id, x.seq)} alt="" />)}</div>}
              <div className="pl-tweet-bar"><MessageCircle size={13} /><Repeat2 size={13} /><Heart size={13} /></div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function MpArticle({ run, fields, images, accent }) {
  const html = useMemo(() => renderArticle(fields.body || '', { accent }), [fields.body, accent])
  const cover = images.find(x => x.seq)
  return (
    <div className="pl-mp">
      {cover && <img className="pl-mp-cover" src={imgUrl(run.id, cover.seq)} alt="" />}
      <h3>{fields.title || '—'}</h3>
      <div className="pl-mp-meta">{fields.author || ''}{fields.digest && <p>{fields.digest}</p>}</div>
      {/* the article as it is pasted, in a sandboxed frame (no script runs, nothing reaches this page): the renderer escapes
          what was written, and only its own tags and attributes are let through (src/clean.js) */}
      <iframe className="pl-mp-body" title="article" sandbox="" srcDoc={framePage(html)} />
    </div>
  )
}

export function Preview({ run, p, accent, handle }) {
  if (p.id === 'xhs') return <XhsPhone run={run} fields={p.fields} images={p.images} handle={handle} />
  if (p.id === 'x') return <XThread run={run} fields={p.fields} images={p.images} limit={p.limits.find(l => l.key === 'tweetMax')?.value || 280} handle={handle} />
  return <MpArticle run={run} fields={p.fields} images={p.images} accent={accent} />
}
