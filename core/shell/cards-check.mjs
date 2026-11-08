// The cards (src/cards/spec.js, cards-tool.js): every example checks as it is; what is wrong is said with where; only the
// fields of a card's type are kept; the tool says what to fix; an answer is said back in the person's words.
import assert from 'node:assert/strict'
import { ANSWER_EVENT, CARD_TYPES, EXAMPLES, answerText, checkCards } from './src/cards/spec.js'
import { cardsTool } from './cards-tool.js'

assert.deepEqual(EXAMPLES.map(e => e.type).sort(), Object.keys(CARD_TYPES).sort(), 'an example of each type')
for (const e of EXAMPLES) { const r = checkCards({ cards: [e] }); assert.deepEqual(r.errors, [], `${e.type}: ${JSON.stringify(r.errors)}`); assert.deepEqual(r.cards[0], e, `${e.type} kept as it is`) }
const said = r => r.errors.map(e => `${e.path}: ${e.message}`)
const bad = checkCards({ cards: [
  { type: 'weather', place: 'X', now: { temp: 'warm', sky: 'sunny' } },
  { type: 'link', url: 'javascript:alert(1)', title: 'x' },
  { type: 'choice', question: '?', options: [{ label: 'only one' }] },
  { type: 'time', zones: [{ zone: 'Mars/Base' }] },
  { type: 'note', text: 'fine' },
] })
assert.deepEqual(said(bad), [
  'cards[0].now.temp: a number', 'cards[0].now.sky: one of clear, partly, cloudy, rain, showers, storm, snow, fog, wind, night',
  'cards[1].url: a web address, http(s)://…', 'cards[2].options: at least 2', 'cards[3].zones[0].zone: an IANA time zone, e.g. Asia/Shanghai',
])
assert.deepEqual(bad.cards, [{ type: 'note', text: 'fine' }], 'only the ones that check are drawn')
assert.deepEqual(said(checkCards({ cards: [
  { type: 'file', name: 'a.md', url: '//evil.example/a.md' },
  { type: 'file', name: 'a.md' },
  { type: 'chart', data: [] },
  { type: 'note', text: 'ok', colour: 'red' },
] })), [
  "cards[0].url: a link of this page's own (api/… or /…)", "cards[1]: a file is a run's (run, path), a session's (session, path) or a link of this page's own (url)",
  'cards[2].type: one of weather, time, link, video, list, table, stat, note, choice, confirm, file, task', 'cards[3].colour: no such field (text)',
])
assert.equal(checkCards({ cards: Array(7).fill({ type: 'note', text: 'x' }) }).errors[0].message, '1 to 6 cards')
assert.deepEqual(checkCards({ type: 'note', text: 'one card alone' }).cards.length, 1, 'one card, not in a list: taken')
assert.equal(checkCards({ cards: [] }).errors[0].message, '1 to 6 cards')
// the tool: shown, or what to fix
const tool = cardsTool()
assert.equal(tool.effect, 'read')
assert.match(tool.description, /link: a web page to open[\s\S]*fields: url, title, text\?, site\?, image\?/)
assert.match((await tool.run({ cards: [EXAMPLES[0], EXAMPLES[2]] })).text, /^Shown: weather, link\. The person sees it now: add at most two short sentences/)
assert.match((await tool.run({ cards: [{ type: 'link', title: 'no url' }] })).text, /^Not shown — fix and call again:\n- cards\[0\]\.url: needed/)
// the answers, as the person's reply
assert.equal(ANSWER_EVENT, 'ruyix:card-answer')
assert.equal(answerText({ type: 'choice', values: ['小周', '工作号'] }), '小周、工作号')
assert.equal(answerText({ type: 'confirm', value: 'ok' }), '好了')
assert.equal(answerText({ type: 'confirm', value: 'revise', text: '标题短一点' }), '再改：标题短一点')
assert.equal(answerText({ type: 'confirm', value: 'revise', text: 'shorter' }, 'en'), 'Change it: shorter')
console.log('cards check: ok')
