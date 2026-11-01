#!/usr/bin/env bash
# Fork-only (Khang5687/paseo); never upstreamed.
# Syncs fork main with upstream (through scripts/fork-sync.mjs, which only moves main when
# every fork check passes), builds the macOS desktop app from it, and installs it to
# /Applications/Paseo.app. Remote daemon hosts (one SSH alias per line in ~/.paseo-fork-remotes)
# get the same main built, and switched over on install (scripts/fork-remote-daemon.sh).
# See "Running the fork" in CLAUDE.md.
#
#   scripts/fork-update.sh               sync + build + install
#   scripts/fork-update.sh --no-sync     build the current checkout (installs when Paseo is not running)
#   scripts/fork-update.sh --build-only  build and smoke-launch the Mac app only: no remote builds,
#                                        never installs (scripts/fork-build.mjs runs this)
#   scripts/fork-update.sh --install     install the last build only
set -euo pipefail

INSTALL_PATH="/Applications/Paseo.app"
REMOTES_FILE="$HOME/.paseo-fork-remotes"

remote_hosts() {
  [[ -f $REMOTES_FILE ]] || return 0
  grep -vE '^\s*(#|$)' "$REMOTES_FILE"
}

# timed <name> <command...>: runs the command, logs how long it took, keeps its exit status.
timed() {
  local name="$1" start=$SECONDS status=0
  shift
  "$@" || status=$?
  if [[ $status == 0 ]]; then
    echo "[fork-update] $name: $((SECONDS - start))s" >&2
  else
    echo "[fork-update] $name: failed (exit $status) after $((SECONDS - start))s" >&2
  fi
  return "$status"
}

cd "$(git rev-parse --show-toplevel)"

sync=1
build=1
remotes=1
install=1
case "${1:-}" in
  "") ;;
  --no-sync) sync=0 ;;
  --build-only) sync=0 remotes=0 install=0 ;;
  --install) sync=0 build=0 ;;
  *) echo "usage: $0 [--no-sync | --build-only | --install]" >&2; exit 2 ;;
esac

if [[ $sync == 1 ]]; then
  if [[ "$(git branch --show-current)" != "main" ]]; then
    echo "Check out fork main first (git checkout main)." >&2
    exit 1
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Working tree has uncommitted changes; commit or stash them first." >&2
    exit 1
  fi
  # Merges in the ../paseo-sync worktree, runs fork-check, and pushes only if it passes.
  timed "fork-sync" node scripts/fork-sync.mjs --apply
  git pull --ff-only origin main
fi

arch="$(uname -m)"
[[ $arch == "x86_64" ]] && arch="x64"
built_app="packages/desktop/release/mac-${arch}/Paseo.app"

if [[ $build == 1 ]]; then
  # The steps of `npm run build:desktop`, minus its clean rebuild of every workspace package:
  # fork-prepare rebuilds those only when their sources changed, and an Android build running
  # beside this one reads their dist/ folders. If upstream changes either script, copy the change
  # here.
  root_chain='npm run build:app-deps:clean && cd packages/app && cross-env PASEO_WEB_PLATFORM=electron npx expo export --platform web && cd ../.. && npm run build --workspace=@getpaseo/desktop --'
  desktop_chain='npm --prefix ../.. run build:server:clean && npm run build:main && electron-builder --config electron-builder.yml'
  if [[ "$(node -p 'require("./package.json").scripts["build:desktop"]')" != "$root_chain" ||
    "$(node -p 'require("./packages/desktop/package.json").scripts.build')" != "$desktop_chain" ]]; then
    echo "build:desktop changed upstream; update the copy of its steps in $0." >&2
    exit 1
  fi
  timed "prepare" node scripts/fork-prepare.mjs
  (
    cd packages/app
    timed "expo export web" env PASEO_WEB_PLATFORM=electron npx expo export --platform web
  )
  timed "desktop build:main" npm run build:main --workspace=@getpaseo/desktop
  # Signing is ad-hoc: never pick up whatever certificate is in the keychain.
  # Hardened runtime must be off: with ad-hoc signatures every binary has no Team ID,
  # so library validation refuses to load Electron Framework and the app cannot open.
  # --dir writes no app-update.yml, so the built app has no update feed and cannot
  # auto-update back to stock Paseo.
  # PASEO_DESKTOP_SMOKE launches the packaged app (isolated home and port) after
  # signing and fails the build if it does not start, so a broken app is never installed.
  (
    cd packages/desktop
    timed "electron-builder + smoke" env CSC_IDENTITY_AUTO_DISCOVERY=false PASEO_DESKTOP_SMOKE=1 \
      npx electron-builder --config electron-builder.yml \
      --mac --dir "--${arch}" \
      -c.mac.identity=- \
      -c.mac.hardenedRuntime=false \
      -c.mac.notarize=false
  )
fi

if [[ $build == 1 && $remotes == 1 ]]; then
  # Remote daemons build origin/main, which matches this checkout after the sync above.
  for host in $(remote_hosts); do
    timed "remote build $host" scripts/fork-remote-daemon.sh "$host" build ||
      echo "Remote daemon build on $host failed; the Mac build continues." >&2
  done
fi

if [[ $install == 0 ]]; then
  echo "Build ready at $built_app (not installed: --build-only)."
  exit 0
fi

# Switching a remote daemon is part of installing: the owner picks the moment. It refuses while
# agents on that host are working and skips hosts already running this build.
if [[ $sync == 1 || $build == 0 ]]; then
  for host in $(remote_hosts); do
    scripts/fork-remote-daemon.sh "$host" restart || echo "Remote daemon on $host not switched (see above)." >&2
  done
fi

if [[ ! -d $built_app ]]; then
  echo "No build at $built_app; run without --install first." >&2
  exit 1
fi

# --install skips the build-time smoke launch, so re-check what would break opening.
codesign --verify --deep --strict "$built_app"
if codesign -dv "$built_app/Contents/MacOS/Paseo" 2>&1 | grep -q "flags=.*runtime"; then
  echo "$built_app is ad-hoc signed with hardened runtime and will not open. Rebuild." >&2
  exit 1
fi

# The daemon outlives the window and runs as "Paseo Helper", so check every Paseo
# process, not just the app window.
if pgrep -xq Paseo || pgrep -xq "Paseo Helper" || pgrep -qf "^${INSTALL_PATH}/"; then
  echo "Build ready at $built_app."
  echo "Paseo is still running from $INSTALL_PATH. Quit Paseo and stop its daemon"
  echo "(paseo daemon stop; this stops every running agent), then run: $0 --install"
  exit 0
fi

backup_path="${INSTALL_PATH%.app}.previous.app"
rm -rf "$backup_path"
if [[ -d $INSTALL_PATH ]]; then
  mv "$INSTALL_PATH" "$backup_path"
fi
ditto "$built_app" "$INSTALL_PATH"
echo "Installed $(defaults read "$INSTALL_PATH/Contents/Info" CFBundleShortVersionString) at $INSTALL_PATH from $(git rev-parse --short HEAD)."
echo "Previous app kept at $backup_path. To roll back: quit Paseo, paseo daemon stop,"
echo "then: rm -rf $INSTALL_PATH && mv $backup_path $INSTALL_PATH"
