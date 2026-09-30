#!/usr/bin/env bash
set -uo pipefail

PARALLEL=${CLEAN_DISK_PARALLEL:-4}
SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")

if [ "${1:-}" = "--rm-one" ]; then
  target=$2
  start=$(date +%s)
  rm -rf -- "$target"
  status=$?
  if [ -e "$target" ]; then
    printf 'FAILED  %s (still present, exit %s)\n' "$target" "$status"
  else
    printf 'removed %s  (%ss)\n' "$target" "$(( $(date +%s) - start ))"
  fi
  exit 0
fi

if [ "${1:-}" = "--worker" ]; then
  RUN_DIR=$2

  printf 'started %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"

  if [ -s "$RUN_DIR/rm-list" ]; then
    total=$(wc -l <"$RUN_DIR/rm-list" | tr -d ' ')
    printf 'deleting %s paths with %s workers\n' "$total" "$PARALLEL"
    tr '\n' '\0' <"$RUN_DIR/rm-list" \
      | xargs -0 -n1 -P "$PARALLEL" "$SELF" --rm-one
  fi

  if [ -s "$RUN_DIR/wt-list" ]; then
    printf 'removing %s worktrees (each re-checked first)\n' "$(wc -l <"$RUN_DIR/wt-list" | tr -d ' ')"
    python3 "$(dirname "$SELF")/worktrees.py" remove <"$RUN_DIR/wt-list" 2>&1
  fi

  if [ -s "$RUN_DIR/cmd-list" ]; then
    while IFS= read -r cmd_id; do
      case "$cmd_id" in
        xcode-unavailable-sims)
          printf 'running xcrun simctl delete unavailable\n'
          xcrun simctl delete unavailable 2>&1
          ;;
        docker-prune)
          printf 'running docker system prune -f\n'
          docker system prune -f 2>&1
          ;;
        brew-cleanup)
          printf 'running brew cleanup --prune=all -s\n'
          brew cleanup --prune=all -s 2>&1
          ;;
        *)
          printf 'skipped unknown command id: %s\n' "$cmd_id"
          ;;
      esac
    done <"$RUN_DIR/cmd-list"
  fi

  if [ -d /System/Volumes/Data ] && df -k /System/Volumes/Data >/dev/null 2>&1; then
    mount_point=/System/Volumes/Data
  else
    mount_point=/
  fi
  after=$(df -k "$mount_point" | awk 'NR==2 {print $4 * 1024}')
  before=$(cat "$RUN_DIR/free-before" 2>/dev/null || echo 0)
  printf 'free before: %s bytes\nfree after:  %s bytes\nreclaimed:   %s bytes\n' \
    "$before" "$after" "$(( after - before ))"
  printf 'finished %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf 'done\n' >"$RUN_DIR/status"
  exit 0
fi

RUN_DIR=${1:-}
if [ -z "$RUN_DIR" ] || [ ! -f "$RUN_DIR/selection.json" ]; then
  printf 'usage: clean.sh <run_dir>  (run_dir must contain selection.json)\n' >&2
  exit 2
fi

SCAN="$RUN_DIR/scan.tsv"
[ -f "$SCAN" ] || { printf 'missing scan.tsv in %s\n' "$RUN_DIR" >&2; exit 2; }

