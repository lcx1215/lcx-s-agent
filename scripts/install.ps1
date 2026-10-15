# LCX Agent Installer for Windows (PowerShell)
# Usage: iwr -useb https://raw.githubusercontent.com/lcx1215/lcx-s-agent/main/scripts/install.ps1 | iex
# Or: & ([scriptblock]::Create((iwr -useb https://raw.githubusercontent.com/lcx1215/lcx-s-agent/main/scripts/install.ps1))) -NoOnboard

param(
    [string]$InstallMethod = "npm",
    [string]$Tag = "latest",
    [string]$Artifact = $env:LCX_INSTALL_TARBALL,
    [string]$GitDir = "",
    [switch]$NoOnboard,
    [switch]$NoGitUpdate,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Colors
$ACCENT = "`e[38;2;255;77;77m"    # coral-bright
$SUCCESS = "`e[38;2;0;229;204m"    # cyan-bright
$WARN = "`e[38;2;255;176;32m"     # amber
$ERROR = "`e[38;2;230;57;70m"     # coral-mid
$MUTED = "`e[38;2;90;100;128m"    # text-muted
$NC = "`e[0m"                     # No Color

function Write-Host {
    param([string]$Message, [string]$Level = "info")
    $msg = switch ($Level) {
        "success" { "$SUCCESS✓$NC $Message" }
        "warn" { "$WARN!$NC $Message" }
        "error" { "$ERROR✗$NC $Message" }
        default { "$MUTED·$NC $Message" }
    }
    Microsoft.PowerShell.Host\Write-Host $msg
}

function Write-Banner {
    Write-Host ""
    Write-Host "${ACCENT}  🦞 LCX Agent Installer$NC" -Level info
    Write-Host "${MUTED}  All your chats, one LCX Agent.$NC" -Level info
    Write-Host ""
}

function Get-ExecutionPolicyStatus {
    $policy = Get-ExecutionPolicy
    if ($policy -eq "Restricted" -or $policy -eq "AllSigned") {
        return @{ Blocked = $true; Policy = $policy }
    }
    return @{ Blocked = $false; Policy = $policy }
}

function Test-Admin {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-ExecutionPolicy {
    $status = Get-ExecutionPolicyStatus
    if ($status.Blocked) {
        Write-Host "PowerShell execution policy is set to: $($status.Policy)" -Level warn
        Write-Host "This prevents scripts like npm.ps1 from running." -Level warn
        Write-Host ""
        
        # Try to set execution policy for current process
        try {
            Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -ErrorAction Stop
            Write-Host "Set execution policy to RemoteSigned for current process" -Level success
            return $true
        } catch {
            Write-Host "Could not automatically set execution policy" -Level error
            Write-Host ""
            Write-Host "To fix this, run:" -Level info
            Write-Host "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process" -Level info
            Write-Host ""
            Write-Host "Or run PowerShell as Administrator and execute:" -Level info
            Write-Host "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine" -Level info
            return $false
        }
    }
    return $true
}

function Get-NodeVersion {
    try {
        $version = node --version 2>$null
        if ($version) {
            return $version -replace '^v', ''
        }
    } catch { }
    return $null
}

function Get-NpmVersion {
    try {
        $version = npm --version 2>$null
        if ($version) {
            return $version
        }
    } catch { }
    return $null
}

function Install-Node {
    Write-Host "Node.js not found" -Level info
    Write-Host "Installing Node.js..." -Level info
    
    # Try winget first
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  Using winget..." -Level info
        try {
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
            # Refresh PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "  Node.js installed via winget" -Level success
            return $true
        } catch {
            Write-Host "  Winget install failed: $_" -Level warn
        }
    }
    
    # Try chocolatey
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Host "  Using chocolatey..." -Level info
        try {
            choco install nodejs-lts -y 2>&1 | Out-Null
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "  Node.js installed via chocolatey" -Level success
            return $true
        } catch {
            Write-Host "  Chocolatey install failed: $_" -Level warn
        }
    }
    
    # Try scoop
    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-Host "  Using scoop..." -Level info
        try {
            scoop install nodejs-lts 2>&1 | Out-Null
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "  Node.js installed via scoop" -Level success
            return $true
        } catch {
            Write-Host "  Scoop install failed: $_" -Level warn
        }
    }
    
    Write-Host "Could not install Node.js automatically" -Level error
    Write-Host "Please install Node.js 22+ manually from: https://nodejs.org" -Level info
    return $false
}

function Ensure-Node {
    $nodeVersion = Get-NodeVersion
    if ($nodeVersion) {
        $major = [int]($nodeVersion -split '\.')[0]
        if ($major -ge 22) {
            Write-Host "Node.js v$nodeVersion found" -Level success
            return $true
        }
        Write-Host "Node.js v$nodeVersion found, but need v22+" -Level warn
    }
    return Install-Node
}

