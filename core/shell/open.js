// The things open on the desk, kept in the box (~/.ruyix/open.json; open-model.js says what they are and how they group):
// every page and browser sees the same, a reload keeps them. The page sends its changes as ops and takes the state back.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIND_TITLES, applyOpen, emptyOpen, groupsOf } from './open-model.js'

export function createOpen({ home, now = Date.now }) {
  const file = join(home, 'open.json')
  const read = () => { try { const v = JSON.parse(readFileSync(file, 'utf8')); return v && Array.isArray(v.items) ? { ...emptyOpen(), ...v } : emptyOpen() } catch { return emptyOpen() } }
  const write = v => { writeFileSync(`${file}.tmp`, `${JSON.stringify(v)}\n`); renameSync(`${file}.tmp`, file) }
  return {
    state: read,
    /** { ops: [change…] } (open-model.js applyOpen), in order; one that does not apply fails them all. → the state */
    apply({ ops } = {}) {
      if (!Array.isArray(ops) || ops.length > 100) throw Object.assign(new Error('{ ops: [...] }, at most 100'), { code: 'badOpen', status: 400 })
      let s = read()
      for (const change of ops) s = applyOpen(s, change, now())
      if (ops.length) write(s)
      return s
    },
  }
}

const said = (zh, en) => ({ zh, en })
// (what desk_window did, in the words of the work record)
const ACTION_WORDS = { front: said('拿到前面', 'Brought to the front'), max: said('铺满桌面', 'Filled the desk'), min: said('收到程序坞', 'Minimised'), restore: said('还原', 'Restored'), close: said('关掉', 'Closed'), tile: said('并排摆开', 'Tiled') }
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
/**
 * The main agent's tools over the open things (the shell's system tools, docs/design/main-agent.md): see them by group,
 * bring one up, put one in another group (remembered for things like it), fold or unfold a group, close one. `page(event,
 * detail)`: what the person's page is asked to do (the shell's page actions).
 */
