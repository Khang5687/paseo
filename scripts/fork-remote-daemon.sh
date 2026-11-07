#!/usr/bin/env bash
# Fork-only (Khang5687/paseo); never upstreamed.
# Runs fork main's daemon on a Linux SSH host (e.g. Omen) in place of its npm daemon, so agents on
# that host get the fork's daemon features (the daemon-owned message queue) and keep them while
# this Mac sleeps. See "Running the fork" in CLAUDE.md.
#
#   scripts/fork-remote-daemon.sh <ssh-host> build                build origin/main on the host
#   scripts/fork-remote-daemon.sh <ssh-host> restart [--now]      switch the host daemon to the newest build
#   scripts/fork-remote-daemon.sh <ssh-host> rollback [--now]     switch back to the previous build
#   scripts/fork-remote-daemon.sh <ssh-host> npm [--now]          drop the fork, run the host's npm daemon again
#   scripts/fork-remote-daemon.sh <ssh-host> status               builds, running daemon, waiting switch
#   scripts/fork-remote-daemon.sh <ssh-host> nightly on|off       at 04:00, switch to a waiting build
#
# restart, rollback and npm never interrupt working agents: they return at once and leave a waiter
# on the host that switches the daemon once nothing is working (no agent running or initializing,
# no running provider subagent, no pending permission, no queued message about to send, no
# schedule run in progress), polling every 30s. Its log is ~/paseo-fork/swap.log on the host. A
# newer request replaces a waiting one. --now switches immediately; restart recovery resumes the
# agents it interrupts. Every switch runs detached from the SSH session (--now follows its log),
# so a dropped connection cannot stop it halfway.
#
# nightly on installs a systemd user timer (paseo-fork-nightly.timer) that, at 04:00 host time,
# starts the same waiting switch as restart when a build waits (next differs from current) and no
# switch is queued yet. Nothing happens when no build waits or the host runs its npm daemon. The
# waiter runs inside the timer's own service, so it never sits in paseo.service's control group.
#
# A switch stops the daemon with --keep-terminals and starts the unit again, so terminals survive
# (the drop-in sets KillMode=process: systemd would otherwise kill the terminal worker with the
# rest of the unit's processes). A switch that ends with the daemon stopped, for any reason short
# of SIGKILL, starts the unit on its way out; a restart that finds nothing to switch but the
# daemon stopped starts it too.
#
# Host layout: ~/paseo-fork/repo is a clone of the fork; each build is a detached worktree in
# ~/paseo-fork/releases/<sha> with its own node_modules. ~/paseo-fork/current and
# ~/paseo-fork/previous are symlinks to builds. A systemd drop-in
# (~/.config/systemd/user/paseo.service.d/fork.conf) points the host's existing paseo.service at
# ~/paseo-fork/current, so the owner's unit file stays untouched. Building never touches the
# running daemon: Node resolves the release's real path at start, so moving `current` only takes
# effect on restart. ~/paseo-fork/bin holds this script's host side and its idle check, copied on
# every call.
set -euo pipefail

usage() {
  echo "usage: $0 <ssh-host> build | status | restart [--now] | rollback [--now] | npm [--now] | nightly on|off" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
host="$1"
action="$2"
now="${3:-}"
case "$action" in
  build | status) [[ -z $now ]] || usage ;;
  restart | rollback | npm) [[ -z $now || $now == "--now" ]] || usage ;;
  nightly) [[ $now == on || $now == off ]] || usage ;;
  *) usage ;;
esac

cd "$(git rev-parse --show-toplevel)"
sha=""
if [[ $action == "build" ]]; then
  git fetch --quiet origin
  sha="$(git rev-parse origin/main)"
fi
origin_url="$(git remote get-url origin)"
case "$origin_url" in
  git@github.com:*) origin_url="https://github.com/${origin_url#git@github.com:}" ;;
esac

