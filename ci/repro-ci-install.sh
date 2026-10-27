#!/usr/bin/env bash
# Reproduce the release workflow's install + gate on pgx, without a full install hiding gaps.
#
# release.yml installs only the desktop/server/scripts/web dependency closures
# (vp install --filter=...), so packages outside them (e.g. apps/mobile since v0.1.3) have no
# node_modules in CI. A full local install hides that; this script does what CI does:
#   1. fresh clone of upstream <tag> under /tmp (shared objects from ~/src/t3code, no network)
#   2. apply patches/*.patch exactly like release.yml (skipping backports the tag already has)
#   3. install with release.yml's filters, read from release.yml itself
#   4. hide pnpm's root fallback dir node_modules/.pnpm/node_modules during `vp test` (see below)
#   5. run ci/gate.sh from this checkout
# Last line of output is the gate's own "GATE PASS" or "GATE FAIL: ...".
#
# Usage: ci/repro-ci-install.sh [tag]      (default: TAG env or v0.1.3)
#        KEEP=1 keeps the scratch dir; GATE=path/to/gate.sh tests another gate script;
#        CI_HOIST=1 keeps node_modules/.pnpm/node_modules (pgx behaviour, hides the CI failure).
set -uo pipefail

CI_REPO="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:-${TAG:-v0.1.3}}"
UPSTREAM_REPO="${UPSTREAM_REPO:-$HOME/src/t3code}"
GATE="${GATE:-$CI_REPO/ci/gate.sh}"
export PATH="$HOME/.local/bin:$PATH"
scratch="$(mktemp -d "/tmp/t3ci-repro-$TAG.XXXXXX")"
[ -n "${KEEP:-}" ] || trap 'rm -rf "$scratch"' EXIT
say() { echo "[repro $(date -u +%T)] $*" >&2; }
die() { echo "GATE FAIL: repro: $*"; exit 1; }

git -C "$UPSTREAM_REPO" rev-parse -q --verify "refs/tags/$TAG" >/dev/null ||
  die "tag $TAG not in $UPSTREAM_REPO (git -C $UPSTREAM_REPO fetch --tags)"
say "scratch $scratch, tag $TAG"
git clone -q --shared --no-checkout "$UPSTREAM_REPO" "$scratch/src" || die "clone failed"
git -C "$scratch/src" checkout -q "$TAG" || die "checkout $TAG failed"
git -C "$scratch/src" config user.name repro && git -C "$scratch/src" config user.email repro@localhost

for patch in "$CI_REPO"/patches/*.patch; do
  name="$(basename "$patch")"
  if [[ "$name" =~ ^[0-9]+-upstream-([0-9a-f]{7,40})- ]] &&
    git -C "$scratch/src" merge-base --is-ancestor "${BASH_REMATCH[1]}" "$TAG" 2>/dev/null; then
    say "skipping $name (tag has it)"; continue
  fi
  git -C "$scratch/src" am -q --3way "$patch" >&2 || die "patch does not apply: $name"
done

# The install line, verbatim from release.yml, so this script cannot drift from CI.
install_line="$(grep -E '^\s*run: vp install ' "$CI_REPO/.github/workflows/release.yml" | head -1 | sed -E 's/^\s*run: //')"
[ -n "$install_line" ] || die "no 'run: vp install' line in release.yml"
say "CI install: $install_line"
# vp is not on PATH on pgx. Its install is pnpm install with the same filters; use vp when present.
if command -v vp >/dev/null 2>&1; then cmd="$install_line"; else cmd="pnpm ${install_line#vp }"; fi
say "running: $cmd"
(cd "$scratch/src" && CI=true eval "$cmd" >"$scratch/install.log" 2>&1) || {
  tail -30 "$scratch/install.log" >&2; die "install failed"; }
for pkg in apps/web apps/desktop apps/server apps/mobile; do
  [ -d "$scratch/src/$pkg/node_modules" ] && say "$pkg: installed" || say "$pkg: NOT installed (as in CI)"
done

# Why step 4: on Linux, vite bundles a package's vite.config.ts and loads it from the root
# node_modules, so a package that was not installed (apps/mobile) still resolves its imports
# through pnpm's root fallback dir node_modules/.pnpm/node_modules. On the windows-2025 runner
# the config's require() resolves from apps/mobile itself and fails (run 40563357027:
# "Cannot find module '@babel/core'" from apps/mobile/vite.config.ts). A vp shim hides the
# fallback dir while `vp test` runs, so pgx fails the same way. Only for tests: typecheck
# resolves types through that dir in CI too.
if [ -z "${CI_HOIST:-}" ]; then
  mkdir -p "$scratch/shim"
  cat >"$scratch/shim/vp" <<SHIM
#!/usr/bin/env bash
real="$scratch/src/node_modules/.bin/vp"
fb="$scratch/src/node_modules/.pnpm/node_modules"
[ "\$1" = test ] || exec "\$real" "\$@"
mv "\$fb" "\$fb.aside" || exit 1
"\$real" "\$@"; rc=\$?
mv "\$fb.aside" "\$fb"
exit \$rc
SHIM
  chmod +x "$scratch/shim/vp"
  export PATH="$scratch/shim:$PATH"
  say "vp shim: node_modules/.pnpm/node_modules hidden during 'vp test' (CI emulation; CI_HOIST=1 to skip)"
fi

say "running $GATE"
bash "$GATE" "$scratch/src" 2>&1
rc=$?
[ $rc -eq 0 ] || { [ -n "${KEEP:-}" ] && say "kept $scratch"; echo "GATE FAIL: gate exited $rc"; exit 1; }
