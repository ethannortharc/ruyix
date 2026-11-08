// Settings → 搜索 (docs/design/search.md): which service searches the web and in what order the others step in, how a
// page is fetched (directly, then Jina Reader or DeepSeek Fetch), each service's key (kept as the models' keys are:
// /api/ruyix/credential — in a box the host's vault; never shown back), and a try of each, there and then. A tab of the
// shell's Settings page, in its look (its fs-* classes).
import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Check, ExternalLink, Globe, Loader2, Play, Search, TriangleAlert } from 'lucide-react'

const TAB = 'ruyix-web'
const cx = (...c) => c.filter(Boolean).join(' ')
async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
  if (!res.ok || data.error) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: data.code })
  return data
}
const call = (op, args = {}) => api('api/ruyix-web', { op, ...args })

const TEXT = {
  zh: {
    tab: '搜索', lead: '所有智能体搜索和打开网页（web_search、web_fetch）都用这里配的。主智能体用 Claude Code、Codex 时，它们自带的搜索也还在。',
    search: '搜索', searchLead: '勾上要用的，排在最前面的先用；它答不上来（没 key、出错、额度用完），就用下一个。',
    fetch: '打开网页', fetchLead: '先直接打开；打不开，或者页面是脚本画出来的、几乎没有文字，就按顺序换下一种。',
    use: '用', first: '主用', then: n => `备用 ${n}`, off: '不用',
    keySet: 'key 已配', keyMissing: '还没有 key', keyOptional: '不填也能用（有次数限制）', keyShared: '和 DeepSeek 模型共用一个 key（设置 → 模型）',
    keyPh: '粘贴 key', save: '保存', remove: '删除', getKey: '去拿 key', confirmRemove: n => `删除 ${n}？`,
    try: '试一下', trying: '在试…', tryAll: '按现在的设置试', query: '要搜的词', url: '要打开的网址',
    ok: ms => `好了，用了 ${ms} 毫秒`, failed: '没成：', chars: (n, w) => `${n} 个字符（可读 ${w}）`, saved: '已保存',
    direct: '直接打开（免费；挡住本机和内网地址）',
  },
  en: {
    tab: 'Search', lead: 'Every agent\'s web search and page fetching (web_search, web_fetch) uses what is set here. Claude Code and Codex keep their own search too.',
    search: 'Search', searchLead: 'Tick the ones to use; the first goes first, and when it cannot answer (no key, an error, out of credit) the next one does.',
    fetch: 'Opening pages', fetchLead: 'Directly first; when that fails, or the page is drawn by scripts with almost no text, the next way in order.',
    use: 'Use', first: 'First', then: n => `Then ${n}`, off: 'Off',
    keySet: 'Key set', keyMissing: 'No key yet', keyOptional: 'Works without one (rate-limited)', keyShared: 'Shares the DeepSeek models\' key (Settings → Models)',
    keyPh: 'Paste the key', save: 'Save', remove: 'Remove', getKey: 'Get a key', confirmRemove: n => `Remove ${n}?`,
    try: 'Try', trying: 'Trying…', tryAll: 'Try as set now', query: 'Search for', url: 'Address to open',
    ok: ms => `Done in ${ms} ms`, failed: 'Failed: ', chars: (n, w) => `${n} characters (${w} readable)`, saved: 'Saved',
    direct: 'Directly (free; this machine and private networks blocked)',
  },
}

