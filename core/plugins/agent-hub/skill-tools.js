// The person's own skills (docs/design/agent-control.md; Ethan: "把这个做法记成一个技能" is one of the things made by
// asking): the skill pack `mine` (我的技能) in <hub home>/skills-mine/<name>/SKILL.md — a pack like any (agents name its
// skills "mine/<name>"), its version the digest of what is in it. The tools: see the packs and their skills, write one
// (each version before kept beside it), put one aside; each undoable.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MINE = 'mine'
const NAME = /^[a-z0-9][a-z0-9-]{1,40}$/
const MAX = 64 * 1024
const said = (zh, en) => ({ zh, en })
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

/** The pack's folder and its version (a digest of its SKILL.md files: a change is a new version). */
export function minePack(home) {
  const dir = join(home, 'skills-mine')
  mkdirSync(dir, { recursive: true })
  const version = () => {
    const h = createHash('sha256')
    for (const n of readdirSync(dir).filter(n => NAME.test(n)).sort()) { const f = join(dir, n, 'SKILL.md'); if (existsSync(f)) h.update(`${n}\0${readFileSync(f)}\0`) }
    return h.digest('hex').slice(0, 12)
  }
  return { dir, version }
}

/** `skills`: Agent Hub's packs (list); `pack`: minePack(); `reregister()`: the pack told again (its new version). */
export function skillTools({ skills, pack, reregister }) {
  const file = name => join(pack.dir, name, 'SKILL.md')
  const text = (name, description, body) => `---\nname: ${name}\ndescription: ${String(description).replace(/\s+/g, ' ').trim()}\n---\n\n${String(body).trim()}\n`
  return [
    {
      name: 'skill_list',
      title: said('看技能', 'Skills'),
      effect: 'read',
      description: 'The skill packs and their skills (an agent is given skills by name, "pack/skill": agent_save skills). The person\'s own are the pack "mine" (我的技能).',
      parameters: schema({}),
      async run() {
        const list = await skills.list()
        return { text: list.map(p => [`## ${p.id} — ${p.title}${p.version ? ` (${p.version})` : ''}`, ...(p.skills || []).map(s => `- ${p.id}/${s.name}: ${s.description}`)].join('\n')).join('\n\n') || 'No skill packs.' }
      },
    },
    {
      name: 'skill_save',
      title: said('记成一个技能', 'Save a skill'),
      effect: 'direct',
      description: 'Write one of the person\'s own skills (pack "mine"): how to do a kind of work, as instructions an agent follows — when they ask to keep a way of working ("把这个做法记成一个技能"). '
        + 'name: lowercase-with-dashes; description: when to use it, in a line (agents choose skills by it); body: the instructions in Markdown. Writing an existing one changes it (the version before is kept). Give it to an agent with agent_save { id, skills: ["mine/<name>"] }. Undoable.',
      parameters: schema({ name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' } }, ['name', 'description', 'body']),
      async run({ name, description, body }) {
        if (!NAME.test(String(name || ''))) throw new Error('name: lowercase letters, digits and dashes (2–41)')
        const t = text(name, description, body)
        if (Buffer.byteLength(t) > MAX) throw new Error(`at most ${MAX / 1024} KB`)
        const before = existsSync(file(name)) ? readFileSync(file(name), 'utf8') : null
        mkdirSync(join(pack.dir, name), { recursive: true })
        if (before !== null) writeFileSync(join(pack.dir, name, `SKILL.${Date.now()}.md.old`), before)
        writeFileSync(file(name), t)
        reregister()
        return { text: `${before === null ? 'Saved' : 'Changed'} the skill mine/${name}.`, summary: said(`${before === null ? '记了技能' : '改了技能'}：${name}`, `${before === null ? 'Saved' : 'Changed'} the skill ${name}`), undo: { tool: 'skill_back', args: { name, text: before, after: t } } }
      },
    },
    {
      name: 'skill_remove',
      title: said('拿掉一个技能', 'Take a skill out'),
      effect: 'direct',
      description: 'Take one of the person\'s own skills (mine/<name>) out — when they say so. It is put aside, so the undo brings it back.',
      parameters: schema({ name: { type: 'string' } }, ['name']),
      async run({ name }) {
        if (!NAME.test(String(name || '')) || !existsSync(file(name))) throw new Error(`no skill mine/${name} (skill_list)`)
        const aside = join(pack.dir, '.removed', `${name}-${Date.now()}`)
        mkdirSync(join(pack.dir, '.removed'), { recursive: true })
        renameSync(join(pack.dir, name), aside)
        reregister()
        return { text: `Took out mine/${name}.`, summary: said(`拿掉了技能：${name}`, `Took out the skill ${name}`), undo: { tool: 'skill_back', args: { name, aside } } }
      },
    },
    {
      name: 'skill_back', effect: 'undo', description: 'Undo skill_save / skill_remove.',
      parameters: schema({ name: { type: 'string' }, text: { type: ['string', 'null'] }, aside: { type: 'string' }, after: { type: 'string' } }, ['name']),
      async run({ name, text: was, aside, after }) {
        if (!NAME.test(String(name || ''))) throw new Error('bad name')
        if (aside) { if (existsSync(join(pack.dir, name))) throw new Error(`there is a skill ${name} again`); renameSync(aside, join(pack.dir, name)) }
        else {
          if (after === undefined || !existsSync(file(name)) || readFileSync(file(name), 'utf8') !== after) throw Object.assign(new Error('this skill changed since: look at it before undoing'), { code: 'skillChanged' })
          if (was == null) rmSync(join(pack.dir, name), { recursive: true, force: true })
          else writeFileSync(file(name), was)
        }
        reregister()
        return { text: `mine/${name} is as it was.` }
      },
    },
  ]
}
