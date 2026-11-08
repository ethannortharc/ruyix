// The system tools: what the main agent may do in this Ruyix for the person (docs/design/main-agent.md). Any plugin
// registers its own on the shell (ruyixShell.systemTools.register); the conversation (the workbench's assistant) offers
// them to whoever answers it and keeps a record of what they did, with the way back.
// A tool: { name, title: { zh, en }, description, parameters (JSON schema), effect, run(args, { by }) → { text, summary?, undo? } }
//   effect 'read': it only looks.
//   effect 'direct': it acts at once — what can be undone, or is harmless, and the person said to do. Its summary
//     ({ zh, en }: what it did, in a line) and its undo ({ tool, args }: another tool here) go on record.
//   effect 'undo': offered to no agent: run only to undo what a 'direct' one did.
//   shows: true (a 'direct' one that only shows something — opens a page, a window, a file; arranges the desk): a
//     request that did nothing else is answered at once, with nothing made to accept (the conversation's tasks).
// What cannot be undone, or reaches outside this Ruyix (deleting, publishing, sending, paying), is no 'direct' tool: it
// stays a card the person applies (the workbench's run drafts and approvals).
// Also here: the page's actions — what a tool asks of the page the person looks at (open an app's window): the page
// takes them with its poll of /api/ruyix/surfaces (every few seconds, while it is in view).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_DEFAULT, MAX_WIDGETS, THEMES, WIDGET_SIZES, checkDesktop, desktopKeys, themeOf, themePatch } from './desktop.js'

const NAME = /^[a-z][a-z0-9_]{2,47}$/
const EFFECTS = ['read', 'direct', 'undo']
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

/**
 * The registry: register(tool) → its removal; list() the tools (an agent's: without the undo ones); get(name).
 * `onUse(name, args)`: told of each thing a tool did (a direct one that says what it did, whoever called it) — what is
 * used most comes first when looking for things (find.js).
 */
export function createSystemTools({ onUse = null } = {}) {
  const tools = new Map()
  return {
    register(tool) {
      if (!NAME.test(String(tool?.name || ''))) throw new Error(`a system tool's name is snake_case: ${tool?.name}`)
      if (!EFFECTS.includes(tool.effect)) throw new Error(`${tool.name}: effect is ${EFFECTS.join(', ')}`)
      if (typeof tool.run !== 'function') throw new Error(`${tool.name}: no run`)
      if (tools.has(tool.name)) throw new Error(`a system tool ${tool.name} is there already`)
      const kept = !onUse || tool.effect !== 'direct' ? tool : { ...tool, async run(args, ctx) { const r = await tool.run(args, ctx); if (r?.summary) { try { onUse(tool.name, args || {}) } catch { /* only a count */ } } return r } }
      tools.set(tool.name, kept)
      return () => { if (tools.get(tool.name) === kept) tools.delete(tool.name) }
    },
    list: ({ undo = false } = {}) => [...tools.values()].filter(t => undo || t.effect !== 'undo'),
    get: name => tools.get(String(name)) || null,
  }
}

/** The page's actions: { id, event, detail, at }, kept two minutes; the page takes those after the last it took. */
export function createPageActions({ now = Date.now, keepMs = 120e3 } = {}) {
  let seq = 0, list = []
  const boot = `${now().toString(36)}${Math.random().toString(36).slice(2, 6)}` // (a restarted host counts from 0 again: the page starts over)
  return {
    boot,
    /** Ask the page to dispatch a window event (an app's window opened, a page shown). */
    add(event, detail = {}) {
      if (!/^[\w:-]{1,60}$/.test(String(event))) throw new Error(`not a page event: ${event}`)
      list = [...list.filter(a => now() - a.at < keepMs), { id: ++seq, event, detail, at: now() }].slice(-50)
      return seq
    },
    since: after => list.filter(a => a.id > (Number(after) || 0) && now() - a.at < keepMs),
    get last() { return seq },
  }
}

/**
 * The shell's own tools: the desktop (through the changes journal: undone as the person would) and voice input.
 * `widgetKinds()`: the widgets the page knows ([{ type, name: {zh,en}|string, sizes }]: built-in, overviews, plugins'),
 * as the page last said — what desk_get offers to add. `pages()`: the pages ([{ id, label, group, hidden? }], the page's
 * language) and `settingsTabs()`: Settings' tabs ([{ id, label }]), as the page last said — what an agent can open
 * (page actions 'ruyix:open' { panel } and 'ruyix-settings:open' { tab }).
 */
