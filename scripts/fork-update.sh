#!/usr/bin/env bash
# Fork-only (Khang5687/paseo); never upstreamed.
# Syncs fork main with upstream (through scripts/fork-sync.mjs, which only moves main when
# every fork check passes), builds the macOS desktop app from it, and installs it to
# /Applications/Paseo.app. Remote daemon hosts (one SSH alias per line in ~/.paseo-fork-remotes)
# get the same main built, and switched over on install (scripts/fork-remote-daemon.sh).
# See "Running the fork" in CLAUDE.md.
#
# With a build host (one SSH alias in ~/.paseo-fork-build-host), the Mac does not build: "build it"
# runs there (scripts/fork-build.mjs), and the default mode and --install fetch the newest Mac app
# that host built from fork main, check its sha256 and signature, run the packaged smoke launch on
# it, and only then install it. On Linux this script only builds that Mac app (--build-only).
#
# Installing never interrupts agents. The daemon runs from its own copy of a build
# (scripts/fork-daemon.sh), so the app window restarts on the new build at once while the
# daemon keeps working; the daemon switches to the new build by itself once nothing is working.
#
#   scripts/fork-update.sh               sync + build + install (build host: fetch + install)
#   scripts/fork-update.sh --no-sync     build the current checkout and install it
#   scripts/fork-update.sh --build-only  build and smoke-launch the Mac app only: no remote builds,
#                                        never installs (scripts/fork-build.mjs runs this). On
#                                        Linux: build the Mac app tarball (scripts/fork-mac-app.mjs)
#   scripts/fork-update.sh --install     install the last build only (build host: fetch the newest
#                                        build of fork main, smoke it, install it)
#   scripts/fork-update.sh --fetch-only  fetch, check and smoke the build host's newest build;
#                                        never installs and never changes the checkout
#   scripts/fork-update.sh --restart-now switch the Mac daemon to the installed build now, without
#                                        waiting; interrupted agents resume through restart recovery
set -euo pipefail

# Overridable so the install path can be exercised against a scratch app and daemon home.
INSTALL_PATH="${PASEO_FORK_INSTALL_PATH:-/Applications/Paseo.app}"
REMOTES_FILE="${PASEO_FORK_REMOTES_FILE:-$HOME/.paseo-fork-remotes}"
BUILD_HOST_FILE="${PASEO_FORK_BUILD_HOST_FILE:-$HOME/.paseo-fork-build-host}"

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

if [[ "$(uname -s)" == "Linux" && "${1:-}" != "--build-only" ]]; then
  echo "On Linux this script only builds the Mac app (--build-only); install it on the Mac." >&2
  exit 2
fi

build_host=""
if [[ -f $BUILD_HOST_FILE ]]; then
  build_host="$(grep -vE '^\s*(#|$)' "$BUILD_HOST_FILE" | head -n 1 | tr -d '[:space:]')"
fi

sync=1
build=1
remotes=1
install=1
fetch=0
case "${1:-}" in
  "") ;;
  --no-sync) sync=0 ;;
  --build-only) sync=0 remotes=0 install=0 ;;
  --install) sync=0 build=0 ;;
  --fetch-only) sync=0 build=0 install=0 fetch=1 ;;
  --restart-now) exec scripts/fork-daemon.sh swap --now ;;
  *) echo "usage: $0 [--no-sync | --build-only | --install | --fetch-only | --restart-now]" >&2; exit 2 ;;
esac

# The default mode and --install take the build host's build in place of building here.
if [[ -n $build_host && $install == 1 && "${1:-}" != "--no-sync" ]]; then
  sync=0 build=0 fetch=1
fi
if [[ $fetch == 1 && -z $build_host ]]; then
  echo "No build host: put its SSH alias in $BUILD_HOST_FILE." >&2
  exit 2
fi

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
built_app="${PASEO_FORK_BUILT_APP:-packages/desktop/release/mac-${arch}/Paseo.app}"
build_label="$(git rev-parse --short HEAD)"

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
  if [[ "$(uname -s)" == "Linux" ]]; then
    # Cross-build for the Mac (arm64): natives swapped, ad-hoc signed with rcodesign, packed as a
    # tarball the Mac fetches. The smoke launch runs on the Mac before it installs.
    timed "mac app (linux cross-build)" node scripts/fork-mac-app.mjs
    exit 0
  fi
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

