# @ruyix/world — the interactive desk

The whole desktop as one map you play on (desktop.json `mode: "world"`, `world: "atlas" | "sky" | "future"`; Settings →
General → Interface → Interactive). Three maps: the **old map** (古地图: real islands in relief on an old sea chart), the **star map** (星图: real
constellations before a great nebula) and the **future** (未来: a city at night seen from space — raised hex platforms
in its districts, highways from the core, holo-rings for tasks, drones for agents). None puts a picture or a name on its
places: pointing at one lights it and shows its name; the buttons low on the right also hold voice input and the whole
screen. Design: `docs/design/world.md`.
**Make your own**: `MAKE-A-MAP.md` and `template/` (a plugin that registers one definition; `@ruyix/world/kit`).

- **Every page is a place**: the conversation (the main agent) is the capital / the sun; the runs page the harbour / the
  star port; the inbox the post station / the beacon (with its count); workflows the library / a constellation; agents
  the guild / the fleet; apps the workshop town / a ringed planet; connectors the ferry's lighthouse / a relay satellite;
  the box the fort / a shield; records the archive / a star catalogue; settings the compass / the observatory. A page no
  one knows yet (another plugin's) becomes a village / a small planet wearing its own icon. The ship / the nursery of gas
  starts a new task; the stele / the ring gate goes back to the ordinary desktop; the cartouche shows the date and time
  (a click: ⌘K). Names are the pages' own, plainly (「应用」「收件箱 · 3」): the picture is the map's, the word is not a riddle.
- **What is at work is on the map**: each task an island (a ring) in the southern sea, its steps the stations of a road
  round it — done ones inked, the one at work vermilion (glowing), a vermilion seal (amber) where it waits for the person;
  its agents banners (stars) on the road, travelling to the next station; messages couriers (meteors); a task just done
  stamped (flaring green); scheduled ones islands in the fog (faint rings) in the east with when they run next.
- **The work list** (the shell's `window.__ruyixWork`: runs, the pool's tasks, sessions) is what the islands, rings and
  platforms show — waiting, at work, queued and gone wrong (the old map crosses its station out in red, the future turns
  its segment red), its agents on it; a click opens it (its `open` event). What is done and not looked at lights the
  records' place (Ireland, Leo, the archive platform: a soft green ring, its count on pointing); a click there lists
  them. The activity's runs are still read until the workbench puts its runs in the list.
- **Looking round**: drag to move, scroll or pinch to zoom round the pointer, double-click to go nearer, the arrow keys,
  `+` `-`, `0` for the whole map; the buttons low on the right (nearer, further, all of it, the other map).
- **Pages open in the map's own frame**: the windows get the old map's paper border or the star map's glow
  (`.ad-root[data-world]`); the page inside is as ever. ⌘K, the conversation, voice and notifications work as on the desk.

- **The old map** is an archipelago of real islands (`src/islands.js`, Made with Natural Earth: the main agent Great
  Britain, tasks Sicily, the inbox Iceland, workflows Crete, agents Taiwan, apps Sri Lanka, connections Cyprus, the box
  Corsica, records Ireland, the way back Tasmania; other pages Hainan, Hokkaido, Sardinia…), read in the scene from a
  picture of their shores' distances (one texture fetch a pixel), found by the pointer by their shape; in relief
  (lit from the upper left: warm slopes, cool shade, contour lines, hachures, a bright rim on the shore facing the light,
  its shadow on the water), green or ochre, sea routes to the capital, on old paper (fibres, foxing, three folds, a
  browned edge, a double frame, laid lines, water stains); the sea deeper away from the shores, dotted soundings along
  them, the rhumb lines of three wind roses. A name shows on pointing, written by hand.
- **The future** is a night city seen from space: districts of street lights thickening round each place, each district's
  streets its own way, avenues between them, a dark river; highways from the core with traffic on them; each place a
  raised hex platform (lit west faces, rows of windows, a glass top).
- **The star map** makes each place a real constellation, its stars where they are in the sky, as bright and as coloured
  as they are (`src/constellations.js`: the main agent Polaris and the Little Dipper, tasks the Big Dipper, a new task
  the Pleiades in their blue haze, the inbox Lyra — amber and pulsing when something waits —, workflows Cassiopeia,
  agents Orion with his nebula, apps Cygnus, connections Gemini, the box the Great Square of Pegasus, records Leo,
  settings the Southern Cross, the way back Corona Borealis; other plugins' pages Scorpius, Taurus, Aquila…). Their lines
  are faint, brighter on the one the pointer is on; no pictures, and a name only when one points. Behind them a great
  nebula: deep red hydrogen, a teal heart, a blue cloud lit by its stars, dark dust, breathing slowly. Tasks are
  constellations too: a star per step on a faint ring.
- **The pages wear the map** while it is the desk: its `theme` (tokens.css colours, lines, surfaces, accent, corners) goes
  on <body> — the old map's paper and ink with a vermilion accent, the star map's cool blues; the person's own light or
  dark stays (forcing one would leave dsh's own surfaces in the other).
- **A map of your own**: a definition for `registerWorld(def)` (`src/register.jsx`; `@ruyix/world/kit` for another
  plugin — World and the shared styles, not this plugin's own maps):
  `{ id, name, tone, scene, icons, words?, road?, below?, land?, figures?, css?, theme? }` — `src/atlas.jsx` and `src/sky.jsx`
  are two.

How: the shell draws no bar, dock, widgets or wallpaper in this mode, only the map a plugin registers in
`window.__ruyixWorlds` (`[{ id, name: { zh, en }, tone, render }]`, event `ruyix:worlds`), and hands it an `api` (the
pages and their counts, open one, talk, a new task, settings, ⌘K, back to the desktop, the other map). The ground is the
shell's own wallpaper engine (`api.createWallpaper(canvas, { scenes })`, so no map's plugin carries a copy) with its
scene (`src/scenes.js`:
the view `uV`, the places `uMark` / `uMarkB`, the tasks, agents and messages as the agents' wallpapers have them); the
places' pictures (`src/icons.jsx`), names and counts are HTML over it that follows the view. Where things go:
`src/layout.js` (checked in `check.mjs`). The main agent's name: the workbench's `chatActions`; listening / answering:
the desk's voice state and `window.__ruyixChat`.

© 2026 Ethan H.B. Zhou
