# @ruyix/apps

The **App Center** (应用中心): Linux software for the nookbox box this Ruyix runs in. One click installs it; a graphical
app opens as a window on Ruyix's desktop, and so does the terminal — drawn in the page itself, not over VNC.

- **The catalog** (`lib/catalog.js`): apps picked by hand, every package from Debian trixie's main archive for arm64 and
  amd64 — but zellij, which the image carries (below). Terminals: **终端** (tmux) and **终端（Zellij）**. Graphical apps — GNOME's own where there is one (GTK 4 and libadwaita: a modern look, light and dark):
  terminal (GNOME Console), files (GNOME Files), text editor (GNOME Text Editor), calculator, PDF viewer (Papers), image
  viewer (Loupe); and the light Xfce ones (xterm, Thunar, Mousepad), code editor (Geany), LibreOffice (one entry:
  Writer, Calc and Impress share one LibreOffice process; with its GTK 3 face, always light), Firefox ESR, GIMP,
  Inkscape. Command-line tools — FFmpeg, ImageMagick, yt-dlp, Pandoc, poppler-utils, Tesseract (with Simplified
  Chinese), ripgrep, Git LFS, jq, SQLite. Anything else installs **by package name** (`^[a-z0-9][a-z0-9+.-]{1,63}$`,
  1–24 at a time).
- **Installed?** `dpkg-query -W` (no root needed).
- **Installing**: nookbox does it — `POST $NOOKBOX_API/v1/packages {packages}` (nookbox 0.5.10 or later): apt as root
  from the image's own sources, kept in the box's spec so a rebuilt box has them too. The box user never has root. Only
  when the box's spec allows it (`self_install`); otherwise the page shows the host command,
  `nookbox update <box> --self-install true` (or `nookbox install <box> <packages>`). An install takes minutes: it is
  a job the page polls, one apt run at a time, the others waiting in order; `busy()` lists them, so `ruyix restart` and
  `ruyix upgrade` wait for them. Outside a box nothing installs and the page says so.
- **Uninstall** (卸载, Ethan 2026-10-17): an installed app's card has 「卸载」 (a second click says yes). nookbox 0.5.11
  (`POST nookbox.internal/v1/packages/remove`) takes out what it installed — the app's own packages and the dependencies
  only they needed — and drops them from the box's spec, so a rebuild does not bring them back; no rebuild, no restart.
  Never the image's own (an app with no packages of its own, or `image: true`; nookbox refuses those too), never a
  package another installed app or the display uses; the person's files and settings stay; the app's windows close
  first. The main agent's `apps_uninstall` (direct: the person asked; undo: install again) and `apps_install`'s undo.
- **A graphical app** runs on a virtual display of its own (`lib/display.js`): `Xvnc :N` (from `:10`, VNC port 5900+N,
  127.0.0.1 only, no password), `matchbox-window-manager -use_titlebar no` (the app's window fills the display; the
  Ruyix window around it is the frame), then the app (in its own session bus with `dbus-run-session` when there is
  one), all as the box user with `DISPLAY=:N`. The app exiting ends the session (the window manager and Xvnc are
  stopped); so does Xvnc dying, closing the window, or the plugin going (dsh stopping). One session per app; several
  apps at once. The image carries the display's packages (`tigervnc-standalone-server`, `matchbox-window-manager`,
  `fonts-noto-cjk`, `dbus-x11`, `xauth`) and the look's; a box without them gets a button that installs them.
