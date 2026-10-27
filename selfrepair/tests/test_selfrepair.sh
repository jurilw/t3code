#!/usr/bin/env bash
# Tests selfrepair/selfrepair.sh end to end against local stubs: fake upstream, fake fork
# (bare repos under a temp dir), a stub `gh`, a stub `pnpm` and a stub gate. Never touches
# GitHub, ~/src or ~/.local/state. Run: bash selfrepair/tests/test_selfrepair.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/selfrepair.sh"
T="$(mktemp -d /tmp/test-selfrepair.XXXXXX)"
[ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT # KEEP=1 keeps $T for debugging
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
TAG=v9.9.9
pass=0 failn=0
ok() { echo "ok   - $*"; pass=$((pass + 1)); }
no() { echo "FAIL - $*"; failn=$((failn + 1)); }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else no "$what"; fi; }

# ---- stubs
mkdir -p "$T/bin" "$T/home"
cat >"$T/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "gh $*" >>"$STUB_DIR/gh.calls"
case "$1 $2" in
  "api repos/pingdotgg/t3code/releases/latest") echo "$STUB_TAG" ;;
  "release list") ;;
  "run list")
    if [[ " $* " == *" --commit "* ]]; then [ -z "${STUB_RUN:-}" ] || echo "$STUB_RUN"; else echo 0; fi ;;
  "run view") for i in $(seq 1 100); do echo "build log line $i"; done ;;
  "workflow run") echo "$*" >>"$STUB_DIR/dispatched" ;;
  *) echo "gh stub: unexpected: $*" >&2; exit 1 ;;
esac
GH
printf '#!/bin/sh\nexit 0\n' >"$T/bin/pnpm"
chmod +x "$T/bin/gh" "$T/bin/pnpm"
export STUB_DIR="$T" STUB_TAG="$TAG"

# ---- fake upstream: a.txt = 1..10, then the tag prepends a line (so old patches apply with an offset)
git init -q --bare "$T/origin.git"
git init -q "$T/upstream" && cd "$T/upstream"
seq 1 10 >a.txt && git add a.txt && git commit -qm base
base=$(git rev-parse HEAD)
{ echo 0; seq 1 10; } >a.txt && git commit -qam "upstream moves" && git tag "$TAG"
git remote add origin "$T/origin.git" && git push -q origin HEAD:main --tags
mkpatch() { # mkpatch <start-commit> <out>
  git -C "$T/upstream" checkout -q "$1"
  sed -i 's/^5$/five/' "$T/upstream/a.txt"
  GIT_COMMITTER_DATE="2001-01-01T00:00:00Z" git -C "$T/upstream" commit -qam "feat: five"
  git -C "$T/upstream" format-patch -q -1 --stdout >"$2"
  git -C "$T/upstream" checkout -q -f "$TAG"
}
mkpatch "$TAG" "$T/clean.patch"   # applies cleanly: a refresh changes only the From line
mkpatch "$base" "$T/offset.patch" # applies with an offset: a refresh changes the hunk header

# ---- one fresh CI repo + fork + state per scenario
setup() { # setup <patch file> <dispatches already done>
  rm -rf "$T/ci" "$T/fork.git" "$T/state" "$T/work" "$T/dispatched" "$T/gh.calls"
  git init -q --bare "$T/fork.git"
  git init -q -b patched-releases "$T/ci"
  mkdir -p "$T/ci/patches" "$T/ci/ci" "$T/ci/selfrepair" "$T/state"
  cp "$1" "$T/ci/patches/0001-five.patch"
  printf '#!/usr/bin/env bash\necho GATE PASS\n' >"$T/ci/ci/gate.sh"
  echo "prompt" >"$T/ci/selfrepair/AGENT_PROMPT.md"
  git -C "$T/ci" add -A && git -C "$T/ci" commit -qm init
  git -C "$T/ci" remote add fork "$T/fork.git" && git -C "$T/ci" push -q fork patched-releases
  [ "$2" = 0 ] || echo "$2" >"$T/state/dispatches-$TAG"
}
run() {
  HOME="$T/home" PATH="$T/bin:$PATH" CI_REPO="$T/ci" UPSTREAM_REPO="$T/upstream" WORK="$T/work" \
    STATE_DIR="$T/state" CONFIG="$T/none.env" AGENT=none NOTIFY_CMD= \
    bash "$SCRIPT" >"$T/out" 2>&1
  rc=$?
  { echo "=== rc=$rc"; cat "$T/out"; } >>"$T/all.out"
}
commits() { git -C "$T/ci" rev-list --count HEAD; }
fork_head() { git -C "$T/fork.git" rev-parse patched-releases; }
stuckf="$T/state/STUCK-$TAG.md"

echo "# 1. header-only refresh + newest release run for HEAD failed -> STUCK with log, no commit, no dispatch"
setup "$T/clean.patch" 0; before=$(commits); STUB_RUN="4242 failure" run
check "exit 2 (stuck)" [ "$rc" = 2 ]
check "header-only change reported as unchanged" grep -q "patches unchanged" "$T/out"
check "STUCK names the failed run" grep -q "release run 4242 failed" "$stuckf"
check "STUCK has the last 60 log lines (41..100)" bash -c "grep -q 'build log line 100' '$stuckf' && grep -q 'build log line 41\$' '$stuckf' && ! grep -q 'build log line 40\$' '$stuckf'"
check "no commit" [ "$(commits)" = "$before" ]
check "no dispatch" [ ! -f "$T/dispatched" ]
check "patches/ left clean" [ -z "$(git -C "$T/ci" status --porcelain -- patches)" ]

echo "# 2. header-only refresh, no failed run for HEAD -> no commit, dispatch once"
setup "$T/clean.patch" 0; before=$(commits); STUB_RUN="" run
check "exit 0" [ "$rc" = 0 ]
check "no commit" [ "$(commits)" = "$before" ]
check "dispatched once" [ "$(wc -l <"$T/dispatched" 2>/dev/null)" = 1 ]
check "dispatch counter = 1" [ "$(cat "$T/state/dispatches-$TAG")" = 1 ]

echo "# 3. real content change but dispatch cap reached -> STUCK, no commit, no push"
setup "$T/offset.patch" 3; before=$(commits); fork_before=$(fork_head); STUB_RUN="" run
check "exit 2 (stuck)" [ "$rc" = 2 ]
check "STUCK says the cap" grep -q "dispatched 3 times" "$stuckf"
check "no commit" [ "$(commits)" = "$before" ]
check "no push" [ "$(fork_head)" = "$fork_before" ]
check "no dispatch" [ ! -f "$T/dispatched" ]
check "patches/ left clean" [ -z "$(git -C "$T/ci" status --porcelain -- patches)" ]

echo "# 4. real content change under the cap -> commit, push, dispatch"
setup "$T/offset.patch" 0; before=$(commits); STUB_RUN="4242 failure" run
check "exit 0" [ "$rc" = 0 ]
check "one new commit" [ "$(commits)" = $((before + 1)) ]
check "pushed" [ "$(fork_head)" = "$(git -C "$T/ci" rev-parse HEAD)" ]
check "dispatched once" [ "$(wc -l <"$T/dispatched" 2>/dev/null)" = 1 ]

echo "# $pass passed, $failn failed"
[ "$failn" = 0 ] || { echo "--- last output:"; tail -20 "$T/out"; exit 1; }