# The host side, written to ~/paseo-fork/bin/fork-remote-daemon-host.sh on every call so a waiter
# can outlive this SSH session.
host_program() {
  cat <<'REMOTE'
# Strict mode stays inside this subshell: a login shell runs ~/.bash_logout on exit, and a failing
# command there (Ubuntu's clear_console without a terminal) would otherwise replace the exit code.
(
set -euo pipefail
action="$1" now="$2" sha="$3" origin_url="$4"
root="$HOME/paseo-fork"
unit_dir="$HOME/.config/systemd/user/paseo.service.d"
dropin="$unit_dir/fork.conf"
self="$root/bin/fork-remote-daemon-host.sh"
lock_dir="$root/swap.lock"
poll_seconds="${FORK_DAEMON_POLL_SECONDS:-30}"
confirm_seconds="${FORK_DAEMON_CONFIRM_SECONDS:-5}"

say() { echo "[$(hostname) $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

cli_of() { echo "$1/packages/cli/bin/paseo"; }

running_cli() {
  if [[ -x $root/current/packages/cli/bin/paseo && -f $dropin ]]; then
    echo "$root/current/packages/cli/bin/paseo"
  else
    command -v paseo || true
  fi
}

# What keeps the daemon busy, one line each; exit 0 idle, 1 busy, 2 could not check. Uses the
# idle check of a fork build (it needs that build's client); a host with no fork build falls back
# to the agents the CLI reports as working.
idle_check() {
  local modules=""
  for link in next current; do
    if [[ -f $root/$link/packages/client/dist/node/index.js ]]; then
      modules="$(readlink -f "$root/$link")"
      break
    fi
  done
  if [[ -n $modules ]]; then
    node "$root/bin/fork-daemon-idle.mjs" --modules "$modules" --home "$HOME/.paseo"
    return
  fi
  local busy
  busy="$({ "$(running_cli)" ls -a -g --json 2>/dev/null || echo "[]"; } | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let agents = [];
      try { agents = JSON.parse(s); } catch {}
      for (const a of agents.filter((a) => ["running", "initializing"].includes(a.status)))
        console.log(`agent ${a.shortId} ${a.name} is ${a.status}`);
    });')"
  [[ -z $busy ]] || { echo "$busy"; return 1; }
}

write_dropin() {
  mkdir -p "$unit_dir"
  cat >"$dropin" <<UNIT
# Written by the Paseo fork's scripts/fork-remote-daemon.sh. Delete this file (or run the
# script's "npm" action) to run the npm-installed daemon again.
[Service]
ExecStart=
ExecStart=/bin/bash -lc "exec %h/paseo-fork/current/packages/cli/bin/paseo daemon run"
Environment=PASEO_HOME=%h/.paseo
# A switch stops the daemon with --keep-terminals; the terminal worker outlives it and the next
# daemon adopts it. With the default (control-group) systemd kills the worker with the unit.
KillMode=process
UNIT
  systemctl --user daemon-reload
}

daemon_pid() { systemctl --user show -p MainPID --value paseo.service; }

# Set while the daemon is stopped by a switch and not yet started again, with the main pid it
# stopped; the exit guard reads both.
stopping=0
stopped_pid=0

# Waits until the unit serves again after a start; $1 is the main pid before the switch.
wait_until_serving() {
  local before="$1" after version expected=""
  if [[ -f $dropin ]]; then
    expected="$(node -p 'require(process.argv[1]).version' "$root/current/packages/cli/package.json" 2>/dev/null || true)"
  fi
  for _ in $(seq 1 60); do
    sleep 1
    after="$(daemon_pid)"
    [[ $after != "0" && $after != "$before" ]] || continue
    version="$("$(running_cli)" daemon status --json 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const j=JSON.parse(s);if(j.localDaemon==="running")console.log(j.daemonVersion)}catch{}})')"
    if [[ -n $version ]]; then
      if [[ -f $dropin ]]; then
        say "daemon running: version $version, pid $after, from $(readlink "$root/current")"
      else
        say "running the npm daemon again: version $version, pid $after"
      fi
      [[ -z $expected || $version == "$expected" ]] || say "warning: expected version $expected"
      return 0
    fi
  done
  say "daemon did not come back within 60s; see: journalctl --user -u paseo.service -n 50"
  return 1
}

# `daemon stop` returns when the daemon's supervisor exits; the unit's main process (the launcher
# around it) exits a moment later, and only then does systemd mark the unit inactive.
# `systemctl start` on a unit that is still active does nothing and succeeds, so a start sent in
# that moment is lost and the daemon stays down (the Omen on 2026-11-08: the worker exited at .367,
# the start ran in the same second, the unit went inactive at .567 and nothing started it).
# $1 is the main pid that was stopped. Returns 0 once the unit is down or already runs a new main
# pid (systemd restarted it after a failure; "activating" is that restart under way), 1 when the
# old pid is still up after 30 s.
wait_until_stopped() {
  local before="$1" state pid
  for _ in $(seq 1 100); do
    state="$(systemctl --user show -p ActiveState --value paseo.service)"
    [[ $state == active || $state == deactivating || $state == reloading ]] || return 0
    pid="$(daemon_pid)"
    [[ $pid == "0" || $pid == "$before" ]] || return 0
    sleep 0.3
  done
  return 1
}

# Stops the running daemon keeping its terminals, then starts the unit with what the drop-in
# (or its absence) now points at.
restart_daemon() {
  local before stop_cli
  before="$(daemon_pid)"
  stop_cli="${1:-$(running_cli)}"
  if [[ $before != "0" ]]; then
    stopping=1
    stopped_pid="$before"
    say "stopping daemon pid $before (terminals stay)"
    if ! "$stop_cli" daemon stop --keep-terminals --json >/dev/null 2>&1; then
      say "stop with --keep-terminals failed; restarting the unit (this closes terminals)"
      systemctl --user restart paseo.service
    elif ! wait_until_stopped "$before"; then
      say "paseo.service still up 30s after the stop; restarting the unit (this closes terminals)"
      systemctl --user restart paseo.service
    fi
  fi
  say "starting paseo.service"
  systemctl --user start paseo.service
  stopping=0
  wait_until_serving "$before"
}

# Exit guard of every switch: releases the lock, and starts the unit when the switch dies between
# stopping the daemon and starting it again (a signal, a failing command under set -e). It waits for
# the stop to land first, for the same reason restart_daemon does; a start on a unit that already
# runs does nothing.
on_exit() {
  if [[ $stopping == 1 ]]; then
    wait_until_stopped "$stopped_pid" || true
    say "switch ended with the daemon stopped; starting paseo.service"
    systemctl --user start paseo.service ||
      say "could not start paseo.service; see: journalctl --user -u paseo.service -n 50"
  fi
  rm -rf "$lock_dir"
}

switch() {
  case "$1" in
    restart)
      [[ -L $root/next ]] || { say "nothing built yet; run the build action first"; exit 1; }
      if [[ "$(readlink "$root/current" 2>/dev/null)" == "$(readlink "$root/next")" && -f $dropin ]]; then
        # Takes the current drop-in (KillMode) without restarting anything.
        write_dropin
        if [[ "$(daemon_pid)" == "0" ]]; then
          say "$(basename "$(readlink "$root/current")") is current but the daemon is stopped; starting it"
          systemctl --user start paseo.service
          wait_until_serving 0
          return
        fi
        say "already running $(basename "$(readlink "$root/current")"); nothing to switch"
        return 0
      fi
      local stop_cli next current
      stop_cli="$(running_cli)"
      next="$(readlink "$root/next")"
      current="$(readlink "$root/current" 2>/dev/null || true)"
      if [[ -n $current && $current != "$next" ]]; then ln -sfn "$current" "$root/previous"; fi
      ln -sfn "$next" "$root/current"
      write_dropin
      restart_daemon "$stop_cli" && return 0
      [[ -n $current && $current != "$next" ]] || return 1
      say "$(basename "$next") did not come up; rolling back to $(basename "$current")"
      ln -sfn "$current" "$root/current"
      ln -sfn "$current" "$root/next"
      restart_daemon "$(cli_of "$next")" || true
      return 1
      ;;
    rollback)
      [[ -L $root/previous ]] || { say "no previous build to roll back to"; exit 1; }
      local stop_cli previous
      stop_cli="$(running_cli)"
      previous="$(readlink "$root/previous")"
      ln -sfn "$(readlink "$root/current")" "$root/previous"
      ln -sfn "$previous" "$root/current"
      ln -sfn "$previous" "$root/next"
      write_dropin
      restart_daemon "$stop_cli"
      ;;
    npm)
      local stop_cli
      stop_cli="$(running_cli)"
      rm -f "$dropin"
      systemctl --user daemon-reload
      restart_daemon "$stop_cli"
      ;;
  esac
}

