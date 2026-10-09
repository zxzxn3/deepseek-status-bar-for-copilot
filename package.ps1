# package.ps1 - Build and package the DeepSeek Usage extension into a .vsix.
# Usage: powershell -ExecutionPolicy Bypass -File .\package.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# One artifact per build, named with the version: no duplicate "current" copy.
$version = (Get-Content -Raw .\package.json | ConvertFrom-Json).version
$artifact = "deepseek-status-bar-for-copilot-$version.vsix"
Get-ChildItem -Path . -Filter "deepseek-status-bar-for-copilot*.vsix" -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne $artifact } |
    Remove-Item -Force

# Package. vsce automatically runs vscode:prepublish (production build).
npx.cmd -y @vscode/vsce package -o $artifact
if ($LASTEXITCODE -ne 0) {
    throw "vsce package failed (exit code $LASTEXITCODE)"
}

Write-Host "Packaged:"
Get-Item -LiteralPath ".\$artifact" |
    Select-Object -ExpandProperty Name
