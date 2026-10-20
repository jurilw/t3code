# T3 Code + burn-rate meter

Official [T3 Code](https://github.com/pingdotgg/t3code) stable releases with one small addition: a
**burn-rate meter** in the composer footer. It shows how fast your subscription quota is going, as a
multiple of the even pace (1x reaches 100% exactly when the window resets). Hover it for each window
(session, weekly): the average since the window opened, the last 30 minutes, and when you would run
out. Accounts without quota windows (API keys, metered plans) never see it.

## Install

Download `T3-Code-<version>-x64.exe` from the [latest release](../../releases/latest) and run it. It
installs over the official app in place and keeps your settings, environments and threads. The
build is unsigned, so Windows SmartScreen asks once: **More info → Run anyway**.

After that, updates arrive through T3 Code's normal "update available" prompt, usually within six
hours of an official stable release. To go back to the official app, install it over this one.

## How it works

- `patches/` holds the change as `git format-patch` files against upstream.
- `.github/workflows/release.yml` checks upstream every six hours. For a new stable tag it applies
  the patches, runs their tests, builds the Windows installer with this repository as its update
  feed, and publishes a release with the same version number.
- The server is not modified, so SSH and WSL environments keep using the official server archive.
- If a patch stops applying, the run fails and nothing is published; installed copies stay on the
  last good version until the patch is refreshed.
