// The cards an agent shows as the result of an exchange (./spec.js; docs/design/agent-tasks.md「回答要看得见」), drawn the
// same everywhere — the conversation, the main agent's strip, the desk (exported as @ruyix/shell/cards; React stays the
// caller's). The system's tokens only, so they follow the theme and light or dark; their look comes with them (a <style>
// put in the document once), so a plugin that draws them needs nothing else.
//   <Cards cards lang onAnswer? answered? compact? />   <Card card … />
// A click that opens something does it in the click itself (a new tab: the browser allows it only then); an answer
// (a choice, 好了 / 再改) goes to onAnswer, or, with none, out as the window event ANSWER_EVENT for the conversation.
// `answered`: what was answered already (from the conversation's record) — the card shows it and asks no more.
import { useEffect, useState } from 'react'
import { ArrowUpRight, Check, CheckCircle2, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSun, File, FileAudio, FileImage, FileText, FileVideo, ListChecks, Moon, Play, Snowflake, Sun, Wind, XCircle } from 'lucide-react'
import { ANSWER_EVENT } from './spec.js'
import { useLiveTask } from './live.js'
import { KIND_ICON, openOutput } from '../tasks/outputs.jsx'
import css from './cards.css'

const cx = (...c) => c.filter(Boolean).join(' ')
const WORDS = {
  zh: {
    open: '打开', ok: '好了', revise: '再改', send: '发送', revisePh: '要改什么？一句话', sent: '已回答', done: '已确认', revised: t => `已请它再改：${t}`,
    pickMany: '选好了', feels: '体感', humidity: '湿度', wind: '风', rain: p => `降水 ${p}%`, from: '来源', ahead: h => (h === 0 ? '和这里同一时间' : h > 0 ? `比这里快 ${h} 小时` : `比这里慢 ${-h} 小时`),
    state: { queued: '排队', working: '在做', waiting: '等你', 'to-confirm': '待确认', done: '完成', failed: '没做成', stopped: '停了' }, view: '看', unknown: '这种卡片还画不出来',
    openTask: '在「任务」里看', goThere: '去处理', more: n => `还有 ${n} 件`,
  },
  en: {
    open: 'Open', ok: 'OK', revise: 'Change it', send: 'Send', revisePh: 'What should change? One line', sent: 'Answered', done: 'Confirmed', revised: t => `Asked to change: ${t}`,
    pickMany: 'Done', feels: 'Feels', humidity: 'Humidity', wind: 'Wind', rain: p => `Rain ${p}%`, from: 'Source', ahead: h => (h === 0 ? 'Same time as here' : h > 0 ? `${h} h ahead of here` : `${-h} h behind here`),
    state: { queued: 'Queued', working: 'At work', waiting: 'Waiting for you', 'to-confirm': 'To confirm', done: 'Done', failed: 'Did not work', stopped: 'Stopped' }, openTask: 'Open in Tasks', goThere: 'Go to it', more: n => `${n} more`,
    view: 'View', unknown: 'This card cannot be drawn yet',
  },
}
const SKY_ICON = { clear: Sun, partly: CloudSun, cloudy: Cloud, rain: CloudRain, showers: CloudDrizzle, storm: CloudLightning, snow: Snowflake, fog: CloudFog, wind: Wind, night: Moon }
const FILE_ICON = { image: FileImage, markdown: FileText, pdf: FileText, text: FileText, video: FileVideo, audio: FileAudio }

/** The look, once in the document (a plugin drawing cards has no other way to bring it). */
function useCardStyle() {
  useEffect(() => {
    if (document.getElementById('ruyix-cards-css')) return
    const el = Object.assign(document.createElement('style'), { id: 'ruyix-cards-css', textContent: css })
    document.head.appendChild(el)
  }, [])
}
/** Open a web page in a new tab of the person's browser (called in the click, which is what lets it). */
const openTab = url => { try { window.open(url, '_blank', 'noopener,noreferrer') } catch { /* blocked: nothing */ } }
const send = (onAnswer, answer, origin) => (onAnswer ? onAnswer(answer) : window.dispatchEvent(new CustomEvent(ANSWER_EVENT, { detail: { answer, ...(origin && { origin }) } })))
/** A YouTube page's picture (when the card gives none). */
export function videoThumb(url) {
  try {
    const u = new URL(url), id = u.hostname.endsWith('youtu.be') ? u.pathname.slice(1) : u.searchParams.get('v') || (u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : null)
    return id && /^[\w-]{6,20}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null
  } catch { return null }
}
const siteOf = url => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }

// ── each type ──