user_tmp_base() {
  local d
  d=$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null) || return 1
  [ -n "${d:-}" ] || return 1
  d=${d%/}
  d=$(dirname "$d")
  case "$d" in
    /var/folders/*) printf '/private%s\n' "$d" ;;
    /private/var/folders/*) printf '%s\n' "$d" ;;
    *) return 1 ;;
  esac
}

TMP_BASE=$(user_tmp_base || true)

is_allowed() {
  local p=$1 rest
  case "$p" in
    *..*) return 1 ;;
  esac
  case "$p" in
    /private/tmp/?*) return 0 ;;
  esac
  if [ -n "${TMP_BASE:-}" ]; then
    case "$p" in
      "$TMP_BASE"/T/?*|"$TMP_BASE"/C/?*|"$TMP_BASE"/X/?*) return 0 ;;
    esac
  fi
  case "$p" in
    "$HOME"|"$HOME/"|/|/System*|/Library*|/Applications*|/usr*|/bin*|/sbin*|/etc*|/var*|/private*|/opt*|/Users) return 1 ;;
  esac
  case "$p" in
    "$HOME"/*) ;;
    *) return 1 ;;
  esac
  rest=${p#"$HOME"/}
  [ -z "$rest" ] && return 1
  case "$rest" in
    Documents|Documents/*|Desktop|Desktop/*|Pictures|Pictures/*|Movies|Movies/*|Music|Music/*) return 1 ;;
    .ssh|.ssh/*|.gnupg|.gnupg/*|.aws|.aws/*|.kube|.kube/*|.claude|.claude/*) return 1 ;;
    Library|Library/*Keychains*|Library/Mail|Library/Mail/*|Library/Messages|Library/Messages/*) return 1 ;;
  esac
  case "$p" in
    *..*) return 1 ;;
  esac
  return 0
}

: >"$RUN_DIR/rm-list"
: >"$RUN_DIR/cmd-list"
: >"$RUN_DIR/wt-list"
: >"$RUN_DIR/rejected"

total_bytes=0
kept=0

while IFS=$'\t' read -r action value bytes; do
  [ -n "${action:-}" ] || continue
  if [ "$action" = "cmd" ]; then
    case "$value" in
      xcode-unavailable-sims|docker-prune|brew-cleanup)
        printf '%s\n' "$value" >>"$RUN_DIR/cmd-list"
        total_bytes=$(( total_bytes + bytes ))
        kept=$(( kept + 1 ))
        ;;
      *) printf 'unknown command id\t%s\n' "$value" >>"$RUN_DIR/rejected" ;;
    esac
    continue
  fi

  if ! grep -qF "$(printf '\t%s\t' "$value")" "$SCAN"; then
    printf 'not in scan\t%s\n' "$value" >>"$RUN_DIR/rejected"
    continue
  fi
  if ! is_allowed "$value"; then
    printf 'protected path\t%s\n' "$value" >>"$RUN_DIR/rejected"
    continue
  fi
  if [ ! -e "$value" ]; then
    printf 'already gone\t%s\n' "$value" >>"$RUN_DIR/rejected"
    continue
  fi
  case "$value" in
    *$'\n'*) printf 'newline in path\t%s\n' "$value" >>"$RUN_DIR/rejected"; continue ;;
  esac
  if [ "$action" = "worktree" ]; then
    printf '%s\n' "$value" >>"$RUN_DIR/wt-list"
  else
    printf '%s\n' "$value" >>"$RUN_DIR/rm-list"
  fi
  total_bytes=$(( total_bytes + bytes ))
  kept=$(( kept + 1 ))
done < <(python3 - "$RUN_DIR/selection.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
for item in data.get("items", []):
    action = item.get("action", "rm")
    value = item.get("cmd_id") if action == "cmd" else item.get("path")
    if not value:
        continue
    print("%s\t%s\t%s" % (action, value, int(item.get("bytes") or 0)))
PY
)

if [ "$kept" -eq 0 ]; then
  printf 'nothing passed validation. see %s/rejected\n' "$RUN_DIR" >&2
  exit 3
fi

printf 'pending\n' >"$RUN_DIR/status"
LOG="$RUN_DIR/clean.log"
: >"$LOG"

nohup "$SELF" --worker "$RUN_DIR" >>"$LOG" 2>&1 </dev/null &
worker_pid=$!
printf '%s\n' "$worker_pid" >"$RUN_DIR/worker.pid"

printf 'queued  : %s items (%s bytes)\n' "$kept" "$total_bytes"
printf 'rejected: %s\n' "$(wc -l <"$RUN_DIR/rejected" | tr -d ' ')"
printf 'pid     : %s\n' "$worker_pid"
printf 'log     : %s\n' "$LOG"
