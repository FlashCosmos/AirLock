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

- `start` (one-shot, not recommended for handoffs) runs a new Claude session in the background and returns its `session` id; with
  `"open": true` it also opens that session in a tab. It uses the Claude CLI bundled inside the
  Claude Code extension, so no separate Claude Code install is needed. Output is logged to
  `~/.claude/airlock/runs/`.
- `open` only pre-fills `prompt`; it never sends it. To get a task running, brief the tab with `SendMessage` (see below).
- `close` reveals that session's tab and closes it, and only ever closes Claude conversation tabs.
  A session's own id is in `$CLAUDE_CODE_SESSION_ID`.
- Every response lists the open tabs. Requests older than 60 s are ignored.

## Install

Works on Windows, macOS and Linux. Requires the Claude Code VS Code extension.

- Local: download `airlock-<version>.vsix` (see Releases), then Extensions view → `...` → Install from VSIX → pick it, then reload.
- Remote-SSH: Airlock runs where the workspace lives, so also install it on each remote host:
  in a connected window, Extensions view → `...` → Install from VSIX.

Log: command palette → "Airlock: Show Log".

## Recommended handoff flow

Don't use `start` for handoffs: it runs a one-shot headless session, and with `"open": true` the tab can
open before the session is ready and come up blank. Instead, open a blank tab with Airlock, find it with
Claude Code's `ListAgents`, and brief it with `SendMessage`. The new tab then becomes a normal, live session
that other sessions can message by name. Open and brief one tab at a time, so each brief goes to the
right tab, and never resend a brief.

## Telling Claude about it

Claude won't know Airlock exists unless told. Without this it may try to launch `claude` in a
terminal instead, which just opens the CLI's first-run setup. Paste this into `~/.claude/CLAUDE.md`
so every project picks it up (or into a single project's `CLAUDE.md`):

```markdown
## Handing off to new Claude tabs in VS Code (Airlock)

When asked to start a new session/tab, hand off to a new tab, or close this tab, use the Airlock VS Code extension
plus cross-session messaging. Do NOT launch `claude` in a terminal, use SendKeys, open `vscode://` links, or use
Airlock's `start` action (it runs a one-shot headless session and its tab opens blank).

Airlock reads request files: write JSON to `~/.claude/airlock/requests/<name>.json`, then poll for
`~/.claude/airlock/responses/<name>.json` (usually under 2 s), read it and delete it. `cwd` = this session's workspace folder.

To hand off to N new sessions, do this ONE SESSION AT A TIME:
1. `ListAgents` and note every name.
2. Open one blank tab: `{"action":"open","cwd":"<workspace>"}`. Wait ~5 s.
3. `ListAgents` again. The new tab is the one row that wasn't there before: `interactive`, `idle`, started a few
   seconds ago, name starting with the workspace folder name (e.g. `pet-simulator-3f`). If it isn't exactly one
   new row, stop and ask the user. Never guess.
4. `SendMessage` to that name with the full brief, ONCE. Never resend or "relay" a brief, and never message a
   session you didn't just identify this way.
5. Repeat for the next session. Once all are briefed, send each one a short note with the others' names so they
   can message each other directly.

The new session gets no context from this one, so its brief must stand on its own: what the project is, where
things are, what was just finished, exactly what to do next, and who else to coordinate with.

Other actions:
- Close a tab: `{"action":"close","cwd":"<workspace>","session":"<session id>"}`. This session's own id is in
  `$CLAUDE_CODE_SESSION_ID`. Close your own tab only as the very last step, after every brief has been sent.
- List tabs: `{"action":"list","cwd":"<workspace>"}`. Every response also includes the open tabs.

Source and docs: https://github.com/FlashCosmos/AirLock
```

A new session only reads `CLAUDE.md` at startup, so sessions already running won't see it until restarted.