function KeyField({ t, svc, onDone }) {
  const [v, setV] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!svc.key) return <span className="fs-dim">{t.direct}</span>
  if (svc.key === 'DEEPSEEK_API_KEY') return <span className="fs-key"><span className={cx('fs-chip', svc.keySet ? 'fs-ok' : 'fs-warn')}>{svc.keySet ? <Check size={11} /> : <TriangleAlert size={11} />}{svc.keySet ? t.keySet : t.keyMissing}</span><span className="fs-dim">{t.keyShared}</span></span>
  const save = async value => {
    setBusy(true); setErr('')
    try { await api('api/ruyix/credential', { name: svc.key, value }); setV(''); onDone() } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  return (
    <span className="fs-key">
      <span className={cx('fs-chip', svc.keySet ? 'fs-ok' : svc.keyOptional ? '' : 'fs-warn')}>{svc.keySet ? <Check size={11} /> : <TriangleAlert size={11} />}{svc.keySet ? t.keySet : svc.keyOptional ? t.keyOptional : t.keyMissing}</span>
      <input type="password" autoComplete="off" spellCheck={false} placeholder={t.keyPh} value={v} onChange={e => setV(e.target.value)} onKeyDown={e => e.key === 'Enter' && v.trim() && save(v.trim())} />
      <button type="button" className="fs-btn" disabled={busy || !v.trim()} onClick={() => save(v.trim())}>{t.save}</button>
      {svc.keySet && <button type="button" className="fs-btn fs-quiet" disabled={busy} onClick={() => window.confirm(t.confirmRemove(svc.key)) && save(null)}>{t.remove}</button>}
      {svc.keyUrl && <a className="fs-link" href={svc.keyUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} />{t.getKey}</a>}
      {err && <span className="fs-chip fs-warn">{err}</span>}
    </span>
  )
}

/** A try's answer, in a few lines. */
function Tried({ t, r }) {
  if (!r) return null
  if (r.busy) return <div className="rw-tried fs-dim"><Loader2 size={12} className="fs-spin" /> {t.trying}</div>
  return (
    <div className="rw-tried">
      <div className={cx('fs-chip', r.ok ? 'fs-ok' : 'fs-warn')}>{r.ok ? t.ok(r.ms) : `${t.failed}${r.error || `HTTP ${r.status}`}`}</div>
      {r.content && <p className="fs-dim">{r.content}</p>}
      {r.sources && <ol>{r.sources.map(s => <li key={s.url}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a>{s.snippet && <span className="fs-dim"> — {s.snippet.slice(0, 140)}</span>}</li>)}</ol>}
      {r.chars != null && <p className="fs-dim">{t.chars(r.chars, r.words)} · {r.text}</p>}
    </div>
  )
}

/** One kind's services: ticked ones in their order (first, then…), each with its key and a try of its own. */
function Services({ t, kind, rows, order, setOrder, reload }) {
  const [tried, setTried] = useState({})
  const used = order.filter(id => rows.some(r => r.id === id)), rest = rows.filter(r => !used.includes(r.id)).map(r => r.id)
  const move = (id, d) => { const i = used.indexOf(id), j = i + d; if (j < 0 || j >= used.length) return; const next = [...used]; [next[i], next[j]] = [next[j], next[i]]; setOrder(next) }
  const toggle = id => setOrder(used.includes(id) ? used.filter(x => x !== id) : [...used, id])
  const tryOne = async id => { setTried(s => ({ ...s, [id]: { busy: true } })); const r = await call('test', kind === 'search' ? { kind, service: id, query: 'DeepSeek' } : { kind, service: id, url: 'https://example.com' }).catch(e => ({ ok: false, error: e.message })); setTried(s => ({ ...s, [id]: r })) }
  return (
    <div className="rw-services">
      {[...used, ...rest].map(id => {
        const svc = rows.find(r => r.id === id), at = used.indexOf(id)
        return (
          <div key={id} className={cx('rw-svc', at < 0 && 'rw-off')}>
            <div className="rw-svc-head">
              <label className="rw-use"><input type="checkbox" checked={at >= 0} onChange={() => toggle(id)} /><b>{svc.name}</b></label>
              <span className={cx('fs-chip', at === 0 && 'fs-accent')}>{at < 0 ? t.off : at === 0 ? t.first : t.then(at)}</span>
              {at >= 0 && <><button type="button" className="fs-link" disabled={at === 0} onClick={() => move(id, -1)} aria-label="up"><ArrowUp size={12} /></button><button type="button" className="fs-link" disabled={at === used.length - 1} onClick={() => move(id, 1)} aria-label="down"><ArrowDown size={12} /></button></>}
              <span className="fs-grow" />
              <button type="button" className="fs-btn fs-quiet" onClick={() => tryOne(id)}><Play size={12} />{t.try}</button>
            </div>
            <KeyField t={t} svc={svc} onDone={reload} />
            <Tried t={t} r={tried[id]} />
          </div>
        )
      })}
    </div>
  )
}

