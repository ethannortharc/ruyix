// The Box panel: the nookbox box this dsh runs in. Overview (what the box is, what the audit sees, the egress policy,
// the credentials it holds placeholders for, and the host commands that change any of it), Insights (health, security
// findings, how each client fared, what looks off), Traffic (every HTTP exchange with headers and bodies), Timeline
// (processes, files, connections, DNS, policy), Usage (model tokens). Insights also shows the AI work the workbench did
// (by agent) and which task was running when the box saw each finding and anomaly.
// All read from the box's own nookbox window through this plugin's host half; nothing here changes the box.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowDownLeft, ArrowUpRight, BarChart3, Bot, Boxes, Timer, Check, ChevronRight, Copy, Cpu, Eye, Gauge, Globe, KeyRound,
  Loader2, Lock, RefreshCw, Search, Server, Shield, ShieldAlert, ShieldCheck, Sparkles, Terminal, X, Zap,
} from 'lucide-react'
import css from './styles.css'
// the product's semantic tokens (--ruyix-*), bundled so this plugin looks the same with the shell off
import tokens from '@ruyix/shell/tokens.css'
import { en, zh } from './locale.js'
import { atWork, spanOf } from '../lib/box.js'
import { money } from '@ruyix/shell/money'
import { startShield } from './shield.jsx'

