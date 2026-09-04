# drives a NATIVE dialog by window title and presses its named button.
# used by run.cjs S17 (D59): the overwrite gate opens a real rfd task dialog
# ("file already exists", buttons "overwrite"/"cancel") that cannot be
# intercepted from the webview (internals frozen, plugin module is ESM) and
# has no default button (Enter is inert) — so UI Automation is the only
# programmatic path. presses InvokePattern when the provider supports it and
# falls back to a synthetic mouse click at the button's rect center
# (cursor position saved/restored; WinForms-style providers sometimes
# advertise no InvokePattern). exits 0 on press, 2 on no-rect, 3 on timeout.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$TimeoutMs = 15000,
  [string]$Owner = 'ytdlp-gui',
  [switch]$Probe
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Runtime.InteropServices;
public static class Win32Click {
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);
  public struct POINT { public int X; public int Y; }
  public const uint LEFTDOWN = 0x02, LEFTUP = 0x04;
  public static void Click(int x, int y) {
    POINT p; GetCursorPos(out p); int ox = p.X, oy = p.Y;
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(60);
    mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    SetCursorPos(ox, oy);
  }
}
'@
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Title)
# find the dialog: rfd opens it OWNED by the app's main window, so UIA nests
# it under the owner element — a root-children search never sees it (found
# live: 'dialog-not-found' while the box sat open on screen). try root
# children first (unowned dialogs), then the owner window's subtree.
function Find-Dialog($titleCond) {
  $d = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $titleCond)
  if ($d) { return $d }
  if ($Owner) {
    $ownCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Owner)
    $owner = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $ownCond)
    if ($owner) { return $owner.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $titleCond) }
  }
  return $null
}
# -Probe: report whether the dialog is currently open (for failure dumps)
if ($Probe) {
  $d = Find-Dialog $cond
  if (-not $d) { Write-Output 'closed'; exit 0 }
  $bcond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  $b = $d.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $bcond)
  Write-Output $(if ($b) { 'open:button-present' } else { 'open:button-missing' })
  exit 0
}
while ((Get-Date) -lt $deadline) {
  $dlg = Find-Dialog $cond
  if ($dlg) {
    $bcond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
    $btn = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $bcond)
    if ($btn) {
      try {
        $rect = $btn.Current.BoundingRectangle
        if ($rect.IsEmpty) { Write-Output 'btn-no-rect'; exit 2 }
        $cx = [int]($rect.X + $rect.Width / 2)
        $cy = [int]($rect.Y + $rect.Height / 2)
        $invoked = $false
        try {
          $pattern = $null
          if ($btn.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            $pattern.Invoke()
            $invoked = $true
            Write-Output 'clicked:invoke'
          }
        } catch { }
        if (-not $invoked) {
          [Win32Click]::Click($cx, $cy)
          Write-Output 'clicked:click'
        }
        exit 0
      } catch {
        # element vanished between find and press (dialog closed underneath
        # us) — fall through and retry the search
        Write-Output 'btn-vanished-retrying'
      }
    }
  }
  Start-Sleep -Milliseconds 200
}
Write-Output 'dialog-not-found'
exit 3