# What would keep an app from opening: a bad signature, or hardened runtime on an ad-hoc one.
check_signature() {
  codesign --verify --deep --strict "$1"
  if codesign -dv "$1/Contents/MacOS/Paseo" 2>&1 | grep -q "flags=.*runtime"; then
    echo "$1 is ad-hoc signed with hardened runtime and will not open. Rebuild." >&2
    return 1
  fi
}

json_field() { node -p 'require(process.argv[1])[process.argv[2]]' "$1" "$2"; }

# Fetches the build host's newest Mac app (for --install: the newest one built from pushed fork
# main without uncommitted changes) into $fetch_dir, checks its sha256 and signature, and runs the
# packaged smoke launch on it. Sets built_app and build_label.
fetch_dir="${TMPDIR:-/tmp}/paseo-fork-fetch"
fetch_build() {
  local builds meta="" candidate sha short dirty
  builds="$(ssh "$build_host" 'ls -1 ~/.paseo-fork-build/*/Paseo-mac-arm64.json 2>/dev/null | sort -r' </dev/null)"
  [[ -n $builds ]] || {
    echo "No Mac app build on $build_host yet; run node scripts/fork-build.mjs there." >&2
    return 1
  }
  rm -rf "$fetch_dir"
  mkdir -p "$fetch_dir"
  git fetch --quiet origin
  for candidate in $builds; do
    scp -q "$build_host:$candidate" "$fetch_dir/build.json"
    sha="$(json_field "$fetch_dir/build.json" sha)"
    dirty="$(json_field "$fetch_dir/build.json" dirty)"
    if [[ $dirty == false ]] && git merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then
      meta="$candidate"
      break
    fi
    if [[ $install == 0 ]]; then
      echo "Warning: $candidate is not a build of pushed fork main; --fetch-only checks it anyway." >&2
      meta="$candidate"
      break
    fi
    echo "Skipping $candidate: not a build of pushed fork main." >&2
  done
  [[ -n $meta ]] || {
    echo "No build of pushed fork main on $build_host; run node scripts/fork-build.mjs there." >&2
    return 1
  }
  short="${sha:0:9}"
  echo "Fetching $build_host:$meta (main $short, version $(json_field "$fetch_dir/build.json" version), built $(json_field "$fetch_dir/build.json" builtAt))."

  # The smoke launch drives the app with this checkout's client and plugin list, so for an
  # install the checkout moves to fork main first (as the default mode's sync always did).
  if [[ $install == 1 ]]; then
    if [[ "$(git branch --show-current)" != "main" || -n "$(git status --porcelain)" ]]; then
      echo "Check out fork main with a clean tree first; the smoke launch runs from it." >&2
      return 1
    fi
    git merge --ff-only --quiet origin/main
    timed "prepare" node scripts/fork-prepare.mjs
  elif [[ "$(git rev-parse HEAD)" != "$sha" ]]; then
    echo "Note: this checkout is at $(git rev-parse --short HEAD), the build at $short; the smoke runs from this checkout." >&2
  fi

  timed "download" scp -q "$build_host:${meta%/*}/$(json_field "$fetch_dir/build.json" tarball)" "$fetch_dir/Paseo.tgz"
  local want got
  want="$(json_field "$fetch_dir/build.json" sha256)"
  got="$(shasum -a 256 "$fetch_dir/Paseo.tgz" | cut -d' ' -f1)"
  if [[ $got != "$want" ]]; then
    echo "Download is corrupt: sha256 $got, the build host wrote $want." >&2
    rm -f "$fetch_dir/Paseo.tgz"
    return 1
  fi
  tar xzf "$fetch_dir/Paseo.tgz" -C "$fetch_dir"
  rm -f "$fetch_dir/Paseo.tgz"
  built_app="$fetch_dir/Paseo.app"
  build_label="$short"
  check_signature "$built_app"
  (
    cd packages/desktop
    timed "packaged smoke" node e2e/packaged-app-smoke.js --app "$built_app"
  )
}

