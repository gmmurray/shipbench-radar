# Puts a "Radar" shortcut on the desktop that runs scripts\radar.cmd from this
# checkout. A shortcut rather than a copy of the .cmd, because the launcher
# finds the repository relative to its own location. Safe to re-run: it
# overwrites the shortcut, e.g. after moving the checkout.

$repo = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$path = Join-Path $desktop 'Radar.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($path)
$shortcut.TargetPath = Join-Path $repo 'scripts\radar.cmd'
$shortcut.WorkingDirectory = $repo
$shortcut.Description = 'Start Radar'
$shortcut.Save()

Write-Output "Created $path"
Write-Output "  -> $($shortcut.TargetPath)"
