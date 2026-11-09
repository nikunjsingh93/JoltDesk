# JoltDesk development handoff

Updated November 9, 2026 by Codex.

## Current state

JoltDesk 0.10.9 is the public rebrand of Bolt Desktop. The app uses the existing bolt mark, and the renamed desktop entry point reuses existing profiles in place. Windows ARM64 is the initial distribution target.

## Recently completed

- Renamed the window, sidebar, launcher, package, icons, and build artifact.
- Added the MIT app license and preserved the bundled Pi-Bolt and Highlight.js notices.
- Replaced machine-specific probes with an opt-in live discovery check and moved fixture output into the ignored `work/` directory.
- Added the shared agent instructions and these project notes.

## Important files

- `desktop.cjs` and `desktop-profile.cjs` handle desktop branding and compatible profile selection.
- `package.json`, `package-lock.json`, and `public/` carry the rename and release metadata.
- `LICENSE`, `licenses/`, and `README.md` document licensing and release setup.
- `test/desktop-profile.test.mjs` and `test/live-api-check.mjs` cover upgrade selection and opt-in discovery.

## Verification

- `npm test` passed all 22 backend checks, including legacy profile selection and signed engine update fixtures.
- The opt-in API check passed against a local fixture with a fake key.
- The packaged smoke test verified JoltDesk branding, the bundled engine, the update check, streaming, and file approval.
- Verified the packaged ARM64 executable and the app, Highlight.js, and Pi-Bolt license files. The portable launcher is being finalized.

## Next step

Verify the portable launcher and upload the Windows ARM64 asset to the `v0.10.9` release. Compare the uploaded asset digest with the local build.

## Open work

Keep platform claims limited to verified releases. The Windows build is unsigned. Interactive browser automation and a verified per-reply budget for Unsloth’s OpenAI-compatible API remain outside the current release.
