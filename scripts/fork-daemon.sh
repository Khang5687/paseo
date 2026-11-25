#!/usr/bin/env bash
# Fork-only (Khang5687/paseo); never upstreamed.
# Runs the Mac daemon from its own copy of a built Paseo.app, outside /Applications, so a new app
# can be installed while agents work, and swaps the daemon to a new build once nothing is working.
# See "Running the fork" in CLAUDE.md.
#
#   scripts/fork-daemon.sh stage <Paseo.app> [label]   copy a build in as the next release
#   scripts/fork-daemon.sh swap [--now] [--max-wait <seconds>]
#                                  wait until no agent is working, then switch the daemon to the
#                                  next release; --now switches without waiting
#   scripts/fork-daemon.sh swap-when-idle [--max-wait <seconds>]
#                                  the same wait, in the background (log: <root>/swap.log)
#   scripts/fork-daemon.sh rollback [--now]             switch back to the previous release
#   scripts/fork-daemon.sh launch                       start the daemon from the current release
#   scripts/fork-daemon.sh status
#
# Layout (<root> = $PASEO_HOME/fork-daemon, ~/.paseo/fork-daemon by default):
#   releases/<id>/Paseo.app   an APFS clone of a built app (no extra disk until files diverge)
#   current, previous, next   symlinks to releases
#   bin/                      copies of this script and its two node helpers, run from there
#   launch                    what the desktop app runs to start its daemon (packages/desktop
#                             daemon/external-daemon-launcher.ts); remove <root> to undo
#
# A swap stops the daemon with --keep-terminals (terminals survive, the next daemon adopts them)
# and launches the next release; agents that were interrupted resume through restart recovery.
# A release whose daemon does not come up healthy is marked failed and the previous one is
# launched again.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ $(basename "$script_dir") == "bin" && $(basename "$(dirname "$script_dir")") == "fork-daemon" ]]; then
  root="$(dirname "$script_dir")"
  home="$(dirname "$root")"
else
  home="${PASEO_HOME:-$HOME/.paseo}"
  root="$home/fork-daemon"
fi
mkdir -p "$root/releases"
root="$(cd "$root" && pwd -P)"
home="$(cd "$home" && pwd -P)"
bin="$root/bin"
poll_seconds="${FORK_DAEMON_POLL_SECONDS:-30}"
confirm_seconds="${FORK_DAEMON_CONFIRM_SECONDS:-5}"

log() { echo "[fork-daemon $(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() {
  log "$*" >&2
  exit 1
}

helper_of() { echo "$1/Paseo.app/Contents/Frameworks/Paseo Helper.app/Contents/MacOS/Paseo Helper"; }
cli_of() { echo "$1/Paseo.app/Contents/Resources/bin/paseo"; }
link_target() { if [[ -L $root/$1 ]]; then readlink "$root/$1"; fi; }
# Runs node from a release: the app's Helper with ELECTRON_RUN_AS_NODE, as the desktop app does.
node_in() {
  local release="$1"
  shift
  ELECTRON_RUN_AS_NODE=1 "$(helper_of "$release")" "$@"
}

notify() {
  [[ ${FORK_DAEMON_NOTIFY:-1} == 1 ]] || return 0
  osascript -e "display notification \"$1\" with title \"Paseo fork daemon\"" >/dev/null 2>&1 || true
}

daemon_pid() {
  local pid
  pid="$(plutil -extract pid raw -o - "$home/paseo.pid" 2>/dev/null)" || return 0
  if kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
}

# Where the running daemon's supervisor executable lives: a release directory, "bundle:<path>"
# for a daemon the desktop app started from its own bundle, or nothing when no daemon runs.
daemon_release() {
  local pid exe rest
  pid="$(daemon_pid)"
  [[ -n $pid ]] || return 0
  exe="$(lsof -nP -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n '/^n/{s/^n//;p;q;}')" || true
  [[ -n $exe ]] || return 0
  if [[ $exe == "$root/releases/"* ]]; then
    rest="${exe#"$root/releases/"}"
    echo "$root/releases/${rest%%/*}"
  else
    echo "bundle:$exe"
  fi
}

describe() {
  case "$1" in
    "") echo "no daemon" ;;
    bundle:*) echo "the app bundle (${1#bundle:})" ;;
    *) echo "release $(basename "$1")" ;;
  esac
}

