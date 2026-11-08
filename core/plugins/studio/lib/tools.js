// The main agent's tools for the studios (the shell's system tools: core/shell/system.js; the skill that says when:
// core/shell/skills/ruyix-system). Looking is free; a record added, changed or removed acts at once and has its way back;
// starting a studio's workflow is for when the person said so outright; a studio of the person's own is made from what
// they described (its declaration, checked) and can be taken out again.

const said = (zh, en) => ({ zh, en })
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const short = (v, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s }
const when = t => `${new Date(t).toISOString().slice(0, 16)}Z` // (UTC, said as such: the agent turns it into the person's time)

/** A record as one line: its id, then its fields that are set (long text cut). */
function line(c, r) {
  if (c.runs) return `- ${r.id} | ${r.title} | ${r.status}${r.record ? ` | from ${r.record}` : ''} | ${when(r.createdAt)}`
  const fields = c.fields.filter(f => r[f.name] !== null && r[f.name] !== undefined && !(Array.isArray(r[f.name]) && !r[f.name].length))
  return `- ${r.id} | ${fields.map(f => `${f.name}: ${f.type === 'datetime' ? when(r[f.name]) : short(r[f.name], f.type === 'textarea' ? 120 : 60)}`).join(' | ')}`
}
const fieldText = f => `${f.name} (${f.type}${f.options ? `: ${f.options.map(o => o.value).join('/')}` : ''}${f.values ? `: ${f.values.map(o => o.value).join('/')}` : ''}${f.required ? ', needed' : ''})`

export const DECLARATION_HELP = `A studio is a declaration (JSON): { id (lowercase, 2–32), name: { zh, en }, icon (one of the given names), collections: { <key>: { title: { zh, en }, fields: [{ name, type, label: { zh, en }, required?, default?, options? (select, tags: [{ value, label }]), values? (status: [{ value, label, tone: neutral|info|progress|success|warning|danger }]), multiple? (image) }], single? } | { title, runs: '<workflow id>' } }, start: [{ id, label, workflow: '<workflow id>', from: '<collection>', title: '<field>', text: '<field>', fields: { <run field>: <record field> }, status: { start, done, failed } }], home: ['start', 'working', { view: 'board'|'list'|'calendar'|'form', collection, by?, at? }, 'library', 'history'] }. Field types: text, textarea, number, bool, select, status, date, datetime, color, links, tags, image, ref:<collection>.`

