// The future map (未来): a city of light seen from above — the definition registerWorld takes (main.jsx). Its ground:
// future-scene.js. Every page a raised platform with its own light, the main agent the core, conduits from it to each.
import css from './future.css'
import { FUTURE } from './future-scene.js'

const S = { viewBox: '0 0 64 64', fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }

export const FUTURE_ICONS = {
  // the core: a hexagon, a heart, two orbits
  capital: <svg {...S}><path d="M32 6l22 13v26L32 58 10 45V19z" /><circle cx="32" cy="32" r="6" /><path d="M20 26a14 14 0 0 1 24 0M44 38a14 14 0 0 1-24 0" /></svg>,
  // the tasks: a dock of three slots, the work queued in it
  harbor: <svg {...S}><rect x="12" y="12" width="40" height="40" rx="4" /><path d="M20 22h24M20 32h24M20 42h14" /><path d="M46 40l4 2-4 2" /></svg>,
  // a new task: a launch ring, a plus at its heart
  launch: <svg {...S}><circle cx="32" cy="32" r="22" strokeDasharray="4 5" /><circle cx="32" cy="32" r="13" /><path d="M32 25v14M25 32h14" /></svg>,
  // the inbox: a signal tower sending
  post: <svg {...S}><path d="M32 30v26M24 56l8-18 8 18" /><circle cx="32" cy="26" r="4" /><path d="M23 17a13 13 0 0 1 18 0M17 11a21 21 0 0 1 30 0" /></svg>,
  // the workflows: nodes joined in a graph
  library: <svg {...S}><circle cx="14" cy="18" r="5" /><circle cx="50" cy="18" r="5" /><circle cx="32" cy="46" r="5" /><path d="M19 18h26M17 22l12 20M47 22L35 42" /></svg>,
  // the agents: three drones in formation
  guild: <svg {...S}><path d="M32 8l7 7-7 7-7-7zM16 34l7 7-7 7-7-7zM48 34l7 7-7 7-7-7z" /><path d="M32 22v8M22 38l6-6M42 38l-6-6" /></svg>,
  // the apps: a grid of four
  workshop: <svg {...S}><rect x="12" y="12" width="16" height="16" rx="3" /><rect x="36" y="12" width="16" height="16" rx="3" /><rect x="12" y="36" width="16" height="16" rx="3" /><rect x="36" y="36" width="16" height="16" rx="5" /></svg>,
  // the connections: two links joined
  port: <svg {...S}><rect x="8" y="24" width="24" height="16" rx="8" /><rect x="32" y="24" width="24" height="16" rx="8" /><path d="M24 32h16" /></svg>,
  // the box: a cube
  fort: <svg {...S}><path d="M32 8l22 12v24L32 56 10 44V20z" /><path d="M10 20l22 12 22-12M32 32v24" /></svg>,
  // the records: stacked disks
  archive: <svg {...S}><ellipse cx="32" cy="16" rx="18" ry="6" /><path d="M14 16v32c0 3 8 6 18 6s18-3 18-6V16" /><path d="M14 27c0 3 8 6 18 6s18-3 18-6M14 38c0 3 8 6 18 6s18-3 18-6" /></svg>,
  // the settings: three sliders
  settings: <svg {...S}><path d="M12 18h40M12 32h40M12 46h40" /><circle cx="24" cy="18" r="4" /><circle cx="42" cy="32" r="4" /><circle cx="30" cy="46" r="4" /></svg>,
  // back to the desktop: a doorway, an arrow out
  gate: <svg {...S}><path d="M26 10H12v44h14" /><path d="M30 32h24M46 24l8 8-8 8" /></svg>,
  village: <svg {...S}><path d="M32 10l19 11v22L32 54 13 43V21z" /></svg>,
}

export const future = {
  id: 'future', name: { zh: '未来', en: 'Future' }, tone: 'dark',
  blurb: { zh: '从太空看夜里的城市：每个页面一个街区，车流就是在跑的工作', en: 'A city at night seen from space: each page a district, the traffic the work going on' },
  scene: FUTURE, icons: FUTURE_ICONS, css,
  words: { zh: { launchHint: '启动一个新任务' }, en: { launchHint: 'Launch a task' } },
  road: 1, // its agents' drones on the task's ring
  below: 1.16,
  // the pages while it is the desk: cool glass, a cyan accent, sharper corners — in the person's own light or dark
  theme: {
    tokens: {
      '--ruyix-accent': ['#0b8aa3', '#38d9f0'], '--ruyix-title': ['#0c1f2b', '#e6fbff'], '--ruyix-text': ['#1b3140', '#cfe9f0'],
      '--ruyix-text-muted': ['#40606f', '#97b9c4'], '--ruyix-text-dim': ['#557282', '#7f9fab'],
      '--ruyix-line': ['#d2e2e9', '#163039'], '--ruyix-line-strong': ['#afc8d3', '#22495a'],
      '--ruyix-canvas': ['#eff5f8', '#050d14'], '--ruyix-chrome': ['#e5eef2', '#040a10'], '--ruyix-surface': ['#ffffff', '#0a1720'],
      '--ruyix-surface-sunk': ['#e8f1f5', '#07121a'], '--ruyix-hover': ['#deebf1', '#10242f'], '--ruyix-radius-k': '0.55',
    },
  },
}
