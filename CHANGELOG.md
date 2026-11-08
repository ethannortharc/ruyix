# Changelog

## 0.4.0 — 2026-11-08

The first public release.

### New

- **Video Studio.** Check local footage, cut on an editable timeline, watch a real preview, review it, and export MP4,
  subtitles and an export list. Large footage comes in from a local folder.
- **Newsletter Studio.** Sources with their evidence, an outline, a draft, a check of every paragraph against its
  sources, your review, and export to Markdown, HTML or text; editorial settings and an issue schedule.
- **Plume knows each platform.** It researches the current guidance for X, Xiaohongshu and WeChat articles with
  sources, keeps it as versioned platform knowledge (refreshed on a schedule if you like), and checks every adapted
  post against it before you review.
- **Feedback that sticks.** Rate a studio's result or one of its steps, say what to change, pick a preference.
  Preferences are kept per studio and account (or editorial setup); one confirmed on two different projects becomes a
  default; each new run keeps a snapshot; any preference can be paused or withdrawn.
- **One place for the day's work.** Runs and records are folded into the **Tasks** page: by day, by agent, usage per
  task, a **Scheduled** tab and **Metrics**. The inbox stays its own page.
- **Chat that finishes what it starts.** Longer work leaves a live task card in the chat and a closing line when it
  ends; installing or removing an app from the chat reports to its task; the main agent answers in the language you
  wrote in.
- **Desk widgets:** Tasks, Today, Agents and Box, and the box's shield in the top bar. Widgets dragged out of the
  column follow the wallpaper's tone; Find finds widgets too.
- **Open things carry names in both languages**, so the desk shows them in the page's language.
- **A new icon:** two squares set on their corners, overlapping (方胜).

### Fixed

- Many concurrency and lifecycle problems found in a full-repository review: concurrent writes to workflows, sessions
  and content files; installing and removing a runtime at once; configuration imports; queued messages after an
  abnormal restart; credential snapshots and sign-in refreshes; restarts and resumes of studio runs; publishing the
  same card twice.
- A step of your own named like a pack's step (`draft`, `review`) showed the pack's name on its run page.
- The buttons of a change card were squeezed into vertical text in Chinese.
- The interface calls the sandbox **Box** everywhere.

### Packaging

- MIT license; every package carries the `LICENSE`.
- In a box, `ruyix upgrade` also installs the plugins its release's image carries — new ones included.
- `@ruyix/workbench` declares its dependency on `@ruyix/shell`.

### Upgrading

- In a box: `ruyix upgrade --version 0.4.0` — the Video and Newsletter studios come along.
- An install from the registry outside a box upgrades the plugins it has; add a new studio with
  `ruyix plugin add @ruyix/video@0.4.0 --integrity <sha512>` (and `@ruyix/newsletter`).
- From source: `git pull` and `node tools/dev-install.mjs`.

© 2026 Ethan H.B. Zhou