const PANEL = 'ruyix-box'
const NS = 'ruyix-box'
const cx = (...n) => n.filter(Boolean).join(' ')
async function call(op, args) {
  const res = await fetch('api/ruyix-box', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...args }) })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok || data.error) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: data.code, params: data.params })
  return data
}
const errText = (t, err) => {
  const key = err?.code && `err.${err.code}`
  const text = key && t(key, err.params || {})
  return text && text !== key ? text : err?.message || String(err)
}
let dateLocale = 'zh-CN'
const when = ts => (ts ? new Date(ts).toLocaleString(dateLocale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')
const num = n => (n ?? 0).toLocaleString(dateLocale)
const compact = n => new Intl.NumberFormat(dateLocale, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0)
const bytes = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n || 0} B`)
const local = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

// ── loading: every part fetched by itself; the answer it last had shows at once, a fresh one replaces it ──
const cache = new Map() // key → { value, at }, for as long as the page is loaded
/** An op's answer by `key`: the one kept shows at once (a skeleton before the first), asked again behind it; `nonce` asks again. */
function useData(key, load, nonce = 0) {
  const kept = () => cache.get(key) || { value: null, at: 0 }
  const [st, setSt] = useState(() => ({ key, ...kept(), error: null, busy: true }))
  useEffect(() => {
    let live = true
    setSt(x => (x.key === key ? { ...x, error: null, busy: true } : { key, ...kept(), error: null, busy: true }))
    load().then(value => { cache.set(key, { value, at: Date.now() }); if (live) setSt({ key, value, at: Date.now(), error: null, busy: false }) },
      error => { if (live) setSt(x => ({ ...x, error, busy: false })) })
    return () => { live = false }
  }, [key, nonce])
  return st.key === key ? st : { key, ...kept(), error: null, busy: true }
}
const Skel = ({ h = 120 }) => <div className="nb-skel" style={{ height: h }} aria-hidden="true" />
/** A part that is drawn once it comes near the view (after the first paint); a skeleton of its height holds its place. */
function Later({ h = 160, children }) {
  const ref = useRef(null)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (on || !ref.current) return
    if (typeof IntersectionObserver === 'undefined') { setOn(true); return }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { setOn(true); io.disconnect() } }, { rootMargin: '240px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [on])
  return on ? children : <div ref={ref}><Skel h={h} /></div>
}
/** A card's head: what it is, a line on how to read it, and what sits at its right. */
function Head({ icon: Icon, title, sub, aside }) {
  return (
    <header className="nb-sec-h">
      <span className="nb-sec-icon"><Icon size={14} /></span>
      <div className="nb-sec-t"><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
      {aside}
    </header>
  )
}

function CopyCmd({ t, cmd }) {
  const [done, setDone] = useState(false)
  const copy = async () => { try { await navigator.clipboard.writeText(cmd); setDone(true); setTimeout(() => setDone(false), 1500) } catch { /* no clipboard */ } }
  return (
    <div className="nb-cmd">
      <Terminal size={13} />
      <code>{cmd}</code>
      <button className="nb-icon-btn" title={t(done ? 'copied' : 'copy')} onClick={copy}>{done ? <Check size={13} /> : <Copy size={13} />}</button>
    </div>
  )
}

const Chip = ({ ok, children }) => <span className={cx('nb-chip', ok ? 'nb-ok' : 'nb-off')}>{ok ? <Check size={12} /> : <X size={12} />}{children}</span>

function Tile({ icon: Icon, label, value, tone, hint }) {
  return (
    <div className={cx('nb-tile', tone && `nb-${tone}`)}>
      <span className="nb-tile-icon"><Icon size={15} /></span>
      <span className="nb-tile-value">{value}</span>
      <span className="nb-tile-label">{label}{hint && <em>{hint}</em>}</span>
    </div>
  )
}

function Overview({ t, s, nonce }) {
  const stats = useData('stats', () => call('stats', { hours: 24 }), nonce).value
  const b = s.box, spec = b.spec, cov = b.agent?.coverage || {}, pol = spec.policy || {}
  const vm = spec.runtime === 'microvm'
  const sensor = cov.sensor ? `cov.sensor.${cov.sensor}` : 'cov.sensor.none'
  const name = b.name
  return (
    <>
      <section className="nb-hero">
        <div className="nb-hero-main">
          <span className={cx('nb-dot', b.state === 'running' && 'nb-live')} />
          <div className="nb-hero-text">
            <h2>{name}</h2>
            <span className="nb-sub">{vm ? t('box.microvm') : t('box.docker')}{spec.oci_runtime ? ` · ${spec.oci_runtime.replace('io.containerd.', '').replace('.v2', '')}` : ''}</span>
          </div>
        </div>
        <div className="nb-facts">
          {spec.image && <div><span>{t('box.image')}</span><code>{spec.image}</code></div>}
          <div><span>{t('box.resources')}</span><b>{[spec.cpus && t('box.cpus', { n: spec.cpus }), spec.memory_mb && t('box.memory', { n: spec.memory_mb })].filter(Boolean).join(' · ') || '—'}</b></div>
          <div><span>{t('box.ports')}</span><b>{spec.ports?.length ? spec.ports.map(p => `127.0.0.1:${p.host} → ${p.guest}`).join(', ') : t('box.noPorts')}</b></div>
          <div><span>{t('box.mounts')}</span><b>{spec.mounts?.length ? spec.mounts.map(m => `${m.source} → ${m.target}${m.mode === 'ro' ? ` (${t('box.ro')})` : ''}`).join(', ') : t('box.noMounts')}</b></div>
          {spec.start && <div><span>{t('box.start')}</span><code>{spec.start}</code></div>}
        </div>
      </section>

      {stats && (
        <section className="nb-tiles">
          <Tile icon={Globe} label={t('stats.requests')} value={num(stats.requests)} />
          <Tile icon={Server} label={t('stats.hosts')} value={num((stats.top_hosts || []).length)} />
          <Tile icon={Zap} label={t('stats.tokens')} value={num((stats.tokens_in || 0) + (stats.tokens_out || 0))} />
          <Tile icon={AlertTriangle} label={t('stats.alerts')} value={num(stats.alerts || 0)} tone={stats.alerts ? 'warn' : ''} />
        </section>
      )}

      <div className="nb-cols">
        <section className="nb-card">
          <h3><Eye size={14} />{t('cov.title')}</h3>
          <div className="nb-chips">
            <Chip ok={cov.net}>{t('cov.net')}</Chip>
            <Chip ok={cov.dns}>{t('cov.dns')}</Chip>
            <Chip ok={cov.sensor === 'ebpf' || cov.sensor === 'engine'}>{t(sensor)}</Chip>
          </div>
          <h3 className="nb-gap"><Shield size={14} />{t('pol.title')}</h3>
          <p className="nb-line">{t(`pol.${pol.mode || 'open'}`)}</p>
          {pol.allow_private && <p className="nb-line nb-sub">{t('pol.private')}</p>}
          {'allow_exfil' in pol && <p className="nb-line nb-sub">{t(pol.allow_exfil ? 'pol.exfilOpen' : 'pol.exfilBlocked')}</p>}
          {pol.allow?.length > 0 && <p className="nb-line"><span className="nb-sub">{t('pol.allow')}</span> <code className="nb-mono">{pol.allow.join(', ')}</code></p>}
          {pol.deny?.length > 0 && <p className="nb-line"><span className="nb-sub">{t('pol.deny.list')}</span> <code className="nb-mono">{pol.deny.join(', ')}</code></p>}
          {pol.passthrough?.length > 0 && <p className="nb-line"><span className="nb-sub">{t('pol.passthrough')}</span> <code className="nb-mono">{pol.passthrough.join(', ')}</code></p>}
          {stats?.top_hosts?.length > 0 && (
            <>
              <h3 className="nb-gap"><Globe size={14} />{t('stats.topHosts')}</h3>
              <ul className="nb-bars">
                {stats.top_hosts.slice(0, 6).map(h => {
                  const max = stats.top_hosts[0].requests || 1
                  return <li key={h.host}><span className="nb-mono">{h.host}</span><span className="nb-bar"><i style={{ width: `${Math.max(4, (h.requests / max) * 100)}%` }} /></span><b>{num(h.requests)}</b></li>
                })}
              </ul>
            </>
          )}
        </section>

        <section className="nb-card">
          <h3><KeyRound size={14} />{t('cred.title')}</h3>
          {!s.credentials?.length ? <p className="nb-sub">{t('cred.none')}</p> : (
            <ul className="nb-creds">
              {s.credentials.map(c => (
                <li key={c.name}>
                  <div className="nb-cred-top"><Lock size={13} /><b>{c.name}</b><span className="nb-tag">{c.kind}</span>{c.login && <span className="nb-tag">{t('cred.login')}</span>}{!c.set && <span className="nb-tag nb-warn">{t('cred.unset')}</span>}</div>
                  <div className="nb-sub">{t('cred.hosts')} <span className="nb-mono">{c.hosts.join(', ') || '—'}</span>{c.env?.length > 0 && <> · {t('cred.env')} <span className="nb-mono">${c.env.join(', $')}</span></>}</div>
                  <div className="nb-sub">{c.last_used_at ? t('cred.used', { at: when(c.last_used_at) }) : t('cred.never')}</div>
                </li>
              ))}
            </ul>
          )}
          <p className="nb-note"><ShieldCheck size={13} />{t('cred.note')}</p>
        </section>
      </div>

      <section className="nb-card">
        <h3><Terminal size={14} />{t('host.title')}</h3>
        <p className="nb-sub">{t('host.note')}</p>
        <div className="nb-cmds">
          <label>{t('host.secret')}</label><CopyCmd t={t} cmd={`nookbox secret add http --name <name> --host <host> --env <VAR> --bind ${name}`} />
          <label>{t('host.login')}</label><CopyCmd t={t} cmd={`nookbox login codex ${name}; nookbox login claude ${name}`} />
          <label>{t('host.mount')}</label><CopyCmd t={t} cmd={`nookbox update ${name} --mount <host folder>`} />
          <label>{t('host.allow')}</label><CopyCmd t={t} cmd={`nookbox update ${name} --allow <host>`} />
          {spec.image && <><label>{t('host.upgrade')}</label><CopyCmd t={t} cmd={`nookbox update ${name} --image ${spec.image.replace(/:[^:/]+$/, '')}:<version>`} /></>}
        </div>
      </section>
    </>
  )
}

function Body({ t, body }) {
  if (!body) return <p className="nb-sub">{t('flow.noBody')}</p>
  if (body.base64 !== undefined) return <p className="nb-sub">{t('flow.binary', { n: body.bytes })}</p>
  let text = body.text
  try { text = JSON.stringify(JSON.parse(text), null, 2) } catch { /* not JSON */ }
  return <pre className="nb-pre">{text.length > 60000 ? `${text.slice(0, 60000)}\n…` : text}</pre>
}

function FlowDetail({ t, id, onClose }) {
  const [d, setD] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => { setD(null); call('flow', { id }).then(setD, err => setError(errText(t, err))) }, [id])
  const f = d?.flow
  return (
    <aside className="nb-drawer">
      <header>
        <b>{f ? `${f.method} ${f.host}` : '…'}</b>
        <span className="nb-grow" />
        <button className="nb-icon-btn" title={t('flow.close')} onClick={onClose}><X size={15} /></button>
      </header>
      {error && <div className="nb-alert"><AlertTriangle size={14} /> {error}</div>}
      {!f ? !error && <div className="nb-sub nb-pad"><Loader2 size={14} className="nb-spin" /> {t('loading')}</div> : (
        <div className="nb-drawer-body">
          <p className="nb-mono nb-url">{f.scheme}://{f.host}{f.port && ![80, 443].includes(f.port) ? `:${f.port}` : ''}{f.path}</p>
          <p className="nb-sub">{when(f.ts)} · {f.http_version} · {f.duration_ms} ms{f.secrets?.length ? ` · ${t('traffic.creds')}: ${f.secrets.join(', ')}` : ''}</p>
          {f.model && <p className="nb-pill-line"><Zap size={13} />{t('flow.model', { model: f.model, input: num(f.input_tokens), output: num(f.output_tokens) })}</p>}
          <h4><ArrowUpRight size={13} />{t('flow.request')} <span className="nb-sub">{bytes(f.req_bytes)}</span></h4>
          <details><summary>{t('flow.headers')} ({f.req_headers.length})</summary><table className="nb-kv"><tbody>{f.req_headers.map(([k, v], i) => <tr key={i}><td>{k}</td><td>{v}</td></tr>)}</tbody></table></details>
          <Body t={t} body={d.request_body} />
          <h4><ArrowDownLeft size={13} />{t('flow.response')} <span className={cx('nb-status', f.status >= 400 && 'nb-bad')}>{f.error || f.status}</span> <span className="nb-sub">{bytes(f.resp_bytes)}</span></h4>
          <details><summary>{t('flow.headers')} ({f.resp_headers.length})</summary><table className="nb-kv"><tbody>{f.resp_headers.map(([k, v], i) => <tr key={i}><td>{k}</td><td>{v}</td></tr>)}</tbody></table></details>
          <Body t={t} body={d.response_body} />
        </div>
      )}
    </aside>
  )
}

function Traffic({ t, setError }) {
  const [rows, setRows] = useState(null)
  const [host, setHost] = useState('')
  const [open, setOpen] = useState(null)
  const filter = useRef(host), request = useRef(0)
  filter.current = host
  const load = useCallback(async (before) => {
    const seq = ++request.current
    try {
      const page = await call('flows', { limit: 100, host: host.trim() || undefined, before })
      if (seq === request.current && filter.current === host) setRows(r => (before ? [...(r || []), ...page.filter(x => !r?.some(y => y.id === x.id))] : page))
    } catch (err) { if (seq === request.current && filter.current === host) setError(errText(t, err)) }
  }, [host])
  useEffect(() => { setRows(null); const timer = setTimeout(() => load(), 250); return () => clearTimeout(timer) }, [load])
  return (
    <div className={cx('nb-split', open && 'nb-split-open')}>
      <div className="nb-split-main">
        <div className="nb-toolbar">
          <div className="nb-search"><Search size={13} /><input value={host} placeholder={t('traffic.filter')} onChange={e => setHost(e.target.value)} /></div>
        </div>
        {!rows ? <div className="nb-sub"><Loader2 size={14} className="nb-spin" /> {t('loading')}</div> : !rows.length ? <div className="nb-empty"><Globe size={22} />{t('traffic.empty')}</div> : (
          <>
            <table className="nb-table nb-flows">
              <colgroup><col className="nb-c-time" /><col /><col className="nb-c-status" /><col className="nb-c-size" /></colgroup>
              <thead><tr><th>{t('traffic.when')}</th><th>{t('traffic.request')}</th><th>{t('traffic.status')}</th><th className="nb-r">{t('traffic.size')}</th></tr></thead>
              <tbody>
                {rows.map(f => (
                  <tr key={f.id} className={cx(open === f.id && 'nb-sel')} onClick={() => setOpen(f.id)}>
                    <td className="nb-time">{when(f.ts)}</td>
                    <td className="nb-req">
                      <span className={`nb-method nb-m-${f.method.toLowerCase()}`}>{f.method}</span>
                      <span className="nb-host">{f.host}</span><span className="nb-path" title={f.path}>{f.path}</span>
                      {f.secrets?.length > 0 && <span className="nb-tag"><KeyRound size={10} />{f.secrets.join(', ')}</span>}
                      {f.model && <span className="nb-tag nb-ai"><Zap size={10} />{f.model}</span>}
                      {AGENTS.has(f.client) && <span className="nb-tag">{clientName(t, f.client)}</span>}
                    </td>
                    <td className="nb-nowrap" title={f.error || ''}><span className={cx('nb-status', (f.error || f.status >= 400) && 'nb-bad')}>{f.error ? '!' : f.status}</span> <span className="nb-sub">{f.duration_ms} ms</span></td>
                    <td className="nb-r nb-sub">{bytes(f.resp_bytes)} <ChevronRight size={12} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length % 100 === 0 && <button className="nb-btn nb-more" onClick={() => load(rows[rows.length - 1].id)}>{t('traffic.more')}</button>}
          </>
        )}
      </div>
      {open && <FlowDetail t={t} id={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

const KINDS = ['exec', 'file', 'net', 'dns', 'policy', 'violation', 'lifecycle', 'agent']
function Timeline({ t, setError }) {
  const [kinds, setKinds] = useState(() => local.get('nb.kinds', []))
  const [text, setText] = useState('')
  const [rows, setRows] = useState(null)
  const timer = useRef(null), request = useRef(0), filter = useRef('')
  const want = JSON.stringify([kinds, text])
  filter.current = want
  const load = useCallback(async () => {
    const seq = ++request.current
    try {
      const page = await call('events', { kinds, text: text.trim() || undefined, limit: 300 })
      if (seq === request.current && filter.current === want) setRows(page)
    } catch (err) { if (seq === request.current && filter.current === want) setError(errText(t, err)) }
  }, [want])
  useEffect(() => { clearTimeout(timer.current); timer.current = setTimeout(load, 250); return () => clearTimeout(timer.current) }, [load])
  const toggle = k => { const next = kinds.includes(k) ? kinds.filter(x => x !== k) : [...kinds, k]; setKinds(next); local.set('nb.kinds', next) }
  return (
    <>
      <div className="nb-toolbar">
        <div className="nb-filters">
          <button className={cx('nb-filter', !kinds.length && 'nb-on')} onClick={() => { setKinds([]); local.set('nb.kinds', []) }}>{t('tl.all')}</button>
          {KINDS.map(k => <button key={k} className={cx('nb-filter', `nb-k-${k}`, kinds.includes(k) && 'nb-on')} onClick={() => toggle(k)}><i />{t(`kind.${k}`)}</button>)}
        </div>
        <div className="nb-search"><Search size={13} /><input value={text} placeholder={t('tl.search')} onChange={e => setText(e.target.value)} /></div>
      </div>
      {!rows ? <div className="nb-sub"><Loader2 size={14} className="nb-spin" /> {t('loading')}</div> : !rows.length ? <div className="nb-empty"><Activity size={22} />{t('tl.empty')}</div> : (
        <ol className="nb-timeline">
          {rows.map(e => (
            <li key={e.id} className={cx(`nb-k-${e.kind}`, ['warn', 'alert'].includes(e.severity) && 'nb-sev')}>
              <i />
              <span className="nb-time">{when(e.ts)}</span>
              <span className="nb-kind">{t(`kind.${e.kind}`) === `kind.${e.kind}` ? e.kind : t(`kind.${e.kind}`)}</span>
              <span className="nb-summary">{e.label && e.label.risk !== 'benign' && <span className={`nb-risk nb-r-${e.label.risk}`} title={tagText(t, e.label.tags?.[0], e.label.reason).desc}>{tagText(t, e.label.tags?.[0], e.label.reason).title}</span>}{e.summary}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

function Usage({ t, setError, nonce }) {
  const [days, setDays] = useState(7)
  const u = useData(`usage:${days}`, () => call('usage', { days }), nonce)
  useEffect(() => { if (u.error) setError(errText(t, u.error)) }, [u.error])
  const rows = u.value
  const by = useMemo(() => {
    const m = new Map()
    for (const r of rows || []) {
      const k = `${r.provider}/${r.model}`, x = m.get(k) || { model: r.model, provider: r.provider, requests: 0, input: 0, output: 0, cr: 0, cw: 0 }
      x.requests += r.requests; x.input += r.input_tokens; x.output += r.output_tokens; x.cr += r.cache_read_tokens; x.cw += r.cache_write_tokens
      m.set(k, x)
    }
    return [...m.values()].sort((a, b) => b.input + b.output - a.input - a.output)
  }, [rows])
  const total = by.reduce((a, x) => ({ requests: a.requests + x.requests, input: a.input + x.input, output: a.output + x.output, cr: a.cr + x.cr, cw: a.cw + x.cw }), { requests: 0, input: 0, output: 0, cr: 0, cw: 0 })
  const max = Math.max(1, ...by.map(x => x.input + x.output))
  return (
    <>
      <div className="nb-toolbar">
        <div className="nb-filters">{[1, 7, 30, 90].map(n => <button key={n} className={cx('nb-filter', days === n && 'nb-on')} onClick={() => setDays(n)}>{n === 1 ? t('usage.day') : t('usage.days', { n })}</button>)}</div>
      </div>
      {!rows ? <div className="nb-sub"><Loader2 size={14} className="nb-spin" /> {t('loading')}</div> : !by.length ? <div className="nb-empty"><Cpu size={22} />{t('usage.empty')}</div> : (
        <table className="nb-table nb-usage">
          <thead><tr><th>{t('usage.model')}</th><th className="nb-r">{t('usage.requests')}</th><th className="nb-r">{t('usage.input')}</th><th className="nb-r">{t('usage.output')}</th><th className="nb-r">{t('usage.cache')}</th></tr></thead>
          <tbody>
            {by.map(x => (
              <tr key={`${x.provider}/${x.model}`}>
                <td><b>{x.model}</b> <span className="nb-sub">{x.provider}</span><span className="nb-bar nb-bar-row"><i style={{ width: `${Math.max(2, ((x.input + x.output) / max) * 100)}%` }} /></span></td>
                <td className="nb-r">{num(x.requests)}</td><td className="nb-r">{num(x.input)}</td><td className="nb-r">{num(x.output)}</td><td className="nb-r nb-sub">{num(x.cr)} / {num(x.cw)}</td>
              </tr>
            ))}
            <tr className="nb-total"><td>{t('usage.total')}</td><td className="nb-r">{num(total.requests)}</td><td className="nb-r">{num(total.input)}</td><td className="nb-r">{num(total.output)}</td><td className="nb-r nb-sub">{num(total.cr)} / {num(total.cw)}</td></tr>
          </tbody>
        </table>
      )}
    </>
  )
}

// ── insights ──
const AGENTS = new Set(['claude', 'codex', 'dsh', 'pi'])
const clientName = (t, c) => (t(`client.${c}`) === `client.${c}` ? c : t(`client.${c}`))
/** A finding's title and line in the panel's language; a tag the panel does not know (a model's) keeps its own words. */
function tagText(t, tag, reason) {
  const title = t(`tag.${tag}`), desc = t(`tagd.${tag}`)
  return { title: title === `tag.${tag}` ? tag || '?' : title, desc: desc === `tagd.${tag}` ? reason || '' : desc }
}
const pct = v => `${Math.round((v || 0) * 1000) / 10}%`
const ms = v => (v == null ? '—' : v >= 10000 ? `${(v / 1000).toFixed(0)} s` : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`)

