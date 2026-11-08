// Readable rendering of agent output: structured results as Markdown (raw JSON one click away) and "#12" evidence
// references as links. A diagram in a report (a mermaid block) shows as code: the browser bundle is not served.
import { createContext, useContext, useMemo, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { Braces, Check, Copy, FileText } from 'lucide-react'
import { EV_URL, linkEvidence, toMarkdown } from './result-md.js'
import { cx, useT } from './ui.jsx'

/** The run page provides it: "#n" in agent text opens evidence n when the run has it. */
export const EvCtx = createContext(null)

export function RichText({ text }) {
  const ev = useContext(EvCtx)
  const s = String(text ?? '')
  if (!ev) return s
  return s.split(/(#\d{1,4}\b)/).map((part, i) => {
    const n = i % 2 ? Number(part.slice(1)) : 0
    return n && ev.has(n) ? <button key={i} className="wb-linkbtn wb-evref" onClick={() => ev.open(n)}>{part}</button> : part
  })
}

export function Md({ text }) {
  const t = useT()
  const ev = useContext(EvCtx)
  const labels = useMemo(() => ({ code: { copyLabel: t('ev.copy'), copiedLabel: t('ev.copied') }, footnotes: 'Footnotes' }), [t])
  const md = useMemo(() => (ev ? linkEvidence(String(text || ''), ev.has) : String(text || '')), [text, ev])
  // Evidence links (linkEvidence) open the drawer instead of navigating.
  const click = e => {
    const a = e.target.closest?.(`a[href^="${EV_URL}"]`)
    if (!a || !ev) return
    e.preventDefault()
    ev.open(Number(a.getAttribute('href').slice(EV_URL.length)))
  }
  return <div className="wb-md" onClick={click}>{md.trim() ? <MarkdownText text={md} labels={labels} /> : null}</div>
}

/** Agent JSON as Markdown (src/result-md.js), the raw JSON one click away; copies whichever is shown. */
export function Structured({ value }) {
  const t = useT()
  const [raw, setRaw] = useState(false)
  const md = useMemo(() => toMarkdown(value, t), [value, t])
  const json = useMemo(() => JSON.stringify(value, null, 2), [value])
  return (
    <div className="wb-structured">
      <div className="wb-structured-bar">
        <div className="wb-seg">
          <button className={cx(!raw && 'wb-on')} onClick={() => setRaw(false)}><FileText size={12} />{t('fields.pretty')}</button>
          <button className={cx(raw && 'wb-on')} onClick={() => setRaw(true)}><Braces size={12} />{t('fields.json')}</button>
        </div>
        <CopyBtn text={raw ? json : md} />
      </div>
      {raw ? <pre className="wb-pre">{json}</pre> : <Md text={md} />}
    </div>
  )
}
function CopyBtn({ text }) {
  const t = useT()
  const [done, setDone] = useState(false)
  return <button className="wb-icon-btn" title={done ? t('ev.copied') : t('ev.copy')} onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>{done ? <Check size={13} /> : <Copy size={13} />}</button>
}

/**
 * What a step handed back: when it has a `summary` that, as Markdown, with the other fields folded under it as JSON;
 * anything else as folded JSON.
 */
export function StepOutput({ value }) {
  const t = useT()
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string') return <Md text={value} />
  const { summary, ...rest } = value && typeof value === 'object' && !Array.isArray(value) ? value : { '': value }
  const more = Array.isArray(value) || !value || typeof value !== 'object' ? value : rest
  const hasMore = more !== null && typeof more === 'object' ? Object.keys(more).length > 0 : more !== undefined
  return (
    <div className="wb-output">
      {typeof summary === 'string' && summary.trim() && <Md text={summary} />}
      {hasMore && (
        <details className="wb-details">
          <summary className="wb-sub">{typeof summary === 'string' ? t('out.more') : t('out.json')}</summary>
          <pre className="wb-pre">{JSON.stringify(more, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}
