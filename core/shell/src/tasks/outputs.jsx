// One thing a task made, as a card with what it is (the portfolio's, and a task's in the task center): a picture shows
// itself; a video its still with a play mark and its length; a document, a draft, a report their first lines on a page;
// a post its platform and where it went; an answer its words. A click opens that one thing (its `open`: the file in the
// viewer, the report alone, a post's page in a new tab — opened in the click itself, which is what lets it).
import { Clapperboard, FileText, Image as ImageIcon, LayoutList, MessageSquare, Newspaper, Package, Play, Sparkles, StickyNote } from 'lucide-react'

const cx = (...c) => c.filter(Boolean).join(' ')
export const KIND_ICON = { file: FileText, draft: StickyNote, post: Newspaper, report: LayoutList, image: ImageIcon, video: Clapperboard, card: Sparkles, answer: MessageSquare }
const PLATFORM = { xhs: '小红书', x: 'X', wechat_mp: '公众号', weibo: '微博', douyin: '抖音', youtube: 'YouTube' }
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }

/** Open what an output is (in the click: a post's page is a new tab). */
export function openOutput(o) {
  const open = o.open
  const url = open?.event === 'ruyix:open-url' ? open.detail?.url : !open?.event ? o.url : null
  if (url) { try { window.open(url, '_blank', 'noopener,noreferrer') } catch { /* blocked */ } return }
  if (open?.event) window.dispatchEvent(new CustomEvent(open.event, { detail: open.detail }))
}

/** What the card shows of it. */
function Preview({ o }) {
  const p = o.preview || {}, I = KIND_ICON[o.kind] || Package
  if (o.kind === 'image' && (o.thumb || p.poster)) return <img className="tk-pv-img" src={o.thumb || p.poster} alt="" loading="lazy" />
  if (o.kind === 'video' || p.poster) {
    return (
      <span className="tk-pv-video">
        {p.poster ? <img src={p.poster} alt="" loading="lazy" /> : <i />}
        <span className="tk-pv-play" aria-hidden="true"><Play size={18} fill="currentColor" /></span>
        {p.duration && <span className="tk-pv-dur">{p.duration}</span>}
      </span>
    )
  }
  if (o.kind === 'post') {
    const where = PLATFORM[p.platform] || p.platform || hostOf(o.url || o.open?.detail?.url || '')
    return (
      <span className={cx('tk-pv-post', p.platform && `tk-pf-${p.platform}`)}>
        <span className="tk-pv-pf">{where}</span>
        {p.text ? <span className="tk-pv-lines">{p.text}</span> : <span className="tk-pv-lines tk-pv-dim">{o.title}</span>}
      </span>
    )
  }
  if ((o.kind === 'answer' || o.kind === 'card') && p.text) return <span className="tk-pv-say"><span>{p.text}</span></span>
  if (p.text) return <span className={cx('tk-pv-doc', `tk-pv-${o.kind}`)}><span className="tk-pv-lines">{p.text}</span></span>
  if (o.thumb) return <img className="tk-pv-img" src={o.thumb} alt="" loading="lazy" />
  return <span className={`tk-tile-sign tk-k-${o.kind}`}><I size={24} strokeWidth={1.5} /></span>
}

/** One output: its preview, its kind, its title, when (and, when asked, its task: a click goes there). */
export function OutputCard({ o, W, withTask = false, when = true }) {
  return (
    <div className={cx('tk-tile', `tk-tile-${o.kind}`)}>
      <button type="button" className="tk-tile-open" onClick={() => openOutput(o)} title={o.title}>
        <span className="tk-tile-pic"><Preview o={o} /><span className="tk-tile-kind">{W.kinds[o.kind] || o.kind}</span></span>
        <b className="tk-tile-title">{o.title}</b>
      </button>
      {withTask && o.task && (
        <button type="button" className="tk-tile-task" onClick={() => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: 'ruyix-tasks', task: o.task.id } }))} title={W.openTask}>
          {W.fromTask}：{o.task.title}
        </button>
      )}
      {when && <span className="tk-tile-when">{W.ago(o.at)}</span>}
    </div>
  )
}
