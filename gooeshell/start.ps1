[CmdletBinding()]
param(
    [string]$BinDirectory,
    [switch]$NoWelcome
)

$ErrorActionPreference = 'Stop'
$gooeAppDirectory = $PSScriptRoot
$gooeRootDirectory = Split-Path -Parent $gooeAppDirectory
$gooeCandidates = @()
if ($BinDirectory) { $gooeCandidates += $BinDirectory }
if ($env:GOOESHELL_BIN_DIR) { $gooeCandidates += $env:GOOESHELL_BIN_DIR }
$gooeCandidates += $gooeRootDirectory
$gooeCandidates += (Join-Path $gooeRootDirectory 'bin')
$gooeCandidates += (Join-Path $gooeRootDirectory 'target\release')
$gooeCandidates += (Join-Path $gooeRootDirectory 'target\debug')
$gooePreviewRoot = Join-Path $gooeRootDirectory '.tools\wezterm-preview\runtime'
if (Test-Path -LiteralPath $gooePreviewRoot) {
    $gooeCandidates += Get-ChildItem -LiteralPath $gooePreviewRoot -Directory | ForEach-Object { $_.FullName }
}

$gooeBinaryDirectory = $null
foreach ($gooeCandidate in $gooeCandidates) {
    if (Test-Path -LiteralPath (Join-Path $gooeCandidate 'wezterm-gui.exe')) {
        $gooeBinaryDirectory = (Resolve-Path -LiteralPath $gooeCandidate).Path
        break
    }
}
if (-not $gooeBinaryDirectory) {
    throw '没有找到 wezterm-gui.exe。请解压完整的 gooeshell 便携包，或先构建项目。'
}

$gooeDataDirectory = Join-Path $gooeAppDirectory 'data'
$gooeSessionDirectory = Join-Path $gooeDataDirectory 'sessions'
[void][System.IO.Directory]::CreateDirectory($gooeSessionDirectory)
[void][System.IO.Directory]::CreateDirectory((Join-Path $gooeAppDirectory 'fonts'))
$gooeSessionPath = Join-Path $gooeSessionDirectory (([guid]::NewGuid().ToString('N')) + '.known_hosts')
$gooeOldEnvironment = @{}
$gooeNames = @('GOOESHELL_BIN_DIR', 'GOOESHELL_DATA_DIR', 'GOOESHELL_SESSION_KNOWN_HOSTS', 'GOOESHELL_DEFAULT_SHELL', 'GOOESHELL_NO_WELCOME')
foreach ($gooeName in $gooeNames) { $gooeOldEnvironment[$gooeName] = [Environment]::GetEnvironmentVariable($gooeName, 'Process') }

try {
    $env:GOOESHELL_BIN_DIR = $gooeBinaryDirectory
    $env:GOOESHELL_DATA_DIR = $gooeDataDirectory
    $env:GOOESHELL_SESSION_KNOWN_HOSTS = $gooeSessionPath
    $gooePowerShell = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if (-not $gooePowerShell) { $gooePowerShell = Get-Command powershell.exe -ErrorAction Stop }
    $env:GOOESHELL_DEFAULT_SHELL = $gooePowerShell.Source
    if ($NoWelcome) { $env:GOOESHELL_NO_WELCOME = '1' }

    $gooeConfig = Join-Path $gooeAppDirectory 'gooeshell.lua'
    $gooeArguments = '--config-file "' + $gooeConfig + '" start --always-new-process'
    $gooeProcess = Start-Process -FilePath (Join-Path $gooeBinaryDirectory 'wezterm-gui.exe') -ArgumentList $gooeArguments -WorkingDirectory $gooeRootDirectory -PassThru
    $gooeProcess.WaitForExit()
    if ($gooeProcess.ExitCode -ne 0) { throw ('终端退出码：' + $gooeProcess.ExitCode) }
}
finally {
    # Remove only files assigned to this launch. Other windows may still be connected.
    foreach ($gooeEphemeralPath in @($gooeSessionPath, ($gooeSessionPath + '.old'))) {
        if (Test-Path -LiteralPath $gooeEphemeralPath) { Remove-Item -LiteralPath $gooeEphemeralPath -Force }
    }
    foreach ($gooeName in $gooeNames) { [Environment]::SetEnvironmentVariable($gooeName, $gooeOldEnvironment[$gooeName], 'Process') }
}
