#!/usr/bin/env bash
# Installs the Ruyix dsh plugins on this machine — re-runnable, nothing machine-specific inside:
#   1. checks the prerequisites,
#   2. builds the shell and the plugins (core/), runs their self-checks and adds them to a dsh profile,
#   3. sets up what the plugins need at run time (Playwright + Chromium for browser sign-ins),
#   4. lists what only you can do (agent CLIs, credentials).
# dsh is found in this order: $DSH_CLI, the DeepSeek Harness app's bundled CLI, `npx @deepseek-ai/dsh`.
# Usage: tools/dev-install.sh [--profile ruyix] [--no-browsers]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
PROFILE=ruyix BROWSERS=1
DSH_VERSION=${DSH_VERSION:-0.2.0-rc.2}
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
APP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE=$2; shift ;;
    --no-browsers) BROWSERS=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
PLUGINS="core/connectors core/plugins/agent-hub core/plugins/apps core/workbench core/plugins/studio core/plugins/web packs/plume packs/video packs/newsletter core/plugins/world core/shell"
TODO=()
say() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
todo() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; TODO+=("$*"); }
need() { command -v "$1" >/dev/null || { echo "missing: $1 — $2" >&2; exit 1; }; }
dsh() {
  if [ -n "${DSH_CLI:-}" ]; then "$DSH_CLI" "$@"
  elif [ -x "$APP_DSH" ]; then "$APP_DSH" "$@"
  else npx -y "@deepseek-ai/dsh@$DSH_VERSION" "$@"; fi
}

say "Prerequisites"
need node "Node.js 22.5 or newer"; need npm "comes with Node.js"; need git "git"
# dsh installs plugins with pnpm (11, like dsh itself); a half-installed corepack shim does not count.
pnpm -v >/dev/null 2>&1 || npm install -g pnpm@11 --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || true
pnpm -v >/dev/null 2>&1 || { echo "missing: pnpm — run: npm install -g pnpm@11 (with sudo if your global npm prefix needs it)" >&2; exit 1; }
node -e 'const [a, b] = process.versions.node.split(".").map(Number); if (a < 22 || (a === 22 && b < 5)) { console.error(`Node ${process.versions.node} is too old: dsh and these plugins need 22.5+`); process.exit(1) }'
ok "node $(node -v), npm $(npm -v), pnpm $(pnpm -v), git"
{ command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ]; } && ok "Claude Code CLI" || todo "install Claude Code (npm i -g @anthropic-ai/claude-code) and run \`claude\` once to sign in — or install it from Agents → Runtimes"
command -v codex >/dev/null && ok "Codex CLI" || todo "install Codex (npm i -g @openai/codex) and run \`codex login\` — or install it from Agents → Runtimes"

say "Build the plugins"
npm install --no-audit --no-fund --loglevel=error >/dev/null # the workspaces (package.json): one node_modules for all
for p in $PLUGINS; do (cd "$p" && ok "$p: $(node build.mjs)"); done
for c in $PLUGINS; do
  if out=$(cd "$c" && node check.mjs 2>&1); then ok "$c self-check $(echo "$out" | grep -v "^ok$\|check: ok$" | tr "\n" " ")"
  else printf "%s\n" "$out" >&2; echo "$c self-check failed; installation stopped before linking plugins" >&2; exit 1; fi
done

# a client.js without apply makes dsh load no plugin at all ("Failed to load plugins")
out=$(node tools/client-check.mjs 2>&1) && ok "$out" || { printf "%s\n" "$out" >&2; echo "installation stopped before linking plugins" >&2; exit 1; }

say "Add them to the dsh profile \"$PROFILE\""
# a new profile starts from the shipped web one; an existing profile is used as it is
[ -d "$DSH_HOME/profiles/$PROFILE" ] || dsh --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null || { echo "dsh could not create the profile \"$PROFILE\"" >&2; exit 1; }
args=(); for p in $PLUGINS; do args+=("link:$ROOT/$p"); done
dsh plugin --profile "$PROFILE" add "${args[@]}" >/dev/null || { echo "dsh could not add the plugins (see the diruyixtics path above)" >&2; exit 1; }
ok "$PLUGINS"

say "Runtime"
for s in core/*/setup.sh core/plugins/*/setup.sh; do
  if [ -f "$s" ]; then bash "$s" $([ "$BROWSERS" = 1 ] || echo --no-browsers); fi
done

say "Done"
todo "start dsh so the profile picks the plugins up: dsh $PROFILE  (or: npx -y @deepseek-ai/dsh@$DSH_VERSION $PROFILE)"
cat <<MSG

Only you can do these:
$(for t in "${TODO[@]}"; do printf '  - %s\n' "$t"; done)
  - Open the Connectors page (sidebar → Admin) and add the credentials the agents need (GitLab token, an API token…),
    then "Test all".
MSG
