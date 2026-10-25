#!/usr/bin/env bash
# Self-repair for the patched T3 Code release pipeline (jurilw/t3code, branch patched-releases).
#
# What it does, in order (see selfrepair/RUNBOOK.md for the why and the manual version):
#   1. Finds the latest upstream stable tag. Exits 0 if this fork already has a release or draft
#      for it, or a release run is in progress.
#   2. Clones upstream at that tag into a scratch dir and applies patches/*.patch with git am --3way.
#   3. If a patch does not apply, or the release gate (ci/gate.sh) fails, hands the scratch dir to a
#      coding agent (claude / cursor-agent) with selfrepair/AGENT_PROMPT.md. The agent never pushes.
#   4. Re-checks everything itself: one commit per patch with unchanged subjects, clean tree,
#      ci/gate.sh passes. Only then regenerates patches/, commits, pushes (never forced) and
#      dispatches the release workflow (which publishes a DRAFT unless PUBLISH_MODE says otherwise).
#   5. If any step fails: writes $STATE_DIR/STUCK-<tag>.md, runs $NOTIFY_CMD once, exits 2.
#
# Usage:
#   selfrepair.sh            normal run (cron)
#   selfrepair.sh --check    apply + gate locally for the latest tag; no agent, no push, no dispatch
#   selfrepair.sh --dry-run  full run including the agent; refreshed patches go to
#                            $STATE_DIR/dryrun-<tag>; patches/ untouched, no push, no dispatch
#   TAG=v0.1.3 selfrepair.sh ...   force a specific upstream tag
#
# Config (optional): ~/.config/t3code-selfrepair/config.env, shell syntax:
#   AGENT=auto|claude|cursor|none   auto = claude until 2026-11-15, then cursor-agent (default auto)
#   AGENT_TIMEOUT=45m
#   NOTIFY_CMD='...'                gets the stuck message on stdin (e.g. a Telegram sender)
#   MAX_AGENT_ATTEMPTS=2            per upstream tag
#
# Exit codes: 0 nothing to do / repaired and dispatched / --check passed, 1 usage or environment
# error, 2 stuck (needs Juri), 3 --check failed.
set -euo pipefail

MODE=run
case "${1:-}" in
  "") ;;
  --check) MODE=check ;;
  --dry-run) MODE=dry-run ;;
  *) echo "usage: $0 [--check|--dry-run]" >&2; exit 1 ;;
esac

FORK=jurilw/t3code
UPSTREAM=pingdotgg/t3code
BRANCH=patched-releases
CI_REPO="${CI_REPO:-$HOME/src/t3code-sq-ci}"
UPSTREAM_REPO="${UPSTREAM_REPO:-$HOME/src/t3code}"
WORK="${WORK:-$HOME/src/t3code-selfrepair}"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/t3code-selfrepair}"
CONFIG="${CONFIG:-$HOME/.config/t3code-selfrepair/config.env}"
CLAUDE_MAX_ENDS=2026-11-15

# Precedence: environment > config file > defaults.
env_AGENT="${AGENT-}" env_AGENT_TIMEOUT="${AGENT_TIMEOUT-}" env_NOTIFY_CMD="${NOTIFY_CMD-}"
env_MAX_AGENT_ATTEMPTS="${MAX_AGENT_ATTEMPTS-}"
AGENT=auto
AGENT_TIMEOUT=45m
NOTIFY_CMD=""
MAX_AGENT_ATTEMPTS=2
# shellcheck disable=SC1090
if [ -f "$CONFIG" ]; then . "$CONFIG"; fi
AGENT="${env_AGENT:-$AGENT}"
AGENT_TIMEOUT="${env_AGENT_TIMEOUT:-$AGENT_TIMEOUT}"
NOTIFY_CMD="${env_NOTIFY_CMD:-$NOTIFY_CMD}"
MAX_AGENT_ATTEMPTS="${env_MAX_AGENT_ATTEMPTS:-$MAX_AGENT_ATTEMPTS}"

export PATH="$HOME/.local/bin:$PATH"
mkdir -p "$STATE_DIR"
LOG="$STATE_DIR/run-$(date +%Y%m%dT%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1
exec 9>"$STATE_DIR/lock"
flock -n 9 || { echo "another self-repair run is active"; exit 0; }

say() { echo "[$(date '+%F %T')] $*"; }

stuck() {
  local reason="$1"
  local file="$STATE_DIR/STUCK-${TAG:-unknown}.md"
  if [ "$MODE" = check ]; then say "CHECK FAILED: $reason"; exit 3; fi
  # Only real runs leave a STUCK note (it pauses the cron job for this tag).
  if [ "$MODE" = dry-run ]; then say "STUCK (dry run): $reason"; exit 2; fi
  {
    echo "# T3 Code self-repair stuck on ${TAG:-unknown} ($(date '+%F %T'))"
    echo
    echo "Reason: $reason"
    echo
    echo "Log: $LOG"
    echo "Scratch checkout (left as is): $WORK"
    echo "Manual steps: $CI_REPO/selfrepair/RUNBOOK.md"
  } >"$file"
  say "STUCK: $reason (wrote $file)"
  if [ -n "$NOTIFY_CMD" ] && [ ! -f "$file.notified" ] && [ "$MODE" = run ]; then
    if sh -c "$NOTIFY_CMD" <"$file"; then touch "$file.notified"; fi
  fi
  exit 2
}

