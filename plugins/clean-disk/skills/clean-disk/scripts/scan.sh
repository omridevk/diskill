#!/usr/bin/env bash
set -uo pipefail

MIN_BYTES=${CLEAN_DISK_MIN_BYTES:-10485760}
STALE_DAYS=${CLEAN_DISK_STALE_DAYS:-90}
BIGFILE_BYTES=${CLEAN_DISK_BIGFILE_BYTES:-1073741824}
OLD_DOWNLOAD_DAYS=${CLEAN_DISK_OLD_DOWNLOAD_DAYS:-180}
MAX_REPORT_ITEMS=${CLEAN_DISK_MAX_REPORT_ITEMS:-40}
MAP_MIN_BYTES=${CLEAN_DISK_MAP_MIN_BYTES:-209715200}
MAP_DEPTH=${CLEAN_DISK_MAP_DEPTH:-5}
NM_DEPTH=${CLEAN_DISK_NM_DEPTH:-9}
NM_MIN_BYTES=${CLEAN_DISK_NM_MIN_BYTES:-5242880}
NOW=$(date +%s)

RUN_DIR=${1:-}
if [ -z "$RUN_DIR" ]; then
  RUN_DIR="$HOME/.cache/clean-disk/run-$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$RUN_DIR/parts"
PARTS="$RUN_DIR/parts"

log() { printf '  %s\n' "$*" >&2; }

emit() {
  local path=$9
  case "$path" in
    *"$(printf '\t')"*) return 0 ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" "${12}" "${13}"
}

