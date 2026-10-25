# T3 Code + patches

Official [T3 Code](https://github.com/pingdotgg/t3code) stable releases with three additions:

1. **Burn-rate meter** in the composer footer: how fast your subscription quota is going, as a
   multiple of the even pace (1x reaches 100% exactly when the window resets). Hover it for each
   window: the average since it opened, the last 30 minutes, and when you would run out. Accounts
   without quota windows (API keys, metered plans) never see it.
2. **Dictation** (desktop app): a mic button records a prompt and inserts the transcript. The
   desktop sends the clip to a [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
   `whisper-server` itself, so it works with any T3 server, including the official one:
   - `T3CODE_TRANSCRIBE_SSH_HOST=<ssh alias>`: `ssh <alias> curl ...` to a whisper-server on that
     host's `127.0.0.1:8178` (override with `T3CODE_TRANSCRIBE_REMOTE_URL`). Needs key auth that
     works without a prompt (`ssh -o BatchMode=yes <alias> true`).
   - otherwise HTTP to `T3CODE_TRANSCRIBE_URL` (default `http://127.0.0.1:8178/inference`).
   - `T3CODE_TRANSCRIBE_URL=off` turns it off. The button only appears while the backend answers.
3. **V1 thread import after a downgrade**: threads created in a 0.0.x build after a 0.1.x build had
   already created `statev2.sqlite` are imported on startup (upstream imports only once).

## Install

Releases are created as **drafts** until approved, so nothing auto-installs. Once a release is
published, download `T3-Code-<version>-x64.exe` from the [latest release](../../releases/latest) and
run it. It installs over the official app in place and keeps your settings, environments and
threads. The build is unsigned, so Windows SmartScreen asks once: **More info → Run anyway**.

Published releases then arrive through T3 Code's normal "update available" prompt.

## How it works

- `patches/` holds the changes as `git format-patch` files against the upstream tag.
- `.github/workflows/release.yml` checks upstream every six hours. For a new stable tag it applies
  the patches, runs the release gate (`ci/gate.sh`), builds the Windows installer with this
  repository as its update feed, checks the bundles contain every patch (`ci/verify-build.sh`),
  and creates a release (draft by default; see the workflow header for `PUBLISH_MODE`).
- Patches 1 and 2 touch only the desktop and web client. Patch 3 touches the server bundled as the
  desktop's local backend. SSH and WSL environments keep the official server.
- If a patch stops applying, the run fails and nothing is published. `selfrepair/selfrepair.sh`
  (cron on pgx) rebases the patches, re-runs the gate, pushes and re-dispatches; see
  `selfrepair/RUNBOOK.md`.
