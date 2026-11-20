// Airlock Send
// Runs on the local (UI) side of VS Code, even in Remote-SSH and tunnel windows, and registers one
// command for Airlock: press the Send button of the newly opened Claude tab in this window.
// Windows only for now (UI Automation). It only presses Send when exactly one window title matches
// and that window has exactly one visible, enabled "Send message" button.

const vscode = require('vscode');
const cp = require('child_process');

const SEND_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$root = $A::RootElement
$wc = New-Object Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Chrome_WidgetWin_1')
$bc = New-Object Windows.Automation.PropertyCondition($A::NameProperty, $env:AIRLOCK_SEND_LABEL)
$prefix = $env:AIRLOCK_TITLE_PREFIX
for ($t = 0; $t -lt 16; $t++) {
  Start-Sleep -Milliseconds 500
  $w = @($root.FindAll([Windows.Automation.TreeScope]::Children, $wc) | Where-Object {
    $n = $_.Current.Name; $n.StartsWith($prefix) -and $n.Contains('Visual Studio Code') })
  if ($w.Count -ne 1) { continue }
  $b = @($w[0].FindAll([Windows.Automation.TreeScope]::Descendants, $bc) | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled })
  if ($b.Count -ne 1) { continue }
  $b[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  'RESULT:SENT'; exit 0
}
'RESULT:NOTSENT'`;

function press({ tabLabel, workspaceName, sendLabel }) {
  if (process.platform !== 'win32') return Promise.resolve({ sent: false, error: 'Airlock Send is Windows-only for now' });
  return new Promise((resolve) => {
    const env = { ...process.env, AIRLOCK_TITLE_PREFIX: `${tabLabel} - ${workspaceName}`, AIRLOCK_SEND_LABEL: sendLabel || 'Send message' };
    delete env.ELECTRON_RUN_AS_NODE;
    cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SEND_PS],
      { env, windowsHide: true, timeout: 20000 }, (err, stdout) => {
        const out = String(stdout || '');
        if (out.includes('RESULT:SENT')) resolve({ sent: true });
        else resolve({ sent: false, error: err ? String(err.message).slice(0, 200) : 'tab not active or Send button not found' });
      });
  });
}

function activate(context) {
  // Only register where pressing is supported, so Airlock can tell whether auto-send is available.
  if (process.platform !== 'win32') return;
  context.subscriptions.push(vscode.commands.registerCommand('airlockSend.press', press));
}

function deactivate() {}

module.exports = { activate, deactivate };
