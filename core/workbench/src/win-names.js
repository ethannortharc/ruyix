// A workbench window's name on the desk in both languages (`names` { zh, en }: core/shell/open-model.js nameOf — the desk
// shows the page's, and the page can change language while the window is open): the workbench's word for the window,
// after the thing's own title (a run's, in the one language it has) when there is one.
import { en, zh } from './locale.js'

export const namesOf = (key, title = '') => ({ zh: title ? `${title} · ${zh[key]}` : zh[key], en: title ? `${title} · ${en[key]}` : en[key] })

// the windows named so: their rows on the desk's open list (`win:` + the window's id) and the words their names end with
const NAMED = [[/^win:viewer:/, ['vw.title', 'vw.sessionTitle']], [/^win:ruyix-tasks-window$/, ['dw.tasks']], [/^win:answer:/, ['aw.title']]]

/** A row kept from before its window had both names (its title in the one language it was opened in): its names, else null. */
export function keptNames(id, title) {
  const s = String(title || ''), keys = NAMED.find(([re]) => re.test(String(id || '')))?.[1] || []
  for (const key of keys) for (const word of [zh[key], en[key]]) {
    if (s === word) return namesOf(key)
    if (s.endsWith(` · ${word}`)) return namesOf(key, s.slice(0, -word.length - 3))
  }
  return null
}