function Get-GitVersion {
    try {
        $version = git --version 2>$null
        if ($version) {
            return $version
        }
    } catch { }
    return $null
}

function Install-Git {
    Write-Host "Git not found" -Level info
    
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  Installing Git via winget..." -Level info
        try {
            winget install Git.Git --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "  Git installed" -Level success
            return $true
        } catch {
            Write-Host "  Winget install failed" -Level warn
        }
    }
    
    Write-Host "Please install Git for Windows from: https://git-scm.com" -Level error
    return $false
}

function Ensure-Git {
    $gitVersion = Get-GitVersion
    if ($gitVersion) {
        Write-Host "$gitVersion found" -Level success
        return $true
    }
    return Install-Git
}

function Resolve-LcxGitDir {
    param([string]$Requested = "", [string]$ProfileRoot = $env:USERPROFILE)
    if ($Requested) { return $Requested }
    $current = Join-Path $ProfileRoot "lcx-agent"
    $legacy = Join-Path $ProfileRoot "openclaw"
    if (Test-Path -LiteralPath $current) { return $current }
    if (Test-Path -LiteralPath $legacy) { return $legacy }
    return $current
}

function Install-OpenClawNpm {
    param([string]$Version = "latest", [string]$Tarball = "")

    $target = "lcx-agent@$Version"
    if ($Tarball) {
        try {
            $target = (Resolve-Path -LiteralPath $Tarball -ErrorAction Stop).Path
            $manifestText = tar -xOf $target package/package.json 2>$null
            if ($LASTEXITCODE -ne 0) { throw "Cannot read archive manifest" }
            $manifest = ($manifestText -join "`n") | ConvertFrom-Json
            if ($manifest.name -ne "lcx-agent" -or !$manifest.bin.lcx -or !$manifest.version) {
                throw "Archive is not an LCX Agent package"
            }
        } catch {
            Write-Host "Invalid LCX build archive" -Level error
            return $false
        }
    }
    Write-Host "Installing LCX Agent..." -Level info
    $backupDir = ""
    $restoreRequired = $false
    $retainBackup = $false
    $legacyBins = @()
    try {
        $globalRoot = npm root -g 2>$null
        if ($LASTEXITCODE -ne 0 -or !$globalRoot) { throw "Cannot identify global package directory" }
        $legacyManifest = Join-Path ($globalRoot -join "") "openclaw/package.json"
        if (Test-Path -LiteralPath $legacyManifest) {
            $legacy = Get-Content -LiteralPath $legacyManifest -Raw | ConvertFrom-Json
            if ($legacy.name -ne "openclaw") { throw "Unrecognized legacy package" }
            # Do not remove a working legacy install before the replacement is available.
            if (!$Tarball) {
                npm view $target version --json 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "LCX release unavailable" }
            }
            $legacyPackageDir = Split-Path -Parent $legacyManifest
            $globalBinDir = Split-Path -Parent ($globalRoot -join "")
            $backupDir = Join-Path ([IO.Path]::GetTempPath()) ("lcx-upgrade-" + [guid]::NewGuid().ToString())
            New-Item -ItemType Directory -Path "$backupDir/package", "$backupDir/shims" -Force | Out-Null
            Copy-Item -LiteralPath $legacyPackageDir -Destination "$backupDir/package" -Recurse -Force
            $binNames = @("openclaw")
            if ($legacy.bin -and $legacy.bin -isnot [string]) { $binNames = @($legacy.bin.PSObject.Properties.Name) }
            foreach ($name in $binNames) {
                if ($name -notmatch '^[a-zA-Z0-9._-]+$') { throw "Invalid legacy executable name" }
                foreach ($suffix in @("", ".cmd", ".ps1")) {
                    $bin = Join-Path $globalBinDir "$name$suffix"
                    if (Test-Path -LiteralPath $bin -PathType Leaf) {
                        Copy-Item -LiteralPath $bin -Destination "$backupDir/shims" -Force
                        $legacyBins += $bin
                    }
                }
            }
            $restoreRequired = $true
            npm uninstall -g openclaw --no-fund --no-audit 2>&1 | Out-Host
            if ($LASTEXITCODE -ne 0) { throw "Legacy package removal failed" }
        }
        npm install -g $target --no-fund --no-audit 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm returned a nonzero exit code" }
        $restoreRequired = $false
        Write-Host "LCX Agent installed" -Level success
        return $true
    } catch {
        if ($restoreRequired) {
            try {
                Copy-Item -LiteralPath "$backupDir/package/openclaw" -Destination ($globalRoot -join "") -Recurse -Force
                foreach ($bin in $legacyBins) {
                    Copy-Item -LiteralPath (Join-Path "$backupDir/shims" (Split-Path -Leaf $bin)) -Destination $bin -Force
                }
                Write-Host "Legacy package and command files restored" -Level warn
            } catch {
                $retainBackup = $true
                Write-Host "Legacy restoration failed; retained backup: $backupDir" -Level error
            }
        }
        Write-Host "LCX npm installation failed" -Level error
        return $false
    } finally {
        if ($backupDir -and !$retainBackup) {
            try { Remove-Item -LiteralPath $backupDir -Recurse -Force } catch {
                Write-Host "Upgrade backup retained: $backupDir" -Level warn
            }
        }
    }
}

