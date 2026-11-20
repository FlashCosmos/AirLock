// Airlock
// Polls ~/.claude/airlock/requests/*.json and performs one of these actions:
//   { "action": "open",  "cwd": "<folder>", "session": "<id>"?, "prompt": "<text>"?, "send": true? }
//       with "send": true and a prompt, the companion "Airlock Send" presses Send in the new tab.
//   { "action": "close", "cwd": "<folder>", "session": "<id>" }
//   { "action": "list",  "cwd": "<folder>" }
//   { "action": "title", "cwd": "<folder>", "session": "<id>", "name": "<title>" }
//       names the session in Claude's session history; Airlock keeps the title line near the end
//       of the transcript so the history keeps finding it.
//   { "action": "start", "cwd": "<folder>", "prompt": "<task>", "open": true? }
//       one-shot headless run with the Claude CLI bundled in the Claude Code extension.
//       Not for handoffs: open a blank tab and brief it with SendMessage instead (see README).
// Only the VS Code window whose workspace contains `cwd` claims a request.
// "close" only ever closes a Claude Code conversation tab (webview claudeVSCodePanel).
// The result is written to ~/.claude/airlock/responses/<same name>.json.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(os.homedir(), '.claude', 'airlock');
const REQ = path.join(ROOT, 'requests');
const RES = path.join(ROOT, 'responses');
const RUNS = path.join(ROOT, 'runs');
const POLL_MS = 750;
const MAX_AGE_MS = 60_000; // ignore stale requests
const CLAUDE_VIEW = 'claudeVSCodePanel';

let log;
let busy = false;

function norm(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch {} // e.g. macOS /tmp -> /private/tmp
  r = r.replace(/[\\/]+$/, '');
  // Windows and default macOS volumes are case-insensitive.
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
}

function ownsCwd(cwd) {
  if (!cwd) return false;
  const c = norm(cwd);
  return (vscode.workspace.workspaceFolders || []).some((f) => {
    if (f.uri.scheme !== 'file' && f.uri.scheme !== 'vscode-remote') return false;
    const w = norm(f.uri.fsPath);
    return c === w || c.startsWith(w + path.sep);
  });
}

function isClaudeTab(tab) {
  const input = tab && tab.input;
  return !!input && input instanceof vscode.TabInputWebview && String(input.viewType).endsWith(CLAUDE_VIEW);
}

function activeClaudeTab() {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return isClaudeTab(tab) ? tab : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doOpen(req) {
  if (req.send && req.prompt && !req.session) return doOpenAndSend(req);
  await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', req.session || undefined, req.prompt || undefined);
  await sleep(1000);
  return { ok: true, tabs: listTabs() };
}

// Open a new Claude tab with `prompt` pre-filled, then have the "Airlock Send" companion press its
// Send button. The companion runs on the machine where the VS Code window is (also in Remote-SSH
// and tunnel windows); the Claude extension itself has no auto-send, and keypresses don't reach it.
async function pressSend(tabLabel) {
  try {
    const r = await vscode.commands.executeCommand('airlockSend.press', { tabLabel, workspaceName: vscode.workspace.name || '', sendLabel: 'Send message' });
    return r || { sent: false, error: 'Airlock Send returned nothing' };
  } catch (e) {
    return { sent: false, error: 'Airlock Send companion not installed on this computer (' + String(e && e.message || e).slice(0, 120) + ')' };
  }
}

function findNewSession(prompt, since) {
  const snippet = JSON.stringify(prompt.slice(0, 60)).slice(1, -1);
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch { return undefined; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(projects, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const full = path.join(projects, d, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < since) continue;
        const fd = fs.openSync(full, 'r'); const buf = Buffer.alloc(Math.min(st.size, 262144));
        try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
        if (buf.toString('utf8').includes(snippet)) return f.slice(0, -6);
      } catch {}
    }
  }
  return undefined;
}

// Airlock Send registers its command only where it can press buttons (Windows), so this tells
// Claude up front whether open+send will work in this window.
async function autoSendAvailable() {
  try { return (await vscode.commands.getCommands(true)).includes('airlockSend.press'); } catch { return false; }
}

