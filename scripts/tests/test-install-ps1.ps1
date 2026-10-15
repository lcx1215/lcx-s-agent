# Exercise installer functions only: no Main, actual install, registry, or user PATH writes.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '../install.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    Invoke-Expression $definition.Extent.Text
}
function Write-Host { param($Message, $Level) }
$script:targets = @()
$script:npmExit = 0
function npm {
    $script:targets += ($args -join ' ')
    $global:LASTEXITCODE = $script:npmExit
}
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
Assert (Install-OpenClawNpm -Version '2026.3.3') 'Own registry target failed'
Assert ($script:targets[-1] -eq 'install -g lcx-agent@2026.3.3 --no-fund --no-audit') 'Wrong package target'
$script:npmExit = 19
Assert (!(Install-OpenClawNpm)) 'Native npm failure reported success'
$script:npmExit = 0
$fixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
try {
    New-Item -ItemType Directory -Path "$fixture/package" -Force | Out-Null
    '{"name":"lcx-agent","version":"2026.3.3","bin":{"lcx":"lcx.mjs"}}' | Set-Content "$fixture/package/package.json"
    tar -czf "$fixture/lcx.tgz" -C $fixture package
    Assert ($LASTEXITCODE -eq 0) 'Fixture pack failed'
    Assert (Install-OpenClawNpm -Tarball "$fixture/lcx.tgz") 'Current build archive rejected'
    Assert ($script:targets[-1].Contains('lcx.tgz')) 'Archive not used'
    '{"name":"openclaw","version":"2026.3.3","bin":{"lcx":"lcx.mjs"}}' | Set-Content "$fixture/package/package.json"
    tar -czf "$fixture/upstream.tgz" -C $fixture package
    $count = $script:targets.Count
    Assert (!(Install-OpenClawNpm -Tarball "$fixture/upstream.tgz")) 'Upstream archive accepted'
    Assert ($script:targets.Count -eq $count) 'Invalid archive reached npm'
    Assert (!(Install-OpenClawNpm -Tarball "$fixture/missing.tgz")) 'Missing archive accepted'
    # Git wrappers must preserve Unicode checkout paths and the legacy command.
    $oldProfile = $env:USERPROFILE
    try {
        $env:USERPROFILE = $fixture
        $repo = Join-Path $fixture 'LCX 中文 checkout'
        New-Item -ItemType Directory -Path $repo -Force | Out-Null
        'process.exit(17);' | Set-Content (Join-Path $repo 'lcx.mjs')
        function pnpm { $global:LASTEXITCODE = 0 }
        function Add-ToPath { param($Path) }
        Assert (Install-OpenClawGit -RepoDir $repo) 'Git install wrapper generation failed'
        $PSNativeCommandUseErrorActionPreference = $false
        & "$fixture/.local/bin/lcx.cmd" --version
        Assert ($LASTEXITCODE -eq 17) 'Canonical wrapper lost Unicode path or exit code'
        & "$fixture/.local/bin/openclaw.cmd" --version
        Assert ($LASTEXITCODE -eq 17) 'Legacy wrapper failed to delegate'
    } finally { $env:USERPROFILE = $oldProfile }
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
# Expected nonzero native exits were asserted above; leave the CI shell successful.
$global:LASTEXITCODE = 0
Microsoft.PowerShell.Utility\Write-Output 'LCX Windows installer: own target/archive/native failure/invalid artifact checks passed'