- **The apps' look**: a box has no desktop environment, so each app is told at its start what one would tell it
  (`lib/display.js`, files written to the session's runtime folder): GTK 3 and 4 settings (Adwaita, Papirus icons,
  Inter, no window buttons in a header bar — the Ruyix window has them) put ahead of the system's in
  `XDG_CONFIG_DIRS`, so `~/.config/gtk-3.0/settings.ini` still wins; light or dark as the page is when it opens
  (`gtk-application-prefer-dark-theme`, and libadwaita's `ADW_DEBUG_COLOR_SCHEME`); the fonts' order (`FONTCONFIG_FILE`:
  Inter, then Noto Sans CJK for Chinese; JetBrains Mono for code); and `GSK_RENDERER=cairo` — the display has no
  OpenGL, and GTK 4 draws a blank window without it. Packages: `adwaita-icon-theme`, `papirus-icon-theme`,
  `librsvg2-common` (the icons are SVG), `fonts-inter`, `fonts-jetbrains-mono`.
- **The display in the browser**: a WebSocket on dsh's own web server, `/ruyix-apps/vnc?s=<session>`, behind dsh's
  sign-in (`connection.admit`); the session id is random (144 bits). `lib/ws.js` is a small RFC 6455 server (masked
  client frames, fragmentation, ping/pong, the closing handshake, `Sec-WebSocket-Protocol: binary` when offered) bridged
  to the display's VNC port. The page draws it with noVNC (bundled, MPL-2.0, loaded when the first display opens): the X
  display follows the window's size, the app's clipboard reaches the browser's, a dropped connection is tried again
  once while the session lives, and an app that quit says so.
- **Typing, Chinese too** (`src/keys.js`, `textBox` in `src/vnc.jsx`): the keyboard goes through a hidden text box over
  the display, not noVNC's canvas, because the Mac's input method only works in a text box. Keys go on through noVNC's
  own keyboard code; what the browser puts in the box — the input method's words (shown by the last click while being
  composed), ⌘V, dictation, a key that carries a non-ASCII character — is typed into the app as X keysyms (Unicode
  keysyms beyond Latin-1; Xvnc lends such a character a spare key code). Xvnc has only about 19 spare key codes and
  reuses them, and an app reads a reused one as the newer character, so a text with more than 16 distinct such
  characters goes by the clipboard instead and is pasted with Shift+Insert (the paste key of xterm, GTK, Qt and
  LibreOffice alike). Text arriving within 15 ms is one text (dictation types a sentence in quick pieces); after a
  paste the next text waits 400 ms, so the app has fetched the clipboard first.
- **The terminals** (`lib/term.js`, `lib/termpty.py`, `src/term.jsx`): text goes over the wire, not pixels. The page
  draws the terminal with xterm.js (sharp at any size; the Mac's input method, dictation, ⌘C/⌘V as they are; Chinese
  and emoji two cells wide); the box runs the multiplexer — `tmux new-session -A -s main` or `zellij attach --create
  main` — on a pseudo-terminal of its own (`termpty.py`: Python's pty, run with `-I`; no native Node module), behind a
  WebSocket on dsh's web server, `/ruyix-apps/term?app=<id>&cols=&rows=&tone=&bg=&fg=&muted=&line=&accent=`, behind
  dsh's sign-in (`connection.admit`: the Host/Origin fence and the browser's session). Its messages are binary, the
  first byte says which: page → box 0 keys, 1 the size ("<cols> <rows>"); box → page 0 output, 1 the end ({"exit"}).
  **The multiplexer keeps the shells**: the window closing, the page reloading or the connection dropping only hangs
  the pseudo-terminal up (SIGHUP: the multiplexer detaches); opening again comes back to the session as it was. Only
  **End the session** (the card's button, a second click to confirm; op `end`) ends what runs there. One window per
  terminal app: tabs and panes are the multiplexer's. Keys: ⌃ and ⌥ (as Meta — zellij and tmux bind it) go to the
  terminal, ⌘ stays the Mac's; `data-ruyix-keys="app"` keeps ⌃K and ⌃, from the desktop. Copying in tmux or zellij
  reaches the Mac's clipboard (OSC 52, xterm.js's clipboard addon); links open in a new tab.
  **The look follows the page**: the terminal's ground and text are Ruyix's (`--ruyix-surface`, `--ruyix-text`), the
  cursor and selection the accent, the ANSI colours GitHub's (light and dark); the page's colours go to the box with
  each opening, and tmux's bar (`tmuxConf`: the session on the left, the windows as tabs, the current one in the
  accent, the folder and the time on the right; mouse on, splits with | and -, a deep history) and zellij's theme
  (`zellijTheme`, zellij 0.42's components) take them. The person's own settings win: `~/.tmux.conf` (or
  `~/.config/tmux/tmux.conf`) is read after Ruyix's; with a `~/.config/zellij/config.kdl` of their own Ruyix hands
  zellij nothing but `show_startup_tips false`, else a config file of its own (`--config`: zellij writes the options
  it starts with into a new ~/.config/zellij/config.kdl when there is none, which would then pass for the person's),
  with `simplified_ui` (no arrow separators: they need a Nerd Font). xterm.js's DOM renderer, not WebGL: inside the
  desktop's windows the WebGL canvas was drawn at twice its size; the DOM renderer draws box lines from the font, so
  a pane's frame may show hairline gaps between rows.
  **Where they come from**: tmux from Debian (in the image; an older box installs it from the card); zellij is not in
  Debian, so the image carries zellij-org's own static release, its sha256 checked against the one in the Dockerfile
  (deb.griffo.io packages it, but its downloads want a subscription since 2026-10). A box on an older image shows
  zellij's card without an Install button: a newer image brings it.
- **⌘ shortcuts**: ⌘ never reaches the app; ⌘+key is the app's shortcut as a Mac user means it — ⌃+key (⌘C copy, ⌘A,
  ⌘Z, ⌘⇧Z, ⌘S, ⌘F…), ⌘←/→ Home/End, ⌘↑/↓ ⌃Home/End; ⌘V is the browser's paste (above). In a terminal (`terminal` in the
  catalog: GNOME Console, xterm) only ⌘C, sent as ⌃⇧C, which the catalog binds to its copy (its ⌃C stops the program running). The
  keysym sent says what the modifiers make (Xvnc hands the app exactly that keysym, letting go of Shift for a lower-case
  one). ⌃K stays the app's (the desktop's palette is ⌘K there). A copy reaches the browser's clipboard; selecting text
  alone does not (`-SendPrimary=0`).
