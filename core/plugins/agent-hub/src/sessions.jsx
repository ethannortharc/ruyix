// Agents → 会话: the pool's sessions (sessions.js) — a list beside the one open: its conversation as it goes (what was
// asked, said, each tool call, each turn's end), a box to write to it, stop and close. A new one: an agent, a folder, the
// first message. The documents come with the page's sync; the conversation is read from where the page was.
import { useEffect, useRef, useState } from 'react'
import { Bot, CirclePause, CircleStop, FileText, FolderOpen, Loader2, MessagesSquare, Plus, Power, Send, Trash2, Workflow } from 'lucide-react'
import { call, local } from './data.js'
import { withAnswers } from '../session-text.js'
import { openRegistry } from '@ruyix/shell/open'
import { RuntimeBadge, ago, cx, errorText, kfmt, toolInfo, useT } from './ui.jsx'
import { money } from '@ruyix/shell/money'

/** A session's look on the page: working / idle (its process on or not) / failed last turn. */
const stateOf = d => (d.state === 'working' ? 'running' : d.error ? 'error' : d.process === 'on' ? 'idle-on' : 'idle')

export function SessionsPage({ store, agents, now, toast, refresh }) {
  const t = useT()
  const list = [...store.sessions.values()].filter(d => !d.removedAt).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
  const [open, setOpenState] = useState(() => local.get('agentHub.session', null))
  const setOpen = id => { setOpenState(id); local.set('agentHub.session', id) }
  const current = open && open !== 'new' ? store.sessions.get(open) : null
  // (a desk's mark opens one: agent-hub:open { tab: 'sessions', session })
  useEffect(() => { const on = e => { if (e.detail?.session) setOpen(String(e.detail.session)) }; window.addEventListener('agent-hub:show', on); return () => window.removeEventListener('agent-hub:show', on) }, [])
  // (one just started may not have come with the sync yet: only a removed one is left for the next)
  useEffect(() => { if (current?.removedAt) setOpen(list[0]?.id || null) }, [current])
  const usable = agents.filter(a => a.runtime !== 'dsh')
  return (
    <div className="ah-body">
      <aside className="ah-rail ah-ses-rail">
        <div className="ah-rail-tools">
          <button className="ah-btn ah-primary" onClick={() => setOpen('new')}><Plus size={13} />{t('ses.new')}</button>
        </div>
        {!list.length && <p className="ah-sub ah-ses-none">{t('ses.none')}</p>}
        <ul className="ah-ses-list">
          {list.map(d => (
            <li key={d.id}>
              <button className={cx('ah-ses-item', open === d.id && 'ah-on')} onClick={() => setOpen(d.id)}>
                <span className={cx('ah-ses-dot', `ah-ses-${stateOf(d)}`)} />
                <span className="ah-ses-main">
                  <b>{d.title}</b>
                  <span className="ah-sub">{d.agent} · {d.state === 'working' ? t('ses.working') : ago(t, now - (d.lastAt || d.createdAt))}{d.by === 'main' ? ` · ${t('ses.byMain')}` : d.by === 'run' ? ` · ${t('ses.byRun')}` : ''}</span>
                  {d.said && <span className="ah-ses-said">{d.state === 'working' && d.now?.tool ? toolInfo(t, d.now.tool).verb : d.said}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="ah-detail">
        {open === 'new'
          ? <NewSession agents={usable} onStarted={d => { setOpen(d.id); refresh?.() }} onCancel={() => setOpen(list[0]?.id || null)} />
          : current
            ? <SessionView key={current.id} d={current} toast={toast} onRemoved={() => { setOpen(null); refresh?.() }} />
            : <div className="ah-ses-empty"><MessagesSquare size={28} /><p>{t('ses.intro')}</p><button className="ah-btn ah-primary" onClick={() => setOpen('new')}><Plus size={13} />{t('ses.new')}</button></div>}
      </main>
    </div>
  )
}

function NewSession({ agents, onStarted, onCancel }) {
  const t = useT()
  const [agent, setAgent] = useState(() => agents[0]?.id || '')
  const [cwd, setCwd] = useState('')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const start = async () => {
    setBusy(true); setError(null)
    try { const { session } = await call('sessionStart', { agent, cwd: cwd.trim() || undefined, title: title.trim() || undefined, text: text.trim() }); onStarted(session) } catch (err) { setError(err) }
    setBusy(false)
  }
  if (!agents.length) return <div className="ah-ses-empty"><Bot size={26} /><p>{t('ses.noAgents')}</p></div>
  return (
    <form className="ah-ses-new" onSubmit={e => { e.preventDefault(); if (text.trim() && !busy) start() }}>
      <h3>{t('ses.new')}</h3>
      <p className="ah-sub">{t('ses.newHint')}</p>
      <label><span>{t('ses.agent')}</span>
        <select className="ah-input" value={agent} onChange={e => setAgent(e.target.value)}>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name || a.id} · {a.runtime}{a.model ? ` · ${a.model}` : ''}</option>)}
        </select>
      </label>
      <label><span>{t('ses.folder')}</span><input className="ah-input ah-mono" value={cwd} onChange={e => setCwd(e.target.value)} placeholder={t('ses.folderPh')} spellCheck={false} /></label>
      <label><span>{t('ses.title')}</span><input className="ah-input" value={title} onChange={e => setTitle(e.target.value)} placeholder={t('ses.titlePh')} /></label>
      <label><span>{t('ses.first')}</span><textarea className="ah-input" rows={5} value={text} onChange={e => setText(e.target.value)} placeholder={t('ses.firstPh')} /></label>
      {error && <div className="ah-note ah-tone-error">{errorText(t, error)}</div>}
      <div className="ah-ses-actions">
        <button className="ah-btn ah-primary" disabled={busy || !text.trim() || !agent}>{busy ? <Loader2 size={13} className="ah-spin" /> : <Send size={13} />}{t('ses.start')}</button>
        <button type="button" className="ah-btn" onClick={onCancel}>{t('cancel')}</button>
      </div>
    </form>
  )
}

/** One session: its conversation as it goes, read from where the page was; the box to write to it. */
function SessionView({ d, toast, onRemoved }) {
  const t = useT()
  const [events, setEvents] = useState([])
  const [error, setError] = useState(null)
  const seen = useRef(0)
  const end = useRef(null)
  // (read again when its record moves on — the sync brings `seq` — and, while it works, every second)
  useEffect(() => {
    let stop = false, reading = false
    const read = async () => {
      if (reading) return
      reading = true
      try {
        const r = await call('sessionRead', { id: d.id, after: seen.current })
        if (stop || !r.events.length) return
        seen.current = r.events.at(-1).seq
        setEvents(all => [...all, ...r.events].slice(-1500))
      } catch (err) { if (!stop) setError(err) } finally { reading = false }
    }
    read()
    const timer = d.state === 'working' ? setInterval(read, 1000) : null
    return () => { stop = true; clearInterval(timer) }
  }, [d.id, d.seq, d.state])
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [events.length])
  // one of the desk's open things (the shell's open list): with its run's when a run opened it, else among the sessions
  useEffect(() => { openRegistry().add({ id: `session:${d.id}`, kind: 'session', title: d.title, hint: d.agent, ...(d.of?.run && { of: `run:${d.of.run}` }), reopen: { event: 'agent-hub:open', detail: { tab: 'sessions', session: d.id } } }) }, [d.id, d.title])
  // looked at: its last answer is seen (the desks' 「做完的」 counts what is not)
  useEffect(() => { if (d.state !== 'working' && (d.turns || 0) > (d.seenTurns || 0) && !document.hidden) call('sessionSeen', { id: d.id }).catch(() => {}) }, [d.id, d.turns, d.state])
  const act = async (op, done) => { try { await call(op, { id: d.id }); done?.() } catch (err) { setError(err) } }
  return (
    <section className="ah-ses-view">
      <header className="ah-ses-head">
        <div className="ah-ses-titles">
          <h3>{d.title}</h3>
          <span className="ah-sub ah-ses-meta">
            <RuntimeBadge runtime={d.runtime} model={d.model} />
            <span className="ah-mono" title={d.cwd}><FolderOpen size={12} />{d.cwd}</span>
            <span>{t('ses.turns', { n: d.turns || 0 })}{d.tokens ? ` · ${kfmt(d.tokens)} tokens` : ''}{d.cost ? ` · ${money(d.cost)}` : ''}</span>
            <span className={cx('ah-ses-proc', d.process === 'on' && 'ah-on')} title={t('ses.procHint')}><Power size={11} />{d.process === 'on' ? t('ses.procOn') : t('ses.procOff')}</span>
            {d.of?.run && <button type="button" className="ah-linkbtn ah-ses-run" onClick={() => window.dispatchEvent(new CustomEvent('ruyix-workbench:open', { detail: { run: d.of.run, tab: 'pipeline' } }))}><Workflow size={11} />{t('ses.ofRun', { step: d.of.step || '' })}</button>}
          </span>
        </div>
        <div className="ah-ses-acts">
          {/* what it made: the files of its folder made or changed since it began, in the workbench's viewer window */}
          {(d.turns || 0) > 0 && <button className="ah-btn" title={t('ses.filesHint')} onClick={() => window.dispatchEvent(new CustomEvent('ruyix-workbench:view', { detail: { session: d.id, title: d.title } }))}><FileText size={13} />{t('ses.files')}</button>}
          {d.state === 'working' && <button className="ah-btn" onClick={() => act('sessionStop')}><CircleStop size={13} />{t('ses.stop')}</button>}
          {d.process === 'on' && d.state !== 'working' && <button className="ah-btn" onClick={() => act('sessionClose')} title={t('ses.closeHint')}><CirclePause size={13} />{t('ses.close')}</button>}
          <button className="ah-icon-btn" title={t('ses.remove')} aria-label={t('ses.remove')} onClick={() => window.confirm(t('ses.removeConfirm', { name: d.title })) && act('sessionRemove', () => { toast(t('ses.removed')); onRemoved() })}><Trash2 size={14} /></button>
        </div>
      </header>
      <div className="ah-ses-log">
        {withAnswers(events).map(e => <Event key={`${e.seq}${e.answer ? 'a' : ''}`} e={e} />)}
        {d.state === 'working' && <div className="ah-ses-busy"><Loader2 size={13} className="ah-spin" />{d.now?.tool ? toolInfo(t, d.now.tool).verb : t('ses.thinking')}</div>}
        <span ref={end} />
      </div>
      {error && <div className="ah-note ah-tone-error">{errorText(t, error)}</div>}
      <Writer id={d.id} working={d.state === 'working'} />
    </section>
  )
}

