// The star map (星图): real constellations before a great nebula — the definition registerWorld takes (register.jsx).
// Its ground: scenes.js SKY; its figures: constellations.js.
import css from './sky.css'
import { SKY_ICONS } from './icons.jsx'
import { SKY } from './scenes.js'

export const sky = {
  id: 'sky', name: { zh: '星图', en: 'Star map' }, tone: 'dark',
  blurb: { zh: '夜空里的星座：每个页面一个星座，智能体在做事时星星亮起', en: 'Constellations in the night sky: each page one, stars lighting up as the agents work' },
  scene: SKY, icons: SKY_ICONS, css,
  words: { zh: { launchHint: '点亮一颗新星' }, en: { launchHint: 'Light a new star' } },
  figures: { r: 0.1 }, // each place a real constellation (constellations.js), this wide (times its own size)
  road: 1, // its agents' stars on the task's ring
  below: 1.12,
  // the pages while it is the desk: cool, a starlight accent — in the person's own light or dark (forcing dark leaves
  // dsh's own surfaces light: half a page unreadable)
  theme: {
    tokens: {
      '--ruyix-accent': ['#2b63d9', '#8fb8ff'], '--ruyix-title': ['#1a2347', '#eef2ff'], '--ruyix-text': ['#2a3358', '#d8e0fb'],
      '--ruyix-text-muted': ['#4a5682', '#aab6de'], '--ruyix-text-dim': ['#56628f', '#8f9bc6'],
      '--ruyix-line': ['#d9def0', '#283158'], '--ruyix-line-strong': ['#bcc5e6', '#37437a'],
      '--ruyix-canvas': ['#f1f3fb', '#0c1124'], '--ruyix-chrome': ['#e8ecf8', '#0a0e1e'], '--ruyix-surface': ['#ffffff', '#131a33'],
      '--ruyix-surface-sunk': ['#eceff9', '#0f152b'], '--ruyix-hover': ['#e4e9f7', '#1c2548'],
    },
  },
}
