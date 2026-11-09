# JoltDesk project knowledge

## Overview

JoltDesk is an independent desktop workspace for local and remote AI model APIs. It uses the bundled Pi-Bolt coding agent and supports multiple chats and projects, streaming reasoning and code, optional web search and page reading, and file actions in the sidebar.

## Architecture

| Component | Role |
| --- | --- |
| `desktop.cjs` and `desktop-profile.cjs` | Electron lifecycle, profile selection, OS-encrypted credentials, window icon, and desktop file actions |
| `server.mjs` and `rpc.mjs` | Loopback Express/WebSocket server and isolated Pi-Bolt RPC processes, one per chat |
| `connections.mjs` | API normalization, model discovery, context estimates, and model-specific reasoning controls |
| `approval.ts` | App-owned Pi-Bolt extension for permissions, web tool registration, and provider timing |
| `web-tools.cjs` | Public web search and read-only HTML/text extraction |
| `public/` | HTML, CSS and vanilla JavaScript renderer, including chat state and reply metrics |
| `engine-updater.mjs` and `bundle-engine.mjs` | Verified engine downloads, activation and packaging |
| `test/` | Backend and Electron UI checks with simulated model APIs, plus an opt-in live discovery check |

The Electron window connects to the local server. API and WebSocket calls use the instance token and loopback origin checks. Each chat’s RPC child binds to its own connection and model configuration. UI state, session files, and diagnostics live on disk. There is no database. Desktop credentials are stored separately using Electron safe storage. Browser mode keeps credentials in process memory.

## Development commands

```sh
npm ci
npm start
npm test
npm run build:ui
npm run bundle:engine
npm run portable -- --arm64
```

`npm start` opens Electron. `npm run web` serves the browser UI. `npm test` runs backend tests. UI checks can be run directly, for example `node test/live-stream-ui-check.mjs`. Set `BOLT_TEST_PACKAGED=1` for checks that support the packaged Windows app. Set `BOLT_TEST_BASE_URL` and, if needed, `BOLT_TEST_API_KEY` for `node test/live-api-check.mjs`. That check reads model metadata without generation. Test artifacts go under ignored `work/`.

## Durable decisions and pitfalls

- The supported release target is Windows ARM64. Electron is ARM64. The bundled upstream Windows x64 Pi-Bolt engine runs under Windows emulation. Verify both the packaged app and the embedded engine before releasing.
- The JoltDesk rename keeps the old Windows app ID and opens existing Bolt Desktop data in place. Keeping the existing profile directory also keeps its encrypted credential store together. Fresh installations use `joltdesk`.
- The Windows portable build registers the outer executable as its taskbar relaunch command and icon source before showing the window. Its temporary Electron executable is removed on exit. Pins made before this fix need to be recreated.
- Saved connection identity matters. Distinct APIs can expose the same model ID, so keep model selection, keys, and active requests scoped to their chat’s endpoint.
- Keep thinking effort, thinking budget, and total output limits separate. Qwen3.6 provides On/Off, while Qwen3.8 can expose distinct efforts. A supported Splash connection can enforce a per-request thinking budget. Unsloth Studio exposes a GGUF model-load budget, and the OpenAI-compatible route tested during development did not honor the attempted per-request budget.
- Some servers return the resident model’s properties for every model query. Match the reported model identity before applying those properties.
- Keep streamed scroll containers mounted. Replacing the thinking or code node on each update reset spinner animation, focus, and scroll position. Follow new output only when the reader is already at the bottom.
- Prefer native generation timings where available. Buffered stream chunks can make receipt-based throughput estimates misleading.
- File permissions control the agent’s available tools and approval flow. Approved shell tools run with the current OS user’s permissions. Web access is separately opt-in and reads public pages without running their scripts.
- Keep the app’s MIT license separate from Pi-Bolt and other bundled notices. Preserve the signed engine bundle’s notices and provenance in distributions.

## Release convention

Keep generated binaries, private diagnostics, profiles, and engine downloads out of Git. Build the portable Windows ARM64 executable, smoke-test the package using an isolated profile, check the artifact and license files, and attach the executable to a versioned GitHub release.
