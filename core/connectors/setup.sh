#!/usr/bin/env bash
# What the connections need on this machine. ruyix setup runs it after every install and upgrade; re-runnable.
# Usage: setup.sh [--no-browsers]
#  - Playwright + Chromium: a browser sign-in (a cookie or a token from a page) runs it — one runtime for the sign-ins and
#    whatever else drives a browser.
set -euo pipefail
WB=${RUYIX_WORKBENCH_HOME:-$HOME/.ruyix/workbench}
ui=${RUYIX_UI_RUNTIME:-$WB/ui-runtime}
mkdir -p "$ui"
[ -f "$ui/package.json" ] || echo '{"name":"ruyix-ui-runtime","private":true,"type":"module","dependencies":{"playwright":"^1.63.0"}}' > "$ui/package.json"
(cd "$ui" && npm install --no-audit --no-fund --loglevel=error >/dev/null) && echo "  ✓ Playwright (browser sign-ins)"
if [ "${1:-}" != --no-browsers ]; then
  (cd "$ui" && npx playwright install chromium >/dev/null 2>&1) && echo "  ✓ Chromium" || printf '\033[1;33m  ! %s\033[0m\n' "Chromium did not install: run \`npx playwright install --with-deps chromium\` in $ui"
fi
