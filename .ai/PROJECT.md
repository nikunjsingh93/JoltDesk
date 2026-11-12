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
| `checkpoints.mjs`, `public/changes-panel.mjs`, `public/diff.mjs` | Per-request file checkpoints, restore, Myers line diff, and the Changes tab |
| `git.mjs`, `public/git-panel.mjs` | Git status, HEAD and working-tree file contents, selective commit, push, and the Git tab |
| `terminal.mjs`, `public/terminal-panel.mjs` | Terminal tab: user commands per chat, and live mirrors of the agent's command tools |
| `public/instructions.mjs` | Instruction-file list in the Files tab and personal instructions in Settings |
| `public/side-panel.mjs` | Files, Changes, Git, Terminal, and Browser tabs of the shared right panel. The tabs wrap to two rows when the panel is narrow |
| `browser-pane.cjs`, `desktop-preload.cjs`, `public/browser-panel.mjs` | Built-in browser: `WebContentsView` tabs owned by the main process, a preload bridge limited to the app origin, and the Browser tab of the right side panel |
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
- The built-in browser's pages are native `WebContentsView`s drawn over `#browser-viewport` and above all HTML. The renderer hides them while any `<dialog>` is open, while the side panel shows Files, and when a page fails to load so the error text is visible. Window captures from `BrowserWindow.capturePage()` do not include these views. Capture the view's own `webContents` instead.
- Browser tabs use the `persist:joltdesk-browser` partition, a sandbox, no preload, HTTP(S)-only navigation, and deny-by-default permissions. Agent `browser_open` accepts only public addresses through the same check as `browse_page`. `browser_read` reads the active tab in an isolated world and requires the chat's Web toggle. The user can browse anywhere, including localhost.
- Files, Changes, and Browser share the right side panel. Each tab remembers its own width.
- Checkpoints: in `approval.ts`, the `tool_call` handler snapshots the exact file bytes as base64 after approval and before `write` or `edit` runs. It sends them as a `BOLT_SNAPSHOT:` notification. Run the snapshot only after approval, so declined calls record nothing. The server opens a checkpoint for each prompt in `rpc.turn` and closes it on `agent_settled`, on the handled disposition, on a prompt error, or when the engine closes. Closing records the after-state and drops files that did not change. Paths are absolute, resolved like the tool does from the chat's working directory. Store bytes, not decoded text, so restores are exact for any encoding.
- Restoring a request also restores later requests that touched the same files. It compares each file with the last recorded after-state and returns `needsConfirmation` with conflicts instead of overwriting outside edits. After a restore, the next prompt first sends `/bolt-note`, a hidden custom message, so the model knows. The chat renderer ignores custom messages.
- `git.mjs` runs the `git` CLI with `--literal-pathspecs`, `GIT_TERMINAL_PROMPT=0`, and porcelain v1 `-z` status. Paths are relative to the repository root, so run commands from the root. Commits stage the chosen paths with `--pathspec-from-file`. Do not pass a rename's old path or a staged deletion to `git add`, because they are no longer in the index and `add` fails. Then commit with `--only` for the same paths, so other staged work is left alone. A first commit, with no HEAD yet, cannot use `--only`. `git diff` does not accept `--pathspec-from-file`. Mutations are serialized per repository.
- `oneShot()` in `server.mjs` sends a single tool-free prompt to the chat's model through a temporary Pi-Bolt process. It uses the chat's runner agent directory and a throwaway session in `<data>/one-shot`, so nothing enters the conversation. The Git tab uses it for commit messages.
- Instruction files, verified with the engine: Pi-Bolt reads AGENTS.md from its agent folder (`PI_CODING_AGENT_DIR`, which is per chat at `<data>/runners/<chat>/agent`), then one file per folder from the filesystem root down to the chat's folder. In each folder it reads AGENTS.md, or CLAUDE.md only when AGENTS.md is absent. `defaultProjectTrust: 'never'` does not block them. Personal instructions (`meta.instructions`) are written to that per-chat AGENTS.md when the runner starts. `meta.instructionsRevision` makes `runner()` quietly replace an idle engine before its next use. Closing runners directly would broadcast `engine_closed` and show an error toast.
- The terminal runs each command as its own process without a pseudo-terminal: `pwsh.exe` or `powershell.exe -NoProfile -Command` on Windows, or `$SHELL -c` elsewhere, with `NO_COLOR` and `TERM=dumb`. Stopping uses `taskkill /T /F` on Windows and kills the process group elsewhere. `cd` is handled by the app. Agent commands are mirrored from `tool_execution_start`, `tool_execution_update` (whose `partialResult` holds all output so far), and `tool_execution_end` (`structuredContent.exit_code`). Entries live in memory, up to 40 per chat and 200 KB of output each.
- UI checks that use a folder under `work/` must set `GIT_CEILING_DIRECTORIES`, or Git finds the JoltDesk checkout.
- Command tools (`bash`, `powershell`) are recorded only as "commands ran". Their file effects are not tracked.
- Keep the app’s MIT license separate from Pi-Bolt and other bundled notices. Preserve the signed engine bundle’s notices and provenance in distributions.

## Release convention

Keep generated binaries, private diagnostics, profiles, and engine downloads out of Git. Build the portable Windows ARM64 executable, smoke-test the package using an isolated profile, check the artifact and license files, and attach the executable to a versioned GitHub release.
