#!/usr/bin/env bash
# Fork-only (Khang5687/paseo); never upstreamed.
# Runs fork main's daemon on a Linux SSH host (e.g. Omen) in place of its npm daemon, so agents on
# that host get the fork's daemon features (the daemon-owned message queue) and keep them while
# this Mac sleeps. See "Running the fork" in CLAUDE.md.
#
#   scripts/fork-remote-daemon.sh <ssh-host> build        build origin/main on the host
#   scripts/fork-remote-daemon.sh <ssh-host> restart      switch the host daemon to the newest build
#   scripts/fork-remote-daemon.sh <ssh-host> rollback     switch back to the previous build
#   scripts/fork-remote-daemon.sh <ssh-host> npm          drop the fork, run the host's npm daemon again
#
# restart, rollback and npm restart the host daemon, which interrupts working agents; they refuse
# (exit 3) while any agent is working unless --force is passed.
#
# Host layout: ~/paseo-fork/repo is a clone of the fork; each build is a detached worktree in
# ~/paseo-fork/releases/<sha> with its own node_modules. ~/paseo-fork/current and
# ~/paseo-fork/previous are symlinks to builds. A systemd drop-in
# (~/.config/systemd/user/paseo.service.d/fork.conf) points the host's existing paseo.service at
# ~/paseo-fork/current, so the owner's unit file stays untouched. Building never touches the
# running daemon: Node resolves the release's real path at start, so moving `current` only takes
# effect on restart.
set -euo pipefail

usage() {
  echo "usage: $0 <ssh-host> build | restart [--force] | rollback [--force] | npm [--force]" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage
host="$1"
action="$2"
force="${3:-}"
case "$action" in
  build) [[ -z $force ]] || usage ;;
  restart | rollback | npm) [[ -z $force || $force == "--force" ]] || usage ;;
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

# The host has no credentials for the fork; it clones over public HTTPS. A login shell puts the
# host's node (mise, nvm) on PATH, the same way paseo.service starts the daemon. ssh joins its
# arguments into one command line, so each one is quoted (an empty one would otherwise vanish).
ssh "$host" "bash -l -s -- $(printf '%q ' "$action" "$force" "$sha" "$origin_url")" <<'REMOTE'
# Strict mode stays inside this subshell: a login shell runs ~/.bash_logout on exit, and a failing
# command there (Ubuntu's clear_console without a terminal) would otherwise replace the exit code.
(
set -euo pipefail
action="$1" force="$2" sha="$3" origin_url="$4"
root="$HOME/paseo-fork"
unit_dir="$HOME/.config/systemd/user/paseo.service.d"
dropin="$unit_dir/fork.conf"

say() { echo "[$(hostname)] $*"; }

cli_of() { echo "$1/packages/cli/bin/paseo"; }

# Agents the running daemon reports as busy; a restart interrupts their turns. Either CLI talks to
# the daemon on its port, so the npm one works before the first fork build is running.
busy_agents() {
  local cli
  cli="$(command -v paseo || true)"
  [[ -x $root/current/packages/cli/bin/paseo ]] && cli="$root/current/packages/cli/bin/paseo"
  { "$cli" ls -g --json 2>/dev/null || echo "[]"; } | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let agents = [];
      try { agents = JSON.parse(s); } catch {}
      for (const a of agents.filter((a) => ["running", "initializing"].includes(a.status)))
        console.log(`${a.shortId} ${a.name} (${a.status})`);
    });'
}

# Exits 3 when agents are working, since every action that calls this restarts the daemon.
guard_busy() {
  [[ $force != "--force" ]] || return 0
  local busy
  busy="$(busy_agents)"
  [[ -n $busy ]] || return 0
  say "not restarting: these agents are working and a restart interrupts them:"
  echo "$busy"
  say "rerun with --force when they are done"
  exit 3
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
UNIT
  systemctl --user daemon-reload
}

restart_daemon() {
  local before after version expected
  before="$(systemctl --user show -p MainPID --value paseo.service)"
  systemctl --user restart paseo.service
  expected="$(node -p 'require(process.argv[1]).version' "$root/current/packages/cli/package.json" 2>/dev/null || true)"
  for _ in $(seq 1 60); do
    sleep 1
    after="$(systemctl --user show -p MainPID --value paseo.service)"
    [[ $after != "0" && $after != "$before" ]] || continue
    version="$("$(cli_of "$root/current")" daemon status --json 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const j=JSON.parse(s);if(j.localDaemon==="running")console.log(j.daemonVersion)}catch{}})')"
    if [[ -n $version ]]; then
      say "daemon running: version $version, pid $after, from $(readlink "$root/current")"
      [[ -z $expected || $version == "$expected" ]] || say "warning: expected version $expected"
      return 0
    fi
  done
  say "daemon did not come back within 60s; see: journalctl --user -u paseo.service -n 50"
  return 1
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
  restart)
    [[ -L $root/next ]] || { say "nothing built yet; run the build action first"; exit 1; }
    if [[ $force != "--force" && "$(readlink "$root/current" 2>/dev/null)" == "$(readlink "$root/next")" && -f $dropin ]]; then
      say "already running $(basename "$(readlink "$root/current")"); nothing to switch"
      exit 0
    fi
    guard_busy
    next="$(readlink "$root/next")"
    current="$(readlink "$root/current" 2>/dev/null || true)"
    if [[ -n $current && $current != "$next" ]]; then ln -sfn "$current" "$root/previous"; fi
    ln -sfn "$next" "$root/current"
    write_dropin
    restart_daemon
    ;;
  rollback)
    [[ -L $root/previous ]] || { say "no previous build to roll back to"; exit 1; }
    previous="$(readlink "$root/previous")"
    guard_busy
    ln -sfn "$(readlink "$root/current")" "$root/previous"
    ln -sfn "$previous" "$root/current"
    ln -sfn "$previous" "$root/next"
    write_dropin
    restart_daemon
    ;;
  npm)
    guard_busy
    rm -f "$dropin"
    systemctl --user daemon-reload
    systemctl --user restart paseo.service
    sleep 5
    say "running the npm daemon again: $(paseo daemon status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{console.log(JSON.parse(s).daemonVersion)}catch{console.log("unknown")}})')"
    ;;
esac
)
exit $?
REMOTE
