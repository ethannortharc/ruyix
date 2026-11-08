---
name: ruyix-desktop
description: Change how this Ruyix desktop looks when the person asks — a theme, the wallpaper, the accent colour, the window tint, the interface size, density, corners, the widgets on the desk, the desktop or the classic sidebar. Use it whenever someone asks to restyle, re-theme, tidy up or personalise their Ruyix desktop. You propose; the person applies.
---

# Changing how Ruyix looks

Ruyix is a desktop in the browser (wallpaper, top bar, dock, windows, widgets). How it looks is one file,
`~/.ruyix/desktop.json`. You never write that file yourself: you **propose** a change, and the person applies it with one
click (the card at the bottom right of the Ruyix page, or Settings → Changes). Every applied change can be undone.

## How to propose

- **With a shell** (Claude Code, Codex, any agent in the box): the `ruyix desk` command.
- **As one of Ruyix's own agents** (dsh): the tools `ruyix_surfaces` (read first) and `ruyix_change_propose` with
  `{ surface: "desktop", value: {…} }`. The keys and values are the same as below.

```bash
ruyix desk                      # what it is now: the theme, every key, the file
ruyix desk themes               # the themes (the current one marked *)
ruyix desk keys                 # what each key takes
ruyix desk theme hills --summary "换成古风主题「远山」"
ruyix desk set wallpaper=aurora accent=teal --summary "极光壁纸，青色强调色"
ruyix desk set scale=1.1 density=roomy --summary "界面放大一点、宽松一些"
ruyix desk widget add note sm --summary "桌面上加一张便签"
ruyix desk widget remove note
ruyix desk reset --summary "桌面恢复默认"
```

Add `--wait 120` to wait until the person applies or discards it (exit 0: applied; 3: discarded; 4: still waiting).

## Choosing what to propose

- **A theme first.** When the person asks for a mood or a style ("make it calmer", "something Chinese classical",
  "dark and techy"), propose one of the themes: it sets the wallpaper, accent, tint and corners so they go together,
  and puts the browser in the theme's light or dark. `ruyix desk themes` lists them; the classical ones are `hills`
  (远山), `inkwash` (水墨), `bluegreen` (青绿), `moonlit` (月夜); the intelligent-looking ones `neural`, `night`, `aurora`.
- **Then single keys**, for a precise ask ("a blue accent", "bigger text"): `ruyix desk set key=value`. A theme stays
  chosen when one of its keys changes; the pickers say it was changed.
- **One intent per change**, with a `--summary` in the person's own language saying what they will see.
- Light or dark is each browser's own choice; only choosing a theme sets it. Don't propose `scale` larger than the
  person asked for: auto already fits the screen.
- Widgets: `clock`, `calendar`, `note`, `ask`, `setup`, a plugin's overview `overview:<section>`, or a plugin's own
  `<plugin>:<name>`. Sizes `sm` (half the column) and `md` (all of it).

## After proposing

Tell the person, in a sentence, what the change does and that it waits for them: "Apply" on the card at the bottom right.
If they want it gone later: `ruyix desk undo` proposes the reverse of the last change (or `ruyix desk undo <id>`; `ruyix
changes` lists them) — they apply it the same way, or undo it themselves in Settings → Changes.

Not here: credentials, plugin settings, the sidebar's order (that is the `layout` surface of `ruyix_surfaces`), and any
other file of Ruyix. Do not edit `desktop.json` by hand to skip the person's click.
