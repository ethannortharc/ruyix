// An agent's work, a line at a time (docs/design/agent-work.md §2): what the desk's "正在做" strip scrolls, like lyrics
// — made by rule from what the agent does (a tool call and what it is on, the first sentence of what it says), no model
// call, there at once. Every producer of the work list (the workbench's runs, Agent Hub's sessions and tasks) says it
// the same way, through these.
//   line: { at (ms), agent (the id of one of the item's agents[]), text, kind: tool | say | wait, live?: true (at it now),
//           ok?: false (it went wrong) }
//   linesOf(act, agent, lang)   from an agent's activity (Agent Hub's agentActivity fold: tools at work, recent ones, said)
//   keepLines(lines)            the newest LINES_PER_AGENT of each agent, oldest first

export const LINES_PER_AGENT = 6

// what a tool does, by its name (Claude Code's, Codex's, dsh's, the system's own): [doing it, done it] in each language
const VERBS = [
  [/^(read|view|cat|open_file|read_file)$/i, ['在读', '读了'], ['reading', 'read']],
  [/^(write|create|write_file|create_file)$/i, ['在写', '写了'], ['writing', 'wrote']],
  [/^(edit|multiedit|str_replace|apply_patch|patch|notebookedit)$/i, ['在改', '改了'], ['editing', 'edited']],
  [/^(bash|shell|exec|exec_command|command|run|terminal|local_shell)$/i, ['在跑', '跑了'], ['running', 'ran']],
  [/^(ls|list|list_dir|list_directory)$/i, ['在看文件夹', '看了文件夹'], ['looking in', 'looked in']],
  [/^(grep|glob|search|find|rg)$/i, ['在找', '找了'], ['searching', 'searched']],
  [/^(webfetch|fetch|web_fetch|browse)$/i, ['在打开', '打开了'], ['opening', 'opened']],
  [/^(websearch|web_search|search_web)$/i, ['在搜', '搜了'], ['searching the web for', 'searched the web for']],
  [/^(task|agent|spawn|delegate)$/i, ['在派给', '派给了'], ['handing to', 'handed to']],
  [/^(todowrite|todo|update_plan|plan)$/i, ['在列步骤', '列了步骤'], ['planning', 'planned']],
  [/^browser_(open|navigate)$/i, ['在浏览器里打开', '在浏览器里打开了'], ['opening in the browser', 'opened in the browser']],
  [/^browser_(look|snapshot|screenshot|read)$/i, ['在看网页', '看了网页'], ['looking at the page', 'looked at the page']],
  [/^browser_(click|type|fill|press|select)/i, ['在网页上操作', '在网页上操作了'], ['using the page', 'used the page']],
  [/^browser_handoff$/i, ['等你在浏览器里点最后一下', '交给你在浏览器里点'], ['waiting for your last click in the browser', 'handed you the browser']],
  [/^stage_result$/i, ['在交结果', '交了结果'], ['handing in the result', 'handed in the result']],
  [/^(toolsearch|tool_search|search_tools)$/i, ['在找工具', '找了工具'], ['looking for tools', 'found tools'], true],
  [/^(ask_person|request_decision|ask_human|decision)$/i, ['在请你拿主意', '请你拿主意'], ['asking you', 'asked you']],
  [/^(post_message|send_message|message|reply)$/i, ['在留言', '留了言'], ['messaging', 'messaged']],
  [/^(file_save|save_file|save|attach)$/i, ['在存', '存了'], ['saving', 'saved']],
]
const strip = name => String(name || '').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^(functions|tools)\./, '')
/** What a tool is on, short: a path's last two parts, a command's first words, a link's host and path. */
export function shortTarget(target) {
  const s = String(target || '').replace(/\s+/g, ' ').trim()
  if (!s || s === '.' || s === './') return ''
  if (/^https?:\/\//i.test(s)) { try { const u = new URL(s); return (u.host + (u.pathname === '/' ? '' : u.pathname)).slice(0, 48) } catch { /* as text */ } }
  if (/^[~.]?\/?[\w@.-]+(\/[\w@. -]+)+$/.test(s)) return s.split('/').filter(Boolean).slice(-2).join('/').slice(0, 48)
  return s.length > 48 ? `${s.slice(0, 47)}…` : s
}
/** A tool call, said: 读了 draft.md · 在跑 npm test · read draft.md. `live`: it is at it now. */
export function toolText({ name, target, ok, live }, lang = 'en') {
  const zh = lang === 'zh', tool = strip(name)
  const verbs = VERBS.find(([re]) => re.test(tool))
  const what = verbs?.[3] ? '' : shortTarget(target) // (a tool whose target says nothing to a person: none)
  const verb = verbs ? (zh ? verbs[1] : verbs[2])[live ? 0 : 1] : tool
  const said = what ? `${verb} ${what}` : verb
  return ok === false && !live ? (zh ? `${said}（没成）` : `${said} (failed)`) : said
}
/** The first sentence of what an agent said, short. */
export function sayText(text, max = 80) {
  // (Markdown's marks go; an underscore inside a word stays: America/Los_Angeles, file_name.md)
  const s = String(text || '').replace(/[`*#>]+/g, '').replace(/(^|[^\p{L}\p{N}_])_+|_+(?=[^\p{L}\p{N}_]|$)/gu, '$1').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const m = s.match(/^.+?[。！？]|^.+?[.!?](?=\s|$)/)
  const one = (m ? m[0] : s).trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * An agent's lines from its activity (Agent Hub's agentActivity: { tools: [{ name, target, at }] at work, recent:
 * [{ name, target, ok, ms, at? }] done, said, saidAt?, turnStartedAt }). A done one without its time (an older fold)
 * is put in its order after the turn's start.
 */
export function linesOf(act, agent, lang = 'en') {
  if (!act || typeof act !== 'object') return []
  const start = act.turnStartedAt || 0, out = []
  ;(act.recent || []).forEach((t, i) => out.push({ at: t.at || start + i + 1, agent, text: toolText(t, lang), kind: 'tool', ...(t.ok === false && { ok: false }) }))
  for (const t of act.tools || []) out.push({ at: t.at || Date.now(), agent, text: toolText({ ...t, live: true }, lang), kind: 'tool', live: true })
  const said = sayText(act.said)
  if (said) out.push({ at: act.saidAt || Math.max(start, ...out.map(l => l.at)) + 1, agent, text: said, kind: 'say' })
  return keepLines(out)
}

/** The newest LINES_PER_AGENT of each agent, oldest first (the same line twice in a row once). */
export function keepLines(lines, per = LINES_PER_AGENT) {
  const by = new Map()
  for (const l of [...lines].sort((a, b) => a.at - b.at)) {
    const list = by.get(l.agent) || by.set(l.agent, []).get(l.agent)
    if (list.length && list.at(-1).text === l.text && list.at(-1).kind === l.kind) { list[list.length - 1] = l; continue }
    list.push(l)
  }
  return [...by.values()].flatMap(list => list.slice(-per)).sort((a, b) => a.at - b.at)
}