/** `studios`: the service (index.js createStudios). `icons`: the names a studio's icon can be. */
export function studioTools({ studios, icons = [] }) {
  const stamp = id => ({ declaration: studios.ownDeclaration(id), rev: studios.rev(id) })
  const collOf = (studio, coll) => {
    const d = studios.declaration(studio), c = d.collections[coll]
    if (!c) throw new Error(`${studio} has no collection ${coll} (${Object.keys(d.collections).join(', ')})`)
    return c
  }
  return [
    {
      name: 'studio_list',
      title: said('看工作室', 'Studios'),
      effect: 'read',
      description: 'The studios: each one an end-to-end line of work with its own page (Plume 工作室: ideas → posts on 小红书, X, 公众号). For each: its id, name, its collections (kinds of records) with their fields and how many records, and what it can start (a workflow from a record). Look here before working in a studio.',
      parameters: schema({}),
      async run() {
        const list = studios.studios()
        if (!list.length) return { text: 'No studios yet. One can be made from what the person describes (studio_create).' }
        return { text: list.map(s => {
          const d = studios.declaration(s.id)
          return [`## ${s.id} — ${s.name.zh} / ${s.name.en}${studios.isOwn(s.id) ? ' (the person\'s own)' : ''}`,
            ...Object.values(d.collections).map(c => `- ${c.key} (${c.title.zh}): ${c.runs ? `the runs of ${c.runs}` : c.fields.map(fieldText).join(', ')} — ${studios.list(s.id, c.key).length} now`),
            ...d.start.map(st => `- start ${st.id} (${st.label.zh}): ${st.workflow}${st.from ? ` from a record of ${st.from}` : ''}${st.status ? ` (its status: ${Object.entries(st.status).map(([k, v]) => `${k} → ${v}`).join(', ')})` : ''}`)].join('\n')
        }).join('\n\n') }
      },
    },
    {
      name: 'studio_items',
      title: said('看工作室里的记录', 'Studio records'),
      effect: 'read',
      description: 'The records of one collection of a studio (studio_list), newest change first: id and the fields that are set. `status` keeps only those with that status. A collection of runs lists its runs.',
      parameters: schema({ studio: { type: 'string' }, collection: { type: 'string' }, status: { type: 'string' } }, ['studio', 'collection']),
      async run({ studio, collection, status }) {
        const c = collOf(studio, collection), st = c.fields?.find(f => f.type === 'status')
        const items = studios.list(studio, collection).filter(r => !status || (st ? r[st.name] === status : r.status === status))
        return { text: items.length ? [`${collection} of ${studio} (${items.length}):`, ...items.slice(0, 60).map(r => line(c, r))].join('\n') : `No ${collection} in ${studio}${status ? ` with status ${status}` : ''}.` }
      },
    },
    {
      name: 'studio_put',
      title: said('记一条 / 改一条', 'Add or change a record'),
      effect: 'direct',
      description: 'Add a record to a studio\'s collection (no id) or change one (its id: only the fields given change). Fields by name, as studio_list says (a ref: the other record\'s id; a datetime: ISO time with its offset; tags: a list). For what the person asked: "记个选题：…", "把这条改成发小红书和 X", "排到明天早上 9 点" (its datetime field). Its undo puts it back.',
      parameters: schema({ studio: { type: 'string' }, collection: { type: 'string' }, id: { type: 'string', description: 'to change one; left out: a new one' }, fields: { type: 'object' } }, ['studio', 'collection', 'fields']),
      async run({ studio, collection, id, fields }, { undo = false } = {}) {
        if (undo) throw Object.assign(new Error('this old undo has no record snapshot: look at the record before changing it'), { code: 'recordChanged' })
        const c = collOf(studio, collection)
        const key = c.single ? 'main' : id
        const before = key ? studios.get(studio, collection, key) : null
        if (key && !before && !c.single) throw new Error(`${studio} has no ${collection} ${id} (studio_items)`)
        const r = studios.put(studio, collection, { ...(fields || {}), ...(id && { id }) }, { by: 'main' })
        const name = r[c.fields[0].name] ?? r.id
        if (!before) return { text: `Added ${r.id} to ${collection} of ${studio}.`, summary: said(`记了一条${c.title.zh}：${short(name, 40)}`, `Added to ${c.title.en}: ${short(name, 40)}`), undo: { tool: 'studio_remove', args: { studio, collection, id: r.id, after: r.rev } } }
        const back = Object.fromEntries(Object.keys(fields || {}).filter(k => k !== 'id').map(k => [k, before[k] ?? null]))
        return { text: `Changed ${r.id} (${Object.keys(back).join(', ')}).`, summary: said(`改了${c.title.zh}：${short(name, 40)}`, `Changed ${c.title.en}: ${short(name, 40)}`), undo: { tool: 'studio_put_back', args: { studio, collection, id: r.id, before: back, after: Object.fromEntries(Object.keys(back).map(k => [k, r[k] ?? null])) } } }
      },
    },
    {
      name: 'studio_put_back', effect: 'undo', description: 'Undo unchanged fields of studio_put.',
      parameters: schema({ studio: { type: 'string' }, collection: { type: 'string' }, id: { type: 'string' }, before: { type: 'object' }, after: { type: 'object' } }, ['studio', 'collection', 'id', 'before', 'after']),
      async run({ studio, collection, id, before, after }) {
        const current = studios.get(studio, collection, id)
        if (!current || !before || !after || Object.keys(before).some(k => JSON.stringify(current[k] ?? null) !== JSON.stringify(after[k] ?? null)))
          throw Object.assign(new Error('this record changed since: look at it in the studio'), { code: 'recordChanged' })
        studios.put(studio, collection, { ...before, id }, { by: 'main' })
        return { text: `${id}: the changed fields are as they were.` }
      },
    },
    {
      name: 'studio_remove',
      title: said('拿掉一条', 'Remove a record'),
      effect: 'direct',
      description: 'Take a record out of a studio\'s collection — only when the person asked. It is kept aside and its undo brings it back.',
      parameters: schema({ studio: { type: 'string' }, collection: { type: 'string' }, id: { type: 'string' }, after: { type: 'integer' } }, ['studio', 'collection', 'id']),
      async run({ studio, collection, id, after }, { undo = false } = {}) {
        const c = collOf(studio, collection), r = studios.get(studio, collection, id)
        if (!r) throw new Error(`${studio} has no ${collection} ${id} (studio_items)`)
        if ((undo || after !== undefined) && (after === undefined || r.rev !== after)) throw Object.assign(new Error('this record changed since: look at it before undoing its creation'), { code: 'recordChanged' })
        studios.remove(studio, collection, id, { by: 'main' })
        const name = r[c.fields[0].name] ?? id
        return { text: `Removed ${id} from ${collection}.`, summary: said(`拿掉了${c.title.zh}：${short(name, 40)}`, `Removed from ${c.title.en}: ${short(name, 40)}`), undo: { tool: 'studio_restore', args: { studio, collection, id } } }
      },
    },
    {
      name: 'studio_restore',
      title: said('放回一条', 'Bring a record back'),
      effect: 'undo',
      description: 'Bring back a record taken out (studio_remove\'s undo).',
      parameters: schema({ studio: { type: 'string' }, collection: { type: 'string' }, id: { type: 'string' } }, ['studio', 'collection', 'id']),
      async run({ studio, collection, id }) {
        const r = studios.restore(studio, collection, id, { by: 'main' })
        if (!r) throw new Error(`${id} is not removed`)
        return { text: `${id} is back in ${collection}.` }
      },
    },
    {
      name: 'studio_start',
      title: said('从一条开始做', 'Start from a record'),
      effect: 'direct',
      description: 'Start a studio\'s workflow (studio_list: its starts) from one of its records — "从选题里挑一个开写" — only when the person said outright to start that one now; otherwise say which one you would pick and why, and ask. The run takes the record\'s title, text and fields; the record\'s status moves on (在写) and again when the run ends. What the run publishes or sends still waits for the person\'s approval in the run.',
      parameters: schema({ studio: { type: 'string' }, start: { type: 'string', description: 'the start\'s id (studio_list)' }, record: { type: 'string', description: 'the record\'s id (studio_items)' } }, ['studio', 'start']),
      async run({ studio, start, record }) {
        const run = await studios.start(studio, start, record || null, { by: 'main' })
        return { text: `Started run ${run.id} from ${record || 'nothing'} (${studio}). Its approvals come to the person in the run.`, summary: said(`开始做：${run.subject?.title || run.title || run.id}`, `Started: ${run.subject?.title || run.title || run.id}`) }
      },
    },
    {
      name: 'studio_create',
      title: said('建一个工作室', 'Make a studio'),
      effect: 'direct',
      description: `Make a studio of the person's own from what they described, when they asked for one — or change one of theirs (the same id). Use only workflows this Ruyix has enabled (the workflow list: a draft does not count); when the work needs one that is not there, make the workflow and have the person enable it first, or start with one there is and say so. Keep it small: 2–4 collections, a start, a home. ${DECLARATION_HELP}${icons.length ? ` Icons: ${icons.join(', ')}.` : ''} It is checked before it is kept; a mistake comes back with where it is. Its undo takes it out (its records stay in its folder).`,
      parameters: schema({ declaration: { type: 'object' } }, ['declaration']),
      async run({ declaration }, { undo = false } = {}) {
        if (undo) throw Object.assign(new Error('this old undo has no declaration snapshot: look at the studio before changing it'), { code: 'studioChanged' })
        const id = declaration?.id, before = id && studios.isOwn(id) ? studios.ownDeclaration(id) : null
        const d = studios.create(declaration)
        return {
          text: `${before ? 'Changed' : 'Made'} the studio ${d.id} (${d.name.zh}): ${Object.keys(d.collections).join(', ')}. It is in the person's nav now.`,
          summary: said(`${before ? '改了' : '建了'}工作室：${d.name.zh}`, `${before ? 'Changed' : 'Made'} a studio: ${d.name.en}`),
          undo: before ? { tool: 'studio_declaration_back', args: { declaration: before, after: stamp(d.id) } } : { tool: 'studio_drop', args: { id: d.id, after: stamp(d.id) } },
        }
      },
    },
    {
      name: 'studio_declaration_back', effect: 'undo', description: 'Undo an unchanged studio declaration.',
      parameters: schema({ declaration: { type: 'object' }, after: { type: 'object' } }, ['declaration', 'after']),
      async run({ declaration, after }) {
        if (!after || JSON.stringify(stamp(declaration?.id)) !== JSON.stringify(after)) throw Object.assign(new Error('this studio changed since: look at its declaration'), { code: 'studioChanged' })
        const d = studios.create(declaration)
        return { text: `${d.id} is as it was.` }
      },
    },
    {
      name: 'studio_drop',
      title: said('拿掉工作室', 'Take a studio out'),
      effect: 'undo',
      description: 'Take one of the person\'s own studios out of the list (studio_create\'s undo); its records stay in its folder.',
      parameters: schema({ id: { type: 'string' }, after: { type: 'object' } }, ['id', 'after']),
      async run({ id, after }) { if (!after || JSON.stringify(stamp(id)) !== JSON.stringify(after)) throw Object.assign(new Error('this studio changed since: look at it before undoing its creation'), { code: 'studioChanged' }); studios.drop(id); return { text: `${id} is out of the list.` } },
    },
  ]
}
