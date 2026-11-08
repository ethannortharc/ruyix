// The things open, gathered (docs/design/sessions.md §5; the list and how it groups: ../open.js, ../../open-model.js):
// each group a card in a column at the desk's left — its work's mark when it is a run, a task or a session at work, the
// kinds of what is in it, how many. A click lays the group's windows out side by side in the rest of the desk and puts
// the other groups away (minimised; a pinned one stays as it is); a click on the group in front puts it away. Pointing
// at a card lists what is in it (one opens it; one whose window is closed but which still runs — a terminal's session,
// the agents' browser — says 「在后台」) and offers to pin it. Groups not used for a while put themselves away.
// The desk (desktop.jsx) does the moving: these only say which group.
import { useEffect, useState } from 'react'
import { Activity, AppWindow, File, FileText, Folder, FolderOpen, Globe, Image, LayoutGrid, MessagesSquare, PanelsTopLeft, Pin, PinOff, SquareTerminal, Terminal } from 'lucide-react'
import { openRegistry } from '../open.js'
import { nameOf } from '../../open-model.js'
import { WorkMark, useWork } from './workmark.jsx'
import { textOf } from './text.js'
export { tileRects } from './store.js'

const cx = (...c) => c.filter(Boolean).join(' ')
export const KIND_ICON = { page: PanelsTopLeft, window: AppWindow, app: LayoutGrid, term: SquareTerminal, web: Globe, file: FileText, session: MessagesSquare, run: Activity }
// an item's own icon, by its lucide name (open items carry `icon` as a short name: a folder window says 'Folder'); else its kind's
const NAMED_ICON = { Activity, AppWindow, File, FileText, Folder, FolderOpen, Globe, Image, LayoutGrid, MessagesSquare, PanelsTopLeft, SquareTerminal, Terminal }
export const iconOf = it => NAMED_ICON[it.icon] || KIND_ICON[it.kind] || AppWindow

/** The groups of open things, as they change (the box's list: every page and browser the same). */
export function useOpenGroups() {
  const [groups, setGroups] = useState(() => openRegistry().groups())
  useEffect(() => {
    const on = () => setGroups(openRegistry().groups())
    window.addEventListener('ruyix:open-things', on); on()
    // another page or browser's changes: looked for now and then while this one is open
    const poll = setInterval(() => { if (!document.hidden) openRegistry().load() }, 20000)
    return () => { window.removeEventListener('ruyix:open-things', on); clearInterval(poll) }
  }, [])
  return groups
}

/** The cards. `front`: the group in front (its card lit); `expand(group)` / `collapse(group)`: the desk's to do. */
export function GroupCards({ lang, top, max = 8, front, expand, collapse }) {
  const T = textOf(lang).groups, groups = useOpenGroups(), work = useWork()
  const [tip, setTip] = useState(null) // the card pointed at: its list
  if (!groups.length) return null
  const shown = groups.slice(0, Math.max(1, max))
  const titleOf = g => g.names?.[lang] || g.title || T.kinds[g.key.slice(5)] || g.key
  return (
    <nav className="ad-groups" style={{ top }} aria-label={T.title} onPointerLeave={() => setTip(null)}>
      {shown.map(g => {
        const w = work.find(x => x.id === g.key), kinds = [...new Set(g.items.map(i => i.kind))].slice(0, 3), on = front === g.key
        const pics = [...new Set(g.items.map(iconOf))].slice(0, 3)
        return (
          <div key={g.key} className={cx('ad-group', on && 'ad-on', g.folded && 'ad-folded', g.pinned && 'ad-pinned')} onPointerEnter={() => setTip(g.key)}>
            <button type="button" className="ad-group-card ad-mat" aria-pressed={on} aria-label={`${titleOf(g)} · ${T.count(g.items.length)}${on ? ` · ${T.inFront}` : ''}`}
              onClick={() => (on ? collapse(g) : expand(g))}>
              <span className="ad-group-pic">
                {w ? <WorkMark item={w} size={26} /> : pics.map((I, n) => <I key={n} size={14} strokeWidth={1.8} />)}
              </span>
              <span className="ad-group-name"><b>{titleOf(g)}</b><small>{w ? textOf(lang).work.states[w.state] : g.key.startsWith('kind:') ? g.items.slice(0, 2).map(i => nameOf(i, lang)).join(' · ') : kinds.map(k => T.kinds[k]).join(' · ')}</small></span>
              <i className="ad-group-n">{g.items.length}</i>
              {g.pinned && <Pin className="ad-group-pin" size={11} strokeWidth={2} aria-hidden="true" />}
            </button>
            {tip === g.key && (
              <div className="ad-group-list ad-mat" role="menu" aria-label={titleOf(g)}>
                <div className="ad-group-head">
                  <span>{titleOf(g)}</span>
                  <button type="button" className="ad-group-act" onClick={() => openRegistry().pin(g.key, !g.pinned)} title={g.pinned ? T.unpin : T.pinHint}>
                    {g.pinned ? <PinOff size={13} /> : <Pin size={13} />}{g.pinned ? T.unpin : T.pin}
                  </button>
                </div>
                {g.items.slice(0, 12).map(it => {
                  const I = iconOf(it)
                  return (
                    <button key={it.id} type="button" role="menuitem" className="ad-mi" title={it.hint || undefined} onClick={() => { setTip(null); openRegistry().open(it.id) }}>
                      <I size={14} strokeWidth={1.8} /><span className="ad-group-item">{nameOf(it, lang)}</span>{it.bg ? <small>{T.bg}</small> : it.folded && <small>{T.away}</small>}
                    </button>
                  )
                })}
                {g.items.length > 12 && <div className="ad-group-more">{T.more(g.items.length - 12)}</div>}
              </div>
            )}
          </div>
        )
      })}
      {groups.length > shown.length && <div className="ad-group-more">{T.more(groups.length - shown.length)}</div>}
    </nav>
  )
}
