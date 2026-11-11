# JoltDesk development handoff

Updated November 11, 2026 by Claude Code.

## Current state

JoltDesk 0.11.0 adds a built-in browser as the Browser tab of the right side panel. It is published as the [0.11.0 portable release](https://github.com/nikunjsingh93/JoltDesk/releases/tag/v0.11.0) for Windows ARM64 and bundles Pi-Bolt bolt-v1.2.1. The app uses the existing bolt mark and reuses existing Bolt Desktop profiles in place.

## Recently completed

- Added a built-in browser as the **Browser** tab of the right side panel, next to **Files**. It has tabs, back, forward, reload or stop, an address bar that also searches DuckDuckGo, open in the default browser, and **＋ Chat**, which attaches the page text as a Markdown attachment.
- Links in replies and Sources open in the built-in browser. Ctrl or Shift click opens the default browser.
- Added agent tools `browser_open` (public URLs only, new tab marked ϟ, waits for load and reads the rendered text) and `browser_read` (reads the active tab). Both require the chat's Web toggle and the desktop app.
- Fixed a flaky assertion in `test/files-web-ui-check.mjs`. The UI shows `new Date(mtimeMs)` but the test compared against Node's rounded `stat.mtime`.
- Released 0.11.0.
- Earlier: rename to JoltDesk, MIT license and bundled notices, opt-in live discovery check, shared agent instructions, README screenshots, and portable taskbar registration.

## Important files

- `browser-pane.cjs` handles main-process tabs, layout, the IPC sender check, agent open and read, and address normalization.
- `desktop-preload.cjs` exposes `window.joltBrowser` with `command` and `onEvent`.
- `desktop.cjs` loads the preload and creates the pane. `native.browser.agent` serves the agent tools.
- `public/browser-panel.mjs`, `public/browser.css`, and the `#work-panel` markup in `public/index.html` provide the panel UI. `public/app.js` keeps a separate width for each panel mode.
- `server.mjs` routes `browser-*` kinds through `/internal/chats/:id/web`. `rpc.mjs` and `approval.ts` register the tools when `BOLT_BROWSER=1`.
- `package.json` adds the two new `.cjs` files to the build files.
- A running portable locks its own `release/*.exe`. Close it, or build a new version name, before running `npm run portable`.
- `test/browser-ui-check.mjs` checks the real `desktop.cjs` with an isolated profile and a loopback page fixture. `BOLT_BROWSER_HOME` overrides the home page.

## Verification

- `npm test`: 21 passed, 1 skipped (the signed real-release check), 0 failed.
- `node test/browser-ui-check.mjs` passed 4 of 5 runs. The first failure came before the start-up wait was added and has not happened since. The check covers address normalization, tabs, navigation, reading script-rendered text, attachments, load errors, Files/Browser switching, chat-link opening, hiding behind dialogs, and refusing commands from other origins.
- `node test/files-web-ui-check.mjs` passed 3 of 3 runs after the mtime fix. It now also routes `browser_open` and `browser_read`.
- `parallel-ui-check`, `thinking-format-ui-check`, and `ui-check` passed.
- A captured view showed the fixture page rendering at the viewport's size.
- The user tested a packaged ARM64 build by hand with real sites, chat links, attachments, and the agent tools, and reported that everything worked.
- Release `v0.11.0`: the ARM64 portable packaged check passed. It covers the bundled engine, the update check, streaming, and tool approval. A packaged browser check also passed, with the app reporting 0.11.0 on arm64. The app, Highlight.js, and Pi-Bolt license files are in the package. The local asset SHA-256 is `768c8c61125aa7e0a02085339f9e9d818fb1b695b560b2f5222c2098747799ce`.

## Next step

Act on feedback about the 0.11.0 browser. Candidates are restoring tabs after restart and letting the agent click and type with a separate approval. Reproduce launch or profile issues with a temporary `BOLT_DATA_DIR`.

## Open work

Keep platform claims limited to verified releases. The Windows build is unsigned. Browser tabs are not restored after restart. The agent can open and read pages, but it cannot click or type in them. A verified per-reply budget for Unsloth's OpenAI-compatible API remains outside the current release.