function Weather({ c, W, lang }) {
  const now = c.now || {}, I = SKY_ICON[now.sky] || Cloud, u = c.unit === 'F' ? '°F' : '°'
  return (
    <div className="rxc-weather">
      <div className="rxc-w-now">
        <div><div className="rxc-w-place">{c.place}</div><div className="rxc-w-temp">{now.temp != null ? Math.round(now.temp) : '–'}<small>{u}</small></div><div className="rxc-w-text">{now.text}</div></div>
        <I className="rxc-w-icon" size={56} strokeWidth={1.3} aria-hidden="true" />
      </div>
      {(now.feels != null || now.humidity != null || now.wind) && (
        <div className="rxc-w-more">
          {now.feels != null && <span>{W.feels} {Math.round(now.feels)}{u}</span>}{now.humidity != null && <span>{W.humidity} {now.humidity}%</span>}{now.wind && <span>{W.wind} {now.wind}</span>}
        </div>
      )}
      {c.days?.length > 0 && (
        <div className="rxc-w-days">
          {c.days.map(d => { const D = SKY_ICON[d.sky] || Cloud; return (
            <div key={d.date} className="rxc-w-day" title={d.text || ''}>
              <span>{d.label || new Date(`${d.date}T12:00`).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en', { weekday: 'short' })}</span>
              <D size={18} strokeWidth={1.6} aria-hidden="true" />
              <b>{d.hi != null ? Math.round(d.hi) : '–'}°</b><i>{d.lo != null ? Math.round(d.lo) : '–'}°</i>
              {d.rain != null && d.rain > 0 && <em>{d.rain}%</em>}
            </div>
          ) })}
        </div>
      )}
      {c.source && <div className="rxc-src">{W.from}：{c.source.url ? <a href={c.source.url} onClick={e => { e.preventDefault(); openTab(c.source.url) }}>{c.source.name}</a> : c.source.name}{c.at && ` · ${new Date(c.at).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en', { hour: '2-digit', minute: '2-digit' })}`}</div>}
    </div>
  )
}

function useClock(every = 1000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), every); return () => clearInterval(t) }, [every])
  return now
}
/** A zone's offset from UTC in minutes, at `at`. */
const offsetOf = (zone, at) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at).map(x => [x.type, x.value])); return (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(at.getTime() / 60000) * 60000) / 60000 }
function Time({ c, W, lang }) {
  const now = useClock(1000), here = -now.getTimezoneOffset(), loc = lang === 'zh' ? 'zh-CN' : 'en'
  return (
    <div className="rxc-times">
      {c.zones.map(z => {
        const h = Math.round((offsetOf(z.zone, now) - here) / 60)
        return (
          <div key={z.zone} className="rxc-time">
            <span className="rxc-t-label">{z.label || z.zone.split('/').pop().replace(/_/g, ' ')}</span>
            <span className="rxc-t-clock">{now.toLocaleTimeString(loc, { timeZone: z.zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
            <span className="rxc-t-date">{now.toLocaleDateString(loc, { timeZone: z.zone, month: 'short', day: 'numeric', weekday: 'short' })}</span>
            <span className="rxc-t-diff">{W.ahead(h)}</span>
          </div>
        )
      })}
    </div>
  )
}

function Link({ c, W }) {
  return (
    <button type="button" className="rxc-link" onClick={() => openTab(c.url)}>
      {c.image && <img className="rxc-link-img" src={c.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      <span className="rxc-link-main">
        <span className="rxc-link-site"><i aria-hidden="true">{(c.site || siteOf(c.url)).slice(0, 1).toUpperCase()}</i>{c.site || siteOf(c.url)}</span>
        <b>{c.title}</b>
        {c.text && <span className="rxc-link-text">{c.text}</span>}
      </span>
      <span className="rxc-go" aria-label={W.open}><ArrowUpRight size={16} /></span>
    </button>
  )
}

function Video({ c }) {
  const thumb = c.thumb || videoThumb(c.url)
  return (
    <button type="button" className="rxc-video" onClick={() => openTab(c.url)}>
      <span className="rxc-v-pic">
        {thumb ? <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <i />}
        <span className="rxc-v-play" aria-hidden="true"><Play size={20} fill="currentColor" /></span>
        {c.duration && <span className="rxc-v-dur">{c.duration}</span>}
      </span>
      <span className="rxc-v-text"><b>{c.title}</b>{c.channel && <span>{c.channel}</span>}</span>
    </button>
  )
}

function List({ c }) {
  return (
    <ol className="rxc-list">
      {c.items.map((it, i) => {
        const Row = it.url ? 'button' : 'div'
        return (
          <li key={i}>
            <Row {...(it.url && { type: 'button', onClick: () => openTab(it.url) })} className={cx('rxc-li', it.url && 'rxc-li-go')}>
              <span className="rxc-li-main"><b>{it.title}</b>{it.text && <span>{it.text}</span>}</span>
              {it.meta && <span className="rxc-li-meta">{it.meta}</span>}
              {it.url && <ArrowUpRight size={14} className="rxc-li-arrow" aria-hidden="true" />}
            </Row>
          </li>
        )
      })}
    </ol>
  )
}

function Table({ c }) {
  const num = j => c.rows.every(r => r[j] === '' || r[j] == null || typeof r[j] === 'number')
  return (
    <div className="rxc-table-wrap">
      <table className="rxc-table">
        <thead><tr>{c.columns.map((h, j) => <th key={j} className={cx(num(j) && 'rxc-num')}>{h}</th>)}</tr></thead>
        <tbody>{c.rows.map((r, i) => <tr key={i}>{c.columns.map((_, j) => <td key={j} className={cx(num(j) && 'rxc-num')}>{r[j] ?? ''}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function Stat({ c }) {
  return (
    <div className="rxc-stats">
      {c.items.map((it, i) => {
        const d = String(it.delta || ''), down = /^[-−]/.test(d), up = /^\+/.test(d)
        return (
          <div key={i} className="rxc-stat">
            <span className="rxc-s-label">{it.label}</span>
            <span className="rxc-s-value">{it.unit === '$' || it.unit === '¥' || it.unit === '€' ? <><small>{it.unit}</small>{it.value}</> : <>{it.value}{it.unit && <small>{it.unit}</small>}</>}</span>
            {d && <span className={cx('rxc-s-delta', up && 'rxc-up', down && 'rxc-down')}>{d}</span>}
          </div>
        )
      })}
    </div>
  )
}

function Note({ c }) { return <p className="rxc-note">{c.text}</p> }

function Choice({ c, W, onAnswer, answered, origin }) {
  const [picked, setPicked] = useState([]), [done, setDone] = useState(answered?.values || null)
  const answer = values => { setDone(values); send(onAnswer, { type: 'choice', card: c, values }, origin) }
  return (
    <div className="rxc-choice">
      <p className="rxc-q">{c.question}</p>
      <div className="rxc-opts" role={c.multi ? 'group' : 'radiogroup'} aria-label={c.question}>
        {c.options.map(o => {
          const on = done ? done.includes(o.label) : picked.includes(o.label)
          return (
            <button key={o.label} type="button" role={c.multi ? 'checkbox' : 'radio'} aria-checked={on} disabled={!!done && !on} className={cx('rxc-opt', on && 'on', done && 'rxc-settled')}
              onClick={() => { if (done) return; if (c.multi) setPicked(p => (p.includes(o.label) ? p.filter(x => x !== o.label) : [...p, o.label])); else answer([o.label]) }}>
              <span className="rxc-opt-mark" aria-hidden="true">{on && <Check size={12} strokeWidth={3} />}</span>
              <span><b>{o.label}</b>{o.text && <span>{o.text}</span>}</span>
            </button>
          )
        })}
      </div>
      {c.multi && !done && <div className="rxc-row"><button type="button" className="rxc-btn rxc-pri" disabled={!picked.length} onClick={() => answer(picked)}>{W.pickMany}</button></div>}
      {done && <div className="rxc-said"><Check size={13} />{W.sent}</div>}
    </div>
  )
}

function Confirm({ c, W, onAnswer, answered, origin }) {
  const [mode, setMode] = useState(null), [text, setText] = useState(''), [done, setDone] = useState(answered || null)
  const answer = a => { setDone(a); send(onAnswer, { type: 'confirm', card: c, ...a, ...(c.task && { task: c.task }), ...(c.run !== undefined && { run: c.run }), ...(c.resultVersion !== undefined && { expect: c.resultVersion }) }, origin) }
  return (
    <div className="rxc-confirm">
      <p className="rxc-c-text">{c.text}</p>
      {done ? (
        <div className={cx('rxc-said', done.value === 'revise' && 'rxc-said-revise')}><Check size={13} />{done.value === 'ok' ? W.done : W.revised(done.text || '')}</div>
      ) : mode === 'revise' ? (
        <form className="rxc-revise" onSubmit={e => { e.preventDefault(); if (text.trim()) answer({ value: 'revise', text: text.trim() }) }}>
          <input autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={W.revisePh} aria-label={W.revisePh} />
          <button type="submit" className="rxc-btn rxc-pri" disabled={!text.trim()}>{W.send}</button>
          <button type="button" className="rxc-btn" onClick={() => setMode(null)} aria-label="×">×</button>
        </form>
      ) : (
        <div className="rxc-row">
          <button type="button" className="rxc-btn rxc-pri" onClick={() => answer({ value: 'ok' })}><Check size={14} />{W.ok}</button>
          <button type="button" className="rxc-btn" onClick={() => setMode('revise')}>{W.revise}</button>
        </div>
      )}
    </div>
  )
}

function FileCard({ c, W }) {
  const I = FILE_ICON[c.kind] || File
  const view = () => window.dispatchEvent(new CustomEvent('ruyix-workbench:view', { detail: c.url ? { files: [{ url: c.url, name: c.name, ...(c.kind && { kind: c.kind }) }], file: 0, title: c.name } : c.run ? { run: c.run, ...(c.path && { file: c.path }) } : { session: c.session, ...(c.path && { file: c.path }) } }))
  return (
    <button type="button" className="rxc-file" onClick={view}>
      <span className="rxc-f-icon"><I size={20} strokeWidth={1.6} /></span>
      <span className="rxc-f-main"><b>{c.name}</b>{c.text && <span>{c.text}</span>}</span>
      <span className="rxc-go">{W.view}</span>
    </button>
  )
}

const OVER = new Set(['done', 'failed', 'stopped'])
const STATE_ICON = { done: CheckCircle2, failed: XCircle, stopped: XCircle }
/**
 * A task the person follows (docs/design/work-in-one-place.md): what it is doing now, then how it ended and what it
 * made — read live while it goes on (./live.js), so the card in an old message is right too. A click opens the task in
 * 「任务」; what it made opens from here; what waits for the person says where to go.
 */
function TaskCard({ c, W, lang }) {
  const live = useLiveTask(c.id, lang, c), t = live?.task || {}
  const state = t.state || c.state || 'working', over = OVER.has(state), waits = state === 'waiting' || state === 'to-confirm'
  const line = over ? t.result || c.result || c.text : waits ? t.waitingFor?.title || c.text : t.step || c.step || c.text
  const outs = live?.outputs || [], I = STATE_ICON[state] || ListChecks
  const go = () => window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: 'ruyix-tasks', task: c.id } }))
  return (
    <div className={cx('rxc-task', `rxc-st-${state}`, !over && !waits && 'rxc-task-going')}>
      <button type="button" className="rxc-task-head" onClick={go} title={W.openTask}>
        <I size={18} strokeWidth={1.7} className="rxc-task-icon" aria-hidden="true" />
        <span className="rxc-f-main"><b>{t.title || c.title || c.id}</b>{line && <span>{line}</span>}</span>
        <span className="rxc-pill">{W.state[state] || state}</span>
      </button>
      {waits && t.waitingFor?.open?.event && (
        <div className="rxc-task-row"><button type="button" className="rxc-btn rxc-pri" onClick={() => window.dispatchEvent(new CustomEvent(t.waitingFor.open.event, { detail: t.waitingFor.open.detail }))}>{W.goThere}</button></div>
      )}
      {outs.length > 0 && (
        <div className="rxc-task-outs">
          {outs.slice(0, 4).map(o => { const K = KIND_ICON[o.kind] || File; return (
            <button key={o.id} type="button" className="rxc-task-out" onClick={() => openOutput(o)} title={o.title}>
              <K size={14} strokeWidth={1.8} aria-hidden="true" /><span>{o.title}</span><span className="rxc-go">{W.open}</span>
            </button>
          ) })}
          {outs.length > 4 && <button type="button" className="rxc-task-more" onClick={go}>{W.more(outs.length - 4)}</button>}
        </div>
      )}
    </div>
  )
}

const BODY = { weather: Weather, time: Time, link: Link, video: Video, list: List, table: Table, stat: Stat, note: Note, choice: Choice, confirm: Confirm, file: FileCard, task: TaskCard }
// the types whose own block is the whole card (no heading above it: their title is inside)
const OWN_TITLE = new Set(['link', 'video', 'task'])

/** One card. */
export function Card({ card, lang = 'zh', onAnswer, answered, compact = false, origin }) {
  useCardStyle()
  const W = WORDS[lang] || WORDS.en, B = BODY[card?.type]
  return (
    <section className={cx('rx-card', `rx-card-${card?.type || 'none'}`, card?.type === 'weather' && `rxc-sky-${card.now?.sky || 'cloudy'}`, compact && 'rx-card-compact')}>
      {card?.title && !OWN_TITLE.has(card.type) && <h4 className="rxc-title">{card.title}</h4>}
      {B ? <B c={card} W={W} lang={lang} onAnswer={onAnswer} answered={answered} origin={origin} /> : <p className="rxc-unknown">{W.unknown}</p>}
    </section>
  )
}

/** Several cards, as an answer shows them. `answered`: { [index]: answer } already given. */
export function Cards({ cards = [], lang = 'zh', onAnswer, answered = {}, compact = false, origin }) {
  useCardStyle()
  return <div className={cx('rx-cards', compact && 'rx-cards-compact')}>{cards.map((c, i) => <Card key={i} card={c} lang={lang} onAnswer={onAnswer} answered={answered[i]} compact={compact} origin={origin} />)}</div>
}
