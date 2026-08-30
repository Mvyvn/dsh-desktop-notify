# dsh-desktop-notify installer — Windows
# Copies the plugin into the dsh web profile, registers it as a bundle
# (idempotent), then tells you to fully restart dsh web.
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$dshHome  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$target   = Join-Path $profileDir 'node_modules\dsh-desktop-notify'
$profilePkg = Join-Path $profileDir 'package.json'

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
New-Item -ItemType Directory -Force -Path (Join-Path $target 'scripts') | Out-Null
Copy-Item (Join-Path $repoRoot 'scripts\register-aumid.py') (Join-Path $target 'scripts') -Force
Write-Host "[dsh-desktop-notify] plugin files installed to $target" -ForegroundColor Green

# 2. register as a bundle in the profile package.json (idempotent)
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

Write-Host ""
# 3. register AUMID shortcut + registry icon (toast 顶部"程序应用图标"来源)
#    只写 DSH 自己的快捷方式与注册表键，不触碰任何 Python 相关项。
$pythonExe = (Get-Command python -ErrorAction SilentlyContinue).Source
if ($pythonExe) {
    $lnkPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DSH 桌面通知.lnk'
    $ico = Join-Path $target 'assets\dsh.ico'
    & $pythonExe (Join-Path $target 'scripts\register-aumid.py') `
        --target $pythonExe --icon $ico --lnk $lnkPath --app-id 'DSH' --display-name 'DSH'
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[dsh-desktop-notify] AUMID registration failed (exit $LASTEXITCODE) — 可稍后手动运行 scripts/register-aumid.py" -ForegroundColor Yellow
    }
} else {
    Write-Host "[dsh-desktop-notify] python not found on PATH — 跳过 AUMID 注册（需要 python 才能发通知）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[dsh-desktop-notify] done. Now FULLY restart 'dsh web' (stop the process, then start it again) - a page refresh is not enough." -ForegroundColor Cyan
