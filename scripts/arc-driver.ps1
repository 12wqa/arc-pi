<#
ARC proof-of-concept autodriver for Windows Terminal / PowerShell.
Watches $HOME\.pi\agent\arc\trigger.json and presses Enter in a target window.

Usage examples:
  # Find a stable title/process, then run:
  powershell -ExecutionPolicy Bypass -File .\scripts\arc-driver.ps1 -WindowTitle "pi"

Notes:
  - This mirrors the old Claude Code SendKeys workaround.
  - It assumes the ARC extension has already drafted /arc-rollover threshold in Pi's editor.
  - Keep this experimental; native Pi support is preferable.
#>
param(
  [string]$TriggerPath = "$HOME\.pi\agent\arc\trigger.json",
  [string]$WindowTitle = "pi",
  [int]$PollMilliseconds = 1000,
  [switch]$SendCommand
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic

$stateDir = Join-Path $HOME ".pi\agent\arc"
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$stateFile = Join-Path $stateDir "driver-last-trigger-id.txt"
if (!(Test-Path $stateFile)) { Set-Content -Path $stateFile -Value "" }

Write-Host "arc-driver.ps1: watching $TriggerPath"
Write-Host "arc-driver.ps1: target window title contains '$WindowTitle'"
Write-Host "arc-driver.ps1: Ctrl-C to stop"

while ($true) {
  try {
    if (Test-Path $TriggerPath) {
      $json = Get-Content -Raw -Path $TriggerPath | ConvertFrom-Json
      $id = [string]$json.id
      $command = if ($json.command) { [string]$json.command } else { "/arc-rollover threshold" }
      $last = (Get-Content -Raw -Path $stateFile).Trim()

      if ($id -and $id -ne $last) {
        Write-Host "arc-driver.ps1: trigger $id -> $command"
        [Microsoft.VisualBasic.Interaction]::AppActivate($WindowTitle) | Out-Null
        Start-Sleep -Milliseconds 250
        if ($SendCommand) {
          [System.Windows.Forms.SendKeys]::SendWait($command + "{ENTER}")
        } else {
          [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
        }
        Set-Content -Path $stateFile -Value $id
        Move-Item -Force -Path $TriggerPath -Destination ($TriggerPath + ".consumed")
      }
    }
  } catch {
    Write-Warning $_.Exception.Message
  }
  Start-Sleep -Milliseconds $PollMilliseconds
}
