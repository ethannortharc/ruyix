// The questions asked and their answers, for the desk (docs/design/desk-answers.md): what grows from the main agent's
// strip — a stem of what is going on, a node per question, a leaf when its answer comes, a drawer for the closed ones.
// One list, like the work list (work.js): a producer (the conversation: the workbench's chat) publishes its whole slice;
// the desk reads one list and acts through the items' own producer. No producer reads another's data.
//   answersRegistry().set(source, items, { seen?, front?, close? })   a producer's whole slice, again at each change;
//                                       its hooks: seen(ids) — looked at (擦掉: out of the drawer, the task done),
//                                       front(id) — put it in front (a window with the whole answer), close(id) — the
//                                       leaf folded into the drawer
//   answersRegistry().get()            every item, the newest asked first; a 'ruyix:answers' event after a change
//   answersRegistry().seen(id) · .front(id) · .close(id)   through the item's own producer
// An item: { id: 'ask:<id>', question (what the person asked, as said), state: queued | working | answered | failed,
//   askedAt, answeredAt?, lines: [{ at, text, kind: ask | tool | say | wait }] (what is going on in it, the newest last,
//   a few), answer?: { text (short, markdown), cards?: [{ n (its entry in the conversation), cards: [card…]
//   (@ruyix/shell/cards-spec), answered? }] }, elsewhere?: [{ kind: workflow | draft, title }] (made in it, drawn only by the
//   conversation), error? (a failed one: why, in a line), task?: '<task id>',
//   open: 'leaf' | 'drawer' (where it shows: a leaf is out on the desk, the drawer holds a closed one), seen }
// What the desk does with it is its own: a leaf for an answered item open as a leaf, the drawer for the others not seen,
// the stem for the items working or queued (their lines, rotating).

const sorted = list => [...list].sort((a, b) => (b.askedAt || 0) - (a.askedAt || 0))

export function answersRegistry(w = globalThis.window) {
  if (w.__ruyixAnswers) return w.__ruyixAnswers
  const slices = new Map(), keys = new Map(), hooks = new Map()
  let merged = []
  const sourceOf = id => [...slices].find(([, list]) => list.some(x => x.id === id))?.[0]
  const hook = (name, id) => { const h = hooks.get(sourceOf(id))?.[name]; if (!h) return false; try { h(name === 'seen' ? [id] : id) } catch { /* the producer's own */ } return true }
  w.__ruyixAnswers = {
    set(source, items, { seen, front, close } = {}) {
      // (hooks not given again stay as they were)
      const was = hooks.get(source) || {}
      hooks.set(source, { seen: seen || was.seen, front: front || was.front, close: close || was.close })
      const list = Array.isArray(items) ? items.filter(x => x && x.id) : []
      const key = JSON.stringify(list)
      if (keys.get(source) === key) return
      keys.set(source, key); slices.set(source, list)
      merged = sorted([...slices.values()].flat())
      w.dispatchEvent?.(new Event('ruyix:answers'))
    },
    get: () => merged,
    /** Looked at (擦掉): its producer records it. → whether one took it */
    seen: id => hook('seen', id),
    /** Put it in front: its producer opens the whole answer in a window. */
    front: id => hook('front', id),
    /** The leaf folded: into the drawer. */
    close: id => hook('close', id),
  }
  return w.__ruyixAnswers
}

/** Where each item shows now: { stem: [working or queued, oldest first], leaves: [answered, out], drawer: [answered or failed, closed, not seen] } */
export function answersLayout(list) {
  const live = list.filter(x => x.state === 'working' || x.state === 'queued').sort((a, b) => (a.askedAt || 0) - (b.askedAt || 0))
  const done = list.filter(x => (x.state === 'answered' || x.state === 'failed') && !x.seen)
  return { stem: live, leaves: done.filter(x => x.open !== 'drawer'), drawer: done.filter(x => x.open === 'drawer') }
}
