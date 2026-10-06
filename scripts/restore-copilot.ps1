<#
.SYNOPSIS
    Undoes scripts/claim-win-c.ps1 and gives Win+C back to Windows Copilot.

.DESCRIPTION
    Reads the backup written by claim-win-c.ps1 and restores each value to
    exactly what it was. Values that did not exist beforehand are removed
    rather than set to a guessed default.
#>
[CmdletBinding()]
param(
    [switch]$RestartExplorer
)

$ErrorActionPreference = 'Stop'

$backupFile = Join-Path $env:LOCALAPPDATA 'Wumpy\copilot-backup.json'

if (-not (Test-Path $backupFile)) {
    Write-Warning "No backup found at $backupFile."
    Write-Host 'Removing the Wumpy policy value anyway so Copilot is re-enabled.' -ForegroundColor Yellow
    Remove-ItemProperty -Path 'HKCU:\Software\Policies\Microsoft\Windows\WindowsCopilot' `
        -Name 'TurnOffWindowsCopilot' -ErrorAction SilentlyContinue
}
else {
    # ConvertFrom-Json returns a single object (not an array) for one-item files.
    $backup = @(Get-Content $backupFile -Raw | ConvertFrom-Json)

    foreach ($entry in $backup) {
        if ($entry.Existed) {
            if (-not (Test-Path $entry.Path)) { New-Item -Path $entry.Path -Force | Out-Null }
            New-ItemProperty -Path $entry.Path -Name $entry.Name -Value $entry.Value `
                -PropertyType DWord -Force | Out-Null
            Write-Host "Restored $($entry.Path)\$($entry.Name) = $($entry.Value)" -ForegroundColor Green
        }
        else {
            Remove-ItemProperty -Path $entry.Path -Name $entry.Name -ErrorAction SilentlyContinue
            Write-Host "Removed $($entry.Path)\$($entry.Name)" -ForegroundColor Green

            # Drop the policy key too, but only if Wumpy created it and it is now empty.
            if (-not $entry.KeyExisted -and (Test-Path $entry.Path)) {
                $remaining = (Get-Item $entry.Path).GetValueNames()
                if ($remaining.Count -eq 0) {
                    Remove-Item -Path $entry.Path -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }

    Remove-Item $backupFile -Force
    Write-Host "Backup consumed and deleted." -ForegroundColor DarkGray
}

Write-Host ''
Write-Host 'Windows Copilot will take Win+C back after Explorer reloads.' -ForegroundColor Cyan

$doRestart = $RestartExplorer
if (-not $doRestart) {
    $answer = Read-Host 'Restart Explorer now? [y/N]'
    $doRestart = $answer -match '^(y|yes)$'
}

if ($doRestart) {
    Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 1200
    if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) {
        Start-Process explorer.exe
    }
    Write-Host 'Explorer restarted.' -ForegroundColor Green
}
