# dsh-desktop-notify installer — Windows
# Copies the plugin into the dsh web profile, ensures its koffi runtime dependency,
# registers it as a bundle, writes the AUMID icon key (idempotent), then tells you
# to fully restart dsh web.
#
# 无需 Python、无需 pip：发送层是 koffi 直调 WinRT（见 lib/winrt.js）。
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$dshHome  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$target   = Join-Path $profileDir 'node_modules\dsh-desktop-notify'
$profilePkg = Join-Path $profileDir 'package.json'
$koffiDir = Join-Path $profileDir 'node_modules\koffi'

if (-not (Test-Path $profileDir)) {
    Write-Host "[dsh-desktop-notify] web profile not found at $profileDir" -ForegroundColor Red
    Write-Host "Start 'dsh web' once so the profile is generated, then re-run this script." -ForegroundColor Yellow
    exit 1
}

# 1. copy plugin files
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $repoRoot 'lib')              $target -Recurse -Force
Copy-Item (Join-Path $repoRoot 'assets')           $target -Recurse -Force
Copy-Item (Join-Path $repoRoot 'cordis.patch.yml') $target -Force
Copy-Item (Join-Path $repoRoot 'package.json')     $target -Force
Write-Host "[dsh-desktop-notify] plugin files installed to $target" -ForegroundColor Green

# 2. ensure the koffi runtime dependency is resolvable from the plugin
#    （profile 用 link: 依赖时 npm 不会自动装它的依赖，故这里显式确保）
function Test-Koffi([string]$dir) {
    return (Test-Path (Join-Path $dir 'package.json')) -and (Test-Path (Join-Path $dir 'build'))
}
if (Test-Koffi $koffiDir) {
    Write-Host "[dsh-desktop-notify] koffi already present in profile" -ForegroundColor Cyan
} else {
    $repoKoffi = Join-Path $repoRoot 'node_modules\koffi'
    $installed = $false
    # 优先用 npm.cmd（避免 PowerShell 执行策略拦截 npm.ps1）
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
    if ($npm) {
        Write-Host "[dsh-desktop-notify] installing koffi into the profile..." -ForegroundColor Cyan
        Push-Location $profileDir
        try {
            # --no-save/--no-package-lock：不重写 profile 的 package.json 与锁文件
            & $npm install 'koffi@^3.1.6' --legacy-peer-deps --no-save --no-package-lock 2>&1 | Out-Null
            $installed = Test-Koffi $koffiDir
        } catch {
            $installed = $false
        } finally {
            Pop-Location
        }
    }
    if (-not $installed -and (Test-Koffi $repoKoffi)) {
        Write-Host "[dsh-desktop-notify] npm path unavailable — copying koffi from the repo" -ForegroundColor Cyan
        New-Item -ItemType Directory -Force -Path (Join-Path $profileDir 'node_modules') | Out-Null
        Copy-Item $repoKoffi $koffiDir -Recurse -Force
        $installed = Test-Koffi $koffiDir
    }
    if ($installed) {
        Write-Host "[dsh-desktop-notify] koffi ready" -ForegroundColor Green
    } else {
        Write-Host "[dsh-desktop-notify] koffi MISSING — 请在 $profileDir 下执行：" -ForegroundColor Yellow
        Write-Host "    npm install koffi --legacy-peer-deps" -ForegroundColor Yellow
        Write-Host "  否则运行时 import koffi 会失败（通知发不出去）。" -ForegroundColor Yellow
    }
}

# 3. register as a bundle in the profile package.json (idempotent)
if (-not (Test-Path $profilePkg)) {
    Write-Host "[dsh-desktop-notify] profile package.json missing at $profilePkg — cannot register bundle" -ForegroundColor Yellow
    Write-Host "Add 'dsh-desktop-notify' to dsh.profile.bundles manually, then restart." -ForegroundColor Yellow
} else {
    $changed = $false
    $json = Get-Content $profilePkg -Raw | ConvertFrom-Json

    if (-not ($json.dependencies.PSObject.Properties.Name -contains 'dsh-desktop-notify')) {
        $json.dependencies | Add-Member -NotePropertyName 'dsh-desktop-notify' -NotePropertyValue '1.0.0'
        $changed = $true
        Write-Host "[dsh-desktop-notify] added to profile dependencies" -ForegroundColor Green
    }

    $bundles = @($json.dsh.profile.bundles)
    if ($bundles -notcontains 'dsh-desktop-notify') {
        $json.dsh.profile.bundles = $bundles + 'dsh-desktop-notify'
        $changed = $true
        Write-Host "[dsh-desktop-notify] added to profile bundles" -ForegroundColor Green
    }

    if ($changed) {
        $out = $json | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($profilePkg, $out, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "[dsh-desktop-notify] updated $profilePkg" -ForegroundColor Green
    } else {
        Write-Host "[dsh-desktop-notify] already registered in profile package.json (no change)" -ForegroundColor Cyan
    }
}

# 4. register the AUMID icon key (toast 顶部"程序应用图标"来源)
#    只写 DSH 自己的键：HKCU\SOFTWARE\Classes\AppUserModelId\DSH
#    插件首次发送时也会幂等补写一次，这里先写好可让图标立刻生效。
$ico = Join-Path $target 'assets\dsh.ico'
if (Test-Path $ico) {
    try {
        $aumidKey = 'HKCU:\SOFTWARE\Classes\AppUserModelId\DSH'
        New-Item -Path $aumidKey -Force | Out-Null
        New-ItemProperty -Path $aumidKey -Name 'DisplayName' -Value 'DSH' -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $aumidKey -Name 'IconUri' `
            -Value ('file:///' + $ico.Replace('\', '/')) -PropertyType String -Force | Out-Null
        Write-Host "[dsh-desktop-notify] AUMID icon registered (DSH -> $ico)" -ForegroundColor Green
    } catch {
        Write-Host "[dsh-desktop-notify] AUMID 注册失败（只影响通知中心图标）：$_" -ForegroundColor Yellow
    }
} else {
    Write-Host "[dsh-desktop-notify] assets\dsh.ico not found — 跳过 AUMID 图标注册" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[dsh-desktop-notify] done. Now FULLY restart 'dsh web' (stop the process, then start it again) - a page refresh is not enough." -ForegroundColor Cyan