function HealthRing({ t, h }) {
  const r = 30, len = 2 * Math.PI * r
  return (
    <div className={cx('nb-health', `nb-h-${h.level}`)}>
      <svg viewBox="0 0 76 76" aria-hidden="true"><circle cx="38" cy="38" r={r} className="nb-ring-bg" /><circle cx="38" cy="38" r={r} className="nb-ring" strokeDasharray={`${(h.score / 100) * len} ${len}`} /></svg>
      <div className="nb-health-text"><b>{h.score}</b><span>{t(`health.${h.level}`)}</span></div>
    </div>
  )
}

function anomalyText(t, a) {
  const p = { ...a, count: num(a.count), usual: num(a.usual), at: when(a.hour || a.last), client: a.client && clientName(t, a.client), status: a.status || t('ins.connError') }
  return t(`anom.${a.code}`, p) === `anom.${a.code}` ? `${a.code} ${a.host || ''} ${num(a.count)}` : t(`anom.${a.code}`, p)
}

// every hour of the window (quiet ones too), at most 120 bars: a month's hours go in groups of six, each bar from its
// group's first hour (`hour`) to its last (`to`)
function barsOf(hourly, since) {
  if (!hourly.length) return []
  const H = 3600000
  const at = new Map(hourly.map(h => [h.hour, h]))
  const all = []
  for (let h = Math.floor(since / H) * H, end = Math.max(hourly[hourly.length - 1].hour, Math.floor(Date.now() / H) * H); h <= end; h += H) {
    all.push(at.get(h) || { hour: h, requests: 0, errors: 0, events: 0 })
  }
  const step = Math.ceil(all.length / 120) || 1
  const out = []
  all.forEach((h, i) => {
    if (i % step === 0) out.push({ ...h, to: h.hour })
    else { const b = out[out.length - 1]; b.requests += h.requests; b.errors += h.errors; b.events += h.events; b.to = h.hour }
  })
  return out
}