lock_holder() {
  local pid
  pid="$(cat "$lock_dir/pid" 2>/dev/null || true)"
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then echo "$pid"; fi
}

# One switch at a time. A newer request replaces a waiting one; a switch in progress (it ignores
# TERM while it runs) finishes first.
take_lock() {
  local holder
  for _ in $(seq 1 240); do
    if mkdir "$lock_dir" 2>/dev/null; then
      # This runs in a subshell: $$ would name the outer bash, and killing that leaves this
      # waiter running without the lock.
      echo "${BASHPID:-$$}" >"$lock_dir/pid"
      trap on_exit EXIT
      return 0
    fi
    holder="$(lock_holder)"
    if [[ -z $holder ]]; then rm -rf "$lock_dir"; continue; fi
    kill "$holder" 2>/dev/null || true
    sleep 0.5
  done
  say "could not take the switch lock from pid $(lock_holder)"
  exit 1
}

wait_then_switch() {
  local what="$1" output status last=""
  take_lock
  trap 'exit 143' TERM
  say "waiting until nothing is working, then: $what"
  while :; do
    if [[ "$(systemctl --user show -p MainPID --value paseo.service)" == "0" ]]; then break; fi
    status=0
    output="$(idle_check 2>&1)" || status=$?
    if [[ $status == 0 ]]; then
      # A queued message leaves the queue a moment before its turn shows as running.
      sleep "$confirm_seconds" &
      wait $!
      status=0
      output="$(idle_check 2>&1)" || status=$?
      [[ $status != 0 ]] || break
    fi
    if [[ $output != "$last" ]]; then
      say "still working:"
      echo "$output" | sed 's/^/  /'
      last="$output"
    fi
    sleep "$poll_seconds" &
    wait $!
  done
  trap '' TERM
  switch "$what"
}

