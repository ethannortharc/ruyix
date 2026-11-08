#!/bin/bash
# Publishes to the public GitHub repository the files of a release — never this repository's history (its first
# commits carry code that is not to be published). Each release becomes one commit on top of the last one published
# there, so GitHub's history is a commit per release.
#   tools/github-snapshot.sh <version>          after `node tools/release.mjs <version> --publish`: the tag's files, tagged
#   tools/github-snapshot.sh --docs "<what>"    between releases: main's files, when main has changed only documents and
#                                               CI since the last commit published there (no unreleased code goes out)
# Do not add GitHub as a remote of this repository, and never push a branch of it there.
set -euo pipefail
die() { echo "✗ $*" >&2; exit 1; }
url=${RUYIX_GITHUB:-https://github.com/ethannortharc/ruyix.git}
repo="$(basename "$(dirname "$url")")/$(basename "$url" .git)"
case "${1:-}" in
  --docs) [ -n "${2:-}" ] || die 'usage: tools/github-snapshot.sh --docs "<what changed>"'; src=main tag='' msg=$2 ;;
  *) [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: tools/github-snapshot.sh <major.minor.patch> | --docs \"<what>\""
     src="v$1" tag="v$1" msg="Ruyix $1" ;;
esac
cd "$(dirname "$0")/.."
tree=$(git rev-parse --verify -q "$src^{tree}") || die "no $src here${tag:+: release it first}"
if [ -n "$tag" ] && git ls-remote --exit-code --tags "$url" "refs/tags/$tag" >/dev/null 2>&1; then die "$tag is on GitHub already"; fi
# the last commit published there (none yet: the first release)
parent=$(git ls-remote "$url" refs/heads/main | cut -f1)
[ -z "$parent" ] || git fetch -q "$url" main
if [ -z "$tag" ]; then
  [ -n "$parent" ] || die "--docs goes on top of a release already published there"
  code=$(git diff --name-only "$parent" "$tree" | grep -vE '^(README[^/]*\.md|CHANGELOG\.md|LICENSE|docs/|\.github/|\.demo-studio/|tools/github-snapshot\.sh$)' || true)
  [ -z "$code" ] || die "main changed more than documents since GitHub's last commit — release it first:"$'\n'"$code"
  when=$(date -Iseconds)
else
  when=$(git log -1 --format=%aI "$tag")
fi
commit=$(GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" git commit-tree "$tree" ${parent:+-p "$parent"} -m "$msg")
# nothing of this repository's history may go along: none of its root commits is an ancestor of what is pushed
while read -r root; do
  ! git merge-base --is-ancestor "$root" "$commit" || die "the commit to push would carry this repository's history"
done < <(git rev-list --max-parents=0 "$src")
[ "$(git rev-list --count "$commit")" = "$(( ${parent:+$(git rev-list --count "$parent")} + 1 ))" ] || die "unexpected history under the snapshot"
git push -q "$url" "$commit:refs/heads/main" ${tag:+"$commit:refs/tags/$tag"}
git update-ref -m "github snapshot ${tag:-docs}" refs/public/main "$commit"
echo "✓ ${tag:-main} on GitHub as $(git rev-parse --short "$commit") ($url)"
[ -z "$tag" ] || echo "  release notes: gh release create $tag -R $repo --title '$msg' --notes-file <the CHANGELOG section>"
