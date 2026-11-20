// Airlock
// Polls ~/.claude/airlock/requests/*.json and performs one of these actions:
//   { "action": "start", "cwd": "<folder>", "prompt": "<task>", "open": true? }
//       runs a new Claude session in the background (Claude CLI bundled with the
//       Claude Code extension; no separate install needed) and optionally opens it in a tab
//   { "action": "open",  "cwd": "<folder>", "session": "<id>"?, "prompt": "<text>"? }
//   { "action": "close", "cwd": "<folder>", "session": "<id>" }
//   { "action": "list",  "cwd": "<folder>" }
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
  await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', req.session || undefined, req.prompt || undefined);
  await sleep(1000);
  return { ok: true, tabs: listTabs() };
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
  try { req = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { return; } // partially written; retry next tick
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
    else if (req.action === 'list') result = { ok: true, tabs: listTabs() };
    else result = { ok: false, error: 'unknown action: ' + req.action };
  } catch (e) {
    result = { ok: false, error: String(e && e.message || e) };
  }
  try { fs.unlinkSync(claimed); } catch {}
  try { fs.writeFileSync(path.join(RES, file), JSON.stringify({ ...result, action: req.action, at: new Date().toISOString() })); } catch {}
  log.appendLine(`${new Date().toISOString()} ${file} ${req.action} -> ${JSON.stringify(result)}`);
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
  context.subscriptions.push(
    log,
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand('airlock.showLog', () => log.show())
  );
  log.appendLine(`active; watching ${REQ}`);
}

function deactivate() {}

module.exports = { activate, deactivate };
