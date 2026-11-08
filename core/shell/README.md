# @ruyix/shell

The shell of **Ruyix** over dsh's web client: it gives dsh and the plugins one identity and shape, and carries the
`ruyix` command that installs, runs and upgrades it (see the repo's README).

- **Desktop** (`src/desktop/`, the default; `desktop.js` is what it can be): Ruyix as an operating system in the
  browser. dsh shows one page at a time; the desktop makes that page a **window** (a title bar to move it, edges to size
  it, lights to close it to the desk, minimize it, zoom it; double-click the title bar to zoom) on a **wallpaper** (six
  drawn by one GPU shader, four of them slowly moving, plus a plain one), with a quiet clock and **widgets** (the setup
  while it is not done, each plugin's overview). Above, the **top bar**: this Ruyix's menu (who it is, its versions,
  Settings, the language, the classic sidebar), the page in the window, what is at work, search, the conversation, the
  appearance (light/dark, wallpaper, accent, motion, glass) and the time. Plugins put an indicator of their own in its
  tray: `window.__ruyixTray = [{ id, order?, render({ lang }) }]` and a `ruyix:tray` event (render draws its button and
  its own menu under it; one that throws is left out) — the workbench's shows the work in progress. Below, the **dock**: every page in the
  sidebar's groups, the one in the window marked (a tile lifts a little on hover, inside the dock's own padding, its name
  drawn above the dock). **⌘K** opens the command palette: pages, settings, the look, the window — and anything else is
  a question for the agent (plugins add items through `window.__ruyixPalette`). The **conversation** is a sheet on the
  right that stays open across pages: the workbench draws it into the slot `ruyix.chat` the desktop declares;
  `ruyix:chat` opens it, `ruyix:chat-ask` `{ text }` asks. `ruyix:notify` `{ title, text?, panel? }` shows a
  notification. A plugin's sidebar entry may say how many wait for it: `window.__ruyixNav[id].badge()` (a dock badge);
  the dock draws each entry's own icon with what its registration injects, so a badge the icon draws itself shows too.
  **Other windows**: a plugin opens a window beside the page window with `window.__ruyixDesk.open({ id, title, icon,
  Content, props, size, onClose })` (`close`, `focus`, `has`; window event `ruyix:desk` when it comes or goes; absent in
  classic mode; an agent places them with the page action `ruyix:desk-window` `{ win | page, action: front | max | min |
  restore | close | tile, wins? }`, `win` being `main` for the page window or an open thing's `win`; desktop.json `windows`:
  `auto` (the default) lays the windows in view out by themselves, side by side and never over each other — one fills
  the room, two halves, three a big one and two stacked, four a 2×2, beyond four the least used in a drawer at the right —
  except one the person moved or sized, until 「排好窗口」 (the desk's and the map's right-click menu, ⌘K, window event
  `ruyix:arrange`); `free`: where they open) — one per id, stacked with the page window (a click brings one to the front), a dock tile each, where it
  was remembered per id (`src/desktop/windows.jsx`). The App Center opens Linux apps this way.
- **Voice input** (`src/desktop/voice.js`, Host `voice.js`): hold its key and speak — the right ⌥ alone unless set
  otherwise in Settings → General → Voice input (`voice-key.js`: a modifier key alone, F1–F24 or a key with Ctrl/⌥/⌘;
  held, or pressed once to start and again to end; kept in `voice.json`, the page publishes its words in
  `window.__ruyixVoiceKey`) — or press the microphone in the top bar; let go and the words go where you were typing (inserted as typed: the page's own handlers
  see them), or open ⌘K when there is nothing to type into. The browser records 16 kHz mono WAV; `POST /api/ruyix/voice`
  sends it through a connection (type http) to an OpenAI-compatible `/audio/transcriptions` — file, model, language, as
  Fonos sends it, so the omlx Qwen3-ASR Fonos uses on this Mac answers both. `~/.ruyix/voice.json` `{ connection, model,
  language }` (Settings → General → Voice input); nothing set: the first connection whose models include a speech model.
  How it looks is this Ruyix's surface `desktop.json` (`{ mode, wallpaper, motion, accent, glass, scale }`): set in
  Settings → General (the size also in the top bar's appearance menu), proposed by an agent like any surface; where the
  window is (shown, zoomed, its rect and the desk size it was set on, the sheet) is each browser's own.
- **Widgets** (`src/desktop/widgets.jsx`): on the desk's right, a column of two widths (small: half, medium: all) —
  the setup while it is open, a clock, a calendar, notes (their text in `~/.ruyix/notes.json`, `GET/POST
  /api/ruyix/notes`, written as typed and so not a surface), a question for the assistant, each plugin's overview section
  (`overview:<section>`), and a plugin's own: it adds `{ type: '<plugin>:<name>', name: { zh, en }, sizes, render }` to
  `window.__ruyixWidgetDefs` and fires `ruyix:widget` (`render` gets `{ size, lang, preview }`; the App Center adds
  `apps:launcher`). `desktop.json`'s `widgets` (`[{ id, type, size, at? }]`, null: the default set) is the column's order; each
  can be dragged anywhere on the desk and resized by its corner (kept as its `at`), and dropped back on the column. Edit them
  from a right click on the desk, ⌘K or the button under the column: − removes, a gallery adds. The main agent is the line
  above the dock (src/desktop/agentbar.jsx). Their glass
  follows the wallpaper's tone (dark glass on a dark wallpaper), so a new wallpaper never leaves them grey; their shadows
  are small and the column's padding holds them (a shadow cut at a scroll box's edge shows as a dark box).
- **The interactive desk** (desktop.json `mode: "world"`, `world`: which map; `src/desktop/worlds.js`): a third way to be,
  beside the desktop and the classic sidebar — the whole desk one map a plugin draws (`core/plugins/world`: the old map, the
  star map), every page a place on it. The shell then draws no bar, dock, widgets, clock or wallpaper, only the map
  (`window.__ruyixWorlds`, event `ruyix:worlds`; without such a plugin: the desktop) and hands it an `api`: the pages
  (name, icon, count — `window.__ruyixNav[id].count()`, see src/nav.js), open one, talk (the conversation), a new task,
  settings, ⌘K, back to the desktop, the other map, and the wallpaper engine (`api.createWallpaper`, so a map's plugin
  carries none); the windows, ⌘K, the conversation, voice and notifications as ever. `createWallpaper(canvas, { scenes })`
  takes a plugin's own scenes (`@ruyix/shell/wallpaper`), with a view (`uV`) and places (`uMark`, `uMarkB`); `set({ fast })` draws
  every frame while one drags or zooms. A map's `theme` (`{ scheme?, tokens: { '--ruyix-…': [light, dark] } }`;
  `themeCssOf` in `src/desktop/worlds.js`) goes on <body> while it is the desk, after the desk's own, so the pages follow
  the map's look. The map also gets voice input (`api.listen()`) and the whole screen (`api.fullscreen`: { on, toggle }
  or null) — the top bar's, which this mode has not. A scene may carry its own data picture (`tex: { uName: () =>
  ({ width, height, data }) }`, one byte a pixel, texture units 1…; the old map's island distances).
- **The marks of the work going on** (`src/desktop/workmark.jsx`, docs/design/sessions.md §3): `<WorkMark item>` — a point
  and a ring of the steps, the same everywhere in the theme's colours (done segments lit, a light running along the one at
  work, amber blinking where it waits for the person, red and broken where it went wrong, a flash at each pulse, growing
  to 1.3× with the work done, a bloom when it finishes); read from the work list (`src/work.js`, `useWork()`), opened by
  its `open` event (`openWork`). On the classic desk the work going on stands left of the dock (its title, state, step and
  time on pointing), what is done and not looked at in a tray right of it (「做完的」: a click lists them, one opens it).
- **The open things, gathered** (`src/desktop/groups.jsx`; the list is `src/open.js`, how it groups `open-model.js`): a card
  for each group in a column at the desk's (or the map's) left — the work's mark when the group is a run, a task or a
  session, the kinds in it and how many; pointing at one lists what is in it (one opens it) and offers to pin it. A click
  lays the group's windows out side by side beside the column (`tileRects` in `src/desktop/store.js`; with the page window
  when a page is in it) and puts the other groups' windows away (a pinned group stays as it is); a click on the group in
  front puts it away. Groups whose windows went unused for 45 minutes put themselves away (never the one in front, never
  the page window). The column is behind the windows, and comes in front of them while pointed at.
- **Window transparency** (desktop.json `transparency: off | light | strong`, Settings → Appearance and the top bar's look
  menu; never with `glass` off): open windows and the conversation show the desk or map through them — their grounds a
  share of themselves (html[data-ruyix-see] re-points the --ruyix-* and dsh's --dsw-alias-bg-* grounds inside the windows),
  the desk behind softened once by the page's frame; cards a little more solid; dialogs, menus and lists (by their role)
  solid.
- **Sharp wallpapers** (`src/desktop/wallpaper.js`): every scene draws at the screen's own pixels (a Retina or 4K
  screen's too — drawn at fewer and stretched, a scene looks soft); when a scene is shown, one frame is timed and only a
  GPU that cannot draw it within about 9 ms gets fewer pixels (at least half). `uP` (how many of the scene's pixels make
  one of the page's) keeps sizes the same on every screen, sharper on a dense one.
- **The agents' desk** (wallpaper `sky`, 星图, in the intelligence group; `src/desktop/sky.jsx`): the agents at work are
  drawn into the wallpaper itself. A nebula that breathes and flickers (deep blue, dark red, gold); each task at work a
  ring of its steps (done ones lit, the one at work glowing, amber and breathing while it waits for the person), its
  agents stars on it (a ring goes out at each thing one does; it travels round the ring to the next step), messages
  meteors between them, a task just done flaring green, scheduled ones faint dotted rings saying when they run next.
  Over it, words (the task, its step, how long, or what it waits for) and places to click (a ring or its words: the task;
  a star: what that agent does); with no task, a hint and a way to start one; a legend at the bottom. Rings go on the
  free part of the desk (not under the widgets, the clock, the bar or the dock). The wallpaper reads the frame's data from
  `set({ data })` (scenes with `data: true`; uniforms `uTask`, `uTaskB`, `uStar`, `uStarB`, `uLink`, `uLinkB`, `uN`);
  the lights over the desk (below) give way to it.
- **Agents at work, on the desk** (`src/desktop/agents.jsx`): each agent working on a run is a light over the
  wallpaper (Claude warm orange, Codex blue, a DeepSeek or other agent violet, a script grey), the agents of one run
  near each other and linked; each thing it does (a tool, a command, a model call) sends a ring out of it (red when it
  failed), a light travels along an arc from one step's agent to the next's when the run moves on, and messages run as
  beads along a dotted line; one waiting for the person glows amber. A chip at each light (its icon, or a simple face)
  says who it is and what it does on hover and opens the run on a click (its cards when it waits). `desktop.json`'s
  `agents`: `icon` (the default), `light` (no chips), `face`, `off`. What it draws is `window.__ruyixActivity` (`{ agents:
  [{ id, kind, name, run, title, step, state: working | waiting, pulse? }], links: [{ from, to, kind: together | handoff |
  message }] }`, event `ruyix:activity`), which the workbench keeps; a plugin adds links of its own (agents messaging
  each other) through `window.__ruyixActivityLinks` and the event `ruyix:activity-links`. The agents at work also
  liven the intelligence wallpapers a little. Cost: one canvas, glows copied from sprites drawn once, at most about 30
  frames a second while something works, none while nothing does or the page is hidden; with less motion asked for
  (the system's or `motion: false`), a still picture redrawn when something changes. On a light wallpaper the lights are
  laid over it instead of added to it, so they do not wash out. (dsh draws corners as superellipses — `corner-shape` —
  so a circle says `corner-shape: round`.)
- **Interface size** (`scale`: `auto`, 0.9, 1, 1.1, 1.25, 1.5; `scaleOf` in `desktop.js`): the desktop (`.ad-root`) and the
  page window's contents (dsh's frame) are zoomed by `--ruyix-scale` (on body); the desk is measured in the zoomed
  pixels (`--ad-vw`, `--ad-vh`; a `vw` would be the screen's, zoomed once more), the pointer divided by it. `auto`: 1 up to
  a laptop's screen, more on a large one (2560 × 1440: about 1.25), at most 1.4. A Linux app's display is not zoomed (it
  is drawn pixel for pixel; its app is told the size instead). The page window adapts: a small desk is all window, a wide
  one keeps the widgets' column in view; a moved window is moved and sized in proportion when the browser grows or
  shrinks. `mode: classic` (or `?ruyix-safe=1`) is the plain sidebar below, with the conversation behind a round
  button. Drawn into the page's body from dsh's overlay layer; dsh's frame is moved and sized by `html[data-ruyix-desk]`
  rules, its grid without the sidebar (`--ruyix-cols`).
- **Brand**: the mark (同心方胜: two squares on their corners overlapping, the overlap filled — the traditional 方胜 pattern, in
  vermilion on black; `mark.js`:
  `MARK_SVG` flat for the page, `MARK_ICON_SVG` with a little light for the installed app, drawn to the PNGs in `assets/`) and the name in the sidebar (replacing dsh's: `cordis.patch.yml` disables
  `ui-brand-official`), on the conversation's start page, the browser title and icon.
- **Sidebar**: the plugins' entries grouped as Workbench · Apps · Agents · System · Sandbox (below); who this Ruyix is
  and its version (and the box's) at the foot. A page a plugin folds into another (`window.__ruyixNav[id] = { into,
  land? }`: the runs and the records into 「任务」) leaves the list, the dock and the pages an agent opens; opened or
  selected anyhow, the other page shows, what was asked kept (a run: its task). A window shorter than the list scrolls the list between the brand and
  the foot. dsh's New Session and session list are gone: talking to an agent is each page's assistant.
- **Settings** (`src/settings.jsx`, Host side `settings.js`): the one page for what a person sets — General (language,
  theme, text size, this Ruyix's name and colour), Models (the providers dsh's agents and the AI helpers run on: keys,
  models fetched from the endpoint, dsh's default model), each plugin's own tab (the slot `ruyix.settings.tab`, with the
  id of its own sidebar entry, which then leaves the list: the connections are one), Plugins (which load; those added
  with `ruyix plugin add`), Changes (below) and Platform (shell, agent loop, subagents, web search). It reads and writes
  what dsh's own pages did (its settings and credentials services). Another panel opens a tab with the window event
  `ruyix-settings:open` `{ tab }` (the page tells the host its tabs with its pages: what an agent can open).
- **「任务」 and the portfolio** (`src/tasks/`; docs/design/agent-tasks.md, work-in-one-place.md): 「任务」 is one page for
  the day's work — every task an agent did or does, by state, the days apart, found by words, source, studio and agent;
  one chosen shows how it went, what it made and what it used. Other plugins put their parts in through the slots it
  hosts (each entry with an id): `ruyix.tasks.part` (`{ task, lang, reload }`, drawn in a task's detail — nothing when
  the task is not theirs), `ruyix.tasks.tab` (`{ id, order, label, count? }`: a tab of its own, such as 定时; `count(counts)` the number on it) and
  `ruyix.tasks.new` (`{ onClose, lang, preset }`: the 新建任务 form, in a sheet over the page). `ruyix:open`
  `{ panel: 'ruyix-tasks', task | run | tab | view: 'new', … }` lands there. A task card (@ruyix/shell/cards) reads its
  task while it goes on (`src/cards/live.js`): the conversation shows what it is doing, then how it ended.
- **Sign-in page**: a browser that is not signed in gets Ruyix's page (zh/en, light/dark) instead of dsh's plain text:
  paste the link `ruyix link` prints, or its token. dsh has no seat for it, so the Host side replaces its browser
  auth's `writeUnauthorized` while the shell runs; a dsh that renames it shows its own text again.
- **Opening**: while a required setup step is open, Ruyix opens on Home (`src/start.jsx`) and lists it; once the setup
  is done Home leaves the sidebar and Ruyix opens on what waits on you (the inbox).
- **Home**: the setup while it is not done (each plugin's steps), then what needs you and how the agents do (each
  plugin's overview), the setup folded under one line; a configuration file to import or export (`ruyix config`).
- **Versions**: the foot shows ours and dsh's; ours is this package's `version`, dsh's is read from the dsh package that
  started the process (`GET /api/ruyix/version`, `ruyix status`).
- **Live reload**: dsh's plugin manager reloads plugins in place and takes the shell's added elements with it; the shell
  watches the page, puts them back and regroups.

## Semantic tokens

The system style — the design code every page follows, its dials (interface size, density, corners) and its rules — is
[docs/design/system-style.md](../../docs/design/system-style.md). `node check.mjs` refuses a raw font size or corner.

`tokens.css` names the design once — `--ruyix-accent` (the Ruyix's teal) · `accent-alt` (the second hue of gradients,
decoration only) · `success` · `warning` · `warning-soft` · `danger` · `highlight`, `--ruyix-title` · `text` · `text-muted`
· `text-dim`, `--ruyix-line` · `line-strong`, `--ruyix-canvas` · `chrome` · `surface` · `surface-sunk` · `hover` ·
`selection`, the corners `--ruyix-radius-xs` · `sm` · `radius` · `lg` · `pill`, and the material — `--ruyix-control` · `control-hover` ·
`control-lift` · `control-press` (a button: a face lit from above, a hairline edge, a small shadow; pressed, it sinks),
`--ruyix-primary` · `primary-hover` · `primary-lift` · `primary-press` · `on-primary` (the one action, in the accent; in
dark a deeper shade with white words), `--ruyix-focus`, `--ruyix-card-lift`, `--ruyix-field`. Every page's buttons and
cards use these, so they look alike and follow the accent. Light and dark follow dsh's theme; the
defaults sit in `:where(body)`, so a plain `body { --ruyix-accent: … }` (or a theme, below) overrides one Ruyix-wide.

Every plugin bundles the file with its stylesheet (it looks the same with the shell off) and styles with these names
only: `node check.mjs` fails on a direct dsh alias for a meaning the tokens name, or a `--ruyix-*` the file does not define.

## Layers and groups

1. **dsh** — the frame, its components and its colour tokens (`--dsw-*`).
2. **this shell** — the only plugin that styles anything outside its own panel. Off, it is plain dsh again.
3. **the plugins** (the workbench, the connections, Agent Hub, the box, the apps) — each styles only its own panels,
   with the tokens, and joins the sidebar with one number: its entry's `order`.

| `order` | Group |
|---|---|
| 10–19 | Workbench (home 10, inbox, runs, workflows) |
| 20–29 | Apps (each app's pages, boards) |
| 30–39 | Agents (Agent Hub) |
| 40–49 | System (Skills 41, the App Center 42, the connections 43, Settings 49 at the foot) |
| 50–59 | Sandbox (the box: only in a nookbox box) |
| outside | not listed: an entry outside every group, or one that is a Settings tab too |

The shell orders the rows and captions the first present entry of each group (`src/nav.js`). dsh keeps only an
entry's `id`, `order` and `label`; what else the shell should know of it goes in `window.__ruyixNav[id]`: `for: ['…']`
(shown only for those presets) and `shown()` (false: nothing to show now).

## What a Ruyix is for, what it loads, who it is

`~/.ruyix/layout.json` (`GET|POST /api/ruyix/layout`):

- **its preset**: one a part brings (`ruyixShell.preset({ id, name, dashboards? })`), picked in Settings → Plugins; none
  yet, so `default`. A part, a setup step, an overview section or a sidebar entry for other presets (`for: [...]`) is left
  out; a step required only for some (`requiredFor: [...]`) is optional elsewhere.
- **its plugins**: each is on unless its package says `"ruyix": { "default": "off" }` or the layout says otherwise; the
  base (shell, connections, workbench, Agent Hub, boards, box, App Center) is always on. `ruyix plugin list | enable | disable |
  default <name>` and Settings → Plugins change it; `ruyix start` writes the profile's bundles from it every time.
- **who it is**: a name (Settings → General), the box it runs in (else the machine) and a colour — before Ruyix's name in
  the browser tab, as a dot on the tab's icon, and in the foot, so several Ruyix instances open side by side are told apart.

## What an agent may change in it (surfaces)

`surfaces.js`: an agent changes this Ruyix itself only through its **surfaces**, each a file in `~/.ruyix` with its own
check — `layout` (the sidebar's order within each group and hidden entries, the name and colour), `theme` (`theme.json`:
the colour tokens of `tokens.css`, colours only, text at 4.5:1 or more against its ground) and `boards`
(`boards/my-*.json`: a personal board over the built-in datasets and its own). Every change is a **change set** in
`~/.ruyix/changes`. The agent proposes (`ruyix_surfaces`, `ruyix_change_propose`, `ruyix_change_undo`, `ruyix_changes`,
on every dsh agent); **only the person applies**, on the card at the bottom of every page (`src/pending.jsx`) or Settings
→ Changes. `ruyix changes [show <id> | undo [<id>] | restore <id>]` is for a page hard to use: it never applies a
proposal, only goes back. Writers take turns through a lock the kernel holds (`lock.js`) and commit through `commit.js`
(crash-safe), so nothing is left half done. `?ruyix-safe=1` opens a tab without the theme, the sidebar's order or the
personal boards. Keeping agents' shells out of `~/.ruyix` is dsh's sandbox's part, not this journal's.

## Cards: answers the person can see

`src/cards/spec.js` (`@ruyix/shell/cards-spec`, plain JS): the cards an agent ends an exchange with — weather, time,
link, video, list, table, stat, note, choice, confirm, file, task (`CARD_TYPES`, one of each in `EXAMPLES`) — and their
check (`checkCards`). The main agent shows them with the system tool `ui_card` (`cards-tool.js`): checked first, what is
wrong said back. A link or a video opens in the person's own browser on their click; a choice or a confirm is answered
through the renderer's `onAnswer`, or the window event `ruyix:card-answer`, and said in the person's words
(`answerText`). The renderer (`src/cards/`) draws them the same in the conversation, the main agent's strip and the desk.
Checked by `cards-check.mjs`.

## What a plugin offers the shell

A plugin joins with `ruyixShell.part({ id, name: { en, zh }, panel, order, optional?, for?, busy?, setup?, overview?,
imported?, workbench? })`:

- `busy()` → what a dsh restart would cut short now; `ruyix restart` and `ruyix upgrade` wait for every list to be empty
  (`GET /api/ruyix/busy`).
- `setup()` → `[{ id, order, required, ready, title, detail, panel? | open? }]`: its steps on Home (`GET /api/ruyix/setup`).
- `overview()` → its sections of tiles on Home (`GET /api/ruyix/overview`).
- `workbench.aiWork` → the AI work done here (the box's Insights reads it).

## The ruyix command

`bin/ruyix`: install (from a release registry, `RUYIX_REGISTRY`; from source it is `tools/dev-install.mjs`), start / stop
/ restart / status / link, upgrade, setup, plugin add / remove / list / enable / disable, check, config export / import
(`bin/ruyix-config.mjs`, version 2: workspaces, settings, agents, connections with their credentials as nookbox secrets,
never a value), changes, data export / import. Start and stop verify the running Ruyix's identity, profile, process
owner and start time; an occupied port alone never authorizes a signal. Restart and upgrade wait for nothing to be at
work (`--force` cuts it short); upgrade snapshots the profile and restores it when install, setup or start fails.

`node build.mjs` (src/ → client.js); `node check.mjs` (the groups, the tokens, the sign-in page, setup and layout, the
settings routes; then the CLI, data, config and surfaces checks).

History import validates every part and destination before moving this home’s files aside. Database files must be regular files; links must be relative and resolve within the exported part. Relative internal links are preserved during export and import. Overlapping destinations and links outside the archive’s copied data are refused.

Import checks and rewrites the staged databases before changing this profile. An Agent Hub or studio-only archive leaves its conversation alone. If a later copy fails, files already moved aside are restored. JSON path values are rewritten after decoding, including Windows paths.
