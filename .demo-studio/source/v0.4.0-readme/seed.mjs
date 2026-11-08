// Sample data for the README shots, in a throwaway demo home: two workflows whose steps are scripts (no model, no agent
// account), runs of them at different states, a scheduled task. Everything here is synthetic.
//   node seed.mjs <en|zh> <link-file>
import { signIn } from './api.mjs'

const [lang = 'en', linkFile] = process.argv.slice(2)
const api = await signIn(linkFile)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const T = {
  en: {
    digest: { id: 'weekly-digest', title: 'Weekly reading digest', description: 'Gather what was saved this week, draft a one-page digest, you review it, then it is filed.' },
    gather: 'Gather saved articles', draft: 'Draft the digest', review: 'Review the digest', reviewText: 'Read the digest; comment on any passage that needs work, then approve it.', results: 'Results',
    sources: `# Saved this week

| # | Title | Where | Saved |
|---|---|---|---|
| 1 | Field notes: running coding agents in a microVM | example.org/notes/microvm-agents | Mon |
| 2 | Why approval cards beat confirmation dialogs | example.org/blog/approval-cards | Tue |
| 3 | A small study of agent hand-offs between steps | example.org/papers/handoffs | Wed |
| 4 | Keeping every step of a workflow on the record | example.org/blog/hash-chain-ledger | Thu |
| 5 | Desktop widgets that show work, not decoration | example.org/design/work-widgets | Fri |
`,
    body: `# Weekly digest — local-first agents

**Five articles saved this week. The short version: let agents act, keep the person in charge of what leaves the machine.**

## What stood out

1. **Sandbox first, then freedom.** Running an agent inside a microVM lets it install, edit and break things without
   touching the host. Credentials stay outside; the box only sees placeholders.
2. **Approval as a card, not a dialog.** A card that waits in an inbox can be answered later and leaves a record;
   a modal dialog interrupts and is forgotten.
3. **Hand-offs need a shared place.** Steps that leave notes for each other repeat less work than steps that only
   pass files along.
4. **A record you can trust.** Each step appends to a hash-chained ledger, so a report can point at the evidence
   behind every claim.

## Worth trying

- Put the long-running checks on a schedule and let the desk show only what needs you.
- Review drafts where they are: comments on a passage, not in a separate chat.

## Next week

Follow up on hand-off formats; compare two ways of resuming a stopped run.
`,
    comments: [
      { quote: 'Credentials stay outside; the box only sees placeholders.', text: 'Add one sentence on how the gateway swaps the placeholder for the real key.' },
      { quote: 'Steps that leave notes for each other repeat less work', text: 'Is there a number for this? Otherwise say "in our runs".' },
    ],
    watch: { id: 'release-watch', title: 'Release watch', description: 'Check the release feeds of the tools in use and say what changed.' },
    poll: 'Check release feeds', compare: 'Compare with last week',
    feeds: '# Feeds checked\n\n- editor 1.98 → 1.99\n- runtime 22.11 → 22.12\n- three libraries unchanged\n',
    runs: ['Digest — week 45', 'Digest — week 44', 'Watch: tools in use'], briefing: 'Morning digest',
    request: 'Turn what I saved this week into a one-page digest.',
  },
  zh: {
    digest: { id: 'weekly-digest', title: '每周阅读摘要', description: '把这周收藏的文章汇总，写一页摘要，你看过以后归档。' },
    gather: '收集收藏的文章', draft: '写摘要', review: '看摘要', reviewText: '读一遍摘要，哪段要改就在那段上写意见，没问题就通过。', results: '结果',
    sources: `# 本周收藏

| # | 标题 | 来源 | 收藏于 |
|---|---|---|---|
| 1 | 实地笔记：在 microVM 里跑编程智能体 | example.org/notes/microvm-agents | 周一 |
| 2 | 为什么审批卡片比确认弹窗好 | example.org/blog/approval-cards | 周二 |
| 3 | 步骤之间的交接：一个小研究 | example.org/papers/handoffs | 周三 |
| 4 | 让工作流的每一步都留下记录 | example.org/blog/hash-chain-ledger | 周四 |
| 5 | 显示工作而不是装饰的桌面小部件 | example.org/design/work-widgets | 周五 |
`,
    body: `# 每周摘要：本地优先的智能体

**这周收藏了五篇。一句话：让智能体放手去做，离开这台机器的事由人说了算。**

## 值得记下的

1. **先有沙箱，再给自由。** 智能体跑在 microVM 里，装软件、改文件、弄坏了都碰不到宿主。
   凭据留在外面，盒子里只有占位符。
2. **审批是一张卡片，不是一个弹窗。** 收件箱里的卡片可以晚点回，还留下记录；弹窗打断你，过后就忘了。
3. **交接要有一个共用的地方。** 步骤之间互相留言，比只传文件少做很多重复的事。
4. **记录要靠得住。** 每一步都写进带哈希链的记录，报告里的每句话都能指到它的证据。

## 可以试试

- 把耗时的检查排成定时任务，桌面上只显示需要你的事。
- 在原文上审稿：意见挂在段落上，而不是另开一个对话。

## 下周

继续看交接的格式；比较两种让停下的运行接着跑的做法。
`,
    comments: [
      { quote: '凭据留在外面，盒子里只有占位符。', text: '补一句：网关在出站请求里把占位符换成真的 key。' },
      { quote: '步骤之间互相留言，比只传文件少做很多重复的事。', text: '有数字吗？没有的话写成「在我们的运行里」。' },
    ],
    watch: { id: 'release-watch', title: '版本更新追踪', description: '看在用的工具有没有新版本，说清改了什么。' },
    poll: '查各个更新源', compare: '和上周比较',
    feeds: '# 查过的更新源\n\n- 编辑器 1.98 → 1.99\n- 运行时 22.11 → 22.12\n- 另外三个库没有变\n',
    runs: ['摘要：第 45 周', '摘要：第 44 周', '追踪：在用的工具'], briefing: '早间摘要',
    request: '把我这周收藏的文章写成一页摘要。',
  },
}[lang]

