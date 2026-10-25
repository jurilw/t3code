# Runbook: keep the patched T3 Code releases building

Written so any agent (Cursor Composer, Codex, a local Qwen) or Juri can follow it with no other
context. Every step has a command and an acceptance check. Run everything on **pgx**.

## What exists

| Thing | Where |
|---|---|
| Pipeline repo (this repo) | `~/src/t3code-sq-ci`, branch `patched-releases`, remote `fork` = github.com/jurilw/t3code |
| Patches (git format-patch vs upstream tag) | `patches/0001-burn-rate-meter.patch`, `0002-dictation.patch`, `0003-legacy-v1-thread-import.patch` |
| Release workflow | `.github/workflows/release.yml` (every 6 h, or manual) |
| Release gate (tests + wiring) | `ci/gate.sh <src>`; post-build bundle check `ci/verify-build.sh <src>` |
| Self-repair script | `selfrepair/selfrepair.sh` (cron on pgx, see below) |
| Agent instructions | `selfrepair/AGENT_PROMPT.md` |
| Upstream clone used as the source | `~/src/t3code` (remote `origin` = pingdotgg/t3code) |
| Scratch checkout made by the script | `~/src/t3code-selfrepair` (deleted and recreated every run) |
| Logs, state, STUCK notes | `~/.local/state/t3code-selfrepair/` |
| Optional config | `~/.config/t3code-selfrepair/config.env` (AGENT, NOTIFY_CMD, ...) |

Hard rules: never `git push --force`; push only to `fork patched-releases`; never open PRs
upstream; releases stay **drafts** unless Juri set `PUBLISH_MODE` (repo variable) or said so.

## Normal operation (nothing to do)

The workflow sees a new upstream stable tag, applies the patches, runs the gate, builds, and
creates a draft release. Check:

    gh release list -R jurilw/t3code --limit 5          # newest tag listed, "Draft" until approved
    gh run list -R jurilw/t3code --workflow release.yml --limit 3

## When a run fails at "Apply patches" (or the gate)

The cron job runs `selfrepair/selfrepair.sh` every 6 hours (30 minutes after the workflow). It
rebases the patches with an agent if needed, verifies, pushes and re-dispatches. If it cannot, it
writes `~/.local/state/t3code-selfrepair/STUCK-<tag>.md`. To do the same by hand:

1. See where it stands.

       cd ~/src/t3code-sq-ci && git pull --ff-only fork patched-releases
       bash selfrepair/selfrepair.sh --check
   Accept: prints `CHECK PASSED for <tag>` (then the failure was not the patches: re-run the
   workflow, step 6). Otherwise it prints which patch does not apply or which gate check failed.

2. Get a scratch checkout with the patches applied as far as they go.

       bash selfrepair/selfrepair.sh --dry-run
   This also runs the agent (claude until 2026-11-15, then cursor-agent; `AGENT=none` in the
   config skips it). If it ends with `dry run: refreshed patches are in <dir>`, the agent fixed
   it and the gate passed: copy `<dir>/*.patch` over `patches/` and continue at step 5 from the
   `--check` line.
   If it ends with `STUCK`, continue with step 3 in `~/src/t3code-selfrepair`.

3. Resolve by hand (or give an agent `selfrepair/AGENT_PROMPT.md` with `{{TAG}}` and
   `{{CI_REPO}}` filled in, working directory `~/src/t3code-selfrepair`).

       cd ~/src/t3code-selfrepair
       git status                                  # shows the conflicted patch
       git am --show-current-patch=diff            # what the patch wanted
       # edit files so the patch does what its commit message says on the new code
       git add -A && git am --continue
       for p in <remaining patches in order>; do git am --3way ~/src/t3code-sq-ci/patches/$p; done
   Accept: `git log --oneline <tag>..HEAD` shows exactly 3 commits with the original subjects;
   `git status` is clean.

4. Run the gate.

       pnpm install --frozen-lockfile || pnpm install
       bash ~/src/t3code-sq-ci/ci/gate.sh .
   Accept: last line `GATE PASS`. Fix failures in the patched code and fold them into the right
   commit (`git commit --fixup=<sha>` then `git -c sequence.editor=: rebase -i --autosquash <tag>`).

5. Write the refreshed patches back and publish.

       cd ~/src/t3code-selfrepair
       out=$(mktemp -d) && git format-patch -q <tag>..HEAD -o "$out"
       cd ~/src/t3code-sq-ci
       cp "$out"/0001-*.patch patches/0001-burn-rate-meter.patch
       cp "$out"/0002-*.patch patches/0002-dictation.patch
       cp "$out"/0003-*.patch patches/0003-legacy-v1-thread-import.patch
       bash selfrepair/selfrepair.sh --check       # must print CHECK PASSED for <tag>
       git add patches && git commit -m "Refresh patches onto upstream <tag>" \
         -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
       git push fork patched-releases              # never --force
   (Or simply `rm ~/.local/state/t3code-selfrepair/STUCK-<tag>.md` and run
   `bash selfrepair/selfrepair.sh`; it does steps 5 and 6 itself once the gate passes.)

6. Re-run the release.

       gh workflow run release.yml -R jurilw/t3code --ref patched-releases -f tag=<tag>
       gh run watch -R jurilw/t3code $(gh run list -R jurilw/t3code --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
   Accept: run conclusion `success`; `gh release view <tag> -R jurilw/t3code` shows the draft with
   `T3-Code-<version>-x64.exe`, `.blockmap` and `latest.yml`.

7. Tell Juri the draft is ready (he approves it; agents do not publish).

## If the failure is in the build, not the patches

`selfrepair.sh` re-dispatches up to 3 times per tag, then reports STUCK. Look at the failed step:

    gh run view <run-id> -R jurilw/t3code --log-failed | tail -80

Typical causes: runner image changes (pin in `runs-on`), upstream changed
`scripts/build-desktop-artifact.ts` flags, a new required secret. Fix the workflow, commit,
push, re-run step 6.

## Approving a release (Juri only)

    gh release edit <tag> -R jurilw/t3code --draft=false --latest      # this one release
    gh variable set PUBLISH_MODE -R jurilw/t3code --body release        # future releases publish directly

Installed apps with the updater on pick up non-draft "latest" releases within hours.

## Real-data check of the legacy thread import (optional)

`tools/realdbLegacyImport.test.ts` runs the patched startup against a COPY of a real
`~/.t3/userdata` (state.sqlite + statev2.sqlite):

    cp ~/src/t3code-sq-ci/tools/realdbLegacyImport.test.ts ~/src/t3code-selfrepair/apps/server/src/persistence/
    mkdir /tmp/t3copy && cp <copy of userdata>/state.sqlite* <...>/statev2.sqlite* /tmp/t3copy/
    echo /tmp/t3copy > /tmp/t3code-real-db-dir.txt
    cd ~/src/t3code-selfrepair && vp test run apps/server/src/persistence/realdbLegacyImport.test.ts
Accept: one `IMPORTED <id> "<title>" v1Messages=N v2Messages=N` line per V1 thread, test passes.
Delete the copied test file afterwards; it is not part of the patches.

## Cron entry

    47 */6 * * * bash /home/jlw/src/t3code-sq-ci/selfrepair/selfrepair.sh >/dev/null 2>&1 # t3code-selfrepair
Remove with `crontab -l | grep -v '# t3code-selfrepair' | crontab -`.
