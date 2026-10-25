#!/usr/bin/env bash
# Post-build gate: the bundles that go into the installer contain each patch.
# Catches a build that silently used stale or unpatched output.
#
# Usage: ci/verify-build.sh <patched upstream checkout after build-desktop-artifact>
set -euo pipefail

src="${1:?usage: ci/verify-build.sh <src-dir>}"
cd "$src"

check() {
  local what="$1" needle="$2"
  shift 2
  if grep -rqF --include='*.js' --include='*.mjs' --include='*.cjs' -- "$needle" "$@"; then
    echo "ok: $what"
  else
    echo "BUILD GATE FAIL: $what ('$needle' not found in $*)" >&2
    exit 1
  fi
}

check "burn meter in the web bundle" "Usage burn rate " apps/web/dist
check "dictation button in the web bundle" "composer-dictation-button" apps/web/dist
check "dictation IPC in the desktop main bundle" "desktop:transcribe-dictation" apps/desktop/dist-electron
check "dictation bridge in the preload bundle" "desktop:get-dictation-status" apps/desktop/dist-electron
check "legacy V1 thread import in the server bundle" "t3code_legacy_v1_resync" apps/server/dist
echo "BUILD GATE PASS"
