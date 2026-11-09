# JoltDesk development instructions

These instructions are shared by Codex, Claude Code, OpenCode, Pi Agent, and other coding agents working on this repository.

## Start a session

1. Read [.ai/PROJECT.md](.ai/PROJECT.md) for architecture, conventions, and lasting decisions.
2. Read [.ai/HANDOFF.md](.ai/HANDOFF.md) for the current state and next step.
3. Check Git status and inspect the relevant source and tests. Continue from the latest verified state.

## Make changes

- Follow the existing architecture and keep changes focused. Preserve unrelated changes in the working tree.
- Treat source and test results as authoritative when notes are outdated.
- Record durable technical decisions, recurring pitfalls, and verified fixes in `.ai/PROJECT.md`.
- Use isolated fixtures for tests. Live checks require an explicitly supplied test endpoint.
- Keep credentials, personal endpoints, session data, and local diagnostics out of commits, documentation, and release artifacts.

## Hand off

After substantial development work, at the end of a coding session, or when asked to hand off, update `.ai/HANDOFF.md`. Record completed work, relevant files, unresolved issues, the checks that ran and their results, and the next concrete step. Preserve prior findings that are still relevant.
