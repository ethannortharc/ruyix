// The main agent's `ui_card` (docs/design/agent-tasks.md「回答要看得见」): an answer shown as cards — the weather, a link
// to open, a choice to click, a result to accept — checked here (src/cards/spec.js) before the conversation draws it; one
// that does not check comes back with what to fix. It only shows: nothing is done, so it is a looking tool for the record.
import { CARD_TYPES, checkCards } from './src/cards/spec.js'

const said = (zh, en) => ({ zh, en })
const fieldsText = fields => Object.entries(fields).map(([k, f]) => `${k}${f.need ? '' : '?'}${f.type === 'object' ? ` {${fieldsText(f.fields)}}` : f.type === 'list' ? `[${f.of.type === 'object' ? `{${fieldsText(f.of.fields)}}` : f.of.type}]` : f.type === 'enum' ? `(${f.values.join('|')})` : ''}`).join(', ')

export const cardsTool = () => ({
  name: 'ui_card',
  title: said('给出卡片', 'Show cards'),
  effect: 'read',
  chat: true, // (cards show in the conversation: not offered to agents outside it)
  description: 'Show the result of what the person asked as cards in the conversation — end an exchange with one when it fits, and keep the words around it to a line or two. '
    + 'A web page or site to open ("打开 YouTube"): a link card — the person\'s click opens it in their own browser (you cannot open it for them). '
    + 'A question for the person: a choice card — never ask in plain text when there are options. '
    + 'Work that made something: a confirm card with what to look at (the person says 好了 or what to change). '
    + 'Times and dates are the person\'s (the [Now: …] line). Types — '
    + Object.entries(CARD_TYPES).map(([t, d]) => `${t}: ${d.use}; fields: ${fieldsText(d.fields)}`).join(' · ')
    + '. Every card may have a title.',
  parameters: { type: 'object', additionalProperties: false, required: ['cards'], properties: { cards: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object' } } } },
  async run(args) {
    const { cards, errors } = checkCards(args)
    if (errors.length) return { text: `Not shown${cards.length ? ` (${cards.length} of them were fine)` : ''} — fix and call again:\n${errors.slice(0, 12).map(e => `- ${e.path}: ${e.message}`).join('\n')}` }
    // (its answer is what the model reads before its own words: the card says it — the words only add what it does not)
    return { text: `Shown: ${cards.map(c => c.type).join(', ')}. The person sees it now: add at most two short sentences, and do not repeat what the card shows.` }
  },
})
