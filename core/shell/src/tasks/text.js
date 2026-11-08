// 「任务」's and the portfolio's words.
import { money } from '../money.js'
const ago = (lang, ms) => {
  if (!ms) return ''
  const m = Math.round((Date.now() - ms) / 60000)
  if (lang === 'zh') return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}
const DAY = 864e5
const dayOf = (lang, ms) => {
  const d = new Date(ms), today = new Date(), start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (ms >= start) return lang === 'zh' ? '今天' : 'Today'
  if (ms >= start - DAY) return lang === 'zh' ? '昨天' : 'Yesterday'
  const year = d.getFullYear() !== today.getFullYear() && { year: 'numeric' }
  return lang === 'zh' ? d.toLocaleDateString('zh-CN', { ...year, month: 'long', day: 'numeric', weekday: 'short' }) : d.toLocaleDateString('en-US', { ...year, weekday: 'short', month: 'short', day: 'numeric' })
}
const tokens = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)))
const took = (lang, ms) => {
  const s = Math.round(ms / 1000), m = Math.round(s / 60), h = Math.floor(m / 60)
  if (lang === 'zh') return s < 60 ? `${s} 秒` : m < 60 ? `${m} 分钟` : `${h} 小时${m % 60 ? ` ${m % 60} 分` : ''}`
  return s < 60 ? `${s} s` : m < 60 ? `${m} min` : `${h} h${m % 60 ? ` ${m % 60} min` : ''}`
}
/** What a task used, in one short line: its tokens, what it cost, how long it took (what is known of them). */
const usageOf = (lang, u) => !u ? '' : [u.tokens > 0 && `${tokens(u.tokens)} token`, u.cost > 0 && money(u.cost), u.ms > 0 && took(lang, u.ms)].filter(Boolean).join(' · ')
export const TEXT = {
  zh: {
    tasks: '任务', works: '作品集', newTask: '新建任务', close: '关上', agent: '智能体', anyAgent: '所有智能体', usage: '用量', noRun: '没找到这次运行属于哪件任务', search: '找…', all: '全部', none: '这里还没有', loading: '正在读…', failed: '没读到：', retry: '再试一次', more: '再看一些',
    tabs: { active: '在做', waiting: '等你', 'to-confirm': '待确认', done: '完成', ended: '没做成', archived: '归档' },
    states: { queued: '排队', working: '在做', waiting: '等你', 'to-confirm': '待确认', done: '完成', failed: '没做成', stopped: '停了' },
    sources: { chat: '对话', session: '会话', job: '池子任务', run: '工作流', studio: '工作室', schedule: '定时' },
    source: '来源', studio: '工作室', anyStudio: '所有工作室', anySource: '所有来源',
    pick: '在左边挑一件看它的经过和做出的东西', ok: '好了', revise: '再改', revisePh: '要改什么？一句话', send: '发送', cancel: '取消',
    archive: '归档', unarchive: '拿出归档', remove: '删除', removeAgain: '再点一下删除', removed: '删掉了', done: '好了，完成了', revised: '已请它再改',
    waitingFor: '等你', goThere: '去处理', timeline: '经过', outputs: '做出来的', noOutputs: '还没有做出东西', noTimeline: '还没有经过',
    started: '开始', updated: '更新', ended: '结束', agents: '谁在做', outputsN: n => `${n} 件`,
    who: { person: '你', agent: '智能体', system: '系统', main: '主智能体' },
    kinds: { file: '文件', draft: '稿子', post: '帖子', report: '报告', image: '图片', video: '视频', card: '卡片', answer: '回答' },
    fromTask: '来自', openTask: '在「任务」里看这件', noTask: '不属于哪件任务', otherCategory: '其他', withArchived: '含已归档', groupBy: '怎么分', groupByKind: { task: '按任务', category: '按类别' },
    ago: ms => ago('zh', ms), day: ms => dayOf('zh', ms), used: u => usageOf('zh', u),
  },
  en: {
    tasks: 'Tasks', works: 'Portfolio', newTask: 'New task', close: 'Close', agent: 'Agent', anyAgent: 'All agents', usage: 'Usage', noRun: 'No task found for that run', search: 'Find…', all: 'All', none: 'Nothing here yet', loading: 'Loading…', failed: 'Could not load: ', retry: 'Try again', more: 'Show more',
    tabs: { active: 'At work', waiting: 'Waiting for you', 'to-confirm': 'To confirm', done: 'Done', ended: 'Did not work', archived: 'Archived' },
    states: { queued: 'Queued', working: 'At work', waiting: 'Waiting for you', 'to-confirm': 'To confirm', done: 'Done', failed: 'Did not work', stopped: 'Stopped' },
    sources: { chat: 'Conversation', session: 'Session', job: 'Pool task', run: 'Workflow', studio: 'Studio', schedule: 'Scheduled' },
    source: 'Source', studio: 'Studio', anyStudio: 'All studios', anySource: 'All sources',
    pick: 'Pick one on the left to see how it went and what it made', ok: 'OK', revise: 'Change it', revisePh: 'What should change? One line', send: 'Send', cancel: 'Cancel',
    archive: 'Archive', unarchive: 'Unarchive', remove: 'Delete', removeAgain: 'Click again to delete', removed: 'Deleted', done: 'OK — done', revised: 'Asked to change it',
    waitingFor: 'Waiting for you', goThere: 'Go to it', timeline: 'How it went', outputs: 'What it made', noOutputs: 'Nothing made yet', noTimeline: 'Nothing yet',
    started: 'Started', updated: 'Updated', ended: 'Ended', agents: 'Who', outputsN: n => `${n} made`,
    who: { person: 'You', agent: 'Agent', system: 'System', main: 'Main agent' },
    kinds: { file: 'Files', draft: 'Drafts', post: 'Posts', report: 'Reports', image: 'Images', video: 'Videos', card: 'Cards', answer: 'Answers' },
    fromTask: 'From', openTask: 'Open it in Tasks', noTask: 'Not of a task', otherCategory: 'Other', withArchived: 'With archived', groupBy: 'Group by', groupByKind: { task: 'By task', category: 'By kind of task' },
    ago: ms => ago('en', ms), day: ms => dayOf('en', ms), used: u => usageOf('en', u),
  },
}
export const textOf = lang => TEXT[lang] || TEXT.en
