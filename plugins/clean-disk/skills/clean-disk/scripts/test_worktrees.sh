#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/wt-test.XXXXXX")
trap 'kill "${SLEEPER:-0}" 2>/dev/null || true; rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

git init -q -b main "$T/repo"
cd "$T/repo"
printf 'node_modules/\ndist/\n.env\n' >.gitignore
echo a >a.txt
git add . && git commit -qm init

add() { git worktree add -q -b "$1" "$T/$1" main; }

add clean
add clean-with-build && mkdir -p "$T/clean-with-build/node_modules/x" "$T/clean-with-build/dist" && echo x >"$T/clean-with-build/node_modules/x/i.js"
add unpushed-commit && (cd "$T/unpushed-commit" && echo b >b.txt && git add b.txt && git commit -qm b)
add modified && echo changed >>"$T/modified/a.txt"
add staged && (cd "$T/staged" && echo s >s.txt && git add s.txt)
add untracked && echo u >"$T/untracked/new.txt"
add env-file && echo SECRET=1 >"$T/env-file/.env"
add locked && git worktree lock "$T/locked"
add in-use
(cd "$T/in-use" && exec sleep 300) &
SLEEPER=$!
add dropped-commit && (cd "$T/dropped-commit" && echo d >d.txt && git add d.txt && git commit -qm d && git reset -q --hard HEAD~1)
add rebasing && mkdir -p "$(git -C "$T/rebasing" rev-parse --absolute-git-dir)/rebase-merge"
git worktree add -q --detach "$T/detached-orphan" main && (cd "$T/detached-orphan" && echo o >o.txt && git add o.txt && git commit -qm o)
add changed-after-scan
sleep 1
echo late >"$T/changed-after-scan/late.txt"

ls -d "$T"/*/ | grep -v "/repo/$" | sed 's#/$##' | python3 "$HERE/worktrees.py" remove >"$T/out.txt"

fail=0
expect() {
  if [ "$1" = gone ] && [ -e "$T/$2" ]; then echo "FAIL $2 should be removed"; fail=1; fi
  if [ "$1" = kept ] && [ ! -e "$T/$2" ]; then echo "FAIL $2 was removed but holds work"; fail=1; fi
}
expect gone clean
expect gone clean-with-build
expect gone unpushed-commit
for w in modified staged untracked env-file locked in-use dropped-commit rebasing detached-orphan changed-after-scan; do
  expect kept "$w"
done
git rev-parse -q --verify unpushed-commit >/dev/null || { echo "FAIL branch unpushed-commit lost"; fail=1; }
[ "$(git log -1 --format=%s unpushed-commit)" = b ] || { echo "FAIL commit on unpushed-commit lost"; fail=1; }

cat "$T/out.txt"
[ "$fail" = 0 ] && echo "PASS" || { echo "FAILED"; exit 1; }