case "$action" in
  build)
    command -v git >/dev/null && command -v node >/dev/null && command -v npm >/dev/null ||
      { say "needs git, node and npm on the login PATH"; exit 1; }
    systemctl --user cat paseo.service >/dev/null 2>&1 ||
      { say "no systemd user unit paseo.service; install Paseo as a user service first"; exit 1; }
    mkdir -p "$root/releases"
    [[ -d $root/repo/.git ]] || git clone --quiet "$origin_url" "$root/repo"
    git -C "$root/repo" fetch --quiet origin
    release="$root/releases/$sha"
    if [[ -f $release/.fork-built ]]; then
      say "$sha already built"
    else
      rm -rf "$release"
      git -C "$root/repo" worktree prune
      git -C "$root/repo" worktree add --quiet --detach "$release" "$sha"
      say "building $sha (npm ci + build:server + build:plugin; several minutes)"
      (
        cd "$release"
        # The daemon never needs the Electron binary the desktop workspace downloads.
        ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
        npm run build:server
        npm run build:plugin
      ) >"$release.build.log" 2>&1 || { say "build failed; log: $release.build.log"; exit 1; }
      touch "$release/.fork-built"
    fi
    ln -sfn "$release" "$root/next"
    # Keep current, previous and next; every other build only costs disk.
    for dir in "$root"/releases/*/; do
      dir="${dir%/}"
      case "$dir" in
        "$(readlink "$root/current" 2>/dev/null)" | "$(readlink "$root/previous" 2>/dev/null)" | "$release") ;;
        *) git -C "$root/repo" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"; rm -f "$dir.build.log" ;;
      esac
    done
    if [[ "$(readlink "$root/current" 2>/dev/null)" == "$release" && -f $dropin ]]; then
      say "$sha is already the running build"
    else
      say "built $sha; switch to it with the restart action"
    fi
    ;;
  status)
    for link in current previous next; do
      target="$(readlink "$root/$link" 2>/dev/null || true)"
      say "$link: ${target##*/}"
    done
    say "daemon: $("$(running_cli)" daemon status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const j=JSON.parse(s);console.log(j.localDaemon+" "+(j.daemonVersion??""))}catch{console.log("unknown")}})')"
    say "waiting switch: $(lock_holder)"
    ;;
  restart | rollback | npm)
    if [[ $now == "--now" ]]; then
      # Runs detached like a waiter, so closing this SSH session cannot stop it halfway; this side
      # follows its lines in the log and returns its exit code.
      touch "$root/swap.log"
      from="$(($(stat -c %s "$root/swap.log") + 1))"
      nohup setsid bash -l "$self" "now-$action" "" "" "" >>"$root/swap.log" 2>&1 </dev/null &
      switcher=$!
      tail -c "+$from" --pid="$switcher" -f "$root/swap.log" || true
      wait "$switcher"
    else
      nohup setsid bash -l "$self" "wait-$action" "" "" "" >>"$root/swap.log" 2>&1 </dev/null &
      say "switches ($action) once nothing on this host is working; log: $root/swap.log"
    fi
    ;;
  now-restart | now-rollback | now-npm)
    take_lock
    trap '' TERM
    switch "${action#now-}"
    ;;
  wait-restart | wait-rollback | wait-npm)
    wait_then_switch "${action#wait-}"
    ;;
  nightly)
    user_units="$HOME/.config/systemd/user"
    if [[ $now == on ]]; then
      mkdir -p "$user_units"
      # Oneshot with no start timeout: the waiter runs in this service until nothing is working.
      # 143 is a newer restart request replacing this waiter (take_lock sends TERM).
      cat >"$user_units/paseo-fork-nightly.service" <<'UNIT'