function Event({ e }) {
  const t = useT()
  const v = e.data || {}
  switch (e.type) {
    case 'user/message': return <div className="ah-ses-msg ah-ses-you">{v.text}</div>
    case 'assistant/message': return <div className="ah-ses-msg ah-ses-it">{(v.message?.content || []).map(c => c.text || '').join('').trim()}</div>
    case 'tool/call': { const { verb, Icon } = toolInfo(t, v.name); return <div className="ah-ses-tool"><Icon size={12} /><span>{verb}</span><span className="ah-mono">{shortArgs(v.arguments)}</span></div> }
    case 'turn/end': return <div className={cx('ah-ses-turn', !v.ok && 'ah-tone-error')}>{v.ok ? t('ses.turnDone', { tools: v.tools || 0, tokens: kfmt(v.tokens || 0) }) : t('ses.turnFailed', { why: v.error })}</div>
    case 'note': return <div className="ah-ses-note">{v.text}</div>
    default: return null
  }
}
const shortArgs = a => { try { const o = JSON.parse(a || '{}'); const v = o.file_path || o.path || o.command || o.pattern || o.query || o.url || Object.values(o)[0]; return String(v ?? '').slice(0, 140) } catch { return '' } }

function Writer({ id, working }) {
  const t = useT()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const send = async () => {
    if (!value.trim() || busy) return
    setBusy(true); setNote(null)
    try { const r = await call('sessionSend', { id, text: value }); setValue(''); if (r.queued) setNote(t('ses.queued')) } catch (err) { setNote(err) }
    setBusy(false)
  }
  return (
    <div className="ah-composer">
      <textarea rows={2} value={value} disabled={busy} placeholder={working ? t('ses.writeBusy') : t('ses.write')}
        onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
      <button className="ah-icon-btn ah-primary-btn" disabled={busy || !value.trim()} onClick={send} aria-label={t('send')}>{busy ? <Loader2 size={15} className="ah-spin" /> : <Send size={15} />}</button>
      {note && <div className="ah-composer-note">{typeof note === 'string' ? note : errorText(t, note)}</div>}
    </div>
  )
}
