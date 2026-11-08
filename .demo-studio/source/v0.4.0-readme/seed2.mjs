// Second half of the sample data (after seed.mjs): approve last week's digest (choice 0 = approve, as the card does),
// start this week's and leave it at the review with two comments, start the long release watch, add a scheduled task.
//   node seed2.mjs <en|zh> <link-file> <older-run-id> <older-card-id>
import { signIn } from './api.mjs'

const [lang, linkFile, olderId, cardId] = process.argv.slice(2)
const api = await signIn(linkFile)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const L = {
  en: { runs: ['Digest — week 45', 'Watch: tools in use'], briefing: 'Morning digest', request: 'Turn what I saved this week into a one-page digest.', watchReq: 'Tell me what changed in the tools I use.',
    comments: [
      { quote: 'Credentials stay outside; the box only sees placeholders.', text: 'Add one sentence on how the gateway swaps the placeholder for the real key.' },
      { quote: 'Steps that leave notes for each other repeat less work than steps that only\n   pass files along.', text: 'Is there a number for this? Otherwise say "in our runs".' },
    ] },
  zh: { runs: ['摘要：第 45 周', '追踪：在用的工具'], briefing: '早间摘要', request: '把我这周收藏的文章写成一页摘要。', watchReq: '告诉我在用的工具有什么更新。',
    comments: [
      { quote: '凭据留在外面，盒子里只有占位符。', text: '补一句：网关在出站请求里把占位符换成真的 key。' },
      { quote: '步骤之间互相留言，比只传文件少做很多重复的事。', text: '有数字吗？没有的话写成「在我们的运行里」。' },
    ] },
}[lang]
const runOf = async id => (await api.op('run', { id }).catch(() => null))?.run
const waitFor = async (id, ok, label, ms = 90000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(1000)) { const r = await runOf(id); if (r && ok(r)) return r }
  throw new Error(`timed out waiting for ${label}`)
}

await api.op('approve', { id: cardId, payload: { choice: 0 } })
const older = await waitFor(olderId, r => ['done', 'failed', 'stopped'].includes(r.status) || r.status === 'waiting', 'older to finish')
console.log('older', older.id, older.status, older.verdict || '')

const now = (await api.op('startRun', { workflow: 'weekly-digest', title: L.runs[0], text: L.request })).run
await waitFor(now.id, r => r.reviews?.review?.status === 'person', 'review')
const view = (await api.op('reviewOf', { id: now.id, stage: 'review' })).review
const comments = L.comments.map((c, i) => ({ id: `c${i + 1}`, file: 'digest.md', at: { quote: c.quote }, text: c.text }))
const saved = await api.op('reviewSave', { id: now.id, stage: 'review', comments, revision: view.commentsRevision })
console.log('review', now.id, 'comments', saved.review.comments.length)

const watch = (await api.op('startRun', { workflow: 'release-watch', title: L.runs[1], text: L.watchReq })).run
await waitFor(watch.id, r => r.stages?.some(s => s.key === 'compare' && s.status === 'running') || r.current === 'compare', 'watch to reach compare', 30000).catch(e => console.log(e.message))
console.log('watch', watch.id)

const task = await api.op('taskCreate', { title: L.briefing, workflow: 'weekly-digest', text: L.request, schedule: { kind: 'daily', at: '08:00' }, tz: 'America/Los_Angeles' })
console.log('task', JSON.stringify(task).slice(0, 160))
console.log(JSON.stringify({ now: now.id, watch: watch.id }))
