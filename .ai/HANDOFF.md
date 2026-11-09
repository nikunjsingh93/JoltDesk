# JoltDesk development handoff

Updated November 9, 2026 by Codex.

## Current state

JoltDesk 0.10.10 fixes Windows ARM64 taskbar pinning in the [portable release](https://github.com/nikunjsingh93/JoltDesk/releases/tag/v0.10.10). The app uses the existing bolt mark and reuses existing Bolt Desktop profiles in place.

## Recently completed

- Renamed the window, sidebar, launcher, package, icons, and build artifact.
- Added the MIT app license and preserved the bundled Pi-Bolt and Highlight.js notices.
- Replaced machine-specific probes with an opt-in live discovery check and moved fixture output into the ignored `work/` directory.
- Added the shared agent instructions and these project notes.
- Added workspace and connection screenshots to the README using an isolated profile and simulated APIs.
- Registered the portable launcher as the Windows taskbar icon and relaunch target. Older pins need to be recreated.

## Important files

- `desktop.cjs` and `desktop-profile.cjs` handle desktop branding and compatible profile selection.
- `package.json`, `package-lock.json`, and `public/` carry the rename and release metadata.
- `LICENSE`, `licenses/`, and `README.md` document licensing and release setup.
- `docs/screenshots/` contains the public README images.
- `test/desktop-profile.test.mjs` and `test/live-api-check.mjs` cover upgrade selection and opt-in discovery.

## Verification

- `npm test` passed all 22 backend checks, including legacy profile selection and signed engine update fixtures.
- The opt-in API check passed against a local fixture with a fake key.
- The packaged smoke test verified JoltDesk branding, the bundled engine, the update check, streaming, and file approval.
- Verified the packaged ARM64 executable, the portable launcher icon, and the app, Highlight.js, and Pi-Bolt license files.
- Ran the 22 backend checks and packaged smoke test again for `v0.10.10`. Read the portable window's native Windows taskbar properties and verified that its icon source and relaunch target survive app shutdown. The local asset SHA-256 is `2c28ed8346a66427ff0ad2e9c5e6dc4e09eb587a15ac2ca2bfe3378deca841b9`.

## Next step

Reproduce any Windows ARM64 launch or profile issues reported after release with a temporary `BOLT_DATA_DIR` and sanitized fixtures.

## Open work

Keep platform claims limited to verified releases. The Windows build is unsigned. Interactive browser automation and a verified per-reply budget for Unsloth’s OpenAI-compatible API remain outside the current release.