# Written by the Paseo fork's scripts/fork-remote-daemon.sh ("nightly off" removes it).
[Unit]
Description=Paseo fork: switch to a waiting build once nothing is working
[Service]
Type=oneshot
TimeoutStartSec=infinity
SuccessExitStatus=143
ExecStart=/bin/bash -l %h/paseo-fork/bin/fork-remote-daemon-host.sh nightly-check - - -
StandardOutput=append:%h/paseo-fork/swap.log
StandardError=append:%h/paseo-fork/swap.log
UNIT
      cat >"$user_units/paseo-fork-nightly.timer" <<'UNIT'
# Written by the Paseo fork's scripts/fork-remote-daemon.sh ("nightly off" removes it).
[Unit]
Description=Paseo fork: nightly switch to a waiting build at 04:00
[Timer]
OnCalendar=*-*-* 04:00:00
[Install]
WantedBy=timers.target
UNIT
      systemctl --user daemon-reload
      systemctl --user enable --now paseo-fork-nightly.timer
      say "nightly switch on; next: $(systemctl --user show -p NextElapseUSecRealtime --value paseo-fork-nightly.timer)"
    else
      systemctl --user disable --now paseo-fork-nightly.timer 2>/dev/null || true
      rm -f "$user_units/paseo-fork-nightly.service" "$user_units/paseo-fork-nightly.timer"
      systemctl --user daemon-reload
      say "nightly switch off"
    fi
    ;;
  nightly-check)
    next="$(readlink "$root/next" 2>/dev/null || true)"
    if [[ ! -f $dropin ]]; then
      say "nightly: the npm daemon runs here; nothing to switch"
    elif [[ -z $next || $next == "$(readlink "$root/current" 2>/dev/null)" ]]; then
      say "nightly: no build waiting"
    elif [[ -n "$(lock_holder)" ]]; then
      say "nightly: a switch already waits (pid $(lock_holder))"
    else
      say "nightly: $(basename "$next") waits"
      wait_then_switch restart
    fi
    ;;
esac
)
exit $?
REMOTE
}

remote_dir='$HOME/paseo-fork/bin'
# Upload the host side and the idle check, each written beside its target and renamed over it so
# a waiting switch keeps the file it started from.
{
  echo "mkdir -p $remote_dir"
  for name in fork-remote-daemon-host.sh fork-daemon-idle.mjs; do
    echo "cat >$remote_dir/.$name.tmp <<'FORK_FILE_END'"
    if [[ $name == fork-remote-daemon-host.sh ]]; then host_program; else cat scripts/fork-daemon-idle.mjs; fi
    echo "FORK_FILE_END"
    echo "mv -f $remote_dir/.$name.tmp $remote_dir/$name"
  done
} | ssh "$host" "bash -s" || { echo "could not copy the host side to $host" >&2; exit 1; }

# A login shell puts the host's node (mise, nvm) on PATH, the same way paseo.service starts the
# daemon. ssh joins its arguments into one command line, so each one is quoted (an empty one would
# otherwise vanish). The host has no credentials for the fork; it clones over public HTTPS.
ssh "$host" "bash -l $remote_dir/fork-remote-daemon-host.sh $(printf '%q ' "$action" "$now" "$sha" "$origin_url")" </dev/null