if [[ $fetch == 1 ]]; then
  # Keep a fetched app only for --fetch-only; an install copies it in and deletes it.
  if [[ $install == 1 ]]; then trap 'rm -rf "$fetch_dir"' EXIT; fi
  fetch_build
fi

if [[ $install == 0 ]]; then
  if [[ $fetch == 1 ]]; then
    echo "Fetched and smoke-tested $built_app (not installed: --fetch-only)."
  else
    echo "Build ready at $built_app (not installed: --build-only)."
  fi
  exit 0
fi

# Remote daemons switch to the new build by themselves once nothing on that host is working.
if [[ $sync == 1 || $build == 0 ]]; then
  for host in $(remote_hosts); do
    scripts/fork-remote-daemon.sh "$host" restart || echo "Remote daemon on $host not switched (see above)." >&2
  done
fi

if [[ ! -d $built_app ]]; then
  echo "No build at $built_app; run without --install first." >&2
  exit 1
fi

# --install of a local build skips the build-time smoke launch, so re-check what would break opening.
check_signature "$built_app"

# The daemon part: copy the build in as the next daemon release. A running daemon switches to it
# once nothing is working; with none running, it starts now.
scripts/fork-daemon.sh stage "$built_app" "$build_label"
case "$(scripts/fork-daemon.sh where)" in
  none) scripts/fork-daemon.sh swap --now ;;
  release) scripts/fork-daemon.sh swap-when-idle ;;
  bundle)
    # A daemon the app started from its own bundle runs that bundle's code, so the bundle cannot be
    # replaced under it. It moves to its own release once idle; the window follows on a later run.
    scripts/fork-daemon.sh swap-when-idle
    echo "The daemon still runs from inside an app bundle, so $INSTALL_PATH was not replaced yet."
    echo "It moves to its own copy once no agent is working (log: ${PASEO_HOME:-$HOME/.paseo}/fork-daemon/swap.log)."
    echo "Then run $0 --install again to update the window. This happens once."
    exit 0
    ;;
esac

# The window part: quit the app window (the daemon runs elsewhere and keeps running), replace the
# bundle, and open it again. SIGTERM takes the app's normal quit path.
window_pids() { pgrep -f "^${INSTALL_PATH}/Contents/MacOS/Paseo" || true; }
reopen=0
if [[ -n $(window_pids) ]]; then
  reopen=1
  echo "Restarting the Paseo window on the new build; the daemon and its agents keep running."
  kill -TERM $(window_pids)
  for _ in $(seq 1 60); do
    [[ -n $(window_pids) ]] || break
    sleep 1
  done
fi
# Terminal workers started by an older daemon may still run the old bundle's Helper; they keep
# running from the moved bundle. Anything else from the bundle (the window, a daemon) blocks.
blocking="$(pgrep -fl "^${INSTALL_PATH}/" | grep -v -- "--paseo-terminal-worker" || true)"
if [[ -n $blocking ]]; then
  echo "Not replacing $INSTALL_PATH; these processes still run from it:" >&2
  echo "$blocking" >&2
  echo "Quit them, then run: $0 --install" >&2
  exit 1
fi

backup_path="${INSTALL_PATH%.app}.previous.app"
rm -rf "$backup_path"
if [[ -d $INSTALL_PATH ]]; then
  mv "$INSTALL_PATH" "$backup_path"
fi
ditto "$built_app" "$INSTALL_PATH"
echo "Installed $(defaults read "$INSTALL_PATH/Contents/Info" CFBundleShortVersionString) at $INSTALL_PATH from $build_label."
if [[ $reopen == 1 ]]; then open "$INSTALL_PATH"; fi
echo "Previous app kept at $backup_path. To roll back the window: quit Paseo, then"
echo "  rm -rf $INSTALL_PATH && mv $backup_path $INSTALL_PATH"
echo "To roll back the daemon: scripts/fork-daemon.sh rollback [--now]"
