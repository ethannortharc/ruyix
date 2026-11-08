// One call to a model, no tools: for a step whose input and output are fixed — a rewrite, a summary, a translation —
// where an agent (its own system prompt, tools, several turns) spends ten times the tokens on the same answer.
// A model is named by a reference "<source>:<model>":
//   dsh:<provider>/<model>   dsh's model service (the providers dsh has keys for: dsh's Settings → Models)
//   <connection>:<model>     a connection of the Connectors page (type http) that speaks the OpenAI chat API —
//                            POST <its address>/chat/completions: OpenRouter, a local oMLX or Ollama, DeepSeek's API…
// The answer is text, or — given a JSON Schema — an object checked against it, asked again (with what was wrong) when it
// is not.
import { randomUUID } from 'node:crypto'
import { noteCall } from './llm.js'

const REF = /^([a-z][a-z0-9-]{0,40}):(\S{1,200})$/

/** "<source>:<model>" → { ref, source: 'dsh', provider, model } | { ref, source: 'connection', connection, model }; throws when it is neither. */
export function parseModelRef(ref) {
  const s = String(ref ?? '').trim(), m = REF.exec(s)
  if (!m) throw new Error(`a model is "<connection>:<model>" or "dsh:<provider>/<model>", not "${s.slice(0, 80)}"`)
  if (m[1] !== 'dsh') return { ref: s, source: 'connection', connection: m[1], model: m[2] }
  const cut = m[2].indexOf('/')
  if (cut < 1 || cut === m[2].length - 1) throw new Error(`a dsh model is "dsh:<provider>/<model>", not "${s.slice(0, 80)}"`)
  return { ref: s, source: 'dsh', provider: m[2].slice(0, cut), model: m[2].slice(cut + 1) }
}
export const isModelRef = ref => { try { parseModelRef(ref); return true } catch { return false } }

// ── JSON Schema: the part answers need (type, enum, const, properties, required, additionalProperties: false, items,
// min/maxItems, min/maxLength, minimum/maximum) ──
const typeOf = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v)
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t)
/** What is wrong with `value` against `schema`: a list of "path: problem" (empty: it fits). */
export function checkSchema(schema, value, path = '') {
  const at = path || '(root)', out = []
  if (!schema || typeof schema !== 'object') return out
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.length && !types.some(t => isType(value, t))) return [`${at}: should be ${types.join(' or ')}, is ${typeOf(value)}`]
  if (schema.enum && !schema.enum.some(x => JSON.stringify(x) === JSON.stringify(value))) out.push(`${at}: should be one of ${JSON.stringify(schema.enum)}`)
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${at}: should be ${JSON.stringify(schema.const)}`)
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) out.push(`${at}: at least ${schema.minLength} characters`)
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) out.push(`${at}: at most ${schema.maxLength} characters`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: at least ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: at most ${schema.maximum}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at}: at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at}: at most ${schema.maxItems} items`)
    if (schema.items) value.forEach((v, i) => out.push(...checkSchema(schema.items, v, `${path}[${i}]`)))
  }
  if (typeOf(value) === 'object') {
    const key = k => (path ? `${path}.${k}` : k)
    for (const k of schema.required || []) if (!(k in value)) out.push(`${key(k)}: missing`)
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) out.push(...checkSchema(schema.properties[k], v, key(k)))
      else if (schema.additionalProperties === false) out.push(`${key(k)}: not a field of the answer`)
    }
  }
  return out
}

/** The JSON object in a model's text: a fenced block, or from the first brace. */
export function jsonOf(text) {
  let t = String(text ?? '').trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t)
  if (fence) t = fence[1].trim()
  const from = t.indexOf('{')
  return JSON.parse(from > 0 ? t.slice(from, t.lastIndexOf('}') + 1) : t)
}

const asked = (schema, extra) => [
  'Answer with one JSON object and nothing else — no Markdown fence, no words before or after it.',
  `It must fit this JSON Schema:\n${JSON.stringify(schema)}`,
  extra,
].filter(Boolean).join('\n\n')

/**
 * llm(): dsh's model service (ctx.llm); connectors(): the connectors service; onCall: the workbench's log of the model
 * calls it makes itself (each request: its kind, model, time, tokens, cost, and `by` — the run and step). → { call }.
 * call({ model, system, user, schema?, temperature?, maxTokens?, retries? (2), signal, by, kind? ('model') }) →
 *   { text, data (the object, given a schema), usage: { calls, input, output, cost }, model, tries: [{ text, problems }] }
 * Throws when the model cannot be reached or never gives an answer that fits.
 */
