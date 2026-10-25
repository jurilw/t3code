You are repairing patches for a patched build of T3 Code. Work only inside the current directory
(a scratch clone of upstream pingdotgg/t3code at tag {{TAG}}). Do not push, do not open PRs, do not
touch any other directory, do not change git remotes.

State: the patches in {{CI_REPO}}/patches/ are being applied in order with `git am --3way`.
Either one of them stopped with a conflict (`git status` shows it; `git am --show-current-patch=diff`
shows the patch), or all applied but the release gate fails.

Goal, in this order:
1. If a `git am` is in progress: resolve the conflict so the patch does what its commit message
   says on the new upstream code (upstream may have moved or renamed the code it touches: find
   the new place, keep upstream's changes, re-apply ours). `git add` the files, then
   `git am --continue`. Then apply the remaining patches from {{CI_REPO}}/patches/ in order with
   `git am --3way <file>`, resolving the same way. Never skip a patch. Never change a commit
   subject. Keep one commit per patch.
2. Make the release gate pass:
       pnpm install --frozen-lockfile || pnpm install
       bash {{CI_REPO}}/ci/gate.sh .
   If it fails, fix the patched code (not the tests' intent, not the gate script) and fold the fix
   into the commit of the patch it belongs to:
       git add <files> && git commit --fixup=<sha> && git -c sequence.editor=: rebase -q -i --autosquash {{TAG}}
3. Finish with: no `git am` in progress, clean `git status`, exactly one commit per patch on top of
   {{TAG}} with the original subjects (`git log --oneline {{TAG}}..HEAD`), and the gate passing.

Do not commit the pnpm-lock.yaml changes that `pnpm install` makes on this machine
(packageManagerDependencies); only commit lockfile changes a patch itself needs.

What the patches are, so you can tell what "working" means:
- 0000-upstream-<sha>-*: a backport of an upstream commit (pins patched dependency versions so the
  Windows server sidecar install works). The script skips it once the tag contains <sha>. If it
  conflicts, resolve towards upstream's newer state while keeping the pins.
- 0001 burn-rate meter: a flame button in the composer footer (BurnRateMeter.tsx), fed by the
  selected provider's usageLimits; tests in BurnRateMeter.logic.test.ts.
- 0002 dictation: a mic button in the composer (DictationButton.tsx, dictationSession.ts,
  dictationAvailability.ts) that records and sends audio through the desktop bridge
  (apps/desktop/src/dictation/whisperTranscription.ts, ipc/methods/dictation.ts, preload.ts,
  contracts ipc.ts DesktopBridge). Hidden unless the whisper backend answers. The server is NOT
  involved; do not add a server RPC.
- 0003 legacy V1 thread import: apps/server/src/persistence/legacyV1Resync.ts, called from
  initializeV2Database.ts when both state.sqlite and statev2.sqlite exist.

If you cannot make it work, stop and print one paragraph saying exactly where you are stuck.
The calling script verifies everything itself and only publishes if all checks pass.
