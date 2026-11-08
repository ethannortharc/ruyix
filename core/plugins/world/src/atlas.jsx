// The old map (古地图): real islands in ink on old paper — the definition registerWorld takes (register.jsx). Its ground:
// scenes.js ATLAS; its islands: islands.js.
import css from './atlas.css'
import { ATLAS_ICONS } from './icons.jsx'
import { ATLAS } from './scenes.js'

export const atlas = {
  id: 'atlas', name: { zh: '古地图', en: 'Old map' }, tone: 'light',
  blurb: { zh: '一张老航海图：每个页面是一座真实的岛，任务是南边海上的小岛', en: 'An old sea chart: each page a real island, tasks the small isles in the southern sea' },
  scene: ATLAS, icons: ATLAS_ICONS, css,
  words: { zh: { launchHint: '扬帆出海' }, en: { launchHint: 'Set sail' } },
  isles: true, // each place a real island (islands.js), its shore as it is
  // each place its own island, this wide (world units; no land: at sea; times its island's scale) — an archipelago
  land: { capital: 0.25, harbor: 0.15, post: 0.15, library: 0.16, guild: 0.15, workshop: 0.15, port: 0.14, fort: 0.14, archive: 0.15, gate: 0.13, village: 0.13, launch: 0, settings: 0, clock: 0 },
  road: 0.62, // its agents' banners on the road round an island (a share of its radius)
  below: 1.55, // a task's words below its island (its shore reaches out to about 1.5 radii)
  // the pages while it is the desk: old paper, ink, a vermilion accent; crisper corners
  theme: {
    tokens: {
      '--ruyix-accent': ['#a3321f', '#ff9b87'], '--ruyix-title': ['#2b2014', '#f2e6cc'], '--ruyix-text': ['#3a2c1e', '#e8dcc2'],
      '--ruyix-text-muted': ['#5e4b35', '#cbbd9f'], '--ruyix-text-dim': ['#6b5842', '#b3a585'],
      '--ruyix-line': ['#dccfb0', '#4c4334'], '--ruyix-line-strong': ['#c2b08a', '#635743'],
      '--ruyix-canvas': ['#efe5cb', '#2a241c'], '--ruyix-chrome': ['#e6d9b8', '#231e17'], '--ruyix-surface': ['#faf4e2', '#332b22'],
      '--ruyix-surface-sunk': ['#ece1c4', '#2d261e'], '--ruyix-hover': ['#e9ddbe', '#3d3428'], '--ruyix-radius-k': '0.7',
    },
  },
}