# ---------------------------------------------------------------- 1. anything to do?
command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }
# --check tests the working tree as it is (e.g. freshly copied patches); the other modes
# commit and push, so they start from a clean, current branch.
if [ "$MODE" != check ]; then
  git -C "$CI_REPO" diff --quiet HEAD -- patches ci .github selfrepair ||
    stuck "$CI_REPO has uncommitted changes in tracked pipeline files; refusing to touch it"
  git -C "$CI_REPO" checkout -q "$BRANCH"
  git -C "$CI_REPO" pull -q --ff-only fork "$BRANCH"
fi

TAG="${TAG:-$(gh api "repos/$UPSTREAM/releases/latest" --jq .tag_name)}"
say "upstream stable: $TAG (mode $MODE)"

if [ "$MODE" = run ]; then
  if gh release list -R "$FORK" --limit 50 --json tagName --jq '.[].tagName' | grep -qx "$TAG"; then
    say "fork already has a release or draft for $TAG; nothing to do"
    rm -f "$STATE_DIR/STUCK-$TAG.md" "$STATE_DIR/STUCK-$TAG.md.notified"
    exit 0
  fi
  active=$(gh run list -R "$FORK" --workflow release.yml --limit 5 --json status \
    --jq '[.[] | select(.status != "completed")] | length')
  if [ "$active" != "0" ]; then say "a release run is in progress; try later"; exit 0; fi
  if [ -f "$STATE_DIR/STUCK-$TAG.md" ]; then
    say "already stuck on $TAG (see $STATE_DIR/STUCK-$TAG.md); delete that file to retry"
    exit 2
  fi
fi

# ---------------------------------------------------------------- 2. apply patches on the tag
git -C "$UPSTREAM_REPO" fetch -q origin --tags
git -C "$UPSTREAM_REPO" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || stuck "tag $TAG not found upstream"
rm -rf "$WORK"
git clone -q --shared --no-checkout "$UPSTREAM_REPO" "$WORK"
git -C "$WORK" checkout -q -b "selfrepair/$TAG" "$TAG"
git -C "$WORK" config user.name "jurilw"
git -C "$WORK" config user.email "washington.juri@gmail.com"

