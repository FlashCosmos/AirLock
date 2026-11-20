# Airlock

A small VS Code extension that lets Claude Code open, close and list its own Claude tabs, so a
session can hand off to new ones: "finish this, start the next task in a new tab, close this tab",
or "start a Game session and an Art session and let them talk to each other".

Airlock comes as two extensions:

- **Airlock** does the tab work: open, close, list, and naming sessions.
- **Airlock Send** (optional, Windows only for now) presses the Send button in a new tab, so a
  handoff brief goes out by itself, with no Enter to press.

## How a handoff works

With Airlock Send:

1. Claude asks Airlock to open a new Claude tab with the brief typed in and `"send": true`.
2. Airlock Send presses Send. The brief goes out as the tab's first message, exactly as if you had
   typed it: the session names itself and shows up in the Session Manager and the Claude apps
   right away.
3. Repeat one tab at a time, then Claude tells each new session the others' names (`ListAgents` +
   `SendMessage`) so they can message each other.
4. Finally Claude asks Airlock to close its own tab.

Without Airlock Send, steps 1 and 2 become: open a blank tab, find it with `ListAgents` (the one new,
idle row named after the workspace folder) and send it the brief with `SendMessage`. See the
limitations below.

## Install

Works on Windows, macOS and Linux. Requires the Claude Code VS Code extension; the Claude Code CLI
does not need to be installed separately. Download the `.vsix` files from
[Releases](https://github.com/FlashCosmos/AirLock/releases), then in VS Code: Extensions view →
`...` → Install from VSIX → pick the file, then reload the window.

- **Airlock** (`airlock-<version>.vsix`): install it locally. For Remote-SSH and Remote Tunnel
  windows, also install it on each remote host (Install from VSIX in a connected window), because
  it runs where the workspace lives.
- **Airlock Send** (`airlock-send-<version>.vsix`): install it once per PC. It always runs on your
  own computer, where the VS Code window is, so it also covers your Remote-SSH and tunnel windows.
  Nothing to install on remote hosts.

Then add the snippet below to `~/.claude/CLAUDE.md`, so Claude knows to use it. On a remote host,
that's the `~/.claude/CLAUDE.md` on the remote host.

Log: command palette → "Airlock: Show Log".

## Without Airlock Send

Everything still works through the blank tab + `SendMessage` route, with these limitations:

- **Not shown in the Session Manager or the Claude apps.** A session that was started by a message
  instead of a typed prompt gets no automatic name, so the history skips it. The tab works, but
  if you close it or reload the window, you can't find the session again from the history.
- **Naming needs a reload.** Claude can name such a session with the `title` request, but the
  name only shows in the Session Manager after the VS Code window is reloaded (Developer: Reload
  Window). The tab label itself stays "Claude Code".
- On macOS and Linux this is currently the only route; Airlock Send is Windows only.

## Airlock Send limitations

- Windows only for now (it uses Windows UI Automation). A macOS version is planned.
- Don't switch tabs or windows during the few seconds while a new tab opens. Airlock Send only
  presses Send when the VS Code window's title shows the new tab and exactly one Send button is
  visible. If not, it presses nothing and the brief stays typed in the new tab: press Enter there
  yourself.
- If two VS Code windows have the same workspace name and the same active tab label, it presses
  nothing, rather than guess.
- It depends on the Claude extension's Send button being named "Send message". If a Claude
  extension update renames it, auto-send stops (and falls back as above) until Airlock Send is
  updated.

## Requests

Claude drops a JSON file in `~/.claude/airlock/requests/`; the VS Code window whose workspace
contains `cwd` acts on it and writes the result to `~/.claude/airlock/responses/<same name>.json`.
On Windows, write `cwd` with forward slashes (`c:/Users/me/project`) or escaped backslashes;
Airlock answers invalid JSON with an error.

```json
{ "action": "list",  "cwd": "/path/to/workspace" }
{ "action": "open",  "cwd": "/path/to/workspace", "prompt": "<brief>", "send": true }
{ "action": "open",  "cwd": "/path/to/workspace", "session": "<id, optional>", "prompt": "<text, optional>" }
{ "action": "close", "cwd": "/path/to/workspace", "session": "<id>" }
{ "action": "title", "cwd": "/path/to/workspace", "session": "<id>", "name": "<short name>" }
{ "action": "start", "cwd": "/path/to/workspace", "prompt": "<task>", "open": true }
```

- `list` returns the open tabs and `autoSend`: whether Airlock Send is available in this window.
  Every response includes the tabs.
- `open` with `prompt` and `"send": true` opens a new tab and has Airlock Send press Send. It returns
  `sent: true` and the new `session` id (allow up to ~25 s). If Airlock Send isn't available it
  opens nothing and returns `autoSend: false`. If the press didn't happen, it returns `sent: false`
  and the brief is left typed in the new tab.
- `open` without `send` opens a blank tab, or with `session` opens or focuses that conversation.
  `prompt` only pre-fills the input box.
- `close` reveals that session's tab and closes it, and only ever closes Claude conversation tabs.
  A session's own id is in `$CLAUDE_CODE_SESSION_ID`.
- `title` names a session in the Session Manager (shows after a window reload). Airlock keeps the
  name attached for 7 days of inactivity.
- `start` runs a one-shot headless session (with the Claude CLI bundled in the Claude Code extension)
  and returns its `session` id; output goes to `~/.claude/airlock/runs/`. Don't use it for handoffs:
  the session ends after one reply, and with `"open": true` the tab can open blank.
- Requests older than 60 s are ignored.

## Telling Claude about it

Claude won't know Airlock exists unless told. Without this it may try to launch `claude` in a
terminal instead, which just opens the CLI's first-run setup. Paste this into `~/.claude/CLAUDE.md`
so every project picks it up (or into a single project's `CLAUDE.md`):

```markdown
## Handing off to new Claude tabs in VS Code (Airlock)

When asked to start a new session/tab, hand off to a new tab, or close this tab, use the Airlock VS Code extension
plus cross-session messaging. Do NOT launch `claude` in a terminal, use SendKeys, open `vscode://` links, or use
Airlock's `start` action (it runs a one-shot headless session).

Airlock reads request files: write JSON to `~/.claude/airlock/requests/<name>.json` (generate it with a JSON
serializer; on Windows use forward slashes in paths), then poll for `~/.claude/airlock/responses/<name>.json`, read
it and delete it. `cwd` = this session's workspace folder.

First send `{"action":"list","cwd":"<workspace>"}`. The response's `autoSend` says which route to use.

The new session gets no context from this one, so each brief must stand on its own: what the project is, where
things are, what was just finished, exactly what to do next, and who else to coordinate with. Do this ONE SESSION AT
A TIME, and run `ListAgents` before and after each open so you know the new session's name (the one new row).

If `autoSend` is true:
1. `{"action":"open","cwd":"<workspace>","prompt":"<full brief>","send":true}`. Allow up to ~30 s for the response.
2. `sent: true` means the brief went out as the tab's first message; `session` is its id. Never send that brief again.
3. `sent: false` with a tab opened means the brief is typed in the new tab but not sent: ask the user to press Enter
   there. Do not open another tab for the same brief.

If `autoSend` is false:
1. Open one blank tab: `{"action":"open","cwd":"<workspace>"}`. Wait ~5 s.
2. `ListAgents` again. The new tab is the one row that wasn't there before: `interactive`, `idle`, started a few
   seconds ago, name starting with the workspace folder name (e.g. `pet-simulator-3f`). If it isn't exactly one
   new row, stop and ask the user. Never guess.
3. `SendMessage` to that name with the full brief, ONCE. Never resend or "relay" a brief, and never message a
   session you didn't just identify this way. Start the brief by asking it to name itself:
   `{"action":"title","cwd":"<workspace>","session":"<its $CLAUDE_CODE_SESSION_ID>","name":"<short name>"}`
   (it shows in the Session Manager after the next window reload).

Once all are briefed, send each new session a short note with the others' names so they can message each other.

Other actions:
- Close a tab: `{"action":"close","cwd":"<workspace>","session":"<session id>"}`. This session's own id is in
  `$CLAUDE_CODE_SESSION_ID`. Close your own tab only as the very last step, after every brief has been sent.
- List tabs: `{"action":"list","cwd":"<workspace>"}`. Every response also includes the open tabs.

Source and docs: https://github.com/FlashCosmos/AirLock
```

A new session only reads `CLAUDE.md` at startup, so sessions already running won't see it until restarted.