sized() {
  local cat_id=$1 cat_title=$2 cat_desc=$3 risk=$4 pre=$5 note=$6 min=${7:-$MIN_BYTES}
  local p kb bytes label
  local -a list=()
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ -e "$p" ] || continue
    list+=("$p")
  done
  [ ${#list[@]} -eq 0 ] && return 0
  printf '%s\0' "${list[@]}" | xargs -0 du -skx 2>/dev/null | while IFS=$'\t' read -r kb p; do
    [ -n "${kb:-}" ] || continue
    case "$kb" in ''|*[!0-9]*) continue ;; esac
    bytes=$((kb * 1024))
    [ "$bytes" -lt "$min" ] && continue
    label=${p/#$HOME/\~}
    emit "$cat_id" "$cat_title" "$cat_desc" "$risk" "$pre" "rm" "-" "$label" "$p" "$bytes" "$note" "$(age_of "$p")" "exact"
  done
}

age_of() {
  local m
  m=$(stat -f %m "$1" 2>/dev/null) || { printf -- '-\n'; return 0; }
  printf '%s\n' $(( (NOW - m) / 86400 ))
}

exists_lines() {
  local p
  for p in "$@"; do
    [ -e "$p" ] && printf '%s\n' "$p"
  done
  return 0
}

scan_trash() {
  find "$HOME/.Trash" -mindepth 1 -maxdepth 1 -print 2>/dev/null \
    | sized trash "Trash" "Items already in the macOS Trash." safe 1 "Permanently removed." 1
}

scan_caches() {
  find "$HOME/Library/Caches" -mindepth 1 -maxdepth 1 -print 2>/dev/null \
    | sized caches "Application caches" "~/Library/Caches — regenerated automatically by each app." safe 1 "App rebuilds this on next launch."
}

scan_logs() {
  {
    find "$HOME/Library/Logs" -mindepth 1 -maxdepth 1 -print 2>/dev/null
    exists_lines "$HOME/Library/Application Support/CrashReporter" \
                 "$HOME/Library/Logs/DiagnosticReports"
  } | sized logs "Logs and crash reports" "Diagnostic output kept by apps and macOS." safe 1 "Diagnostics only."
}

scan_pkg() {
  local brew_cache=""
  command -v brew >/dev/null 2>&1 && brew_cache=$(brew --cache 2>/dev/null)
  exists_lines \
    "$HOME/.npm/_cacache" \
    "$HOME/Library/Caches/Yarn" \
    "$HOME/.yarn/berry/cache" \
    "$HOME/Library/Caches/pnpm" \
    "$HOME/.bun/install/cache" \
    "$HOME/Library/Caches/pip" \
    "$HOME/.cache/pip" \
    "$HOME/.cache/uv" \
    "$HOME/Library/Caches/Homebrew" \
    ${brew_cache:+"$brew_cache"} \
    "$HOME/Library/Caches/go-build" \
    "$HOME/.cargo/registry/cache" \
    "$HOME/.cache/ms-playwright" \
    "$HOME/Library/Caches/ms-playwright" \
    "$HOME/.cache/puppeteer" \
    "$HOME/Library/Caches/CocoaPods" \
    "$HOME/.composer/cache" \
    "$HOME/.cache/yarn" \
    "$HOME/Library/Caches/electron" \
    "$HOME/Library/Caches/node-gyp" \
    "$HOME/Library/Caches/deno" \
    | sized pkg-cache "Package manager caches" "Download caches for npm, brew, pip, cargo, go and friends." safe 1 "Re-downloaded on next install."

  exists_lines \
    "$HOME/.cargo/registry/src" \
    "$HOME/go/pkg/mod" \
    "$HOME/.m2/repository" \
    "$HOME/.gradle/caches" \
    "$HOME/.gem" \
    | sized pkg-store "Package manager stores" "Extracted dependency sources. Safe to delete but slower to restore." review 0 "Re-downloaded and re-extracted on next build."

  exists_lines "$HOME/Library/pnpm/store" "$HOME/.local/share/pnpm/store" \
    | sized pnpm-store "pnpm content store" "The store that existing node_modules hard-link into." review 0 "Breaks every existing node_modules on this Mac until each project reinstalls."
}

scan_xcode() {
  exists_lines \
    "$HOME/Library/Developer/Xcode/DerivedData" \
    "$HOME/Library/Developer/CoreSimulator/Caches" \
    "$HOME/Library/Developer/Xcode/iOS DeviceSupport" \
    "$HOME/Library/Developer/Xcode/watchOS DeviceSupport" \
    "$HOME/Library/Developer/Xcode/UserData/IB Support" \
    | sized xcode "Xcode build data" "Derived data, simulator caches and device support files." safe 1 "Xcode regenerates on next build or device connect."

  exists_lines "$HOME/Library/Developer/Xcode/Archives" \
    | sized xcode-archives "Xcode archives" "Built .xcarchive bundles. Needed to re-submit or symbolicate an old build." review 0 "Not recoverable without rebuilding that exact commit."

  if command -v xcrun >/dev/null 2>&1 && [ -d "$HOME/Library/Developer/CoreSimulator/Devices" ]; then
    local sims kb bytes
    sims=$(xcrun simctl list devices 2>/dev/null | grep -c "unavailable" || true)
    if [ "${sims:-0}" -gt 0 ]; then
      kb=$(du -skx "$HOME/Library/Developer/CoreSimulator/Devices" 2>/dev/null | awk '{print $1}')
      bytes=$(( ${kb:-0} * 1024 / 3 ))
      emit xcode-sims "Unavailable simulators" "Simulator devices whose runtime is no longer installed." safe 1 "cmd" "xcode-unavailable-sims" \
        "xcrun simctl delete unavailable ($sims devices)" "cmd:xcode-unavailable-sims" "$bytes" "Rough estimate. Removes only devices macOS already marks unavailable." "-" "estimate"
    fi
  fi
}

scan_dev_artifacts() {
  local d parent bytes kb label
  find "$HOME" -maxdepth 7 \
    \( -path "$HOME/Library" -o -path "$HOME/.Trash" -o -path "$HOME/Applications" \
       -o -path "$HOME/.cargo" -o -path "$HOME/go/pkg" -o -path "$HOME/.gradle" \
       -o -path "$HOME/.m2" -o -path "$HOME/.npm" -o -path "$HOME/.bun" \
       -o -path "$HOME/.nvm" -o -path "$HOME/.volta" -o -path "$HOME/.asdf" \
       -o -path "$HOME/.local" -o -path "$HOME/.rbenv" -o -path "$HOME/.pyenv" \
       -o -path "$HOME/.docker" -o -path "$HOME/.orbstack" \
       -o -name ".git" \) -prune -o \
    -type d \( -name .venv -o -name venv -o -name target \
       -o -name .next -o -name .nuxt -o -name .turbo -o -name .svelte-kit \
       -o -name .parcel-cache -o -name __pycache__ -o -name .pytest_cache \
       -o -name .mypy_cache -o -name .ruff_cache \) -prune -mtime +"$STALE_DAYS" -print 2>/dev/null \
  | while IFS= read -r d; do
      case "$(basename "$d")" in
        target)
          parent=$(dirname "$d")
          [ -f "$parent/Cargo.toml" ] || continue
          ;;
      esac
      printf '%s\n' "$d"
    done \
  | sized dev-artifacts "Stale build artifacts" "Virtualenvs and build output untouched for over $STALE_DAYS days. node_modules has its own section below." safe 1 "Restored by re-running the project's install or build."
}

