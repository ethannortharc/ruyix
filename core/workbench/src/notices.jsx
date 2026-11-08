// The inbox's notifications: what happened lately — a run ending, failing, being stopped or cut short, a person step
// that waited past its hours (a reminder) — the events the desktop notifications tell, kept for two weeks. Read up to
// `seen` (a time, per browser); the page marks them read when you look. Also the inbox's other plugins' parts: what waits
// on the person elsewhere (NeedsView, above the approvals) and what this machine needs from them (SystemView).
import { useState } from 'react'
import { AlertTriangle, Bell, Bot, CheckCircle2, CircleSlash, Clock, ExternalLink, Gavel, Info, LifeBuoy, Loader2, OctagonPause, Rocket, ShieldCheck, XCircle } from 'lucide-react'
import { blocksWork, remindersOf, toneOf } from './inbox.js'
import { dateLoc, ACTIVE, cx, lastActivity, runTitle, useT, useWorkflowData, verdictText, verdictTone } from './ui.jsx'

const KEEP = 14 * 864e5
// how long ago, to the minute (a feed, not a stopwatch)
const ago = ms => (ms < 36e5 ? `${Math.max(1, Math.round(ms / 6e4))}m` : ms < 48 * 36e5 ? `${Math.round(ms / 36e5)}h` : `${Math.round(ms / 864e5)}d`)

/**
 * The notifications of these runs, newest first: { key, at, run, kind }, kind: done | failed | cancelled | interrupted —
 * and, given the approvals, remind (a person step waited past its hours: `approval`).
 */
export function noticesOf(runs, now = Date.now(), approvals = []) {
  const out = remindersOf(approvals, new Map(runs.map(r => [r.id, r])), now)
  for (const r of runs) {
    if (r.archivedAt) continue
    if (r.status === 'interrupted') { out.push({ key: `${r.id}:cut:${r.interruptedAt || 0}`, at: r.interruptedAt || lastActivity(r), run: r, kind: 'interrupted' }); continue }
    if (!r.endedAt || ACTIVE.has(r.status)) continue
    const kind = r.status === 'failed' || r.verdict?.level === 'failed' ? 'failed' : r.status === 'cancelled' || r.verdict?.level === 'cancelled' ? 'cancelled' : 'done'
    out.push({ key: `${r.id}:end`, at: r.endedAt, run: r, kind })
  }
  return out.filter(n => now - n.at < KEEP).sort((a, b) => b.at - a.at).slice(0, 100)
}
/** How many came after `seen`. */
export const unseen = (notices, seen) => notices.filter(n => n.at > seen).length

const ICON = { done: CheckCircle2, failed: XCircle, cancelled: CircleSlash, interrupted: AlertTriangle, remind: Clock }
const TONE = { failed: 'red', cancelled: 'muted', interrupted: 'amber', remind: 'amber' }