// ── the AI work (the workbench's aiWork) ──
const taskName = (t, x) => (x.source === 'helper' ? t('ai.helperCall', { kind: x.kind || '?' }) : `${x.name || x.runtime || '?'} · ${x.step || t('ai.job')}`)
const taskTip = (t, x) => [`${when(x.at)} – ${x.ended_at ? when(x.ended_at) : t('ai.stillRunning')}`, x.workflow, x.run_id, x.model].filter(Boolean).join(' · ')
const rateTone = r => (r == null ? '' : r < 0.6 ? 'nb-bad' : r < 0.85 ? 'nb-warn' : '')

/** The AI work running when the box saw `x` (a finding, an anomaly): matched by time, and by runtime when x names an agent client. */
function AtWork({ t, w, x }) {
  const hits = w?.tasks ? atWork(w.tasks, { ...spanOf(x), client: x.client }) : []
  if (!hits.length) return null
  return (
    <div className="nb-at-work">
      <span className="nb-sub"><Bot size={12} />{t('ai.atWork')}</span>
      {hits.slice(0, 3).map((h, i) => <span key={h.id || i} className={cx('nb-tag', h.source !== 'helper' && 'nb-ai', h.ok === false && 'nb-warn')} title={taskTip(t, h)}>{taskName(t, h)}</span>)}
      {hits.length > 3 && <span className="nb-sub">{t('ai.more', { n: hits.length - 3 })}</span>}
    </div>
  )
}

