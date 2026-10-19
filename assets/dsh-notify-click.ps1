# dsh-notify-click.ps1 — `dsh-notify:` 自定义协议的本机转发器（URI 只当数据）
#
# 为什么是独立脚本而不是注册表里的 -Command：
#   -Command 会把命令行后面的参数**拼回脚本文本**再解析，系统传入的 %1 于是变成代码的
#   一部分（旧实现的 $raw='%1' 可被 URI 里的引号闭合 → 网页触发协议 = 命令注入）。
#   改用 -File 后 %1 只是 argv[1]：本脚本从 $args[0] 取值，只做字符串校验与拼查询参数，
#   绝不 Invoke-Expression、绝不把外部数据当代码执行。
#
# 数据来源（插件注册时写入 HKCU\Software\Classes\dsh-notify，本脚本只读）：
#   ActivateEndpoint  激活端点（带进程令牌），返回宿主的决策 JSON
#   FallbackBase      失败时交给浏览器打开的落地页前缀
#   FocusWindow       '1'/'0'：投递成功后是否把带 DSH 标签的浏览器窗口带到前台
#
# 行为：
#   1) 去掉 scheme 得到 wire，严格白名单校验（none / session:<id> / page:<name> / url:<encoded>）
#   2) 请求激活端点 → 宿主先决策：
#        open       → Start-Process 宿主给的地址（DSH 深链或外部地址）
#        delivered  → 页面已经跳了；按 FocusWindow 决定是否 AppActivate 浏览器
#        ignore     → 什么都不做
#   3) 任何失败：写一行日志到 %TEMP%\dsh-notify-activate.log，并退回浏览器落地页
#      （至少让用户看到"有个标签页开了"，而不是"点了没反应"）

$ErrorActionPreference = 'Stop'
$scheme = 'dsh-notify:'
# URI 长度上限：正常 wire 最长是 url:<percent-encoded>，给足余量即可；
# 过长的一律拒绝（注册表命令行与日志都不该被无界数据撑爆）。
$maxUriLength = 4096
$maxUrlLength = 2048
$logPath = Join-Path $env:TEMP 'dsh-notify-activate.log'

function Write-ActivateLog([string]$line) {
  try {
    Add-Content -Path $logPath -Value ((Get-Date -Format s) + ' ' + $line) -ErrorAction SilentlyContinue
  } catch { }
}

function Read-ActivateValue([string]$name) {
  $item = Get-ItemProperty -Path 'HKCU:\Software\Classes\dsh-notify' -Name $name -ErrorAction Stop
  return [string]$item.$name
}

$wire = ''
$sawScheme = $false
try {
  if ($args.Count -lt 1) { throw 'missing uri argument' }
  $uri = [string]$args[0]
  if ($uri.Length -eq 0 -or $uri.Length -gt $maxUriLength) { throw 'uri length out of range' }
  # 控制字符（NUL/换行/DEL 等）：合法 URI 里不可能出现；先拒绝，避免把换行写进日志
  # （日志注入），后面的参数也更干净。
  if ($uri -match '[\x00-\x1F\x7F]') { throw 'control character in uri' }
  Write-ActivateLog ('invoked ' + $uri)
  if (-not $uri.StartsWith($scheme, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'unexpected scheme' }
  $sawScheme = $true
  $wire = $uri.Substring($scheme.Length)
  if ($wire.Length -eq 0 -or $wire.Length -gt $maxUriLength) { throw 'wire length out of range' }
  # 白名单与 src/protocol.ts 的 decodeClickTarget 同构（测试会从这一行提取正则并逐条断言）。
  # 用 -cmatch 保持大小写敏感，避免与 JS 侧的严格解码产生分歧。
  $wirePattern = '^(none|session:[A-Za-z0-9._:-]{1,200}|page:(settings-plugins|plugins)|url:.+)$'
  if (-not ($wire -cmatch $wirePattern)) { throw 'invalid wire' }
  if ($wire -ceq 'none') { exit 0 }
  if ($wire.StartsWith('url:', [System.StringComparison]::Ordinal)) {
    # url:<percent-encoded>：解码后必须是绝对 http(s) 地址；其它 scheme 一律拒绝。
    $decoded = [uri]::UnescapeDataString($wire.Substring(4))
    if ($decoded.Length -eq 0 -or $decoded.Length -gt $maxUrlLength) { throw 'url length out of range' }
    $parsed = $null
    if (-not [uri]::TryCreate($decoded, [System.UriKind]::Absolute, [ref]$parsed)) { throw 'url not absolute' }
    if ($parsed.Scheme -ne 'http' -and $parsed.Scheme -ne 'https') { throw 'url scheme not allowed' }
    if ([string]::IsNullOrEmpty($parsed.Host)) { throw 'url host missing' }
  }
  # 激活端点是 GET（宿主 /dnotify/activate 只挂 GET）；Invoke-RestMethod 默认就是 GET。
  $activate = Read-ActivateValue 'ActivateEndpoint'
  if ([string]::IsNullOrEmpty($activate)) { throw 'activate endpoint missing' }
  $separator = '&'
  if (-not $activate.Contains('?')) { $separator = '?' }
  $response = Invoke-RestMethod -TimeoutSec 5 -Uri ($activate + $separator + 'raw=' + [uri]::EscapeDataString($wire))
  if ($response.action -eq 'open' -and $response.url) {
    Start-Process ([string]$response.url)
  } elseif ($response.action -eq 'delivered') {
    $focusWindow = $true
    try { $focusWindow = ((Read-ActivateValue 'FocusWindow') -ne '0') } catch { $focusWindow = $true }
    if ($focusWindow) {
      Add-Type -AssemblyName Microsoft.VisualBasic
      $candidates = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match 'chrome|msedge|firefox|brave|vivaldi|opera' })
      # 优先标题像 DSH 的窗口；只有一个浏览器窗口时就用它；都不确定就不动（不抢焦点）
      $target = $candidates | Where-Object { $_.MainWindowTitle -match 'dsh|deepseek|harness' } | Select-Object -First 1
      if (-not $target -and $candidates.Count -eq 1) { $target = $candidates[0] }
      if ($target) { [Microsoft.VisualBasic.Interaction]::AppActivate($target.Id) }
    }
  }
} catch {
  Write-ActivateLog ([string]$wire + ' ' + $_.Exception.Message)
  if ($sawScheme) {
    try {
      $fallback = Read-ActivateValue 'FallbackBase'
      if (-not [string]::IsNullOrEmpty($fallback)) {
        Start-Process ($fallback + [uri]::EscapeDataString($wire))
      }
    } catch {
      Write-ActivateLog ('fallback failed: ' + $_.Exception.Message)
    }
  }
}
