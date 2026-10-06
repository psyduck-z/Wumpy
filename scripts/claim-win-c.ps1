<#
.SYNOPSIS
    Frees the Win+C shortcut so Wumpy can register it.

.DESCRIPTION
    While Windows Copilot is enabled the shell holds Win+C, and any
    RegisterHotKey call for that combination is refused. Setting the
    TurnOffWindowsCopilot policy releases the shortcut.

    This writes only to HKCU, so it affects the current user and needs no
    elevation. Run scripts/restore-copilot.ps1 to undo everything.

.NOTES
    Explorer caches the policy at sign-in, so the script offers to restart it.
#>
[CmdletBinding()]
param(
    # Restart Explorer without asking. Required for the change to take effect now.
    [switch]$RestartExplorer
)

$ErrorActionPreference = 'Stop'

$policies = @(
    # The documented policy; frees Win+C on Windows 11 22H2+.
    @{ Path = 'HKCU:\Software\Policies\Microsoft\Windows\WindowsCopilot'; Name = 'TurnOffWindowsCopilot'; Value = 1 },
    # Removes the taskbar button so the key is not re-bound by the shell.
    @{ Path = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'; Name = 'ShowCopilotButton'; Value = 0 }
)

$backupDir = Join-Path $env:LOCALAPPDATA 'Wumpy'
$backupFile = Join-Path $backupDir 'copilot-backup.json'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

# Capture the prior state once, so restore puts things back exactly as found.
if (-not (Test-Path $backupFile)) {
    $backup = foreach ($p in $policies) {
        $existing = $null
        if (Test-Path $p.Path) {
            $existing = (Get-ItemProperty -Path $p.Path -Name $p.Name -ErrorAction SilentlyContinue).($p.Name)
        }
        [pscustomobject]@{
            Path     = $p.Path
            Name     = $p.Name
            Existed  = $null -ne $existing
            Value    = $existing
            KeyExisted = (Test-Path $p.Path)
        }
    }
    $backup | ConvertTo-Json -Depth 4 | Set-Content -Path $backupFile -Encoding UTF8
    Write-Host "Saved previous state to $backupFile" -ForegroundColor DarkGray
}
else {
    Write-Host "Existing backup kept at $backupFile" -ForegroundColor DarkGray
}

foreach ($p in $policies) {
    if (-not (Test-Path $p.Path)) {
        New-Item -Path $p.Path -Force | Out-Null
    }
    New-ItemProperty -Path $p.Path -Name $p.Name -Value $p.Value -PropertyType DWord -Force | Out-Null
    Write-Host "Set $($p.Path)\$($p.Name) = $($p.Value)" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Win+C is released once Explorer reloads the policy.' -ForegroundColor Cyan

$doRestart = $RestartExplorer
if (-not $doRestart) {
    $answer = Read-Host 'Restart Explorer now? Taskbar will blink for a second. [y/N]'
    $doRestart = $answer -match '^(y|yes)$'
}

if ($doRestart) {
    Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
    # Windows normally relaunches Explorer itself; start it if it does not.
    Start-Sleep -Milliseconds 1200
    if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) {
        Start-Process explorer.exe
    }
    Write-Host 'Explorer restarted. Start Wumpy and press Win+C.' -ForegroundColor Green
}
else {
    Write-Host 'Sign out and back in (or restart Explorer) to apply.' -ForegroundColor Yellow
}
