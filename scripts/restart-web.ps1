# 重启 DSH Web：先停掉占着 3080 的旧实例，再启动
#
# 为什么需要它：
#   · `dsh web` 的 EADDRINUSE 只有一个含义 —— **已经有一个实例在跑**，它不是"卡死"；
#   · 在 Windows 上「关掉终端窗口」**不一定**会终止 pnpm 派生的 node 进程（孤儿会继续占端口）；
#   · 早期构建里串口同步调用可能冻住事件循环，那时 Ctrl+C 送不进去，
#     只能用 TerminateProcess（Stop-Process -Force，不需要目标进程响应）。
#
# 用法（在任意 PowerShell 里）：
#   pwsh -File D:\Program\dsh-desktop-notify\scripts\restart-web.ps1
#   加 -NoStart 只停不启：  pwsh -File ... -NoStart

param(
  [int]$Port = 3080,
  [string]$HarnessDir = 'D:\Program\deepseek-harness',
  [switch]$NoStart
)

$ErrorActionPreference = 'Continue'

Write-Host "== 1) 查找占用 $Port 的进程 ==" -ForegroundColor Cyan
$owners = @()
try {
  $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
} catch { }

if (-not $owners -or $owners.Count -eq 0) {
  Write-Host "   端口 $Port 空闲（没有旧实例）。"
} else {
  foreach ($procId in $owners) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host ("   停止 PID {0}（{1}，启动于 {2}）" -f $proc.Id, $proc.ProcessName, $proc.StartTime)
      # -Force = TerminateProcess：不等它响应信号，冻结的事件循环也能被干掉
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "== 2) 等端口释放 ==" -ForegroundColor Cyan
$freed = $false
for ($i = 0; $i -lt 50; $i++) {
  $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $still) { $freed = $true; break }
  Start-Sleep -Milliseconds 200
}
if (-not $freed) {
  Write-Warning "   端口 $Port 仍被占用；可能有别的程序（不是 node）在监听，请手动检查：Get-NetTCPConnection -LocalPort $Port"
  exit 1
}
Write-Host "   端口 $Port 已释放。"

if ($NoStart) { Write-Host "== -NoStart：不启动 ==" -ForegroundColor Yellow; exit 0 }

Write-Host "== 3) 启动 dsh web ==" -ForegroundColor Cyan
if (-not (Test-Path $HarnessDir)) { Write-Error "找不到目录 $HarnessDir"; exit 1 }
Set-Location $HarnessDir
Write-Host "   提示：启动后请到浏览器 Ctrl+Shift+R 硬刷新（客户端 bundle 才会更新）。"
pnpm dsh web