const file = (name, text) => `cat > ${name} <<'EOF'\n${text}EOF`
const digest = {
  ...T.digest, base: 'blank',
  steps: [
    { use: 'intake' },
    { id: 'gather', use: 'script', title: T.gather, run: `sleep 2\n${file('sources.md', T.sources)}` },
    { id: 'draft', use: 'script', title: T.draft, run: `sleep 3\n${file('digest.md', T.body)}` },
    { id: 'review', use: 'person', ask: 'review', title: T.review, text: T.reviewText, show: ['digest.md'] },
    { id: 'results', use: 'output', title: T.results, show: ['digest.md', 'sources.md'] },
    { use: 'report' },
  ],
}
const watch = {
  ...T.watch, base: 'blank',
  steps: [
    { use: 'intake' },
    { id: 'poll', use: 'script', title: T.poll, run: `sleep 4\n${file('feeds.md', T.feeds)}` },
    { id: 'compare', use: 'script', title: T.compare, run: 'sleep 3000', timeoutMinutes: 60 },
    { use: 'report' },
  ],
}
for (const def of [digest, watch]) {
  const saved = await api.op('workflowSave', { definition: def, enable: true })
  console.log('workflow', def.id, 'errors:', JSON.stringify(saved.errors || []))
}

const runOf = async id => (await api.op('run', { id }).catch(() => null))?.run
const waitFor = async (id, ok, label, ms = 60000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(1000)) {
    const r = await runOf(id)
    if (r && ok(r)) return r
  }
  throw new Error(`timed out waiting for ${label}`)
}

// 1. last week's digest: through review (approved) to the end
const older = (await api.op('startRun', { workflow: digest.id, title: T.runs[1], text: T.request })).run
console.log('run', older.id, older.status)
await waitFor(older.id, r => r.reviews?.review?.status === 'person', 'older review')
const card1 = (await api.op('reviewOf', { id: older.id, stage: 'review' })).card
console.log('card', card1?.id, JSON.stringify(card1?.payload?.options || card1?.payload?.opts || Object.keys(card1?.payload || {})))
process.stdout.write(JSON.stringify({ older: older.id, card: card1?.id }) + '\n')