export function openTools({ open, page }) {
  const item = id => { const it = open.state().items.find(x => x.id === String(id)); if (!it) throw new Error(`nothing open is "${id}" (open_list)`); return it }
  return [
    {
      name: 'open_list',
      title: said('看打开的东西', 'What is open'),
      effect: 'read',
      description: 'What is open on the person\'s desk — pages, windows, apps, terminals, web pages, files, sessions, runs — by group: a group is where the person put a thing, else the work it belongs to (a run, a session), else a rule learned from an earlier move, else its kind. Each line: its id, kind, title, folded or not. Use it before tidying: put the loose ones (kind groups) where they belong with open_group.',
      parameters: schema({}),
      async run() {
        const s = open.state(), groups = groupsOf(s)
        return { text: [
          groups.length ? 'Open, by group (the latest used first):' : 'Nothing is open.',
          ...groups.flatMap(g => [`## ${g.key} — ${g.title || KIND_TITLES[g.key.slice(5)]?.en || g.key}${g.pinned ? ' (pinned)' : ''}${g.folded ? ' (folded)' : ''}`,
            ...g.items.map(x => `- ${x.id} | ${x.kind} | ${x.title}${x.of ? ` | of ${x.of}` : ''}${x.folded ? ' | folded' : ''}`)]),
          ...(s.closed.length ? ['Closed lately:', ...s.closed.slice(0, 10).map(x => `- ${x.id} | ${x.kind} | ${x.title}`)] : []),
        ].join('\n') }
      },
    },
    {
      name: 'open_focus',
      title: said('打开', 'Bring up'),
      effect: 'direct',
      shows: true, // (it only shows something: a request that did only this is answered, not waiting for 好了)
      description: 'Bring an open thing (open_list) up on the person\'s desk — only when the person asked to see it.',
      parameters: schema({ id: { type: 'string' } }, ['id']),
      async run({ id }) {
        const it = item(id)
        open.apply({ ops: [{ op: 'use', id: it.id }] })
        page(it.reopen.event, it.reopen.detail)
        return { text: `${it.title} comes up on the person's desk.`, summary: said(`打开了：${it.title}`, `Brought up: ${it.title}`) }
      },
    },
    {
      name: 'open_group',
      title: said('归到一组', 'Put in a group'),
      effect: 'direct',
      description: 'Put an open thing in a group: the work it belongs to (run:<id>, session:<id>, task:<id>), a group of the person\'s own (g:<name>, e.g. g:公众号), or back where it goes by itself (group null). Things like it (the same site, folder, app) go there from now on. For tidying when the person asks: group what belongs together.',
      parameters: schema({ id: { type: 'string' }, group: { type: ['string', 'null'] } }, ['id', 'group']),
      async run({ id, group }) {
        const it = item(id)
        open.apply({ ops: [{ op: 'move', id: it.id, group: group || null }] })
        return { text: `${it.title} is in ${group || 'its own place'} now.`, summary: said(`归了组：${it.title} → ${group || '原处'}`, `Grouped: ${it.title} → ${group || 'its place'}`), undo: { tool: 'open_group', args: { id: it.id, group: it.group || null } } }
      },
    },
    {
      name: 'open_fold',
      title: said('收起/展开一组', 'Fold or unfold a group'),
      effect: 'direct',
      description: 'Fold a group of open things into its card on the desk (folded true), or lay it out again (false). group: a key from open_list (run:…, g:…, kind:web…). A pinned group is the person\'s: leave it.',
      parameters: schema({ group: { type: 'string' }, folded: { type: 'boolean' } }, ['group', 'folded']),
      async run({ group, folded }) {
        open.apply({ ops: [{ op: 'foldGroup', key: group, folded }] })
        return { text: `${group} ${folded ? 'folded' : 'laid out'}.`, summary: said(`${folded ? '收起了' : '展开了'}：${group}`, `${folded ? 'Folded' : 'Unfolded'}: ${group}`), undo: { tool: 'open_fold', args: { group, folded: !folded } } }
      },
    },
    {
      name: 'desk_window',
      title: said('摆窗口', 'Arrange windows'),
      effect: 'direct',
      shows: true, // (it only shows something: a request that did only this is answered, not waiting for 好了)
      description: 'Arrange the windows on the person\'s desk, when they ask: front, max (fill the desk), min, restore, close, or tile (side by side: the ones given, else every window not minimised, at most 8). '
        + 'id: an open thing (open_list) — or "main", the page window; page: show that page in the page window first (open_page lists them).',
      parameters: schema({ action: { type: 'string', enum: ['front', 'max', 'min', 'restore', 'close', 'tile'] }, id: { type: 'string' }, page: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, ['action']),
      async run({ action, id, page: p, ids }) {
        const winOf = x => (x === 'main' ? 'main' : item(x).win || null)
        const detail = { action, ...(p && { page: String(p) }), ...(id && { win: winOf(id) }), ...(ids?.length && { wins: ids.map(winOf).filter(Boolean) }) }
        if (id && !detail.win) throw new Error(`"${id}" is not a window on the desk (open_focus brings it up)`)
        if (action !== 'tile' && !detail.win && !detail.page) throw new Error('which window: id (open_list), "main", or page')
        page('ruyix:desk-window', detail)
        const what = id ? (id === 'main' ? said('页面窗口', 'the page window') : said(item(id).title, item(id).title)) : p ? said(`页面 ${p}`, `the page ${p}`) : said('窗口', 'the windows')
        const did = ACTION_WORDS[action]
        return { text: `${did.en}: ${what.en}.`, summary: said(`${did.zh}：${what.zh}`, `${did.en}: ${what.en}`) }
      },
    },
    {
      name: 'open_close',
      title: said('关掉', 'Close'),
      effect: 'direct',
      description: 'Close an open thing (open_list): its window goes; it stays among the lately closed, and open_reopen brings it back. Only when the person asked.',
      parameters: schema({ id: { type: 'string' } }, ['id']),
      async run({ id }) {
        const it = item(id)
        open.apply({ ops: [{ op: 'close', id: it.id }] })
        if (it.win) page('ruyix:close-window', { win: it.win })
        return { text: `${it.title} closed.`, summary: said(`关掉了：${it.title}`, `Closed: ${it.title}`), undo: { tool: 'open_reopen', args: { id: it.id } } }
      },
    },
    {
      name: 'open_reopen',
      title: said('重新打开', 'Open again'),
      effect: 'undo',
      description: 'Open again a thing closed lately.',
      parameters: schema({ id: { type: 'string' } }, ['id']),
      async run({ id }) {
        const it = open.state().closed.find(x => x.id === String(id))
        if (!it) throw new Error(`"${id}" was not closed lately`)
        open.apply({ ops: [{ op: 'reopen', id: it.id }] })
        page(it.reopen.event, it.reopen.detail)
        return { text: `${it.title} opens again.`, summary: said(`重新打开：${it.title}`, `Opened again: ${it.title}`) }
      },
    },
  ]
}
