// A studio's home page (docs/design/studio.md): its name, then the blocks its declaration's `home` lists, two to a row
// (a block of size 'full' takes the row) — start, working, board, list, calendar, library, form, history (./views.jsx).
import tokens from '@ruyix/shell/tokens.css'
import { useEffect, useState } from 'react'
import { useCollection, useStudio } from './data.js'
import { RecordDialog, RefLoader, useRefs } from './fields.jsx'
import { useFocus } from './focus.js'
import { studioIcon } from './icons.js'
import { say, wordsOf } from './text.js'
import { Failed, Loading, NoteHost } from './ui.jsx'
import { FeedbackBlock } from './feedback.jsx'
import { BoardBlock, CalendarBlock, FormBlock, HistoryBlock, LibraryBlock, ListBlock, StartBlock, WorkingBlock, startable, startsFrom } from './views.jsx'

const VIEWS = { start: StartBlock, working: WorkingBlock, board: BoardBlock, list: ListBlock, calendar: CalendarBlock, library: LibraryBlock, form: FormBlock, history: HistoryBlock }
const NEEDS_COLLECTION = new Set(['board', 'list', 'calendar', 'form'])
export const langOf = locale => (String(locale?.getSnapshot?.().active || 'zh').startsWith('zh') ? 'zh' : 'en')

/** A pack supplies its own views through the same extension registry as its workbench panels. */
export function OwnView({ studio, block, ...props }) {
  const [, changed] = useState(0)
  useEffect(() => {
    const update = () => changed(n => n + 1)
    window.addEventListener('ruyix-workbench-ext', update)
    return () => window.removeEventListener('ruyix-workbench-ext', update)
  }, [studio])
  const extension = window.__ruyixWorkbenchExt?.[studio]
  const View = extension?.studioViews?.[block.view.slice(4)]
  return typeof View === 'function' ? <><style>{extension.css || ''}</style><View studio={studio} block={block} {...props} /></> : null
}

export function StudioPage({ studioId, locale }) {
  const lang = langOf(locale), W = wordsOf(lang)
  const { studio: decl, loading, error, reload } = useStudio(studioId)
  const { refs, colls, setRef } = useRefs(decl)
  const [focus, landed] = useFocus(studioId)
  const Icon = studioIcon(decl?.icon)
  const blocks = (decl?.home || []).map(b => (typeof b === 'string' ? { view: b } : b))
    .filter(b => b.view?.startsWith('own:') ? Object.hasOwn(decl.views || {}, b.view.slice(4)) : VIEWS[b.view] && (!NEEDS_COLLECTION.has(b.view) || decl.collections?.[b.collection]))
  return (
    <div className="st-page">
      <style>{tokens}</style>
      <NoteHost>
        <header className="st-header">
          <span className="st-glyph"><Icon size={20} strokeWidth={1.8} /></span>
          <div className="st-head-text"><h1>{decl ? say(decl.name, lang) : '…'}</h1></div>
        </header>
        <main className="st-main">
          {loading && !decl ? <Loading W={W} /> : error && !decl ? <Failed W={W} error={error.code === 'noStudio' ? { message: W.noStudio } : error} retry={reload} /> : decl && (
            <div className="st-grid">
              {colls.map(c => <RefLoader key={c} studio={studioId} coll={c} onItems={setRef} />)}
              {blocks.map((b, i) => { const V = b.view.startsWith('own:') ? OwnView : VIEWS[b.view]; return <V key={`${studioId}:${b.view}:${b.collection || ''}:${i}`} studio={studioId} decl={decl} block={b} lang={lang} W={W} refs={refs} /> })}
              <FeedbackBlock studio={studioId} lang={lang} W={W} />
            </div>
          )}
          {decl && focus && decl.collections?.[focus.collection] && !decl.collections[focus.collection].runs && <Focus key={`${focus.collection}:${focus.record}`} studio={studioId} decl={decl} focus={focus} lang={lang} W={W} refs={refs} onDone={landed} />}
        </main>
      </NoteHost>
    </div>
  )
}

/** The record the page was asked to land on, opened over it (gone, or not found once loaded: nothing). */
function Focus({ studio, decl, focus, lang, W, refs, onDone }) {
  const api = useCollection(studio, focus.collection)
  const rec = api.items.find(r => r.id === focus.record)
  if (!api.loading && !rec) { queueMicrotask(onDone); return null }
  if (!rec) return null
  return <RecordDialog studio={studio} decl={decl} collName={focus.collection} record={rec} api={api} refs={refs} lang={lang} W={W} startWith={startsFrom(decl, focus.collection).find(s => startable(s, rec, decl.collections[focus.collection])) || null} onClose={onDone} />
}