function Install-OpenClawGit {
    param([string]$RepoDir, [switch]$Update)
    
    Write-Host "Installing LCX Agent from git..." -Level info
    
    if (!(Test-Path $RepoDir)) {
        Write-Host "  Cloning repository..." -Level info
        git clone https://github.com/lcx1215/lcx-s-agent.git $RepoDir 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { return $false }
    } elseif ($Update) {
        Write-Host "  Updating repository..." -Level info
        git -C $RepoDir pull --ff-only 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { return $false }
    }
    
    # Install pnpm if not present
    if (!(Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Host "  Installing pnpm..." -Level info
        npm install -g pnpm 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { return $false }
    }
    
    # Install dependencies
    Write-Host "  Installing dependencies..." -Level info
    pnpm install --dir $RepoDir --frozen-lockfile 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { return $false }
    
    # Build
    Write-Host "  Building..." -Level info
    pnpm --dir $RepoDir build 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { return $false }
    
    # Create wrapper
    $wrapperDir = "$env:USERPROFILE\.local\bin"
    if (!(Test-Path $wrapperDir)) {
        New-Item -ItemType Directory -Path $wrapperDir -Force | Out-Null
    }
    
    $entry = Join-Path (Resolve-Path -LiteralPath $RepoDir).Path "lcx.mjs"
    $entryJson = ConvertTo-Json -InputObject $entry -Compress
    $launcher = @"
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, [$entryJson, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) console.error('LCX launcher could not start Node');
process.exit(result.status ?? 1);
"@
    [IO.File]::WriteAllText((Join-Path $wrapperDir "lcx-launcher.cjs"), $launcher, [Text.UTF8Encoding]::new($false))
    @'
@echo off
node "%~dp0lcx-launcher.cjs" %*
'@ | Out-File -FilePath "$wrapperDir\lcx.cmd" -Encoding ASCII -Force
    @'
@echo off
call "%~dp0lcx.cmd" %*
'@ | Out-File -FilePath "$wrapperDir\openclaw.cmd" -Encoding ASCII -Force
    Add-ToPath -Path $wrapperDir
    
    Write-Host "LCX Agent installed" -Level success
    return $true
}

function Add-ToPath {
    param([string]$Path)
    
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -notlike "*$Path*") {
        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$Path", "User")
        Write-Host "Added $Path to user PATH" -Level info
    }
}

# Main
function Main {
    Write-Banner
    
    Write-Host "Windows detected" -Level success
    
    # Check and handle execution policy FIRST, before any npm calls
    if (!(Ensure-ExecutionPolicy)) {
        Write-Host ""
        Write-Host "Installation cannot continue due to execution policy restrictions" -Level error
        exit 1
    }
    
    if (!(Ensure-Node)) {
        exit 1
    }
    
    if ($InstallMethod -eq "git") {
        $GitDir = Resolve-LcxGitDir -Requested $GitDir
        if (!(Ensure-Git)) {
            exit 1
        }
        
        if ($DryRun) {
            Write-Host "[DRY RUN] Would install LCX Agent from git to $GitDir" -Level info
        } else {
            if (!(Install-OpenClawGit -RepoDir $GitDir -Update:(-not $NoGitUpdate))) { exit 1 }
        }
    } else {
        # npm method
        if (!(Ensure-Git)) {
            Write-Host "Git is required for npm installs. Please install Git and try again." -Level warn
        }
        
        if ($DryRun) {
            Write-Host "[DRY RUN] Would install LCX Agent via npm (tag: $Tag)" -Level info
        } else {
            if (!(Install-OpenClawNpm -Version $Tag -Tarball $Artifact)) {
                exit 1
            }
        }
    }
    
    # Try to add npm global bin to PATH
    try {
        $npmPrefix = npm config get prefix 2>$null
        if ($npmPrefix) {
            Add-ToPath -Path "$npmPrefix"
        }
    } catch { }
    
    if (!$NoOnboard -and !$DryRun) {
        Write-Host ""
        Write-Host "Run 'lcx onboard' to complete setup" -Level info
    }
    
    Write-Host ""
    Write-Host "🦞 LCX Agent installed successfully!" -Level success
}

Main
