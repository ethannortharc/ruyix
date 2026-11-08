// Plume 工作室 (docs/design/studio.md): the line from an idea to a post on 小红书, X and 公众号 — the ideas waiting to
// be written, the accounts (personas) that write them, the posts that came of them (the runs of plume.post), the
// materials. Registered with the `ruyixStudio` service (index.js) when the studio plugin is on; without it, Plume works
// as before, from its settings.
// The accounts take over settings.packs.plume (style, brand, X, the connections): the first one is made from them,
// once; the settings stay as they are for a release (the run falls back to them when it has no account).
import { DEFAULTS } from './pack.js'
export { settingsFromAccount } from './lib/account.js'

const PLATFORMS = [{ value: 'xhs', label: '小红书' }, { value: 'x', label: 'X' }, { value: 'wechat_mp', label: '公众号' }]

/** The first account, from Plume's settings as they are (nothing set: none — the person makes one). */
export function accountFromSettings(s) {
  const st = { ...DEFAULTS.style, ...(s?.style || {}) }, brand = { ...DEFAULTS.brand, ...(s?.brand || {}) }, x = { ...DEFAULTS.x, ...(s?.x || {}) }, conns = { ...DEFAULTS.accounts, ...(s?.accounts || {}) }
  const anything = st.name || st.positioning || st.guide || brand.signature || brand.accent !== DEFAULTS.brand.accent || brand.background !== DEFAULTS.brand.background || x.premium || x.cover || st.language !== DEFAULTS.style.language || conns.x !== DEFAULTS.accounts.x || conns.xhs !== DEFAULTS.accounts.xhs
  if (!anything) return null
  return {
    name: st.name || '我的账号', positioning: st.positioning || null, guide: st.guide || null, language: st.language || DEFAULTS.style.language,
    accent: brand.accent, background: brand.background, signature: brand.signature || null,
    xPremium: !!x.premium, xCover: !!x.cover, xConnection: conns.x || 'x', xhsConnection: conns.xhs || 'xhs',
  }
}

export const studio = {
  id: 'plume',
  name: { zh: 'Plume 工作室', en: 'Plume Studio' },
  icon: 'Feather',
  collections: {
    ideas: {
      title: { zh: '选题', en: 'Ideas' },
      fields: [
        { name: 'title', type: 'text', label: { zh: '题目', en: 'Title' }, required: true },
        { name: 'notes', type: 'textarea', label: { zh: '想法和要点', en: 'Notes' } },
        { name: 'audience', type: 'textarea', label: { zh: '本篇写给谁', en: 'Audience for this piece' }, hint: { zh: '读者已有的知识、关心的问题、读完后的行动', en: 'What readers know, need answered, and should do next' } },
        { name: 'references', type: 'textarea', label: { zh: '参考链接', en: 'Reference links' }, hint: { zh: '每行一个链接；需要读取网页时打开「先调研」', en: 'One URL per line; enable research to read the pages' } },
        { name: 'materials', type: 'file', multiple: true, label: { zh: '参考资料（不会作为配图发布）', en: 'Reference materials (not published as images)' } },
        { name: 'account', type: 'ref:accounts', label: { zh: '用哪个账号', en: 'Account' } },
        { name: 'platforms', type: 'tags', label: { zh: '发到', en: 'Platforms' }, options: PLATFORMS, default: ['xhs', 'x', 'wechat_mp'] },
        { name: 'research', type: 'bool', label: { zh: '先调研', en: 'Research first' }, default: false },
        { name: 'images', type: 'image', multiple: true, label: { zh: '配图', en: 'Images' } },
        { name: 'when', type: 'datetime', label: { zh: '计划发布', en: 'Planned for' } },
        { name: 'status', type: 'status', label: { zh: '状态', en: 'Status' }, default: 'idea', values: [
          { value: 'idea', label: { zh: '想到', en: 'Idea' }, tone: 'neutral' },
          { value: 'writing', label: { zh: '在写', en: 'Writing' }, tone: 'progress' },
          { value: 'ready', label: { zh: '待发布', en: 'Ready to publish' }, tone: 'info' },
          { value: 'posted', label: { zh: '已发', en: 'Posted' }, tone: 'success' },
          { value: 'dropped', label: { zh: '放下了', en: 'Dropped' }, tone: 'neutral' },
        ] },
      ],
    },
    accounts: {
      title: { zh: '账号', en: 'Accounts' },
      fields: [
        { name: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, required: true },
        { name: 'positioning', type: 'textarea', label: { zh: '定位', en: 'Positioning' }, hint: { zh: '写给谁、讲什么、什么口吻', en: 'Who it writes for, about what, in what voice' } },
        { name: 'guide', type: 'textarea', label: { zh: '风格指南', en: 'Style guide' } },
        { name: 'language', type: 'text', label: { zh: '语言', en: 'Language' }, default: DEFAULTS.style.language },
        { name: 'accent', type: 'color', label: { zh: '主色', en: 'Accent' }, default: DEFAULTS.brand.accent },
        { name: 'background', type: 'color', label: { zh: '卡片底色', en: 'Card background' }, default: DEFAULTS.brand.background },
        { name: 'signature', type: 'text', label: { zh: '署名', en: 'Signature' } },
        { name: 'xPremium', type: 'bool', label: { zh: 'X 是 Premium（能发长帖）', en: 'X Premium (long posts)' }, default: false },
        { name: 'xCover', type: 'bool', label: { zh: 'X 第一条带宽封面', en: 'Wide cover on the first X post' }, default: false },
        { name: 'xConnection', type: 'text', label: { zh: 'X 用哪个连接', en: 'X connection' }, default: DEFAULTS.accounts.x },
        { name: 'xhsConnection', type: 'text', label: { zh: '小红书用哪个连接', en: '小红书 connection' }, default: DEFAULTS.accounts.xhs },
      ],
    },
    posts: { title: { zh: '成品', en: 'Posts' }, runs: 'plume.post' },
  },
  materials: { kinds: ['image', 'markdown', 'pdf'] },
  views: { knowledge: { title: { zh: '平台资料', en: 'Platform knowledge' } } },
  start: [{
    id: 'write', label: { zh: '写一条', en: 'Write a post' }, workflow: 'plume.post', from: 'ideas', allowedStatuses: ['idea'], showForm: true, title: 'title', text: 'notes',
    fields: { platforms: 'platforms', research: 'research', images: 'images', account: 'account', audience: 'audience', references: 'references', materials: 'materials' },
    // (a run stopped or not done: the idea goes back to 想到, to be picked again — not left 在写 for ever)
    status: { start: 'writing', done: 'ready', failed: 'idea' },
  }],
  home: [
    'start', 'working',
    { view: 'own:knowledge', size: 'full' },
    { view: 'board', collection: 'ideas', by: 'status' },
    { view: 'list', collection: 'posts' },
    { view: 'library' },
    { view: 'calendar', collection: 'ideas', at: 'when' },
    { view: 'form', collection: 'accounts' },
    'history',
  ],
  // its planned time come (when), an idea not posted yet waits for the person on the desk: to write it, or to publish it
  remind: [{ collection: 'ideas', at: 'when', unless: ['posted', 'dropped'] }],
  seed: ({ packSettings }) => { const a = accountFromSettings(packSettings('plume')); return { accounts: a ? [a] : [] } },
}
