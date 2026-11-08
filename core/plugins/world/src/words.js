// The maps' words. Names say what a place is plainly (the page's own name, 新建任务, 收件箱 · 3): the picture is the map's,
// the word is not a riddle.
export const fmt = (s, p = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m))

const zh = {
  map: '交互式桌面', capital: '主智能体', talk: '点这里说话', listening: '在听…', answering: '在回答…', mainIs: '{name}',
  running: '{n} 个任务在跑', calm: '现在没有任务在跑', waits: '{n} 件等你', empty: '没有要你处理的', newTask: '新建任务', menuApps: '应用中心', menuTasks: '任务', menuPalette: '搜索和命令', menuMaps: '换地图', menuSettings: '设置', menuAbout: '关于 Ruyix', arrange: '排好窗口', built: '构建于',
  archive: '做完的事', leave: '回到普通桌面', waitsYou: '等你：{what}', done: '做完了', failed: '没成功', next: '下次 {when} · 还有 {in}',
  working: '在做', waiting: '等你', nearer: '放大', further: '缩小', whole: '看整张图', wholeShort: '全图', other: '换一张图',
  doneN: '{n} 件做完了还没看', doneList: '做完的', justNow: '刚刚',
  voice: '说话', voiceOn: '在听，再按一下停', voiceHint: (k, toggle) => `说给主智能体听（也可以${k || '按住右边的 ⌥'} 说话${toggle ? '，说完再按一下' : ''}）`, fullOn: '全屏（⌃⌘F）', fullOff: '退出全屏（⌃⌘F）',
}
const en = {
  map: 'Interactive desk', capital: 'Main agent', talk: 'Click to talk', listening: 'Listening…', answering: 'Answering…', mainIs: '{name}',
  running: '{n} task(s) running', calm: 'No task running', waits: '{n} waiting for you', empty: 'Nothing waiting', newTask: 'New task', menuApps: 'App Center', menuTasks: 'Tasks', menuPalette: 'Search and commands', menuMaps: 'Switch map', menuSettings: 'Settings', menuAbout: 'About Ruyix', arrange: 'Arrange windows', built: 'Built',
  archive: 'Done', leave: 'Back to the desktop', waitsYou: 'Waiting for you: {what}', done: 'Done', failed: 'Did not succeed', next: 'Next {when} · in {in}',
  working: 'working on', waiting: 'waiting for you', nearer: 'Zoom in', further: 'Zoom out', whole: 'See the whole map', wholeShort: 'All', other: 'The other map',
  doneN: '{n} done, not looked at yet', doneList: 'Done', justNow: 'just now',
  voice: 'Speak', voiceOn: 'Listening — press again to stop', voiceHint: (k, toggle) => `Speak to the main agent (or ${k || 'hold the right ⌥'}${toggle ? ', and again when done' : ''})`, fullOn: 'Full screen (⌃⌘F)', fullOff: 'Leave full screen (⌃⌘F)',
}
export const WORDS = { zh: { ...zh, launchHint: '新建' }, en: { ...en, launchHint: 'Start one' } }
/** A map's words: the shared ones, its own (def.words: { zh, en }) over them. */
export const wordsFor = (lang, def) => ({ ...WORDS[lang === 'zh' ? 'zh' : 'en'], ...(def?.words?.[lang === 'zh' ? 'zh' : 'en'] || {}) })