export function createModels({ llm = () => null, connectors = () => null, onCall = null } = {}) {
  /** One request → { text, input, output, cost }. */
  async function once(m, { system, user, temperature, maxTokens, json, signal, by }) {
    if (m.source === 'dsh') {
      const service = llm()
      if (!service?.stream) throw new Error(`${m.ref}: dsh's model service is not available`)
      let text = '', finish = null, usage = null
      for await (const c of service.stream({
        provider: m.provider, model: m.model, system, signal, ...(temperature !== undefined && { temperature }), ...(maxTokens && { maxTokens }),
        messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'ruyix-workbench-model' } }],
      })) {
        if (c.type === 'text-delta') text += c.text
        else if (c.type === 'usage') usage = c.usage
        else if (c.type === 'finish') finish = c.reason
      }
      if (finish && finish.kind !== 'stop') throw new Error(`${m.ref}: ${finish.kind}${finish.failure?.message ? ` — ${finish.failure.message}` : ''}`)
      return { text, input: (usage?.inputTokens || 0) + (usage?.cacheReadTokens || 0) + (usage?.cacheWriteTokens || 0), output: usage?.outputTokens || 0, cost: 0 }
    }
    const service = connectors()
    if (!service) throw new Error(`${m.ref}: the connectors plugin is not loaded`)
    const client = service.client(m.connection, { by })
    const res = await client.request('chat/completions', {
      method: 'POST', timeout: 600000, signal,
      body: {
        model: m.model, messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
        ...(temperature !== undefined && { temperature }), ...(maxTokens && { max_tokens: maxTokens }),
        ...(json && { response_format: { type: 'json_object' } }), usage: { include: true }, // (OpenRouter: the cost comes back)
      },
    })
    if (!res.ok) throw new Error(`${m.ref}: ${m.connection} answered ${res.status} — ${String(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`)
    const body = await res.json()
    const u = body.usage || {}
    return { text: String(body.choices?.[0]?.message?.content ?? ''), input: Number(u.prompt_tokens) || 0, output: Number(u.completion_tokens) || 0, cost: Number(u.cost) || 0 }
  }

  return {
    parse: parseModelRef,
    async call({ model, system = '', user, schema, temperature, maxTokens, retries = 2, signal, by = '', kind = 'model' }) {
      const m = parseModelRef(model)
      const usage = { calls: 0, input: 0, output: 0, cost: 0 }
      const tries = []
      let prompt = schema ? `${user}\n\n${asked(schema)}` : user
      for (let i = 0; i <= retries; i++) {
        const t0 = Date.now()
        let r
        try { r = await once(m, { system, user: prompt, temperature, maxTokens, json: !!schema, signal, by }) } catch (err) {
          noteCall(onCall, { at: t0, kind, model: m.ref, ms: Date.now() - t0, ok: false, usage: null, ...(by && { by }), error: String(err?.message || err).slice(0, 300) })
          throw err
        }
        noteCall(onCall, { at: t0, kind, model: m.ref, ms: Date.now() - t0, ok: true, usage: { inputTokens: r.input, outputTokens: r.output, ...(r.cost && { cost: r.cost }) }, ...(by && { by }) })
        usage.calls++; usage.input += r.input; usage.output += r.output; usage.cost = Math.round((usage.cost + r.cost) * 1e6) / 1e6
        const text = r.text.trim()
        if (!schema) {
          if (text) return { text, usage, model: m.ref, tries: [...tries, { text, problems: [] }] }
          tries.push({ text, problems: ['the answer was empty'] })
        } else {
          let data, problems
          try { data = jsonOf(text); problems = typeOf(data) === 'object' ? checkSchema(schema, data) : ['the answer is not a JSON object'] } catch (err) { problems = [`not JSON (${err.message})`] }
          tries.push({ text, problems })
          if (!problems.length) return { text, data, usage, model: m.ref, tries }
        }
        // asked again: the question, what came back, what was wrong with it
        const last = tries.at(-1)
        prompt = `${user}\n\n## Your previous answer was not accepted\n${last.text ? `\`\`\`\n${last.text.slice(0, 20000)}\n\`\`\`` : '(empty)'}\n\nWhat was wrong:\n${last.problems.map(p => `- ${p}`).join('\n')}\n\n${schema ? asked(schema, 'Give the whole answer again, corrected.') : 'Answer again.'}`
      }
      throw Object.assign(new Error(`${m.ref}: no usable answer in ${retries + 1} tries (${tries.at(-1)?.problems.slice(0, 3).join('; ')})`), { usage, tries })
    },
  }
}
