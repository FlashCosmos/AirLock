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

- Local: download `airlock-<version>.vsix` (see Releases), then Extensions view → `...` → Install from VSIX → pick it, then reload.
- Remote-SSH: Airlock runs where the workspace lives, so also install it on each remote host:
  in a connected window, Extensions view → `...` → Install from VSIX.

Log: command palette → "Airlock: Show Log".

## Known issue (0.1.2)

`start` with `"open": true` can open the tab before the session is ready, giving a blank tab.
Until that's fixed, start without `open`, wait until the run log contains a `"type":"assistant"`
line, then send a separate `open` with the returned `session`. The instructions below already do this.

## Telling Claude about it

Claude won't know Airlock exists unless told. Without this it may try to launch `claude` in a
terminal instead, which just opens the CLI's first-run setup. Paste this into `~/.claude/CLAUDE.md`
so every project picks it up (or into a single project's `CLAUDE.md`):

```markdown
## Handing off to a new Claude tab in VS Code (Airlock)

When asked to start a new session/tab, hand off to a new tab, or close this tab, use the Airlock VS Code extension.
Do NOT launch `claude` in a terminal, use SendKeys, or open `vscode://` links: those don't work here.

Airlock reads request files. Write JSON to `~/.claude/airlock/requests/<name>.json`, then poll for
`~/.claude/airlock/responses/<name>.json` (usually under 2 s), read it and delete it. `cwd` must be this
session's workspace folder.

- Start a new session that actually runs a prompt:
  `{"action":"start","cwd":"<workspace>","prompt":"<fully self-contained task>"}` → response has `session` and `log`.
  Then wait until the run log (`log`, JSON lines) contains a line with `"type":"assistant"`, and only then open it:
  `{"action":"open","cwd":"<workspace>","session":"<session>"}`.
  (Don't use `"open": true` on start: in v0.1.2 the tab opens too early and comes up blank.)
- Open a blank tab: `{"action":"open","cwd":"<workspace>"}`. A `prompt` field only pre-fills text; it is never sent.
- Close a tab: `{"action":"close","cwd":"<workspace>","session":"<id>"}`. This session's own id is in
  `$CLAUDE_CODE_SESSION_ID`. Close your own tab only as the very last step.
- List tabs: `{"action":"list","cwd":"<workspace>"}`. Every response also includes the open tabs.

The new session gets no context from this one, so its prompt must stand on its own: what the project is,
where things are, what was just finished, and exactly what to do next.
```

A new session only reads `CLAUDE.md` at startup, so sessions already running won't see it until restarted.
