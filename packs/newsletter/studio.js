import { DEFAULTS } from './pack.js'
const L = (en, zh) => ({ en, zh })
export const studio = {
  id: 'newsletter', name: L('Newsletter Studio', 'Newsletter 工作室'), icon: 'Newspaper',
  collections: {
    issues: { title: L('Issue queue', '选题队列'), fields: [
      { name: 'title', type: 'text', label: L('Topic', '主题'), required: true },
      { name: 'notes', type: 'textarea', label: L('Brief and reader promise', '写作要求与读者价值') },
      { name: 'references', type: 'textarea', label: L('Reference URLs (one per line)', '参考链接（每行一个）') },
      { name: 'materials', type: 'file', multiple: true, label: L('Source documents', '参考资料') },
      { name: 'timeframe', type: 'text', label: L('Coverage period', '调研时间范围'), default: 'Last 7 days' },
      { name: 'profile', type: 'ref:profiles', label: L('Editorial profile', '编辑设定') },
      { name: 'length', type: 'select', label: L('Reading length', '阅读长度'), default: 'standard', options: [{ value: 'brief', label: L('Brief · 3–5 min', '简报 · 3–5 分钟') }, { value: 'standard', label: L('Standard · 5–8 min', '标准 · 5–8 分钟') }, { value: 'deep', label: L('In depth · 10–15 min', '深度 · 10–15 分钟') }] },
      { name: 'when', type: 'datetime', label: L('Planned for', '计划时间') },
      { name: 'status', type: 'status', label: L('Status', '状态'), default: 'idea', values: [
        { value: 'idea', label: L('Idea', '待写'), tone: 'neutral' }, { value: 'writing', label: L('Researching / writing', '调研 / 写作'), tone: 'progress' },
        { value: 'ready', label: L('Approved exports', '已审并导出'), tone: 'success' }, { value: 'archived', label: L('Archived', '已归档'), tone: 'neutral' },
      ] },
    ] },
    profiles: { title: L('Editorial profiles', '编辑设定'), fields: [
      { name: 'name', type: 'text', label: L('Name', '名称'), required: true },
      { name: 'audience', type: 'textarea', label: L('Who reads this?', '目标读者'), default: DEFAULTS.audience },
      { name: 'voice', type: 'textarea', label: L('Voice and editorial rules', '文风与编辑规则'), default: DEFAULTS.voice },
      { name: 'language', type: 'text', label: L('Language', '语言'), default: DEFAULTS.language },
      { name: 'sourcePolicy', type: 'textarea', label: L('Source policy', '来源要求'), default: DEFAULTS.sourcePolicy },
    ] },
    sources: { title: L('Source desk', '来源库'), fields: [
      { name: 'title', type: 'text', label: L('Source name', '来源名称'), required: true },
      { name: 'links', type: 'links', label: L('URLs', '链接') }, { name: 'notes', type: 'textarea', label: L('Coverage and reliability notes', '覆盖范围与可靠性备注') },
      { name: 'topics', type: 'tags', label: L('Topics', '主题标签') },
    ] },
    editions: { title: L('Issues and exports', '稿件与导出'), runs: 'newsletter.issue' },
  },
  materials: { kinds: ['markdown', 'text', 'html', 'json', 'pdf'] },
  start: [{ id: 'write', label: L('Research and write', '调研并写作'), workflow: 'newsletter.issue', from: 'issues', showForm: true, title: 'title', text: 'notes', fields: { materials: 'materials', references: 'references', timeframe: 'timeframe', profile: 'profile', length: 'length' }, status: { start: 'writing', done: 'ready', failed: 'idea' } }],
  home: ['start', 'working', { view: 'board', collection: 'issues', by: 'status' }, { view: 'list', collection: 'editions' }, { view: 'calendar', collection: 'issues', at: 'when' }, { view: 'form', collection: 'profiles' }, { view: 'list', collection: 'sources' }, { view: 'library' }, 'history'],
  remind: [{ collection: 'issues', at: 'when', unless: ['ready', 'archived'] }],
}
