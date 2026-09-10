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
#
#    判据必须是真的能 require 到：koffi 3.x 由 npm 安装时**不会**创建 build/ 目录
#    （原生二进制来自独立的 @koromix/koffi-<platform>-<arch> 包），用目录形状判断
#    会把装好的 koffi 误报为缺失。这里直接以插件目录为解析起点真加载一次，
#    与 lib/winrt.js 的 import 'koffi' 走同一条解析链。
function Get-KoffiProbe([string]$dir) {
    $code = "try{const p=require.resolve('koffi');const k=require('koffi');console.log('OK '+k.version+' '+p)}catch(e){console.log('FAIL '+(e.code||e.message))}"
    $out = ''
    Push-Location $dir
    try {
        $out = (& node -e $code 2>&1 | Out-String).Trim()
    } catch {
        $out = 'FAIL ' + $_.Exception.Message
    } finally {
        Pop-Location
    }
    if ($out -like 'OK *') {
        $parts = $out.Split(' ', 3)
        return [pscustomobject]@{ ok = $true; version = $parts[1]; path = $parts[2]; raw = $out }
    }
    return [pscustomobject]@{ ok = $false; version = ''; path = ''; raw = $out }
}

function Test-LocalKoffi($probe) {
    return ($probe.ok -and ($probe.path -like "$profileDir*"))
}

$probe = Get-KoffiProbe $target
$npmLog = ''
if (Test-LocalKoffi $probe) {
    Write-Host "[dsh-desktop-notify] koffi ready ($($probe.version))" -ForegroundColor Cyan
} else {
    if ($probe.ok) {
        Write-Host "[dsh-desktop-notify] koffi 当前解析到 profile 之外：$($probe.version) $($probe.path)" -ForegroundColor Yellow
        Write-Host "  （依赖 DSH 自身的依赖布局，DSH 换目录/清理依赖后插件会整个加载失败，故尝试装一份到 profile）" -ForegroundColor DarkGray
    }
    # 优先用 npm.cmd（避免 PowerShell 执行策略拦截 npm.ps1）
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }
    if ($npm) {
        Write-Host "[dsh-desktop-notify] installing koffi into the profile..." -ForegroundColor Cyan
        Push-Location $profileDir
        try {
            # --no-save/--no-package-lock：不重写 profile 的 package.json 与锁文件
            $npmLog = (& $npm install 'koffi@^3.1.6' --legacy-peer-deps --no-save --no-package-lock 2>&1 | Out-String)
        } catch {
            $npmLog = $_ | Out-String
        } finally {
            Pop-Location
        }
        $probe = Get-KoffiProbe $target
    }
    if (-not (Test-LocalKoffi $probe)) {
        # 离线回退：从本仓库 node_modules 拷贝。
        # ⚠️ 必须连 @koromix/koffi-<platform>-<arch> 一起拷——koffi 的原生模块是独立的
        # optionalDependency，只拷 koffi 会得到 "Cannot find the native Koffi module"。
        $repoKoffi = Join-Path $repoRoot 'node_modules\koffi'
        $repoKoromix = Join-Path $repoRoot 'node_modules\@koromix'
        if (Test-Path $repoKoffi) {
            Write-Host "[dsh-desktop-notify] npm 不可用或未成功 — 从仓库拷贝 koffi" -ForegroundColor Cyan
            New-Item -ItemType Directory -Force -Path (Join-Path $profileDir 'node_modules') | Out-Null
            Copy-Item $repoKoffi $koffiDir -Recurse -Force
            if (Test-Path $repoKoromix) {
                Copy-Item $repoKoromix (Join-Path $profileDir 'node_modules\@koromix') -Recurse -Force
            } else {
                Write-Host "[dsh-desktop-notify] 警告：仓库里没有 node_modules\@koromix，拷贝出的 koffi 无法加载原生模块" -ForegroundColor Yellow
            }
            $probe = Get-KoffiProbe $target
        }
    }
    if ($probe.ok) {
        $where = if (Test-LocalKoffi $probe) { 'profile 内' } else { 'profile 之外' }
        Write-Host "[dsh-desktop-notify] koffi ready ($($probe.version), $where)" -ForegroundColor Green
    } else {
        Write-Host "[dsh-desktop-notify] koffi MISSING — 请在 $profileDir 下执行：" -ForegroundColor Yellow
        Write-Host "    npm install koffi --legacy-peer-deps" -ForegroundColor Yellow
        Write-Host "  否则运行时 import koffi 会失败，插件整个不会加载（不只是发不出通知）。" -ForegroundColor Yellow
        if ($npmLog) {
            Write-Host "  npm 输出（末 8 行）:" -ForegroundColor DarkGray
            ($npmLog -split "`n" | Select-Object -Last 8) | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        }
    }
}

# 3. register as a bundle in the profile package.json (idempotent)
#    用 node 读写 JSON：PowerShell 5.1 的 ConvertTo-Json 会把非 ASCII 转义成 \uXXXX、
#    并整体重排格式；交给 node 可保持 UTF-8 原样（与 install.sh 行为一致）。
if (-not (Test-Path $profilePkg)) {
    Write-Host "[dsh-desktop-notify] profile package.json missing at $profilePkg — cannot register bundle" -ForegroundColor Yellow
    Write-Host "Add 'dsh-desktop-notify' to dsh.profile.bundles manually, then restart." -ForegroundColor Yellow
} else {
    # 登记真实版本号（原先硬编码 1.0.0，与包版本漂移）
    $repoVersion = '0.0.0'
    try { $repoVersion = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version } catch { }
    $code = @'
const fs = require('fs')
const [pkg, name, version] = process.argv.slice(1)
const p = JSON.parse(fs.readFileSync(pkg, 'utf8'))
let changed = false
if (!p.dependencies) { p.dependencies = {}; changed = true }
if (!p.dependencies[name]) { p.dependencies[name] = version; changed = true }
if (!p.dsh) { p.dsh = {}; changed = true }
if (!p.dsh.profile) { p.dsh.profile = {}; changed = true }
if (!Array.isArray(p.dsh.profile.bundles)) { p.dsh.profile.bundles = []; changed = true }
if (!p.dsh.profile.bundles.includes(name)) { p.dsh.profile.bundles.push(name); changed = true }
if (changed) fs.writeFileSync(pkg, JSON.stringify(p, null, 2) + '\n')
process.exit(changed ? 0 : 1)
'@
    & node -e $code $profilePkg 'dsh-desktop-notify' $repoVersion
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[dsh-desktop-notify] registered in profile package.json as $repoVersion" -ForegroundColor Green
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
