// A studio's records whose time has come (the declarations' `remind`: Plume's ideas at their planned time), on the desk
// as work waiting for the person — the shell's work list, slice 'studio' (@ruyix/shell/work): amber 等你 until they deal
// with it, opening the studio's page at that record; 擦掉 = seen (for that time: a new time is a new reminder). One look
// at the box every half minute while the page is in front. Each item says where the record's work stands: not begun,
// being written, ready to publish (its run waits for the person), or its run stopped.
import { workRegistry } from '@ruyix/shell/work'
import { call } from './data.js'
import { dueItem } from './due-item.js'

const LOOK_MS = 30000
/** Keep the work list's 'studio' slice: → stop() */
export function startDue(lang = () => 'zh') {
  let stopped = false, timer = null, said = false
  const reg = workRegistry(window)
  const look = async () => {
    clearTimeout(timer)
    if (stopped) return
    if (!document.hidden) {
      try {
        const { due } = await call('due')
        reg.set('studio', due.map(x => dueItem(x, lang())), {
          seen: ids => call('dueSeen', { items: ids.filter(id => /^studio:/.test(id)).map(id => { const [, studio, collection, ...rest] = id.split(':'); return { studio, collection, id: rest.join(':') } }) }).then(look),
        })
      } catch (err) { if (!said) { said = true; console.warn('ruyix-studio: what is due:', err) } } // (once: the next look tries again)
    }
    if (!stopped) timer = setTimeout(look, LOOK_MS)
  }
  look()
  const now = () => look() // (a studio changed here: look now — a time set to now is due at once)
  window.addEventListener('ruyix:studio', now)
  return () => { stopped = true; clearTimeout(timer); window.removeEventListener('ruyix:studio', now); reg.set('studio', []) }
}
