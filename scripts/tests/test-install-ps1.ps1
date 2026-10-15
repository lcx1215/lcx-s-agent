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
$fixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$script:npmRoot = Join-Path $fixture "npm-global"
$script:uninstallExit = 0
$script:viewExit = 0
$script:targets = @()
$script:npmExit = 0
function npm {
    $script:targets += ($args -join ' ')
    if ($args[0] -eq 'root') { $global:LASTEXITCODE = 0; return $script:npmRoot }
    if ($args[0] -eq 'view') { $global:LASTEXITCODE = $script:viewExit; return }
    if ($args[0] -eq 'uninstall') {
        if ($script:uninstallExit -eq 0) {
            Remove-Item -LiteralPath "$script:npmRoot/openclaw" -Recurse -Force
            $shim = Join-Path (Split-Path -Parent $script:npmRoot) 'openclaw.cmd'
            if (Test-Path -LiteralPath $shim) { Remove-Item -LiteralPath $shim -Force }
        }
        $global:LASTEXITCODE = $script:uninstallExit
        return
    }
    $global:LASTEXITCODE = $script:npmExit
}
function Assert($Condition, $Message) { if (!$Condition) { throw $Message } }
Assert (Install-OpenClawNpm -Version '2026.3.3') 'Own registry target failed'
Assert ($script:targets[-1] -eq 'install -g lcx-agent@2026.3.3 --no-fund --no-audit') 'Wrong package target'
$script:npmExit = 19
Assert (!(Install-OpenClawNpm)) 'Native npm failure reported success'
$script:npmExit = 0
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
    New-Item -ItemType Directory -Path "$script:npmRoot/openclaw" -Force | Out-Null
    '{"name":"openclaw","version":"2026.3.2","bin":{"openclaw":"cli.js"}}' | Set-Content "$script:npmRoot/openclaw/package.json"
    'process.exit(0);' | Set-Content "$script:npmRoot/openclaw/cli.js"
    'legacy shim bytes' | Set-Content "$fixture/openclaw.cmd"
    $originalShim = Get-Content "$fixture/openclaw.cmd" -Raw
    $script:viewExit = 1
    $count = $script:targets.Count
    Assert (!(Install-OpenClawNpm)) 'Unavailable replacement must preserve legacy install'
    Assert (!(($script:targets[$count..($script:targets.Count - 1)] -join ';').Contains('uninstall'))) 'Unavailable replacement removed legacy package'
    $script:viewExit = 0
    $script:uninstallExit = 23
    $count = $script:targets.Count
    Assert (!(Install-OpenClawNpm -Tarball "$fixture/lcx.tgz")) 'Legacy uninstall failure ignored'
    Assert (@($script:targets[$count..($script:targets.Count - 1)] | Where-Object { $_ -like 'install -g *' }).Count -eq 0) 'Install continued after failed removal'
    $script:uninstallExit = 0
    $script:npmExit = 19
    Assert (!(Install-OpenClawNpm -Tarball "$fixture/lcx.tgz")) 'Failed replacement reported success'
    Assert (Test-Path "$script:npmRoot/openclaw/package.json") 'Legacy package not restored'
    Assert ((Get-Content "$fixture/openclaw.cmd" -Raw) -eq $originalShim) 'Legacy shim bytes not restored'
    & node "$script:npmRoot/openclaw/cli.js"
    Assert ($LASTEXITCODE -eq 0) 'Restored legacy CLI cannot execute'
    $script:npmExit = 0
    Assert (Install-OpenClawNpm -Tarball "$fixture/lcx.tgz") 'Legacy package migration failed'
    Assert ($script:targets[-2] -eq 'uninstall -g openclaw --no-fund --no-audit') 'Wrong legacy removal target'
    Assert ($script:targets[-1].Contains('lcx.tgz')) 'Migration did not install own archive'
    $newDefault = Join-Path $fixture 'lcx-agent'
    $oldDefault = Join-Path $fixture 'openclaw'
    Assert ((Resolve-LcxGitDir -ProfileRoot $fixture) -eq $newDefault) 'Fresh default incorrect'
    New-Item -ItemType Directory -Path $oldDefault | Out-Null
    Assert ((Resolve-LcxGitDir -ProfileRoot $fixture) -eq $oldDefault) 'Legacy checkout bypassed'
    Assert ((Resolve-LcxGitDir -ProfileRoot $fixture -Requested 'explicit-checkout') -eq 'explicit-checkout') 'Explicit checkout ignored'
    New-Item -ItemType Directory -Path $newDefault | Out-Null
    Assert ((Resolve-LcxGitDir -ProfileRoot $fixture) -eq $newDefault) 'Current checkout priority lost'
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
