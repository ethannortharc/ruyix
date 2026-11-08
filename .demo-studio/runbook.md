# README media · v0.4.0

What the README shows and how to make it again. Everything is captured from a fresh install in a throwaway home with
synthetic data: two workflows whose steps are scripts (no model, no agent account, no network), runs of them at
different states, one scheduled task. Nothing from a real desk, account or terminal appears.

## Shots

| Asset | Shows | Made by |
|---|---|---|
| `hero.png` | The desk (theme Moonlit lake): what is at work, tasks, today, agents | still, 1600×1000 CSS px ×2 |
| `customize.gif` | `ruyix desk theme hills` proposes a change → the card → Apply → Far hills | video, cut and made a GIF |
| `run.png` | The Tasks page with a run at its review step, flow map on the Process tab | still, window zoomed, dock cut off |
| `review.png` | The review window: the document, two passages highlighted, two comments | still, dock cut off |
| `maps.gif` | The desk as three maps: old chart, star map, future city | video, 3 s of each map |

English (`docs/media/v0.4.0/en/`) and Chinese (`docs/media/v0.4.0/zh/`) are each made in their own home, the page in
that language.

## Run it

Needs: this checkout, ffmpeg, gifski, pngquant, Playwright with Chromium in some folder (`PLAYWRIGHT_DIR`), the
DeepSeek Harness app (its `dsh`) or npx. Scripts are in `source/v0.4.0-readme/`.

1. **deterministic** — homes. For each language a new empty folder under `$DEMO_DIR` (`home-en`, `home-zh`, mode 700):
   ```bash
   HOME=$DEMO_DIR/home-en node tools/dev-install.mjs --profile ruyix-demo --no-browsers --no-checks
   ```
2. **deterministic** — start each with its own terminal sockets, so the host's tmux and Zellij sessions do not show on
   the desk (the App Center lists the sessions it can see):
   ```bash
   mkdir -p $DEMO_DIR/home-en/zs $DEMO_DIR/home-en/tm
   HOME=$DEMO_DIR/home-en TZ=America/Los_Angeles ZELLIJ_SOCKET_DIR=$DEMO_DIR/home-en/zs TMUX_TMPDIR=$DEMO_DIR/home-en/tm \
     dsh --profile ruyix-demo --no-open --host 127.0.0.1 --port 3295      # zh: home-zh, port 3296
   ```
   Save the sign-in link it prints to `$DEMO_DIR/link-en.txt` (`link-zh.txt`).
3. **deterministic** — sample data: `node seed.mjs en $DEMO_DIR/link-en.txt` prints the first run and its review
   card; `node seed2.mjs en $DEMO_DIR/link-en.txt <run> <card>` approves it, starts this week's run and leaves it at
   the review with two comments, starts the long "release watch" run (its second step sleeps 50 minutes: capture
   within that) and adds a daily task. Note the `now` run id it prints.
4. **checkpoint** — open the page once; the desk writes a complete `~/.ruyix/desktop.json`. Copy the English one into
   the Chinese home too, so both desks are the same (a file with only some keys makes `ruyix desk` propose 16 lines,
   and a long change shows "See all changes" instead of Apply).
5. **deterministic** — capture:
   ```bash
   DEMO_DIR=… PLAYWRIGHT_DIR=… REVIEW_RUN=<now> node capture.mjs en .demo-studio/capture/v0.4.0-readme/en
   ```
   It discards any change card left on the desk first, closes the windows for the desk shots, and draws a pointer in
   the clips (a recording does not show the system's).
6. **checkpoint** — look at the cut points. The clips start with the page loading; `export.sh` cuts customize at
   7.0–17.5 s (en) / 7.5–18.0 s (zh) and takes maps 4–7, 10–13, 18–21 s. Check with a frame strip every 0.5 s if a
   new recording's timing differs.
7. **deterministic** — export: `export.sh .demo-studio/capture/v0.4.0-readme docs/media/v0.4.0 en` (then `zh`).
8. **checkpoint** — first, middle and last frame of each GIF at full size; every still at full size: no host
   terminals, no key prompt, no stale change card, text readable.

`capture/` and `_production/` are ignored: the raw takes stay on the machine that made them.

## Known limits

- The pages need DSH's "Add an API key" prompt put aside ("Configure later") — a fresh home has no model key.
- Headless Chromium draws the wallpapers on the GPU (`--use-angle=metal` on a Mac); without a GPU they may be blank.