install_bin() {
  mkdir -p "$bin"
  if [[ $script_dir != "$bin" ]]; then
    # Write each copy beside its target and rename it over: a waiting swap keeps reading the
    # file it started from (bash reads scripts as it runs them).
    for file in fork-daemon.sh fork-daemon-launch.mjs fork-daemon-idle.mjs; do
      cp "$script_dir/$file" "$bin/.$file.tmp"
      chmod +x "$bin/.$file.tmp"
      mv -f "$bin/.$file.tmp" "$bin/$file"
    done
  fi
  cat >"$root/.launch.tmp" <<'LAUNCH'
#!/bin/sh
# Written by the Paseo fork's scripts/fork-daemon.sh. The desktop app runs this file to start its
# daemon from the current fork daemon release. Delete the fork-daemon directory to go back to the
# daemon inside the app bundle.
exec "$(dirname "$0")/bin/fork-daemon.sh" launch
LAUNCH
  chmod +x "$root/.launch.tmp"
  mv -f "$root/.launch.tmp" "$root/launch"
}

stage() {
  local app="$1" label="${2:-build}" id tmp
  [[ -d $app/Contents/MacOS ]] || die "no app at $app"
  codesign --verify --deep --strict "$app" || die "$app fails codesign --verify"
  if codesign -dv "$app/Contents/MacOS/Paseo" 2>&1 | grep -q "flags=.*runtime"; then
    die "$app is ad-hoc signed with hardened runtime and cannot load Electron Framework. Rebuild."
  fi
  id="$(date +%Y%m%d-%H%M%S)-$label"
  tmp="$root/releases/.$id.tmp"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  # clonefile(2): the copy shares blocks with the build until either changes.
  cp -cR "$app" "$tmp/Paseo.app" 2>/dev/null || ditto "$app" "$tmp/Paseo.app"
  plutil -extract CFBundleShortVersionString raw -o - "$tmp/Paseo.app/Contents/Info.plist" >"$tmp/version"
  mv "$tmp" "$root/releases/$id"
  install_bin
  ln -sfn "$root/releases/$id" "$root/next"
  log "staged release $id ($(cat "$root/releases/$id/version"))"
}

launch() {
  local current pid
  pid="$(daemon_pid)"
  if [[ -n $pid ]]; then
    log "daemon already running (pid $pid, $(describe "$(daemon_release)"))"
    return 0
  fi
  current="$(link_target current)"
  if [[ -z $current && -n $(link_target next) ]]; then
    current="$(link_target next)"
    ln -sfn "$current" "$root/current"
  fi
  [[ -n $current && -d $current/Paseo.app ]] || die "no release to launch; stage one first"
  [[ ! -e $current/.failed ]] || die "release $(basename "$current") failed its last start; run rollback or stage a new build"
  node_in "$current" "$bin/fork-daemon-launch.mjs" "$current/Paseo.app" "$home" \
    "$root/current/Paseo.app/Contents/Resources/bin/paseo"
}