function AiWork({ t, w }) {
  const head = <Head icon={Bot} title={t('ai.title')} sub={t('ai.sub')} aside={w && !w.error && !w.available.hub && <span className="nb-tag nb-warn">{t('ai.noHub')}</span>} />
  if (!w || w.error) return <section className="nb-card nb-gap-b">{head}<p className="nb-sub">{w ? w.error : <><Loader2 size={14} className="nb-spin" /> {t('loading')}</>}</p></section>
  const tot = w.totals
  return (
    <section className="nb-card nb-gap-b">
      {head}
      {!tot.calls ? <p className="nb-sub">{t('ai.empty')}</p> : (
        <>
          <div className="nb-tiles">
            <Tile icon={Bot} label={t('ai.tasks')} value={num(tot.agent_tasks)} />
            <Tile icon={Check} label={t('ai.success')} value={tot.ok_rate == null ? '—' : pct(tot.ok_rate)} tone={rateTone(tot.ok_rate) && 'warn'} />
            <Tile icon={Zap} label={tot.cost ? `${t('ai.tokens')} · ${money(tot.cost)}` : t('ai.tokens')} value={compact(tot.tokens)} />
            <Tile icon={Sparkles} label={t('ai.helper')} value={num(tot.helper_calls)} />
          </div>
          {w.by_agent.length > 0 && (
            <div className="nb-scroll">
              <table className="nb-table nb-agents">
                <thead><tr><th>{t('ai.agent')}</th><th>{t('ai.model')}</th><th className="nb-r">{t('ai.tasks')}</th><th className="nb-r">{t('ai.success')}</th><th className="nb-r" title={t('ai.heldHow')}>{t('ai.held')}</th><th className="nb-r">{t('ai.tokens')}</th><th className="nb-r">{t('ai.time')}</th></tr></thead>
                <tbody>
                  {w.by_agent.map(a => (
                    <tr key={a.agent || a.name}>
                      <td><b>{a.name || a.agent}</b>{a.runtime && !String(a.name).includes(a.runtime) && <span className="nb-sub"> {a.runtime}</span>}<span className="nb-sub nb-mono nb-agent-model">{a.model || t('ai.default')}</span></td>
                      <td className="nb-mono">{a.model || t('ai.default')}</td>
                      <td className="nb-r">{num(a.calls)}{a.running > 0 && <span className="nb-sub"> · {t('ai.running', { n: a.running })}</span>}</td>
                      <td className="nb-r"><span className={cx('nb-rate', rateTone(a.ok_rate))}>{a.ok_rate == null ? '—' : pct(a.ok_rate)}</span></td>
                      <td className="nb-r nb-sub">{a.held_rate == null ? '—' : pct(a.held_rate)}</td>
                      <td className="nb-r">{compact(a.tokens)}{a.cost > 0 && <span className="nb-sub nb-cost"> · {money(a.cost)}</span>}</td>
                      <td className="nb-r nb-sub">{ms(a.p50_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {w.by_model.length > 0 && (
            <div className="nb-chips nb-gap-s">
              <span className="nb-sub">{t('ai.byModel')}</span>
              {w.by_model.map(m => <span key={m.model} className="nb-tag nb-ai" title={t('ai.modelTip', { agents: num(m.agent_tasks), helper: num(m.helper_calls), ok: m.ok_rate == null ? '—' : pct(m.ok_rate) })}>{m.model} · {num(m.calls)} · {compact(m.tokens)}</span>)}
            </div>
          )}
        </>
      )}
    </section>
  )
}

/** The destinations, by what one wants to see: the busiest, the slowest, the most failing. */
function Destinations({ t, x }) {
  const [by, setBy] = useState(() => local.get('nb.ins.destBy', 'busy'))
  const pick = k => { setBy(k); local.set('nb.ins.destBy', k) }
  const all = x.destinations || []
  const sort = { busy: (a, b) => b.requests - a.requests, slow: (a, b) => (b.p95_ms ?? -1) - (a.p95_ms ?? -1), failing: (a, b) => b.error_rate - a.error_rate || b.errors - a.errors }
  const list = all.filter(d => by !== 'failing' || d.errors > 0).sort(sort[by]).slice(0, 15)
  const peak = Math.max(1, ...list.map(d => d.requests))
  return (
    <>
      <div className="nb-seg nb-seg-sm" role="tablist" aria-label={t('ins.destinations')}>
        {['busy', 'slow', 'failing'].map(k => <button key={k} role="tab" aria-selected={by === k} className={cx(by === k && 'nb-on')} onClick={() => pick(k)}>{t(`ins.sort.${k}`)}</button>)}
      </div>
      {!list.length ? <p className="nb-sub nb-ok-line"><Check size={13} />{t(by === 'failing' ? 'ins.noFailing' : 'traffic.empty')}</p> : (
        <div className="nb-scroll">
          <table className="nb-table nb-dests">
            <thead><tr><th>{t('ins.dest.host')}</th><th className="nb-r">{t('stats.requests')}</th><th className="nb-r">{t('ins.failRate')}</th><th className="nb-r">{t('ins.latency')}</th><th className="nb-r">{t('ins.dest.data')}</th></tr></thead>
            <tbody>
              {list.map(d => (
                <tr key={d.host}>
                  <td>
                    <div className="nb-dest-host"><span className="nb-mono">{d.host}</span>{d.first_seen >= x.since && <span className="nb-tag nb-new" title={when(d.first_seen)}>{t('ins.dest.new')}</span>}</div>
                    <div className="nb-dest-clients">{d.clients.map(c => <span key={c} className="nb-tag">{clientName(t, c)}</span>)}</div>
                  </td>
                  <td className="nb-r"><b>{num(d.requests)}</b><span className="nb-bar nb-bar-row nb-bar-r"><i style={{ width: `${Math.max(3, (d.requests / peak) * 100)}%` }} /></span></td>
                  <td className="nb-r"><span className={cx('nb-rate', d.error_rate > 0.2 ? 'nb-bad' : d.error_rate > 0.05 && 'nb-warn')}>{pct(d.error_rate)}</span><div className="nb-sub">{num(d.errors)}</div></td>
                  <td className="nb-r"><b>{ms(d.p50_ms)}</b><div className="nb-sub">p95 {ms(d.p95_ms)}</div></td>
                  <td className="nb-r nb-sub"><span title={t('ins.dest.sent')}><ArrowUpRight size={11} />{bytes(d.sent)}</span><br /><span title={t('ins.dest.received')}><ArrowDownLeft size={11} />{bytes(d.received)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/** Requests by hour (failures in red) over the window. */
function Hours({ t, x }) {
  const bars = barsOf(x.activity.hourly || [], x.since)
  const peak = Math.max(1, ...bars.map(h => h.requests))
  const span = h => (h.to === h.hour ? when(h.hour) : `${when(h.hour)} – ${when(h.to + 3600000)}`)
  if (!bars.length) return <p className="nb-sub">{t('traffic.empty')}</p>
  return (
    <div className="nb-hours" role="img" aria-label={t('ins.activity')}>
      {bars.map(h => (
        <span key={h.hour} title={t('ins.hourTip', { at: span(h), requests: num(h.requests), errors: num(h.errors), events: num(h.events) })}>
          <i style={{ height: `${Math.max(2, (h.requests / peak) * 100)}%` }}><u style={{ height: `${h.requests ? (h.errors / h.requests) * 100 : 0}%` }} /></i>
        </span>
      ))}
    </div>
  )
}

function InsightsSkeleton() {
  return (
    <>
      <Skel h={150} />
      <div className="nb-gap-s"><Skel h={150} /></div>
      <div className="nb-cols nb-gap-s"><Skel h={220} /><Skel h={220} /></div>
    </>
  )
}

/**
 * Insights: the summary (health and what it rests on, the numbers that matter), traffic over the window, findings and
 * what looks off, the destinations, the clients, the AI work — each part drawn as it comes near the view, the window's
 * last answer shown at once and refreshed behind it.
 */
function Insights({ t, nonce }) {
  const [hours, setHours] = useState(() => local.get('nb.ins.hours', 24))
  const choose = h => { setHours(h); local.set('nb.ins.hours', h) }
  const ins = useData(`insights:${hours}`, () => call('insights', { hours }), nonce)
  const ai = useData(`aiWork:${hours}`, () => call('aiWork', { hours }), nonce)
  const x = ins.value, w = ai.value || (ai.error ? { error: errText(t, ai.error) } : null)
  const ranges = [[24, t('usage.day')], [168, t('usage.days', { n: 7 })], [720, t('usage.days', { n: 30 })]]
  return (
    <div className="nb-ins">
      <div className="nb-ins-bar">
        <div className="nb-seg" role="tablist" aria-label={t('tab.insights')}>
          {ranges.map(([h, label]) => <button key={h} role="tab" aria-selected={hours === h} className={cx(hours === h && 'nb-on')} onClick={() => choose(h)}>{label}</button>)}
        </div>
        <span className="nb-grow" />
        {x && (ins.busy ? <span className="nb-sub nb-stamp"><Loader2 size={12} className="nb-spin" />{t('ins.updating')}</span> : <span className="nb-sub nb-stamp">{t('ins.updated', { at: when(ins.at) })}</span>)}
      </div>
      {ins.error && <div className="nb-alert"><AlertTriangle size={14} /> {errText(t, ins.error)}</div>}
      {!x ? !ins.error && <InsightsSkeleton /> : <InsightsBody t={t} x={x} w={w} />}
    </div>
  )
}

function InsightsBody({ t, x, w }) {
  const a = x.activity, findings = Object.values(x.risks).reduce((n, v) => n + v, 0)
  const errRate = a.requests ? a.errors / a.requests : 0
  const group = (() => { const b = barsOf(a.hourly || [], x.since); return b.length ? (b[0].to - b[0].hour) / 3600000 + 1 : 1 })()
  return (
    <>
      {/* the summary: health and what it rests on, then the numbers that matter */}
      <section className={cx('nb-ins-top', `nb-h-${x.health.level}`)}>
        <div className="nb-sum-health">
          <HealthRing t={t} h={x.health} />
          <div className="nb-ins-why">
            <h3><Gauge size={14} />{t('health.title')}</h3>
            {x.health.reasons.length ? (
              <div className="nb-chips">{x.health.reasons.map(r => <span key={r.code} className="nb-chip nb-why">{t(`why.${r.code}`, { n: r.code === 'errors' ? `${r.n}%` : num(r.n) })}<em>−{r.cost}</em></span>)}</div>
            ) : <p className="nb-sub">{t('health.clean')}</p>}
            <p className="nb-sub nb-how">{t('health.how')}</p>
          </div>
        </div>
        <div className="nb-kpis">
          <Tile icon={Globe} label={t('stats.requests')} value={compact(a.requests)} />
          <Tile icon={AlertTriangle} label={t('ins.failRate')} value={pct(errRate)} tone={errRate > 0.05 ? 'warn' : ''} hint={a.errors ? num(a.errors) : ''} />
          <Tile icon={Timer} label={t('ins.latencyKpi')} value={ms(a.p50_ms)} hint={a.p95_ms != null ? `p95 ${ms(a.p95_ms)}` : ''} />
          <Tile icon={ShieldAlert} label={t('ins.findings')} value={num(findings)} tone={x.risks.malicious || x.risks.suspicious ? 'warn' : ''} />
          <Tile icon={Activity} label={t('ins.anomalies')} value={num(x.anomalies.length)} tone={x.anomalies.length ? 'warn' : ''} />
          <Tile icon={Server} label={t('ins.destCount')} value={num((x.destinations || []).length)} hint={x.new_hosts.length ? t('ins.newN', { n: x.new_hosts.length }) : ''} />
        </div>
      </section>

      {/* traffic over the window */}
      <section className="nb-card">
        <Head icon={BarChart3} title={group > 1 ? t('ins.activityN', { n: group }) : t('ins.activity')} sub={t('ins.activitySub')}
          aside={<span className="nb-legend"><i className="nb-lg-req" />{t('stats.requests')}<i className="nb-lg-err" />{t('ins.failures')}</span>} />
        <Later h={100}><Hours t={t} x={x} /></Later>
        <div className="nb-chips nb-gap-s">{Object.entries(a.kinds).sort((p, q) => q[1] - p[1]).map(([k, n]) => <span key={k} className={cx('nb-tag', `nb-k-${k}`)}><i className="nb-dot-k" />{t(`kind.${k}`) === `kind.${k}` ? k : t(`kind.${k}`)} {num(n)}</span>)}</div>
      </section>

      <div className="nb-cols">
        <section className="nb-card">
          <Head icon={ShieldAlert} title={t('ins.findings')} sub={t('ins.findingsSub')} aside={findings > 0 && <span className="nb-count">{num(findings)}</span>} />
          {!x.findings.length ? <p className="nb-sub nb-ok-line"><ShieldCheck size={13} />{t('ins.noFindings')}</p> : (
            <ul className="nb-finds">
              {x.findings.map(g => {
                const tx = tagText(t, g.tag, g.reason)
                return (
                  <li key={`${g.risk}/${g.tag}/${g.subject}`}>
                    <div className="nb-find-top">
                      <span className={`nb-risk nb-r-${g.risk}`}>{t(`risk.${g.risk}`)}</span><b>{tx.title}</b>
                      <span className="nb-grow" /><span className="nb-count">×{num(g.count)}</span>
                    </div>
                    {g.subject && <code className="nb-find-subject">{g.subject}</code>}
                    <p className="nb-sub">{tx.desc} · {t('ins.last', { at: when(g.last) })}</p>
                    {g.example?.summary && g.example.summary !== g.subject && <p className="nb-find-ex">{g.example.summary}</p>}
                    <AtWork t={t} w={w} x={g} />
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        <section className="nb-card">
          <Head icon={Activity} title={t('ins.anomalies')} sub={t('ins.anomaliesSub')} aside={x.anomalies.length > 0 && <span className="nb-count">{num(x.anomalies.length)}</span>} />
          {!x.anomalies.length ? <p className="nb-sub nb-ok-line"><Check size={13} />{t('ins.noAnomalies')}</p> : (
            <ul className="nb-anoms">{x.anomalies.map((an, i) => <li key={i} className={`nb-a-${an.code}`}><i /><div>{anomalyText(t, an)}<AtWork t={t} w={w} x={an} /></div></li>)}</ul>
          )}
          {x.new_hosts.length > 0 && (
            <>
              <h4 className="nb-sub-h"><Sparkles size={13} />{t('ins.newHosts')}</h4>
              <div className="nb-chips">{x.new_hosts.map(h => <span key={h.host} className="nb-tag" title={when(h.first)}>{h.host} · {num(h.requests)}</span>)}</div>
            </>
          )}
        </section>
      </div>

      {x.destinations && (
        <section className="nb-card nb-gap-b">
          <Head icon={Server} title={t('ins.destinations')} sub={t('ins.destinationsSub')} />
          <Later h={260}><Destinations t={t} x={x} /></Later>
        </section>
      )}

      <section className="nb-card nb-gap-b">
        <Head icon={Cpu} title={t('ins.clients')} sub={t('ins.clientsSub')} />
        {!x.clients.length ? <p className="nb-sub">{t('traffic.empty')}</p> : (
          <Later h={180}>
            <div className="nb-scroll">
              <table className="nb-table nb-clients">
                <thead><tr><th>{t('ins.client')}</th><th className="nb-r">{t('stats.requests')}</th><th className="nb-r">{t('ins.failRate')}</th><th className="nb-r">{t('ins.latency')}</th><th className="nb-r">{t('ins.model')}</th><th className="nb-r">{t('ins.cacheHit')}</th></tr></thead>
                <tbody>
                  {x.clients.map(c => (
                    <tr key={c.client}>
                      <td><b>{clientName(t, c.client)}</b> <span className="nb-sub">{t('ins.hosts', { n: c.hosts })}</span></td>
                      <td className="nb-r">{num(c.requests)}</td>
                      <td className="nb-r"><span className={cx('nb-rate', c.error_rate > 0.2 ? 'nb-bad' : c.error_rate > 0.05 && 'nb-warn')}>{pct(c.error_rate)}</span></td>
                      <td className="nb-r nb-sub">{ms(c.p50_ms)} / {ms(c.p95_ms)}</td>
                      <td className="nb-r">{c.ai_requests ? <>{num(c.ai_requests)} <span className="nb-sub">· {num(c.input_tokens + c.output_tokens)}</span></> : <span className="nb-sub">—</span>}</td>
                      <td className="nb-r nb-sub">{c.ai_requests && c.cache_hit != null ? pct(c.cache_hit) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Later>
        )}
      </section>

      <Later h={220}><AiWork t={t} w={w} /></Later>
    </>
  )
}

function OutOfBox({ t, s }) {
  return (
    <section className="nb-card nb-out">
      <Boxes size={28} />
      <h2>{t('out.title')}</h2>
      <p>{t('out.body')}</p>
      <CopyCmd t={t} cmd="nookbox up ruyix:latest --name ruyix" />
      {s?.api && <p className="nb-sub">{t('out.api', { api: s.api })}</p>}
    </section>
  )
}

const TABS = [['overview', Boxes], ['insights', Gauge], ['traffic', Globe], ['timeline', Activity], ['usage', Cpu]]

function BoxPage({ t, locale }) {
  const lang = String(locale?.getSnapshot?.().active || 'zh').startsWith('zh') ? 'zh' : 'en'
  dateLocale = lang === 'zh' ? 'zh-CN' : 'en-US'
  const [tab, setTab] = useState(() => local.get('nb.tab', 'overview'))
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  // the box itself: the last answer at once (a revisit draws immediately), asked again behind it
  const st = useData('status', () => call('status'), nonce)
  const s = st.value
  const pick = k => { setTab(k); setError(''); local.set('nb.tab', k) }
  useEffect(() => { const on = e => e.detail?.tab && pick(e.detail.tab); addEventListener('ruyix-box:open', on); return () => removeEventListener('ruyix-box:open', on) }, [])
  return (
    <div className="nb-page">
      <style>{tokens + css}</style>
      <header className="nb-header">
        <span className="nb-glyph"><Boxes size={18} /></span>
        <div className="nb-head-text"><h1>{t('title')}</h1><span className="nb-sub">{t('subtitle')}</span></div>
        <span className="nb-grow" />
        <button className="nb-btn" disabled={st.busy && !s} onClick={() => { setError(''); setNonce(n => n + 1) }}>{st.busy ? <Loader2 size={14} className="nb-spin" /> : <RefreshCw size={14} />}{t('refresh')}</button>
      </header>
      {(s?.inBox || !s) && (
        <nav className={cx('nb-tabs', !s && 'nb-tabs-wait')}>
          {TABS.map(([k, Icon]) => <button key={k} className={cx(tab === k && 'nb-on')} disabled={!s} onClick={() => pick(k)}><Icon size={14} />{t(`tab.${k}`)}</button>)}
        </nav>
      )}
      <main className="nb-main">
        {(error || (st.error && !s)) && <div className="nb-alert"><AlertTriangle size={14} /> {error || errText(t, st.error)}</div>}
        {!s ? !st.error && <div><Skel h={140} /><div className="nb-gap-s"><Skel h={90} /></div></div> : !s.inBox ? <OutOfBox t={t} s={s} /> : (
          <div>
            {tab === 'overview' && <Overview t={t} s={s} nonce={nonce} />}
            {tab === 'insights' && <Insights t={t} nonce={nonce} />}
            {tab === 'traffic' && <Traffic key={nonce} t={t} setError={setError} />}
            {tab === 'timeline' && <Timeline key={nonce} t={t} setError={setError} />}
            {tab === 'usage' && <Usage t={t} setError={setError} nonce={nonce} />}
          </div>
        )}
      </main>
    </div>
  )
}

// ── the workbench's System tab (slot 'ruyix.inbox.system'): the audit's dangerous and suspicious findings of the last day,
// one row each (risk, rule, what it concerns) until someone marks it seen — it comes back when it happens again ──
const findingRows = { items: [], listeners: new Set(), getSnapshot: () => findingRows.items, subscribe: fn => { findingRows.listeners.add(fn); return () => findingRows.listeners.delete(fn) } }
const setFindingRows = items => { if (JSON.stringify(items) === JSON.stringify(findingRows.items)) return; findingRows.items = items; for (const fn of findingRows.listeners) fn() }
const openInsights = () => {
  local.set('nb.tab', 'insights')
  window.dispatchEvent(new CustomEvent('ruyix-box:open', { detail: { tab: 'insights' } })) // a Box page already showing
  window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: PANEL } }))
}
async function lookAtFindings(t, lang) {
  const x = await call('insights', { hours: 24 }).catch(() => null) // not in a box, or a nookbox without insights: no rows
  dateLocale = lang() === 'zh' ? 'zh-CN' : 'en-US' // the rows' dates in the page's language, the Box page not yet shown
  if (!x) return setFindingRows([])
  const seen = local.get('nb.sys.seen', {}), rows = new Map()
  // one row per risk and subject: the rules that flagged the same host (blocked, and an exfil service) say it together
  for (const g of (x.findings || []).filter(g => ['malicious', 'suspicious'].includes(g.risk))) {
    const key = `finding:${g.risk}:${g.subject}`, r = rows.get(key)
    if (!r) rows.set(key, { ...g, key, tags: [g], count: g.count })
    else { r.tags.push(g); r.count = Math.max(r.count, g.count); if (g.last > r.last) Object.assign(r, { last: g.last, example: g.example }) } // (the rules label the same events)
  }
  setFindingRows([...rows.values()].filter(g => (seen[g.key] || 0) < g.last).map(g => {
    const tx = g.tags.map(x => tagText(t, x.tag, x.reason))
    return {
      key: g.key, tone: g.risk === 'malicious' ? 'danger' : 'warning', // (not `since`: the tab reads that as when it was checked)
      title: `${t(`risk.${g.risk}`)} · ${tx.map(x => x.title).join(' · ')}${g.subject ? `: ${g.subject}` : ''}`,
      detail: [tx[0].desc, g.count > 1 && t('sys.times', { n: num(g.count) }), t('ins.last', { at: when(g.last) }), g.example?.summary].filter(Boolean).join(' · '),
      actions: [
        { label: t('sys.open'), primary: true, run: openInsights },
        { label: t('sys.seen'), run: () => { local.set('nb.sys.seen', { ...local.get('nb.sys.seen', {}), [g.key]: g.last }); return lookAtFindings(t, lang) } },
      ],
    }
  }))
}

export const inject = ['slots', 'locale', 'layout']
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'box: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS, inject: () => ({ t, locale: ctx.locale }) }, BoxPage))
  // with the shell: under Admin, after the workbench's settings (40) and Skills (41)
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 50, locale: NS, label: () => t('panel') }, ({ size }) => <Boxes size={size || 16} strokeWidth={1.6} />))
  ctx.slots.inject('ruyix.inbox.system', () => ctx.slots.register({ name: 'ruyix.inbox.system', id: PANEL, order: 50, label: () => t('sys.group') }, () => null))
  ctx.effect(() => { (window.__ruyixInbox ||= {})[PANEL] = { items: findingRows }; return () => { delete window.__ruyixInbox[PANEL] } }, 'box: system rows')
  const lang = () => (String(ctx.locale.getSnapshot().active || 'zh').startsWith('zh') ? 'zh' : 'en'), look = () => lookAtFindings(t, lang)
  ctx.effect(() => { look(); const timer = setInterval(look, 5 * 60e3); return () => clearInterval(timer) }, 'box: system look')
  // the desk's 「盒子」 widget and the top bar's shield (shield.jsx), both from one shared poll
  ctx.effect(() => startShield({ openInsights }), 'box: desk widget and top bar shield')
  let shown = lang() // (the locale also changes when a plugin registers its words: only a new language looks again)
  ctx.effect(() => ctx.locale.subscribe(() => { if (lang() !== shown) { shown = lang(); look() } }), 'box: system rows in the new language')
}
