// A map of my own for the interactive desk: its definition, registered while the plugin is on. The places, the tasks,
// the agents, looking round, the names, opening pages — all of that is @ruyix/world's (World); a map is how it looks.
import { registerWorld, SKY_ICONS } from '@ruyix/world/kit'
import { BLUEPRINT } from './scene.js'
import css from './map.css'

export const blueprint = {
  id: 'blueprint', // unique among the maps; also .wd-blueprint and data-world="blueprint" in the css
  name: { zh: '蓝图', en: 'Blueprint' }, // shown in Settings → Interactive and on the "other map" button
  tone: 'dark', // the ground is dark: names in light letters
  scene: BLUEPRINT, // the ground: a fragment shader (scene.js)
  icons: SKY_ICONS, // a picture per kind of place (line drawings; any SVG); here the star map's, drawn white
  css, // the names, the buttons, the windows' frame
  words: { zh: { launchHint: '画一张新图' }, en: { launchHint: 'Draw a new one' } }, // over the shared words
  road: 1, // where agents sit on a task's ring (1: on it)
  below: 1.15, // a task's words this many radii below its ring
  // the pages while this map is the desk: a blueprint blue accent, crisp corners; both values readable (light, dark)
  theme: { tokens: { '--ruyix-accent': ['#1f5fbf', '#8cb8ff'], '--ruyix-radius-k': '0.5' } },
}

export function apply(ctx) {
  ctx.effect(() => registerWorld(blueprint), 'blueprint: the map')
}