- **Sharpness**: on a Retina screen (or chosen: App Center → Sharpness, this browser's) the display is twice the window's
  size and drawn at half (`sharp` in `src/vnc.jsx` overrides two of noVNC's methods), so the app is pixel for pixel; the
  app is told its scale when it starts (`GDK_SCALE`, `GDK_DPI_SCALE`, `QT_SCALE_FACTOR`, Xvnc's `-dpi` for Xft apps),
  times the interface size. An app already running keeps how it was started.
- **The page**: in the sidebar's System group (`order` 42, after Skills). Graphical apps and command-line tools as cards (not
  installed / waiting / installing / installed / running; Install, Open, Close), a search, install by package name, the
  installs and their output, what to do outside a box or when the box may not install. Open puts the app in a desktop
  window (`window.__ruyixDesk`); in the classic sidebar mode it fills the page, with a way back to the list. The ⌘K
  palette (`window.__ruyixPalette`) gets "Open <app>" for each installed graphical app, and the App Center itself.
- `POST /api/ruyix-apps { op }`: `catalog`, `state` (installed, jobs, the install running, sessions, inBox,
  canInstall, the display's packages, `terms`: whether each terminal's session is there), `install` (`{ appId }` |
  `{ support: true }` | `{ packages }`), `launch` (`{ appId }`, a graphical app), `stop` (`{ id }`), `sessions`,
  `end` (`{ appId }`: a terminal's session ends). Errors: `{ error: <code>, params: { message, … } }`.

What it does not do yet: sound, an agent looking at or driving the apps (screenshots), uninstalling. Any program in the box can reach a display's VNC port on
127.0.0.1 without a password — the box is one user's, and the browser only gets there through dsh's sign-in.

`node build.mjs` builds `client.js` from `src/`; `node check.mjs` checks the catalog, the WebSocket framing over real
sockets, the bridge against a fake VNC server, the terminal's settings and messages, a real pseudo-terminal end to end
behind the route (size, keys, a resize, the exit status, the hang-up when the page goes), the display sessions with a fake spawn, installing against a fake
nookbox window, the routes and the words.

© 2026 Ethan H.B. Zhou
