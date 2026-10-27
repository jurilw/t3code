#!/usr/bin/env bash
# Release gate: every patched feature must be present, wired in, and pass its tests.
# Used by .github/workflows/release.yml and by selfrepair/selfrepair.sh, so CI and
# local repair check exactly the same thing.
#
# Usage: ci/gate.sh <patched upstream checkout with dependencies installed>
# Exit 0 only if all checks pass.
set -euo pipefail

src="${1:?usage: ci/gate.sh <src-dir>}"
cd "$src"
if ! command -v vp >/dev/null 2>&1; then
  export PATH="$PWD/node_modules/.bin:$PATH"
fi

fail() {
  echo "GATE FAIL: $*" >&2
  exit 1
}

echo "== wiring: each feature is reachable from the app, not just present as a module"
grep -q "<BurnRateMeter" apps/web/src/components/chat/ComposerFooterControls.tsx ||
  fail "burn meter not rendered in the composer footer"
grep -q "usageLimitsProvider=" apps/web/src/components/chat/ChatComposer.tsx ||
  fail "burn meter not fed by ChatComposer"
grep -q "<DictationButton" apps/web/src/components/chat/ChatComposer.tsx ||
  fail "dictation button not rendered in ChatComposer"
grep -q "useIsDictating" apps/web/src/components/chat/ChatComposer.tsx ||
  fail "composer does not stay open while dictating"
grep -q "transcribeDictation" apps/desktop/src/preload.ts ||
  fail "dictation bridge not exposed by the preload"
grep -q "ipc.handle(transcribeDictation)" apps/desktop/src/ipc/DesktopIpcHandlers.ts ||
  fail "dictation IPC handler not registered"
grep -q "resyncLegacyV1Threads" apps/server/src/persistence/initializeV2Database.ts ||
  fail "legacy V1 thread import not hooked into startup"

echo "== tests"
# Run each package's tests from its own directory, so vitest loads only that package's config.
# From the repo root, vite.config.ts declares every app as a vitest project, and vitest loads
# all project configs before any --project or file filter applies. Since v0.1.3 that includes
# apps/mobile, whose config requires @babel/core, and release.yml does not install apps/mobile
# (Startup Error: Cannot find module '@babel/core', run 40563357027).
pkg_tests() {
  local dir="$1"
  shift
  (cd "$dir" && vp test run "$@") || fail "tests failed in $dir"
}
pkg_tests apps/web --project unit   src/components/chat/BurnRateMeter.logic.test.ts   src/components/chat/dictationSession.test.ts   src/components/chat/dictationAvailability.test.ts
pkg_tests apps/desktop src/dictation/whisperTranscription.test.ts
pkg_tests apps/server   src/persistence/legacyV1Resync.test.ts   src/persistence/initializeV2Database.test.ts

echo "== typecheck"
for package in @t3tools/contracts @t3tools/web @t3tools/desktop t3; do
  log="$(mktemp)"
  if ! vp run --filter "$package" typecheck >"$log" 2>&1; then
    grep -E "error" "$log" | grep -v "suggestion" >&2 || tail -40 "$log" >&2
    fail "typecheck failed for $package"
  fi
  rm -f "$log"
done

echo "GATE PASS"
