// What a script step names, read from its text (the editor's and the checker's): its steps, the agents it asks, the
// installed scripts it runs — the literal ones of real calls (not in a comment or a string; a name made at run time is
// not seen here).

/**
 * The script with its comments and the text of its strings blanked (same length, lines kept): what is code — a
 * template's ${…} stays code — and each string by where its quote opens.
 */
export function codeOf(src) {
  const s = String(src || ''), strings = new Map()
  let out = '', i = 0
  const blank = t => t.replace(/[^\n]/g, ' ')
  // (each open parenthesis: whether it is an if / while / for's — after its close a / starts a regular expression)
  const parens = []
  let controlClose = false
  // code up to the end, or (inside a template's ${) up to its closing brace
  const code = inside => {
    let depth = 0
    while (i < s.length) {
      const c = s[i], d = s[i + 1]
      if (inside && c === '}' && !depth) return
      if (inside && c === '{') depth++
      if (inside && c === '}') depth--
      if (c === '(') parens.push(/\b(?:if|while|for|with)\s*$/.test(out))
      if (c === ')') controlClose = !!parens.pop()
      if (c === '/' && (d === '/' || d === '*')) {
        const e = d === '/' ? s.indexOf('\n', i) : s.indexOf('*/', i + 2), stop = e < 0 ? s.length : d === '/' ? e : e + 2
        out += blank(s.slice(i, stop))
        i = stop
      } else if (c === '/' && regexHere()) regex()
      else if (c === '"' || c === "'") quoted(c)
      else if (c === '`') template()
      else { out += c; i++ }
    }
  }
  // a / that starts a regular expression (not a division): after an operator, an opening bracket, a comma or a keyword
  const regexHere = () => {
    const before = out.replace(/\s+$/, '')
    if (!before) return true
    if (before.endsWith(')')) return controlClose // if (…) /re/ — but (a) / b divides
    if (/(?:\+\+|--)$/.test(before)) return false // n++ / 2
    return /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(before)
  }
  const regex = () => {
    let cls = false
    out += '/'
    i++
    while (i < s.length && s[i] !== '\n' && (cls || s[i] !== '/')) {
      if (s[i] === '\\') { out += blank(s.slice(i, i + 2)); i += 2; continue }
      if (s[i] === '[') cls = true
      else if (s[i] === ']') cls = false
      out += ' '
      i++
    }
    if (s[i] === '/') { out += '/'; i++ }
    while (/[a-z]/i.test(s[i] || '')) out += s[i++]
  }
  const quoted = q => {
    const at = i
    let text = ''
    out += q
    i++
    while (i < s.length && s[i] !== q && s[i] !== '\n') {
      if (s[i] === '\\') { text += s[i + 1] ?? ''; out += blank(s.slice(i, i + 2)); i += 2 } else { text += s[i]; out += ' '; i++ }
    }
    strings.set(at, text)
    if (s[i] === q) { out += q; i++ }
  }
  const template = () => {
    const at = i
    let text = ''
    out += '`'
    i++
    while (i < s.length && s[i] !== '`') {
      if (s[i] === '\\') { text += s[i + 1] ?? ''; out += blank(s.slice(i, i + 2)); i += 2 } else if (s[i] === '$' && s[i + 1] === '{') {
        text += '${'
        out += '${'
        i += 2
        code(true)
        if (s[i] === '}') { out += '}'; i++ }
      } else { text += s[i]; out += s[i] === '\n' ? '\n' : ' '; i++ }
    }
    strings.set(at, text)
    if (s[i] === '`') { out += '`'; i++ }
  }
  code(false)
  return { code: out, strings }
}
/** The literal first arguments of the calls a pattern finds in code (`.step(`, `.agent(`, `.script(`), in order, once each. */
const literals = (call, ok) => source => {
  const { code, strings } = codeOf(source), out = []
  for (const m of code.matchAll(new RegExp(`\\.\\s*${call}\\s*\\(\\s*(['"\`])`, 'g'))) {
    const text = strings.get(m.index + m[0].length - 1)
    if (text !== undefined && !text.includes('${') && ok(text) && !out.includes(text)) out.push(text)
  }
  return out
}
/** The steps it names (wf.step('name', …), a branch's b.step('name', …)), in the order they are written. */
export const stepNames = literals('step', t => /^[a-z][\w-]{0,59}$/i.test(t))
/** The agents it asks (s.agent('role', …)). */
export const agentRoles = literals('agent', t => t.length > 0 && t.length <= 40)
/** The installed scripts it runs (s.script('name@version', …)). */
export const scriptRefs = literals('script', t => t.length > 0 && t.length <= 110)

/** A new script step's script: what the editor and the assistant start from. */
export const FLOW_TEMPLATE = `// Each wf.step runs once: a run that stops goes on from the first step not done.
const plan = await wf.step('plan', s => s.agent('coder', 'Read the task and the code; say what to change and how to check it.'))
if (!plan.ok) throw new Error('no plan: ' + plan.summary)
const change = await wf.step('change', s => s.agent('coder', 'Make the change you planned:\\n' + plan.summary), { retries: 1 })
await wf.step('check', s => s.sh('make test'), { retries: 1 })
return { summary: change.summary }
`