# NNNN-upstream-<sha>-*.patch are backports of upstream commits; once the tag contains the
# commit they are obsolete (skipped here and in CI, deleted in the refresh commit).
PATCHES=()
OBSOLETE=()
for patch in $(ls "$CI_REPO"/patches/*.patch | sort); do
  name="$(basename "$patch")"
  if [[ "$name" =~ ^[0-9]+-upstream-([0-9a-f]{7,40})- ]] &&
    git -C "$WORK" merge-base --is-ancestor "${BASH_REMATCH[1]}" "$TAG" 2>/dev/null; then
    say "skipping $name: $TAG already contains upstream ${BASH_REMATCH[1]}"
    OBSOLETE+=("$patch")
  else
    PATCHES+=("$patch")
  fi
done
[ "${#PATCHES[@]}" -gt 0 ] || stuck "no patches in $CI_REPO/patches"
# Subject headers can be folded over several lines in a patch file.
patch_subject() {
  awk '/^Subject: /{s=substr($0,10); while ((getline line) > 0 && line ~ /^[ \t]/) s=s line; print s; exit}' "$1" |
    sed 's/^\[PATCH[^]]*\] //'
}
mapfile -t SUBJECTS < <(for p in "${PATCHES[@]}"; do patch_subject "$p"; done)

applied_all=true
for patch in "${PATCHES[@]}"; do
  say "applying $(basename "$patch")"
  if ! git -C "$WORK" am -q --3way "$patch"; then
    applied_all=false
    say "patch does not apply: $(basename "$patch")"
    break
  fi
done

install_deps() {
  (cd "$WORK" && { pnpm install --frozen-lockfile >/dev/null 2>&1 || pnpm install >/dev/null; })
}

run_gate() {
  install_deps || return 1
  bash "$CI_REPO/ci/gate.sh" "$WORK"
}

gate_ok=false
if $applied_all; then
  say "all patches apply; running the gate"
  if run_gate; then gate_ok=true; fi
fi

if [ "$MODE" = check ]; then
  $applied_all || stuck "patches do not apply on $TAG"
  $gate_ok || stuck "gate failed on $TAG"
  say "CHECK PASSED for $TAG"
  exit 0
fi

# ---------------------------------------------------------------- 3. agent, if needed
pick_agent() {
  local choice="$AGENT"
  if [ "$choice" = auto ]; then
    if [ "$(date +%F)" \< "$CLAUDE_MAX_ENDS" ] && command -v claude >/dev/null; then choice=claude
    elif command -v cursor-agent >/dev/null; then choice=cursor
    else choice=none; fi
  fi
  echo "$choice"
}

if ! $gate_ok; then
  attempts_file="$STATE_DIR/attempts-$TAG"
  attempts=$(cat "$attempts_file" 2>/dev/null || echo 0)
  [ "$attempts" -lt "$MAX_AGENT_ATTEMPTS" ] || stuck "agent already tried $attempts times on $TAG"
  [ "$MODE" != run ] || echo $((attempts + 1)) >"$attempts_file"
  agent=$(pick_agent)
  [ "$agent" != none ] || stuck "patches need a human or agent rebase on $TAG and AGENT=none"
  prompt="$(sed -e "s|{{TAG}}|$TAG|g" -e "s|{{CI_REPO}}|$CI_REPO|g" "$CI_REPO/selfrepair/AGENT_PROMPT.md")"
  say "handing $WORK to $agent (timeout $AGENT_TIMEOUT)"
  set +e
  case "$agent" in
    claude)
      (cd "$WORK" && timeout "$AGENT_TIMEOUT" claude -p "$prompt" \
        --permission-mode acceptEdits \
        --allowedTools "Read,Edit,Write,Glob,Grep,Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git add:*),Bash(git am:*),Bash(git rm:*),Bash(git checkout:*),Bash(git commit:*),Bash(git rebase:*),Bash(git -c sequence.editor=: rebase:*),Bash(pnpm install:*),Bash(vp:*),Bash(bash $CI_REPO/ci/gate.sh:*),Bash(grep:*),Bash(sed:*),Bash(cat:*),Bash(ls:*)")
      ;;
    cursor)
      (cd "$WORK" && timeout "$AGENT_TIMEOUT" cursor-agent -p --force --output-format text "$prompt")
      ;;
    *) stuck "unknown AGENT '$agent'" ;;
  esac
  agent_exit=$?
  set -e
  say "agent exited with $agent_exit"
fi

# ---------------------------------------------------------------- 4. verify independently
[ ! -d "$WORK/.git/rebase-apply" ] || stuck "git am still in progress in $WORK after the agent"
# pnpm install on pgx rewrites packageManagerDependencies in the lockfile; not part of any patch.
git -C "$WORK" checkout -q -- pnpm-lock.yaml 2>/dev/null || true
[ -z "$(git -C "$WORK" status --porcelain --untracked-files=no)" ] || stuck "uncommitted changes left in $WORK"
mapfile -t GOT < <(git -C "$WORK" log --reverse --format=%s "$TAG..HEAD")
[ "${#GOT[@]}" -eq "${#PATCHES[@]}" ] ||
  stuck "expected ${#PATCHES[@]} commits on $TAG, found ${#GOT[@]}: ${GOT[*]}"
for i in "${!SUBJECTS[@]}"; do
  [ "${GOT[$i]}" = "${SUBJECTS[$i]}" ] || stuck "commit $((i + 1)) is '${GOT[$i]}', expected '${SUBJECTS[$i]}'"
done
if ! $gate_ok; then
  run_gate || stuck "gate still fails on $TAG after the agent"
fi

# ---------------------------------------------------------------- 5. publish the refreshed patches
out="$(mktemp -d)"
git -C "$WORK" format-patch -q "$TAG..HEAD" -o "$out"
mapfile -t NEW < <(ls "$out"/*.patch | sort)
if [ "$MODE" = dry-run ]; then
  keep="$STATE_DIR/dryrun-$TAG"
  rm -rf "$keep" && mkdir -p "$keep"
  for i in "${!PATCHES[@]}"; do cp "${NEW[$i]}" "$keep/$(basename "${PATCHES[$i]}")"; done
  rm -rf "$out"
  say "dry run: refreshed patches are in $keep (patches/ untouched, nothing pushed or dispatched)"
  diff -q "$CI_REPO/patches" "$keep" || true
  exit 0
fi
for i in "${!PATCHES[@]}"; do cp "${NEW[$i]}" "${PATCHES[$i]}"; done
rm -rf "$out"
for patch in "${OBSOLETE[@]}"; do git -C "$CI_REPO" rm -q -- "patches/$(basename "$patch")"; done

if [ -z "$(git -C "$CI_REPO" status --porcelain -- patches)" ]; then
  say "patches unchanged (the failure was not a patch problem)"
else
  git -C "$CI_REPO" add patches
  git -C "$CI_REPO" commit -q -F - <<EOF
Refresh patches onto upstream $TAG

Rebased by selfrepair/selfrepair.sh; ci/gate.sh passed locally on $TAG.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
  say "committed refreshed patches: $(git -C "$CI_REPO" log -1 --format=%h)"
fi

git -C "$CI_REPO" push -q fork "$BRANCH"
dispatches_file="$STATE_DIR/dispatches-$TAG"
dispatches=$(cat "$dispatches_file" 2>/dev/null || echo 0)
[ "$dispatches" -lt 3 ] || stuck "dispatched $dispatches times for $TAG without a release"
echo $((dispatches + 1)) >"$dispatches_file"
gh workflow run release.yml -R "$FORK" --ref "$BRANCH" -f tag="$TAG"
say "pushed and dispatched the release workflow for $TAG"