function SearchSettings({ lang }) {
  const t = TEXT[lang] || TEXT.en
  const [st, setSt] = useState(null)
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [q, setQ] = useState('今天的科技新闻'), [u, setU] = useState('https://example.com')
  const [tryS, setTryS] = useState(null), [tryF, setTryF] = useState(null)
  const reload = useCallback(() => call('state').then(setSt, e => setErr(e.message)), [])
  useEffect(() => { reload() }, [reload])
  const save = async patch => { try { const { settings } = await call('save', { settings: patch }); setSt(s => ({ ...s, settings })); setNote(t.saved); setTimeout(() => setNote(''), 1500) } catch (e) { setErr(e.message) } }
  if (!st) return <div className="fs-dim">{err || <Loader2 size={14} className="fs-spin" />}</div>
  return (
    <div className="rw-page">
      <style>{CSS}</style>
      <p className="fs-lead">{t.lead}</p>
      {err && <div className="fs-chip fs-warn">{err}</div>}
      <section className="fs-card">
        <header className="fs-card-head"><span className="fs-card-icon"><Search size={15} /></span><h3>{t.search}</h3><span className="fs-grow" />{note && <span className="fs-chip fs-ok">{note}</span>}</header>
        <p className="fs-dim">{t.searchLead}</p>
        <Services t={t} kind="search" rows={st.search} order={st.settings.search} setOrder={order => order.length && save({ search: order })} reload={reload} />
      </section>
      <section className="fs-card">
        <header className="fs-card-head"><span className="fs-card-icon"><Globe size={15} /></span><h3>{t.fetch}</h3></header>
        <p className="fs-dim">{t.fetchLead}</p>
        <Services t={t} kind="fetch" rows={st.fetch} order={st.settings.fetch} setOrder={order => order.length && save({ fetch: order })} reload={reload} />
      </section>
      <section className="fs-card">
        <header className="fs-card-head"><span className="fs-card-icon"><Play size={15} /></span><h3>{t.tryAll}</h3></header>
        <div className="rw-tryrow"><input value={q} onChange={e => setQ(e.target.value)} placeholder={t.query} /><button type="button" className="fs-btn" onClick={async () => { setTryS({ busy: true }); setTryS(await call('test', { kind: 'search', query: q }).catch(e => ({ ok: false, error: e.message }))) }}><Search size={12} />{t.try}</button></div>
        <Tried t={t} r={tryS} />
        <div className="rw-tryrow"><input value={u} onChange={e => setU(e.target.value)} placeholder={t.url} /><button type="button" className="fs-btn" onClick={async () => { setTryF({ busy: true }); setTryF(await call('test', { kind: 'fetch', url: u }).catch(e => ({ ok: false, error: e.message }))) }}><Globe size={12} />{t.try}</button></div>
        <Tried t={t} r={tryF} />
      </section>
    </div>
  )
}

const CSS = `
.rw-page { display: flex; flex-direction: column; gap: 14px; }
.rw-services { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.rw-svc { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--ruyix-line); border-radius: var(--ruyix-radius); background: var(--ruyix-surface-sunk); }
.rw-svc.rw-off { opacity: .72; }
.rw-svc-head { display: flex; align-items: center; gap: 8px; }
.rw-use { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.rw-tried { display: flex; flex-direction: column; gap: 4px; font-size: var(--ruyix-text-xs); }
.rw-tried ol { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; }
.rw-tried p { margin: 0; overflow-wrap: anywhere; }
.rw-tryrow { display: flex; gap: 8px; margin-top: 8px; }
.rw-tryrow input { flex: 1; min-width: 0; }
`

export const inject = ['slots', 'locale']
export function apply(ctx) {
  const lang = () => (String(ctx.locale.getSnapshot().active || 'zh').startsWith('zh') ? 'zh' : 'en')
  ctx.slots.inject('ruyix.settings.tab', () => ctx.slots.register({ name: 'ruyix.settings.tab', id: TAB, order: 35, label: () => TEXT[lang()].tab }, () => <SearchSettings lang={lang()} />))
}