scan_node_modules() {
  local p kb bytes parent mgr age label pre note measurement
  find "$HOME" -maxdepth "$NM_DEPTH" \
    \( -path "$HOME/Library" -o -path "$HOME/.Trash" -o -path "$HOME/Applications" \
       -o -path "$HOME/.claude" -o -path "$HOME/.nvm" -o -path "$HOME/.volta" \
       -o -path "$HOME/.asdf" -o -path "$HOME/.local" -o -path "$HOME/.bun" \
       -o -path "$HOME/.npm" -o -path "$HOME/.cache" -o -path "$HOME/.cursor" \
       -o -path "$HOME/.vscode" -o -path "$HOME/.codex" -o -path "$HOME/.rustup" \
       -o -path "$HOME/Documents" -o -path "$HOME/Desktop" \
       -o -name ".git" \) -prune -o \
    -type d -name node_modules -prune -print 2>/dev/null \
  | tr '\n' '\0' | xargs -0 du -skx 2>/dev/null | while IFS=$'\t' read -r kb p; do
      [ -n "${kb:-}" ] || continue
      case "$kb" in ''|*[!0-9]*) continue ;; esac
      bytes=$((kb * 1024))
      [ "$bytes" -lt "$NM_MIN_BYTES" ] && continue
      parent=$(dirname "$p")
      mgr=npm
      [ -f "$parent/pnpm-lock.yaml" ] && mgr=pnpm
      [ -f "$parent/yarn.lock" ] && mgr=yarn
      [ -f "$parent/bun.lockb" ] && mgr=bun
      [ -f "$parent/bun.lock" ] && mgr=bun
      age=$(age_of "$p")
      pre=0
      [ "$age" != "-" ] && [ "$age" -gt "$STALE_DAYS" ] && pre=1
      label=${parent/#$HOME/\~}
      note="$mgr project, last installed ${age} days ago. Restore with: $mgr install"
      measurement="exact"
      if [ "$mgr" = "pnpm" ]; then
        measurement="estimate"
        note="$note Size is apparent: pnpm clones package files from ~/Library/pnpm/store, so deleting frees only blocks no other project or the store still holds."
      fi
      emit node-modules "node_modules" "Every node_modules folder on this Mac, whatever its age. Each one is fully rebuildable from its lockfile." safe "$pre" "rm" "-" "$label" "$p" "$bytes" "$note" "$age" "$measurement"
    done
}

scan_ios_backups() {
  find "$HOME/Library/Application Support/MobileSync/Backup" -mindepth 1 -maxdepth 1 -print 2>/dev/null \
    | sized ios-backups "iOS device backups" "Local iPhone and iPad backups." review 0 "Not recoverable. Only delete if the device backs up to iCloud."
}