async function doOpenAndSend(req) {
  if (!(await autoSendAvailable())) {
    return { ok: false, sent: false, autoSend: false, error: 'Airlock Send is not installed on this computer (or not supported on this OS); no tab was opened. Open a blank tab and brief it with SendMessage instead.', tabs: listTabs() };
  }
  const since = Date.now();
  const before = new Set(claudeTabs());
  await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', undefined, req.prompt);
  let tab;
  for (let i = 0; i < 20 && !tab; i++) { await sleep(150); const t = activeClaudeTab(); if (t && !before.has(t)) tab = t; }
  if (!tab) return { ok: false, sent: false, error: 'new tab did not become active; prompt left unsent', tabs: listTabs() };
  const r = await pressSend(tab.label);
  if (!r.sent) return { ok: true, sent: false, error: (r.error || 'not sent') + '; the prompt is typed in the new tab', tabs: listTabs() };
  let session;
  for (let i = 0; i < 30 && !session; i++) { await sleep(500); session = findNewSession(req.prompt, since); }
  return { ok: true, sent: true, session, tabs: listTabs() };
}

// The Claude Code extension ships its own CLI binary; prefer it so users need no separate install.
function claudeBinary() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const p = path.join(ext.extensionPath, 'resources', 'native-binary', exe);
    if (fs.existsSync(p)) return p;
  }
  return exe; // fall back to a `claude` on PATH
}

async function doStart(req) {
  if (!req.prompt) return { ok: false, error: 'start needs a prompt' };
  const bin = claudeBinary();
  fs.mkdirSync(RUNS, { recursive: true });
  const runLog = path.join(RUNS, `${Date.now()}-${process.pid}.jsonl`);
  const fd = fs.openSync(runLog, 'w');
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  let child;
  try {
    child = cp.spawn(bin, ['-p', req.prompt, '--output-format', 'stream-json', '--verbose'], {
      cwd: req.cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
    });
  } finally { fs.closeSync(fd); }
  let spawnError;
  child.on('error', (e) => { spawnError = e; });
  child.unref();

  // The first stream-json line ({"type":"system","subtype":"init",...}) carries the session id.
  let session;
  for (let i = 0; i < 120 && !session && !spawnError; i++) {
    await sleep(250);
    try {
      for (const line of fs.readFileSync(runLog, 'utf8').split('\n')) {
        try { const m = JSON.parse(line); if (m.session_id) { session = m.session_id; break; } } catch {}
      }
    } catch {}
  }
  if (!session) {
    let tail = '';
    try { tail = fs.readFileSync(runLog, 'utf8').slice(-500); } catch {}
    return { ok: false, error: spawnError ? String(spawnError.message) : 'no session id within 30 s', binary: bin, output: tail };
  }
  const result = { ok: true, session, binary: bin, log: runLog };
  if (req.open) Object.assign(result, await doOpen({ session }), { ok: true });
  return result;
}

function claudeTabs() {
  const out = [];
  for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) if (isClaudeTab(t)) out.push(t);
  return out;
}

function listTabs() {
  return vscode.window.tabGroups.all.flatMap((g) =>
    g.tabs.map((t) => ({ group: g.viewColumn, label: t.label, claude: isClaudeTab(t), active: t.isActive && g.isActive })));
}

async function doClose(req) {
  if (!req.session) return { ok: false, error: 'close needs a session id' };
  const before = new Set(claudeTabs());
  // Revealing the session's existing tab makes it the active tab; then close exactly that tab.
  await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', req.session, undefined);
  let tab;
  for (let i = 0; i < 10 && !tab; i++) { await sleep(150); tab = activeClaudeTab(); }
  if (!tab) return { ok: false, error: 'active tab after reveal is not a Claude tab; nothing closed', tabs: listTabs() };
  // If the reveal spawned a fresh tab instead of focusing the old one, close both copies.
  const extra = claudeTabs().filter((t) => !before.has(t) && t !== tab);
  const victims = [tab, ...extra];
  const original = !before.has(tab) ? claudeTabs().find((t) => before.has(t) && t.label === tab.label) : undefined;
  if (original) victims.push(original);
  const closed = victims.map((t) => t.label);
  await vscode.window.tabGroups.close(victims, true);
  return { ok: true, closed, revealMadeNewTab: !before.has(tab), tabs: listTabs() };
}

