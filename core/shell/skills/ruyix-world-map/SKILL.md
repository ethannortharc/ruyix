---
name: ruyix-world-map
description: Make a new map for Ruyix's interactive desk (交互式桌面) when the person wants their own look — a style, a theme, a picture of their work as a city, a garden, a circuit, a sea chart. The map is a small dsh plugin with one definition (a shader for the ground, a picture per place, its styles, the colours the pages take on); everything else — the places, tasks, agents, zooming, opening pages — is @ruyix/world's.
---

# Making a map for the interactive desk

The interactive desk (Settings → General → Interface → Interactive) shows the whole desk as one map. Every page, every task
at work and every agent is a place on it. Ruyix has three maps: `atlas` (古地图), `sky` (星图) and `future` (未来). A new one is
a plugin that registers a **definition** with `@ruyix/world`. The full guide is `MAKE-A-MAP.md` in the `@ruyix/world` package.
Read it first: it explains every field and every value the shader is given.

## Where things are

- The `@ruyix/world` package is in the dsh profile's `node_modules/@ruyix/world/` (in a box: `~/.dsh/profiles/ruyix/node_modules/@ruyix/world/`).
- Start from `template/` there: a working plugin that draws a blueprint. Copy it to a new folder; don't edit it in place.
- To see how the maps that ship are done: `src/future.jsx` + `src/future-scene.js`, `src/sky.jsx` + `src/scenes.js`, `src/atlas.jsx`.

## Steps

1. **Agree on the look in words first.** One or two sentences with the person: the ground, what a place looks like, the
   colours, light or dark. Name the map plainly (「蓝图」「花园」), never with a riddle.
2. Copy `template/` and change these: `package.json`'s `name` (`@<their scope>/world-<id>`), `cordis.patch.yml`, and in
   `src/main.jsx` the `id`, `name`, `words` and `theme`.
3. Write the ground in `src/scene.js`. Keep the uniform declarations exactly as the template has them, and draw in world
   units (`w`, `px`). Draw only the ground: the places' pictures and names are page elements laid over it. Keep what you
   draw under a place a ring bigger than its picture, so the name below it stays readable.
4. Pick or draw the pictures: `icons` is one SVG per kind (capital, harbor, launch, post, library, guild, workshop, port,
   fort, archive, settings, gate, village). `ATLAS_ICONS` and `SKY_ICONS` from `@ruyix/world/kit` can be used as they are.
5. Style it in `src/map.css`: `.wd-<id>` for the names and buttons, `.ad-root[data-world="<id>"]` for the windows' frame.
6. `theme`: give each token two values, `[light, dark]`, and keep both readable. Never force dark.
7. `npm install && node build.mjs`. It must build without errors.
8. **Installing is the person's step.** A plugin is added from an npm registry with its sha512 checked:
   `npm publish` to their registry, then they run (or approve) `ruyix plugin add @scope/world-<id>@<version> --integrity
   sha512-… --registry <url>`. Tell them exactly what to run. Do not install it any other way, and do not copy files
   into the profile's `node_modules`.
9. Once it is on, they pick it in Settings → General → Interface → Interactive → 哪张图. If they see only a soft gradient
   instead of the map, the shader did not compile. The browser console says why, in a line starting
   `ruyix wallpaper world-<id>:`. Fix it and build again.

## Keep in mind

- It is drawn every frame for every pixel. Keep loops to the ones the template has (places, tasks, agents, links), and
  keep `fps` low (15–30).
- Motion should loop (`sin`, `fract`): `t` only grows.
- Names on the map are the pages' own (「应用」「收件箱 · 3」). The picture can be playful, but the words say what a place is.
- A map changes only how the desk looks. It never changes what the places do.
