# Airlock

Lets Claude Code open, start and close Claude tabs in VS Code, so a session can hand off to a new
one ("finish this, start the next task in a new tab, close this tab").

Claude drops a JSON file in `~/.claude/airlock/requests/`; the VS Code window whose workspace
contains `cwd` acts on it and writes the result to `~/.claude/airlock/responses/<same name>.json`.

```json
{ "action": "start", "cwd": "/path/to/workspace", "prompt": "<task>", "open": true }
{ "action": "open",  "cwd": "/path/to/workspace", "session": "<id, optional>", "prompt": "<text, optional>" }
{ "action": "close", "cwd": "/path/to/workspace", "session": "<id>" }
{ "action": "list",  "cwd": "/path/to/workspace" }
```

- `start` runs a new Claude session in the background and returns its `session` id; with
  `"open": true` it also opens that session in a tab. It uses the Claude CLI bundled inside the
  Claude Code extension, so no separate Claude Code install is needed. Output is logged to
  `~/.claude/airlock/runs/`.
- `open` only pre-fills `prompt`; it never sends it. Use `start` to have a task actually run.
- `close` reveals that session's tab and closes it, and only ever closes Claude conversation tabs.
  A session's own id is in `$CLAUDE_CODE_SESSION_ID`.
- Every response lists the open tabs. Requests older than 60 s are ignored.

## Install

Works on Windows, macOS and Linux. Requires the Claude Code VS Code extension.

- Local: Extensions view → `...` → Install from VSIX → pick `airlock-<version>.vsix`, then reload.
- Remote-SSH: Airlock runs where the workspace lives, so also install it on each remote host:
  in a connected window, Extensions view → `...` → Install from VSIX.

Log: command palette → "Airlock: Show Log".

## Telling Claude about it

Claude won't know Airlock exists unless told. Add something like this to your `CLAUDE.md`
(or `~/.claude/CLAUDE.md` for all projects):

> To start a new session in a new VS Code tab, or close this one, use the Airlock extension:
> write a request JSON (actions: start, open, close, list) to `~/.claude/airlock/requests/<name>.json`
> and read the result from `~/.claude/airlock/responses/<name>.json`. Give `start` a fully
> self-contained prompt. Close your own tab (session `$CLAUDE_CODE_SESSION_ID`) only as the last step.