export function shellTools({ home, changes, voice, widgetKinds = () => [], pages = () => [], settingsTabs = () => [], page = () => {}, notes = () => null }) {
  const file = join(home, 'desktop.json')
  const desktopNow = () => {
    let text = null
    try { text = readFileSync(file, 'utf8') } catch { return { ...DESKTOP_DEFAULT } }
    return checkDesktop(JSON.parse(text))
  }
  // a change applied at once, by the main agent as the person asked (it is in Settings → Changes like any, undone there too)
  const applied = async (patch, summary, by) => {
    const c = await changes.propose({ summary, edits: [{ surface: 'desktop', value: patch }], by })
    try { await changes.apply(c.id, { by, digest: c.digest }) } catch (err) { await changes.discard(c.id).catch(() => {}); throw err }
    return c
  }
  const said = (zh, en) => ({ zh, en })
  // a page or a tab by its id or its name, as the person said it (any case; the page's language)
  const pick = (list, want) => {
    const w = String(want || '').trim().toLowerCase()
    return list.find(x => x.id.toLowerCase() === w) || list.find(x => String(x.label || '').toLowerCase() === w) || list.find(x => w && String(x.label || '').toLowerCase().includes(w)) || null
  }
  // the desk's note widgets (the first one, or the one named), one made when there is none
  const noteWidgets = () => (desktopNow().widgets || []).filter(w => w.type === 'note')
  return [
    {
      name: 'desk_note',
      title: said('写便签', 'Write a note'),
      effect: 'direct',
      description: 'Write on a note on the person\'s desk (a note widget) — a reminder, a list, what they asked to jot down. append: add it under what is there (default: replace). id: which note (desk_get lists the widgets; default the first; none there: one is put on the desk). Undoable.',
      parameters: schema({ text: { type: 'string' }, append: { type: 'boolean' }, id: { type: 'string' } }, ['text']),
      async run({ text, append = false, id }, { by } = {}) {
        const n = notes()
        if (!n) throw new Error('the desk\'s notes are not here')
        let w = id ? noteWidgets().find(x => x.id === id) : noteWidgets()[0], made = false
        if (id && !w) throw new Error(`no note ${id} on the desk: ${noteWidgets().map(x => x.id).join(', ') || 'none'} (desk_get)`)
        if (!w) {
          const list = desktopNow().widgets || [{ id: 'dsetup', type: 'setup', size: 'md' }, { id: 'dclock', type: 'clock', size: 'sm' }, { id: 'dcal', type: 'calendar', size: 'sm' }]
          if (list.length >= MAX_WIDGETS) throw new Error(`the desk has ${MAX_WIDGETS} widgets already: take one away first`)
          let nid = 'note'
          for (let k = 2; list.some(x => x.id === nid); k++) nid = `note${k}`
          await applied({ widgets: [...list, { id: nid, type: 'note', size: 'md' }] }, said('加了一张便签', 'A note put on the desk'), by)
          w = { id: nid }; made = true
        }
        const before = n.all().notes[w.id] || ''
        const next = append && before ? `${before.replace(/\s+$/, '')}\n${text}` : String(text)
        const written = n.save({ id: w.id, text: next }).notes[w.id] || ''
        page('ruyix:notes', { id: w.id })
        return { text: `The note ${w.id} says now:\n${next}`, summary: said(`写在便签上：${String(text).slice(0, 40)}`, `Wrote on a note: ${String(text).slice(0, 40)}`), undo: { tool: 'desk_note_back', args: { id: w.id, text: before, after: written, ...(made && { made: true }) } } }
      },
    },
    {
      name: 'desk_note_back',
      effect: 'undo',
      description: 'Undo desk_note.',
      parameters: schema({ id: { type: 'string' }, text: { type: 'string' }, after: { type: 'string' }, made: { type: 'boolean' } }, ['id', 'text', 'after']),
      async run({ id, text, after, made }, { by } = {}) {
        const n = notes()
        if (!n || after === undefined || (n.all().notes[id] || '') !== after) throw Object.assign(new Error('this note changed since: look at it on the desk'), { code: 'noteChanged' })
        n.save({ id, text })
        if (made) { const list = desktopNow().widgets || []; await applied({ widgets: list.filter(x => x.id !== id) }, said('拿掉了便签', 'The note taken off the desk'), by) }
        page('ruyix:notes', { id })
        return { text: `The note ${id} is as it was.` }
      },
    },
    {
      name: 'open_page',
      title: said('打开页面', 'Open a page'),
      effect: 'direct',
      shows: true, // (it only shows something: a request that did only this is answered, not waiting for 好了)
      description: 'Show the person one of Ruyix\'s pages (in the page window on the desk): Tasks (what the agents did and do), the portfolio, the App Center, the agents, the workbench, a studio\'s page, Settings, … — by its id or its name. With no page: the list there is. Only when the person asked to see it.',
      parameters: schema({ page: { type: 'string', description: 'its id or its name (no page: the list)' } }),
      async run({ page: want } = {}) {
        const list = pages()
        if (!want) return { text: list.length ? ['Pages (id | name | group):', ...list.map(p => `- ${p.id} | ${p.label}${p.group ? ` | ${p.group}` : ''}${p.hidden ? ' | hidden from the menu' : ''}`)].join('\n') : 'The page has not said its pages yet (it does when it is open).' }
        const p = pick(list, want)
        if (!p) throw new Error(`no page "${want}" (open_page with no page lists them)`)
        page('ruyix:open', { panel: p.id })
        return { text: `${p.label} opens on the person's desk.`, summary: said(`打开了页面：${p.label}`, `Opened the page ${p.label}`) }
      },
    },
    {
      name: 'open_settings',
      title: said('打开设置', 'Open Settings'),
      effect: 'direct',
      shows: true, // (it only shows something: a request that did only this is answered, not waiting for 好了)
      description: 'Open Settings at one of its tabs (general, models, connectors, search, plugins, changes, …) by its id or its name — for the person to look at or set something themselves (keys, sign-ins). With no tab: the list there is.',
      parameters: schema({ tab: { type: 'string', description: 'its id or its name (no tab: the list)' } }),
      async run({ tab } = {}) {
        const list = settingsTabs()
        if (!tab) return { text: list.length ? ['Settings tabs (id | name):', ...list.map(t => `- ${t.id} | ${t.label}`)].join('\n') : 'The page has not said Settings\' tabs yet (it does when it is open).' }
        const t = pick(list, tab)
        if (!t) throw new Error(`no Settings tab "${tab}" (open_settings with no tab lists them)`)
        page('ruyix-settings:open', { tab: t.id })
        return { text: `Settings opens at ${t.label}.`, summary: said(`打开了设置：${t.label}`, `Opened Settings: ${t.label}`) }
      },
    },
    {
      name: 'desk_get',
      title: said('看桌面设置', 'Desktop settings'),
      effect: 'read',
      description: 'This Ruyix desktop now: its theme, every key of desktop.json (wallpaper, accent, tint, corners, appearance, widgets…), the themes there are and what each key takes.',
      parameters: schema({}),
      run: async () => {
        const d = desktopNow(), { theme, changed } = themeOf(d)
        return { text: [
          `Theme: ${theme ? `${theme.id} (${theme.en} · ${theme.zh})${changed.length ? `, with ${changed.join(', ')} changed` : ''}` : 'none'}`,
          ...Object.entries(d).filter(([k]) => k !== 'theme').map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
          '', 'Themes:', ...THEMES.map(th => `- ${th.id}: ${th.en} · ${th.zh} (wallpaper ${th.wallpaper}, accent ${th.accent}${th.appearance ? `, ${th.appearance}` : ''})`),
          '', 'Widgets there are (desk_set widget_add takes the type exactly as here):',
          ...(widgetKinds().length ? widgetKinds().map(k => `- ${k.type}: ${typeof k.name === 'object' ? `${k.name.en || ''} · ${k.name.zh || ''}` : k.name}${k.sizes?.length ? ` (${k.sizes.join(', ')})` : ''}`) : ['(not known yet: the page says which when it is open)']),
          '', 'Keys:', ...desktopKeys(),
        ].join('\n') }
      },
    },
    {
      name: 'desk_set',
      title: said('改桌面', 'Change the desktop'),
      effect: 'direct',
      description: 'Change how this desktop looks, at once — only what the person asked for. One of: theme (a theme id from desk_get: wallpaper, accent, tint and corners together); set (keys of desktop.json with their values, e.g. {"wallpaper":"aurora","accent":"indigo"}); widget_add ({ type, size: sm|md }); widget_remove (a widget id or type); reset (true: the defaults). summary: what it is, in a short line in the person\'s language. It can be undone (the person sees it on record, with an undo).',
      parameters: schema({
        theme: { type: 'string' }, set: { type: 'object' }, widget_add: { type: 'object', properties: { type: { type: 'string' }, size: { type: 'string', enum: WIDGET_SIZES } }, required: ['type'] },
        widget_remove: { type: 'string' }, reset: { type: 'boolean' }, summary: { type: 'string' },
      }),
      async run(a, { by }) {
        const d = desktopNow()
        let patch, what
        if (a.theme) {
          patch = themePatch(a.theme)
          if (!patch) throw new Error(`no theme ${a.theme}: ${THEMES.map(x => x.id).join(', ')}`)
          const th = THEMES.find(x => x.id === a.theme)
          what = said(`主题：${th.zh}`, `Theme: ${th.en}`)
        } else if (a.set && typeof a.set === 'object' && Object.keys(a.set).length) {
          patch = { ...a.set }
          checkDesktop({ ...d, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null)) })
          const keys = Object.entries(patch).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')
          what = said(`桌面：${keys}`, `Desktop: ${keys}`)
        } else if (a.widget_add?.type) {
          const size = a.widget_add.size || 'md'
          if (!WIDGET_SIZES.includes(size)) throw new Error(`size: ${WIDGET_SIZES.join(' or ')}`)
          const list = d.widgets || [{ id: 'dsetup', type: 'setup', size: 'md' }, { id: 'dclock', type: 'clock', size: 'sm' }, { id: 'dcal', type: 'calendar', size: 'sm' }]
          if (list.length >= MAX_WIDGETS) throw new Error(`the desk has ${MAX_WIDGETS} widgets already: take one away first`)
          let id = String(a.widget_add.type).replace(/[^a-z0-9]/g, '').slice(0, 9) || 'w'
          for (let n = 2; list.some(w => w.id === id); n++) id = `${id.slice(0, 9)}${n}`
          patch = { widgets: [...list, { id, type: String(a.widget_add.type), size }] }
          what = said(`加了小组件：${a.widget_add.type}`, `Widget added: ${a.widget_add.type}`)
        } else if (a.widget_remove) {
          const list = d.widgets
          if (!list) throw new Error('the desk shows its default set: there is no list of its own to take one from')
          const left = list.filter(w => w.id !== a.widget_remove && w.type !== a.widget_remove)
          if (left.length === list.length) throw new Error(`no widget ${a.widget_remove} on the desk: ${list.map(w => `${w.id} (${w.type})`).join(', ')}`)
          patch = { widgets: left }
          what = said(`去掉了小组件：${a.widget_remove}`, `Widget removed: ${a.widget_remove}`)
        } else if (a.reset) {
          patch = null
          what = said('桌面恢复默认', 'Desktop back to the defaults')
        } else throw new Error('say what to change: theme, set, widget_add, widget_remove or reset')
        if (a.widget_add?.type && widgetKinds().length && !widgetKinds().some(k => k.type === String(a.widget_add.type))) throw new Error(`no widget "${a.widget_add.type}": desk_get lists the types there are`)
        // the keys it changes, as they were and as they will be: the way back by key when the journal's own undo cannot
        // be had (a later change touched desktop.json)
        const keys = {}
        for (const k of patch === null ? Object.keys(d) : Object.keys(patch)) {
          const before = d[k] ?? null, after = patch === null ? (DESKTOP_DEFAULT[k] ?? null) : patch[k] ?? null
          if (JSON.stringify(before) !== JSON.stringify(after)) keys[k] = { before, after } // (a key it leaves as it was has nothing to undo)
        }
        const c = await applied(patch, String(a.summary || '').slice(0, 200) || `${what.en} · ${what.zh}`, by)
        return { text: `Done (change ${c.id}): ${what.en}. The page shows it within seconds; it can be undone.`, summary: what, undo: { tool: 'desk_undo', args: { id: c.id, keys } } }
      },
    },
    {
      name: 'desk_undo',
      title: said('撤销桌面改动', 'Undo a desktop change'),
      effect: 'undo',
      description: 'The reverse of a desktop change the main agent applied.',
      parameters: schema({ id: { type: 'string' }, keys: { type: 'object' } }, ['id']),
      async run({ id, keys }, { by }) {
        // (undone already — on Settings → Changes, say): nothing more to do
        if ((await changes.get(String(id))).state === 'undone') return { text: `Undone already: ${id}.`, summary: said('撤销了桌面改动', 'Desktop change undone') }
        try {
          await changes.undo(String(id), { by })
          return { text: `Undone: ${id}.`, summary: said('撤销了桌面改动', 'Desktop change undone') }
        } catch (err) {
          // a later change touched desktop.json (another of the agent's, an undo of one): back by key — each key this change
          // set goes back to what it was, while it is still as the change left it; one changed since is left as it is
          if (err?.code !== 'moved' || !keys || typeof keys !== 'object') throw err
          const now = desktopNow(), back = {}, left = []
          for (const [k, v] of Object.entries(keys)) {
            const at = JSON.stringify(now[k] ?? null)
            if (at === JSON.stringify(v?.before ?? null)) continue // (back already)
            if (at === JSON.stringify(v?.after ?? null)) back[k] = v?.before ?? null
            else left.push(k)
          }
          if (!Object.keys(back).length && !left.length) return { text: `Already as it was before ${id}.`, summary: said('桌面已经是原样', 'The desktop is as it was') }
          if (!Object.keys(back).length) throw new Error(`nothing to undo: ${left.join(', ')} changed again since`)
          const c = await applied(back, `↶ ${Object.keys(back).join(', ')}`, by)
          return { text: `Undone (change ${c.id}): ${Object.keys(back).join(', ')} as they were${left.length ? `; left as they are now (changed since): ${left.join(', ')}` : ''}.`,
            summary: said(`撤销了桌面改动${left.length ? `（${left.join('、')} 后来又改过，没动）` : ''}`, `Desktop change undone${left.length ? ` (${left.join(', ')} changed since: left)` : ''}`) }
        }
      },
    },
    {
      name: 'voice_get',
      title: said('看语音输入设置', 'Voice input settings'),
      effect: 'read',
      description: 'Voice input now: the connection and speech model in use, the language, and the connections with speech models to choose from.',
      parameters: schema({}),
      async run() {
        const c = await voice.config()
        return { text: [
          `In use: ${c.using ? `${c.using.provider || c.using.connection} · ${c.using.model} · language ${c.using.language}${c.using.chosen ? '' : ' (found by itself)'}` : 'none — no model endpoint with a speech model yet (Settings → General → Voice input adds one: an OpenAI-compatible address with /audio/transcriptions, like omlx)'}`,
          'Model endpoints (provider) and connections set before (connection):', ...c.choices.map(x => `- ${x.kind} ${x.id} (${x.baseUrl}): ${x.models.length ? x.models.join(', ') : 'no speech model'}`),
          `Languages: ${c.languages.join(', ')}`,
        ].join('\n') }
      },
    },
    {
      name: 'voice_set',
      title: said('改语音输入设置', 'Change voice input'),
      effect: 'direct',
      description: 'Choose voice input\'s model endpoint (provider) or connection, speech model and/or language (auto, zh, en, ja, ko, fr, de, es) — only what the person asked. voice_get lists the choices. It can be undone.',
      parameters: schema({ provider: { type: 'string' }, connection: { type: 'string' }, model: { type: 'string' }, language: { type: 'string' } }),
      async run(a) {
        const before = (await voice.config()).set
        const next = { ...before, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) }
        if (a.provider) delete next.connection // (one or the other)
        if (a.connection) delete next.provider
        await voice.save(next, { expect: before })
        const keys = ['provider', 'connection', 'model', 'language'].filter(k => (before[k] || null) !== (next[k] || null))
        const pick = (v, fields = keys) => Object.fromEntries(fields.map(k => [k, v[k] || null]))
        const guard = keys.some(k => ['provider', 'connection', 'model'].includes(k)) ? pick(next, ['provider', 'connection', 'model']) : {}
        const what = Object.entries(a).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${v}`).join(', ')
        return { text: `Voice input: ${what}.`, summary: said(`语音输入：${what}`, `Voice input: ${what}`), undo: { tool: 'voice_restore', args: { before: pick(before), after: { ...guard, ...pick(next) } } } }
      },
    },
    {
      name: 'voice_restore',
      title: said('恢复语音输入设置', 'Voice input restored'),
      effect: 'undo',
      description: 'Voice input\'s settings as they were.',
      parameters: schema({ before: { type: 'object' }, after: { type: 'object' } }, ['before', 'after']),
      async run({ before, after }) {
        const current = (await voice.config()).set, keys = before && Object.keys(before)
        if (!keys || !after || keys.some(k => !['provider', 'connection', 'model', 'language'].includes(k)) || Object.keys(after || {}).some(k => (current[k] || null) !== (after[k] || null)))
          throw Object.assign(new Error('voice settings changed since: look at them again'), { code: 'changedMeanwhile' })
        const next = { ...current }
        for (const k of keys) { if (before[k] === null) delete next[k]; else next[k] = before[k] }
        await voice.save(next, { replace: true, expect: current })
        return { text: 'Voice input as it was.', summary: said('语音输入恢复原样', 'Voice input as it was') }
      },
    },
  ]
}