# Healthy: the daemon answers status as running, from this release, at this release's version.
healthy() {
  local release="$1" status_file running version expected
  status_file="$(mktemp)"
  for _ in $(seq 1 30); do
    if "$(cli_of "$release")" daemon status --home "$home" --json >"$status_file" 2>/dev/null &&
      [[ "$(plutil -extract localDaemon raw -o - "$status_file" 2>/dev/null)" == "running" ]]; then
      running="$(daemon_release)"
      version="$(plutil -extract daemonVersion raw -o - "$status_file" 2>/dev/null || true)"
      expected="$(cat "$release/version")"
      rm -f "$status_file"
      if [[ $running != "$release" ]]; then
        log "daemon runs from $(describe "$running"), expected release $(basename "$release")"
        return 1
      fi
      if [[ ${version#v} != "${expected#v}" ]]; then
        log "daemon reports version $version, expected $expected"
        return 1
      fi
      log "daemon healthy: pid $(daemon_pid), version $version, release $(basename "$release")"
      return 0
    fi
    sleep 1
  done
  rm -f "$status_file"
  log "daemon did not report running within 30s; see $home/daemon.log"
  return 1
}

stop_keeping_terminals() {
  local cli="$1" output
  if output="$("$cli" daemon stop --home "$home" --keep-terminals --json 2>&1)"; then return 0; fi
  log "daemon stop --keep-terminals failed: $output"
  return 1
}

# Switches the daemon to `next`. Returns 1 when it did not end on the next release.
swap_now() {
  local target running current previous
  target="$(link_target next)"
  [[ -n $target && -d $target/Paseo.app ]] || die "nothing staged; run stage first"
  [[ ! -e $target/.failed ]] || die "release $(basename "$target") failed before; stage a new build"
  running="$(daemon_release)"
  current="$(link_target current)"
  previous="$(link_target previous)"
  if [[ $running == "$target" ]]; then
    log "already running release $(basename "$target")"
    return 0
  fi
  # Point `current` at the new release first: a launch in the gap (the desktop's Start button)
  # then starts the new build instead of the old one.
  ln -sfn "$target" "$root/current"
  if [[ -n $running ]]; then
    log "stopping the daemon on $(describe "$running"), keeping terminals"
    if ! stop_keeping_terminals "$(cli_of "$target")"; then
      if [[ -n $current ]]; then ln -sfn "$current" "$root/current"; else rm -f "$root/current"; fi
      log "swap aborted; the daemon keeps running on $(describe "$running")"
      return 1
    fi
  fi
  if [[ -n $current && $current != "$target" ]]; then ln -sfn "$current" "$root/previous"; fi
  log "launching release $(basename "$target")"
  if launch && healthy "$target"; then
    log "swapped: $(describe "$running") -> release $(basename "$target")"
    notify "Daemon switched to $(basename "$target")"
    prune
    return 0
  fi
  touch "$target/.failed"
  log "release $(basename "$target") did not come up healthy; marked failed"
  if [[ -n $(daemon_pid) ]]; then stop_keeping_terminals "$(cli_of "$target")" || true; fi
  if [[ -n $current && $current != "$target" && -d $current/Paseo.app ]]; then
    ln -sfn "$current" "$root/current"
    ln -sfn "$current" "$root/next"
    if [[ -n $previous ]]; then ln -sfn "$previous" "$root/previous"; else rm -f "$root/previous"; fi
    log "rolling back to release $(basename "$current")"
    if launch && healthy "$current"; then
      notify "New daemon failed; rolled back to $(basename "$current")"
      return 1
    fi
  elif [[ $running == bundle:* ]]; then
    rm -f "$root/current"
    log "starting the app bundle's daemon again"
    running="${running#bundle:}"
    "${running%%.app/Contents/*}.app/Contents/Resources/bin/paseo" daemon start --home "$home" || true
  fi
  if [[ -z $(daemon_pid) ]]; then
    log "NO DAEMON IS RUNNING. Open Paseo (it starts one) or run: $bin/fork-daemon.sh launch"
    notify "No Paseo daemon is running; open Paseo"
  fi
  return 1
}

prune() {
  local keep in_use dir
  keep="$(link_target current) $(link_target previous) $(link_target next)"
  # A release stays while any process runs from it: a terminal worker the next daemon adopted
  # keeps running the Helper of the release that started it. Every process a release runs is its
  # Helper, so only those are checked (lsof over all processes takes minutes).
  in_use="$(for pid in $(pgrep -x "Paseo Helper" || true); do
    lsof -nP -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n '/^n/{s/^n//;p;q;}' || true
  done | sed -n "s|^$root/releases/\([^/]*\)/.*|\1|p" | sort -u)" || true
  for dir in "$root"/releases/*/; do
    dir="${dir%/}"
    [[ -d $dir ]] || continue
    [[ " $keep " == *" $dir "* ]] && continue
    grep -qxF "$(basename "$dir")" <<<"$in_use" && continue
    rm -rf "$dir"
    log "pruned release $(basename "$dir")"
  done
}

lock_dir="$root/swap.lock"
lock_holder() {
  local pid
  pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
}

# One swap at a time. With --now, a waiting swap is stopped and this one takes over; a swap
# already switching finishes first (it ignores TERM while it does).
acquire_lock() {
  local now="$1" holder
  for _ in $(seq 1 240); do
    if mkdir "$lock_dir" 2>/dev/null; then
      echo $$ >"$lock_dir/pid"
      trap 'rm -rf "$lock_dir"' EXIT
      return 0
    fi
    holder="$(lock_holder)"
    if [[ -z $holder ]]; then
      rm -rf "$lock_dir"
      continue
    fi
    if [[ $now != 1 ]]; then
      log "a swap is already waiting (pid $holder); it switches to the newest staged release"
      exit 0
    fi
    kill "$holder" 2>/dev/null || true
    sleep 0.5
  done
  die "could not take the swap lock from pid $(lock_holder)"
}

idle_check() {
  local release="$1"
  node_in "$release" "$bin/fork-daemon-idle.mjs" \
    --modules "$release/Paseo.app/Contents/Resources/app.asar" --home "$home"
}

swap() {
  local now=0 max_wait=0 started=$SECONDS target running output status last=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --now) now=1 ;;
      --max-wait) max_wait="${2:?--max-wait needs seconds}"; shift ;;
      *) die "unknown swap option $1" ;;
    esac
    shift
  done
  acquire_lock "$now"
  trap 'exit 143' TERM
  if [[ $now == 0 ]]; then
    while :; do
      target="$(link_target next)"
      [[ -n $target ]] || die "nothing staged; run stage first"
      running="$(daemon_release)"
      if [[ $running == "$target" ]]; then
        log "already running release $(basename "$target")"
        return 0
      fi
      [[ -n $running ]] || break
      status=0
      output="$(idle_check "$target" 2>&1)" || status=$?
      if [[ $status == 0 ]]; then
        # A queued message leaves the queue a moment before its turn shows as running.
        sleep "$confirm_seconds" &
        wait $!
        status=0
        output="$(idle_check "$target" 2>&1)" || status=$?
        [[ $status != 0 ]] || break
      fi
      if [[ $output != "$last" ]]; then
        log "waiting for idle before switching to release $(basename "$target"):"
        echo "$output" | sed 's/^/  /'
        last="$output"
      fi
      if [[ $max_wait != 0 && $((SECONDS - started)) -ge $max_wait ]]; then
        log "gave up after ${max_wait}s; the daemon stays on $(describe "$running")." \
          "Switch anyway (interrupts that work): $bin/fork-daemon.sh swap --now"
        exit 4
      fi
      sleep "$poll_seconds" &
      wait $!
    done
  fi
  # From here the daemon may be stopped; finish even if asked to stop.
  trap '' TERM
  swap_now
}

swap_when_idle() {
  local holder
  holder="$(lock_holder)"
  if [[ -n $holder ]]; then
    log "a swap is already waiting (pid $holder); it switches to the newest staged release"
    return 0
  fi
  nohup "$bin/fork-daemon.sh" swap "$@" >>"$root/swap.log" 2>&1 </dev/null &
  log "the daemon switches to release $(basename "$(link_target next)") once nothing is working" \
    "(waiter pid $!, log $root/swap.log)"
}

status() {
  local name target
  for name in current previous next; do
    target="$(link_target "$name")"
    printf '%-9s %s\n' "$name" "${target##*/}"
  done
  printf '%-9s %s\n' running "$(describe "$(daemon_release)")"
  printf '%-9s %s\n' waiter "$(lock_holder)"
}

action="${1:-}"
[[ $# -gt 0 ]] && shift
case "$action" in
  stage) stage "$@" ;;
  swap) swap "$@" ;;
  swap-when-idle) swap_when_idle "$@" ;;
  rollback)
    [[ -n $(link_target previous) ]] || die "no previous release"
    ln -sfn "$(link_target previous)" "$root/next"
    rm -f "$(link_target next)/.failed"
    if [[ ${1:-} == "--now" ]]; then swap --now; else swap_when_idle; fi
    ;;
  launch) launch ;;
  status) status ;;
  where)
    # For scripts: none, bundle (the daemon runs from an app bundle) or release.
    case "$(daemon_release)" in
      "") echo none ;;
      bundle:*) echo bundle ;;
      *) echo release ;;
    esac
    ;;
  *)
    echo "usage: $0 stage <Paseo.app> [label] | swap [--now] [--max-wait <s>] | swap-when-idle [--max-wait <s>] | rollback [--now] | launch | status | where" >&2
    exit 2
    ;;
esac