async function handle(file) {
  const full = path.join(REQ, file);
  let req;
  try { req = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) {
    // Maybe still being written: retry for a few seconds, then report it instead of retrying forever.
    let age = 0;
    try { age = Date.now() - fs.statSync(full).mtimeMs; } catch { return; }
    if (age < 3000) return;
    try { fs.unlinkSync(full); } catch { return; }
    const error = 'invalid JSON (' + String(e && e.message || e).slice(0, 120) + '); on Windows, escape backslashes in cwd or use forward slashes';
    try { fs.writeFileSync(path.join(RES, file), JSON.stringify({ ok: false, error, at: new Date().toISOString() })); } catch {}
    log.appendLine(`${new Date().toISOString()} ${file} -> ${error}`);
    return;
  }
  if (!ownsCwd(req.cwd)) return; // another window's job

  // Claim atomically so two windows on the same folder can't both act.
  const claimed = full + '.' + process.pid + '.claimed';
  try { fs.renameSync(full, claimed); } catch { return; }

  let result;
  try {
    const age = Date.now() - fs.statSync(claimed).mtimeMs;
    if (age > MAX_AGE_MS) result = { ok: false, error: 'stale request ignored' };
    else if (req.action === 'open') result = await doOpen(req);
    else if (req.action === 'close') result = await doClose(req);
    else if (req.action === 'start') result = await doStart(req);
    else if (req.action === 'title') result = await doTitle(req);
    else if (req.action === 'list') result = { ok: true, autoSend: await autoSendAvailable(), tabs: listTabs() };
    else result = { ok: false, error: 'unknown action: ' + req.action };
  } catch (e) {
    result = { ok: false, error: String(e && e.message || e) };
  }
  try { fs.unlinkSync(claimed); } catch {}
  try { fs.writeFileSync(path.join(RES, file), JSON.stringify({ ...result, action: req.action, at: new Date().toISOString() })); } catch {}
  log.appendLine(`${new Date().toISOString()} ${file} ${req.action} -> ${JSON.stringify(result)}`);
}

// Give a session a title in Claude's session history (and the iPhone/web app list).
// The history only reads the start and end of each transcript, so the title line must stay near
// the end of the file: Airlock re-appends it whenever the session has written past it.
const TITLES = path.join(ROOT, 'titles.json');
const TAIL_BYTES = 16 * 1024;
const TITLE_TTL_MS = 7 * 24 * 3600 * 1000;

function loadTitles() { try { return JSON.parse(fs.readFileSync(TITLES, 'utf8')); } catch { return {}; } }
function saveTitles(t) { try { fs.writeFileSync(TITLES, JSON.stringify(t, null, 1)); } catch {} }

function findTranscript(session) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch { return undefined; }
  for (const d of dirs) {
    const f = path.join(projects, d, session + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

function titleLine(session, name) {
  return JSON.stringify({ type: 'custom-title', sessionId: session, customTitle: name }) + '\n';
}

function tailHasTitle(file, session, name) {
  const st = fs.statSync(file);
  const len = Math.min(st.size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
  return buf.toString('utf8').includes(titleLine(session, name).trim());
}

function ensureTitle(file, session, name) {
  if (tailHasTitle(file, session, name)) return false;
  fs.appendFileSync(file, titleLine(session, name));
  return true;
}

async function doTitle(req) {
  const name = String(req.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
  if (!/^[0-9a-f-]{36}$/i.test(String(req.session || '')) || !name) return { ok: false, error: 'title needs a session id and a name' };
  const file = findTranscript(req.session);
  if (!file) return { ok: false, error: 'no transcript found for that session yet' };
  ensureTitle(file, req.session, name);
  const titles = loadTitles();
  titles[req.session] = { name, file, at: Date.now() };
  saveTitles(titles);
  return { ok: true, name, note: 'shows in the Session Manager after the next window reload; the open tab label does not change' };
}

function keepTitles() {
  const titles = loadTitles();
  let changed = false;
  for (const [session, t] of Object.entries(titles)) {
    try {
      const st = fs.statSync(t.file);
      if (Date.now() - st.mtimeMs > TITLE_TTL_MS) { delete titles[session]; changed = true; continue; }
      if (t.mtime === st.mtimeMs) continue;
      if (ensureTitle(t.file, session, t.name)) log.appendLine(`re-appended title "${t.name}" for ${session}`);
      t.mtime = fs.statSync(t.file).mtimeMs; changed = true;
    } catch { delete titles[session]; changed = true; }
  }
  if (changed) saveTitles(titles);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const files = fs.readdirSync(REQ).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) await handle(f);
  } catch {} finally { busy = false; }
}

function activate(context) {
  log = vscode.window.createOutputChannel('Airlock');
  fs.mkdirSync(REQ, { recursive: true });
  fs.mkdirSync(RES, { recursive: true });
  const timer = setInterval(tick, POLL_MS);
  const titleTimer = setInterval(() => { try { keepTitles(); } catch {} }, 15_000);
  context.subscriptions.push(
    log,
    { dispose: () => { clearInterval(timer); clearInterval(titleTimer); } },
    vscode.commands.registerCommand('airlock.showLog', () => log.show())
  );
  log.appendLine(`active; watching ${REQ}`);
}

function deactivate() {}

module.exports = { activate, deactivate };