scan_docker() {
  command -v docker >/dev/null 2>&1 || return 0
  docker info >/dev/null 2>&1 || return 0
  local reclaim bytes
  reclaim=$(docker system df --format '{{.Reclaimable}}' 2>/dev/null | head -1)
  bytes=$(python3 - "$reclaim" <<'PY' 2>/dev/null
import re, sys
s = sys.argv[1] if len(sys.argv) > 1 else ""
m = re.search(r"([\d.]+)\s*([KMGT]?)B", s)
u = {"": 1, "K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4}
print(int(float(m.group(1)) * u[m.group(2)]) if m else 0)
PY
)
  [ "${bytes:-0}" -lt "$MIN_BYTES" ] && return 0
  emit docker "Docker" "Dangling images, stopped containers and build cache." review 0 "cmd" "docker-prune" \
    "docker system prune -f" "cmd:docker-prune" "$bytes" "Frees space INSIDE Docker's sparse VM disk image, which does not shrink — macOS gets little or none of it back. Reclaim it on the host by resetting the Docker VM disk in Docker Desktop. Named volumes are never touched." "-" "vm"
}

scan_big_files() {
  local f blocks apparent sz label note
  find "$HOME" -maxdepth 6 \
    \( -path "$HOME/Library" -o -path "$HOME/.Trash" -o -name ".git" -o -name node_modules \) -prune -o \
    -type f -size +"${BIGFILE_BYTES}"c -print 2>/dev/null \
  | head -n "$MAX_REPORT_ITEMS" \
  | while IFS= read -r f; do
      blocks=$(stat -f %b "$f" 2>/dev/null) || continue
      apparent=$(stat -f %z "$f" 2>/dev/null) || continue
      sz=$(( blocks * 512 ))
      [ "$sz" -lt "$BIGFILE_BYTES" ] && continue
      note="Review manually."
      [ "$apparent" -gt $(( sz * 2 )) ] && note="Sparse file — $(( apparent / 1073741824 )) GB apparent, $(( sz / 1073741824 )) GB actually on disk."
      label=${f/#$HOME/\~}
      emit big-files "Large files (report only)" "Files over $((BIGFILE_BYTES / 1073741824)) GB, measured by space actually allocated on disk. Listed for awareness — never deleted by this skill." report 0 "rm" "-" \
        "$label" "$f" "$sz" "$note" "$(age_of "$f")" "exact"
    done
}

scan_old_downloads() {
  find "$HOME/Downloads" -mindepth 1 -maxdepth 1 -mtime +"$OLD_DOWNLOAD_DAYS" -print 2>/dev/null \
    | head -n "$MAX_REPORT_ITEMS" \
    | sized old-downloads "Old downloads (report only)" "~/Downloads entries untouched for over $OLD_DOWNLOAD_DAYS days. Listed for awareness — never deleted by this skill." report 0 "Review manually."
}

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

scan_private_tmp() {
  [ -d /private/tmp ] || return 0
  find /private/tmp -mindepth 1 -maxdepth 1 -user "$(id -u)" -print 2>/dev/null \
    | sized private-tmp "Temp files in /private/tmp" "Entries in /private/tmp that belong to you. Tools recreate what they need, but a running process may still be using one." review 0 "Recreated on demand."
}

scan_user_tmpdir() {
  local base d kb bytes label
  base=$(user_tmp_base) || return 0
  [ -d "$base" ] || return 0

  find "$base/T" "$base/C" -mindepth 1 -maxdepth 1 -print 2>/dev/null \
    | sized user-tmpdir "Your macOS temp and cache folder" "The per-user \$TMPDIR tree. Rebuilt automatically, but a running process may still be using one." review 0 "Rebuilt on demand."

  for d in "$base"/X/*.code_sign_clone; do
    [ -d "$d" ] || continue
    kb=$(du -skx "$d" 2>/dev/null | awk '{print $1}')
    case "${kb:-}" in ''|*[!0-9]*) continue ;; esac
    bytes=$((kb * 1024))
    [ "$bytes" -lt "$MIN_BYTES" ] && continue
    label=${d#"$base"/X/}
    emit "code-sign-clones" "App code-signing clones" "Copies macOS makes of an app bundle while the app runs. They pile up and are rarely cleaned. Sizes are apparent — clones share disk blocks with the app, so the space actually returned is only the blocks of app versions no longer on disk." \
      review 0 "rm" "-" "\$TMPDIR/../X/$label" "$d" "$bytes" "Quit the app first. Frees far less than the size shown." "$(age_of "$d")" "estimate"
  done
}

scan_map() {
  [ "${CLEAN_DISK_SKIP_MAP:-0}" = "1" ] && return 0
  local root prefix
  root=$(data_mount)
  prefix=""
  [ "$root" != "/" ] && prefix="$root"
  du -xk -d "$MAP_DEPTH" "$root" 2>/dev/null \
    | awk -F'\t' -v min=$(( MAP_MIN_BYTES / 1024 )) -v pre="$prefix" '
        {
          p = $2
          if (pre != "" && index(p, pre) == 1) {
            p = substr(p, length(pre) + 1)
            if (p == "") p = "/"
          }
          if ($1 + 0 >= min || p == "/") printf "%.0f\t%s\n", $1 * 1024, p
        }'
}

data_mount() {
  if [ -d /System/Volumes/Data ] && df -k /System/Volumes/Data >/dev/null 2>&1; then
    printf '/System/Volumes/Data\n'
  else
    printf '/\n'
  fi
}

write_disk_facts() {
  local total used free home snaps
  read -r total used free < <(df -k "$(data_mount)" | awk 'NR==2 {print $2 * 1024, $3 * 1024, $4 * 1024}')
  home=$(awk -F'\t' -v h="$HOME" '$2 == h {print $1}' "$RUN_DIR/map.tsv" 2>/dev/null | tail -1)
  [ -z "${home:-}" ] && home=$(du -sxk "$HOME" 2>/dev/null | awk '{print $1 * 1024}')
  snaps=$(tmutil listlocalsnapshots / 2>/dev/null | grep -c 'com.apple' || echo 0)
  {
    printf 'total\t%s\n' "${total:-0}"
    printf 'used\t%s\n' "${used:-0}"
    printf 'free\t%s\n' "${free:-0}"
    printf 'home\t%s\n' "${home:-0}"
    printf 'snapshots\t%s\n' "${snaps:-0}"
  } >"$RUN_DIR/disk.tsv"
}

log "scanning (this takes a few minutes — the storage map walks the whole volume)..."

scan_trash          >"$PARTS/trash.tsv"          2>/dev/null &
scan_caches         >"$PARTS/caches.tsv"         2>/dev/null &
scan_logs           >"$PARTS/logs.tsv"           2>/dev/null &
scan_pkg            >"$PARTS/pkg.tsv"            2>/dev/null &
scan_xcode          >"$PARTS/xcode.tsv"          2>/dev/null &
scan_dev_artifacts  >"$PARTS/dev.tsv"            2>/dev/null &
scan_ios_backups    >"$PARTS/ios.tsv"            2>/dev/null &
scan_node_modules   >"$PARTS/nodemodules.tsv"    2>/dev/null &
scan_docker         >"$PARTS/docker.tsv"         2>/dev/null &
scan_big_files      >"$PARTS/bigfiles.tsv"       2>/dev/null &
scan_old_downloads  >"$PARTS/downloads.tsv"      2>/dev/null &
scan_private_tmp    >"$PARTS/privatetmp.tsv"     2>/dev/null &
scan_user_tmpdir    >"$PARTS/usertmpdir.tsv"     2>/dev/null &
python3 "$(dirname "$0")/worktrees.py" scan >"$PARTS/worktrees.tsv" 2>/dev/null &
scan_map            >"$RUN_DIR/map.tsv"          2>/dev/null &
wait
write_disk_facts

cat "$PARTS/trash.tsv" "$PARTS/pkg.tsv" "$PARTS/xcode.tsv" "$PARTS/nodemodules.tsv" "$PARTS/dev.tsv" \
    "$PARTS/docker.tsv" "$PARTS/ios.tsv" "$PARTS/caches.tsv" "$PARTS/logs.tsv" \
    "$PARTS/usertmpdir.tsv" "$PARTS/privatetmp.tsv" "$PARTS/worktrees.tsv" \
    "$PARTS/bigfiles.tsv" "$PARTS/downloads.tsv" 2>/dev/null \
  | awk -F'\t' '!seen[$9]++' >"$RUN_DIR/scan.tsv"
rm -rf "$PARTS"

df -k "$(data_mount)" | awk 'NR==2 {print $4 * 1024}' >"$RUN_DIR/free-before"

log "found $(wc -l <"$RUN_DIR/scan.tsv" | tr -d ' ') items"
printf '%s\n' "$RUN_DIR"
