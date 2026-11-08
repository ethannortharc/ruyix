#!/usr/bin/env bash
# Builds the Ruyix image from this checkout:
#   box/image/build.sh [--tag <repo:version>] [--engine container|docker]
# The tag defaults to ruyix:<the shell's version>-<commit> (-dirty with uncommitted changes), also tagged
# ruyix:<the shell's version>; the engine to Apple's `container` (macOS 26: what nookbox's microvm boxes run on), else
# docker. A box moves to a build by its own tag — a tag reused for a newer build is not seen by a cached builder. What goes in: the files git tracks or would track (core/, packs/, tools/, the workspace's
# package.json, lock and .npmrc) — uncommitted changes too, never what .gitignore keeps out (node_modules, built clients, .env).
# A box from it: nookbox create ruyix --image <tag>   (its labels give the runtime, the port, the start command)
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
tag='' engine=''
while [ $# -gt 0 ]; do case "$1" in
  --tag) tag=$2; shift ;;
  --engine) engine=$2; shift ;;
  -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
  *) echo "unknown option $1" >&2; exit 2 ;;
esac; shift; done
version=$(node -p "require('./core/shell/package.json').version")
dsh=$(node -p "require('./core/shell/package.json').ruyix.dsh")
commit=$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . 2>/dev/null || echo -dirty)
own=${tag:-ruyix:$version-$commit}
if [ -z "$engine" ]; then
  if command -v container >/dev/null && container system status >/dev/null 2>&1; then engine=container
  elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then engine=docker
  else echo "no image engine: start Apple's container (container system start) or a docker engine" >&2; exit 1; fi
fi

# the build context: the Dockerfile, and the checkout as src/
ctx=$(mktemp -d); trap 'rm -rf "$ctx"' EXIT
cp box/image/Dockerfile "$ctx/"
mkdir -p "$ctx/src"
git ls-files -co --exclude-standard -z -- .npmrc package.json package-lock.json core packs tools | node --input-type=module -e 'let s = ""; for await (const c of process.stdin) s += c; process.stdout.write(s.split("\0").filter(p => p && !/(^|\/)\.env(\.[^/]*)?$/.test(p)).map(p => p + "\0").join(""))' | tar --null -T - -cf - | tar -xf - -C "$ctx/src"
echo "context: $(find "$ctx/src" -type f | wc -l | tr -d ' ') files, $(du -sh "$ctx/src" | cut -f1)"

"$engine" build --build-arg "RUYIX_VERSION=$version" --build-arg "RUYIX_DSH=$dsh" -t "$own" "$ctx"
[ -n "$tag" ] || "$engine" image tag "$own" "ruyix:$version"
echo "built $own (Ruyix $version on dsh $dsh) with $engine — a box: nookbox create ruyix --image $own, or nookbox update ruyix --image $own"
