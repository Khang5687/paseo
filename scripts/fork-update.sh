#!/usr/bin/env bash
# Fork-only (Khang5687/paseo); never upstreamed.
# Syncs fork main with upstream, builds the macOS desktop app from it, and installs it
# to /Applications/Paseo.app. See "Running the fork" in CLAUDE.md.
#
#   scripts/fork-update.sh            sync + build + install
#   scripts/fork-update.sh --no-sync  build + install the current checkout
#   scripts/fork-update.sh --install  install the last build only
set -euo pipefail

INSTALL_PATH="/Applications/Paseo.app"

cd "$(git rev-parse --show-toplevel)"

sync=1
build=1
case "${1:-}" in
  "") ;;
  --no-sync) sync=0 ;;
  --install) sync=0 build=0 ;;
  *) echo "usage: $0 [--no-sync | --install]" >&2; exit 2 ;;
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
  git pull --no-rebase origin main
  git fetch upstream
  git merge --no-ff --no-edit upstream/main
  git push origin main
fi

arch="$(uname -m)"
[[ $arch == "x86_64" ]] && arch="x64"
built_app="packages/desktop/release/mac-${arch}/Paseo.app"

if [[ $build == 1 ]]; then
  npm ci --no-audit --no-fund
  # Signing is ad-hoc: never pick up whatever certificate is in the keychain.
  # --dir writes no app-update.yml, so the built app has no update feed and cannot
  # auto-update back to stock Paseo.
  CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:desktop -- \
    --mac --dir "--${arch}" \
    -c.mac.identity=- \
    -c.mac.notarize=false
fi

if [[ ! -d $built_app ]]; then
  echo "No build at $built_app; run without --install first." >&2
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

rm -rf "$INSTALL_PATH"
ditto "$built_app" "$INSTALL_PATH"
echo "Installed $(defaults read "$INSTALL_PATH/Contents/Info" CFBundleShortVersionString) at $INSTALL_PATH from $(git rev-parse --short HEAD)."