export function NoticesView({ notices, seen, now, onRun, onReadAll }) {
  const t = useT()
  const data = useWorkflowData()
  const fresh = unseen(notices, seen)
  return (
    <div className="wb-view wb-pad">
      <h2 className="wb-h">{t('sec.notices')}
        {fresh > 0 && <button className="wb-btn wb-small wb-push" onClick={onReadAll}>{t('nt.readAll')}</button>}
      </h2>
      <p className="wb-sub wb-block">{t('nt.hint')}</p>
      {notices.length === 0 ? <div className="wb-empty-small">{t('nt.empty')}</div> : (
        <ul className="wb-notices">
          {notices.map(n => {
            const r = n.run, Icon = ICON[n.kind], tone = TONE[n.kind] || verdictTone(r, data)
            const what = n.kind === 'done' ? t('nt.done', { verdict: r.verdict?.level ? verdictText(t, r.verdict.level) : t(`status.${r.status}`) })
              : n.kind === 'remind' ? t('nt.remind', { title: n.approval.title, h: n.approval.payload?.wait ?? '' }) : t(`nt.${n.kind}`)
            return (
              <li key={n.key}>
                <button className={cx('wb-notice', `wb-t-${tone}`, n.at > seen && 'wb-notice-new')} onClick={() => onRun(r.id)}>
                  <Icon size={15} className="wb-notice-icon" />
                  <span className="wb-notice-main">
                    <b>{what}</b>
                    <span className="wb-sub">{runTitle(r, data)}{n.kind === 'failed' && r.error ? ` — ${String(r.error).slice(0, 140)}` : ''}</span>
                  </span>
                  <span className="wb-notice-when wb-sub" title={new Date(n.at).toLocaleString(dateLoc())}>{t('ago', { t: ago(now - n.at) })}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ── what waits on the person elsewhere (the slot 'ruyix.inbox.needs'): each plugin's rows, drawn alike above the approvals ──
const NEED_ICON = { review: Gavel, help: LifeBuoy, job: Rocket, blocked: OctagonPause, agent: Bot, failed: XCircle }
/** groups: [{ id, label, items: [{ key, icon?, kind?, title, since?, tone?, external?, open?(), actions? }] }] — those with items. */
export function NeedsView({ groups, now, toast }) {
  const t = useT()
  if (!groups.length) return null
  return (
    <div className="wb-view wb-pad wb-needs">
      {groups.map(g => (
        <section key={g.id}>
          <h3 className="wb-needs-head">{g.label}<span className="wb-count wb-count-warn">{g.items.length}</span></h3>
          <ul className="wb-notices">
            {g.items.map(i => {
              const Icon = NEED_ICON[i.icon] || Bell
              // a row that opens where it lives; one with actions only (a System-like row) gets them as buttons
              if (!i.open && i.actions?.length) return <SysRow key={i.key} x={i} now={now} toast={toast} />
              return (
                <li key={i.key}>
                  <button className={cx('wb-notice', `wb-t-${toneOf(i.tone)}`)} onClick={() => i.open?.()}>
                    <Icon size={15} className="wb-notice-icon" />
                    <span className="wb-notice-main"><b>{i.kind || i.title}</b>{i.kind && <span className="wb-sub">{i.title}</span>}</span>
                    {i.since ? <span className="wb-notice-when wb-sub" title={new Date(i.since).toLocaleString(dateLoc())}>{t('ago', { t: ago(now - i.since) })}</span> : null}
                    {i.external && <ExternalLink size={12} className="wb-notice-when wb-sub" />}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

// ── the System tab: what this machine needs from the person (a connection that fails or runs out, a CLI not signed in,
// a skill pack that could not be fetched, a security finding), from other plugins (the slot 'ruyix.inbox.system') ──
const SYS = { danger: [XCircle, 0], red: [XCircle, 0], warning: [AlertTriangle, 1], amber: [AlertTriangle, 1], info: [Info, 2] }
/** groups: [{ id, label, items: [{ key, tone, title, detail?, affects?, since?, actions: [{ label, primary?, run() }] }] }] */
export function SystemView({ groups, now, toast }) {
  const t = useT()
  const shown = groups.filter(g => g.items.length)
  if (!shown.length) return <div className="wb-view wb-pad"><div className="wb-sys-ok"><ShieldCheck size={22} /><div><b>{t('sys.ok')}</b><span className="wb-sub">{t('sys.okHint')}</span></div></div></div>
  return (
    <div className="wb-view wb-pad wb-sys">
      <p className="wb-sub wb-block">{t('sys.hint')}</p>
      {shown.map(g => (
        <section key={g.id} className="wb-sys-group">
          <h3 className="wb-needs-head">{g.label}<span className={cx('wb-count', g.items.some(blocksWork) && 'wb-count-warn')}>{g.items.length}</span></h3>
          <ul className="wb-sys-list">{[...g.items].sort((a, b) => (SYS[a.tone]?.[1] ?? 3) - (SYS[b.tone]?.[1] ?? 3)).map(x => <SysRow key={x.key} x={x} now={now} toast={toast} />)}</ul>
        </section>
      ))}
    </div>
  )
}

function SysRow({ x, now, toast }) {
  const t = useT()
  const [busy, setBusy] = useState(-1)
  const run = async (a, i) => { setBusy(i); try { await a.run() } catch (err) { toast?.('error', err?.message || String(err)) } finally { setBusy(-1) } }
  const Icon = SYS[x.tone]?.[0] || Info
  const tone = { red: 'danger', amber: 'warning', blue: 'info' }[x.tone] || x.tone || 'info'
  return (
    <li className={cx('wb-sys-row', `wb-sys-${tone}`)}>
      <Icon size={16} className="wb-sys-icon" />
      <div className="wb-sys-main">
        <b>{x.title}</b>
        {x.detail && <p className="wb-sub">{x.detail}</p>}
        {(x.affects?.length > 0 || x.since) && (
          <div className="wb-sys-meta">
            {x.affects?.length > 0 && <><span className="wb-sub">{t('sys.affects')}</span>{x.affects.map(a => <span key={a} className="wb-sys-chip">{a}</span>)}</>}
            {x.since && <span className="wb-sub wb-sys-at" title={new Date(x.since).toLocaleString(dateLoc())}>{t('sys.checked', { t: ago(now - x.since) })}</span>}
          </div>
        )}
      </div>
      <div className="wb-sys-actions">{(x.actions || []).map((a, i) => (
        <button key={a.label} className={cx('wb-btn wb-small', a.primary && 'wb-primary')} disabled={busy >= 0} onClick={() => run(a, i)}>{busy === i && <Loader2 size={12} className="wb-spin" />}{a.label}</button>
      ))}{x.open && !x.actions?.length && <button className="wb-btn wb-small wb-primary" onClick={() => x.open()}>{t('sys.open')}</button>}</div>
    </li>
  )
}
