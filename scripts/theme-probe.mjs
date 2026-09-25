// dsh-desktop-notify — 主题自检（合并/安装前的冒烟测试）
//
//   node scripts/theme-probe.mjs
//
// 做什么：
//   1. 按平台读一次系统深浅色（Windows: 注册表；Linux: xdg-desktop-portal）
//   2. 打印两套图标解析结果（确认 assets 齐全）
//   3. Windows：在 HKCU\Software 下建一个临时键，注册 RegNotifyChangeKeyValue
//      事件通知 → 改写该键的值 → 断言回调在超时内被触发 → 删除临时键。
//      验证的是"切换事件跟踪"这条链路本身（对系统主题零副作用）。
//   4. Linux：读一次 portal 的 color-scheme 并订阅 SettingChanged 信号
//      （没有 portal 的环境会明确报告"不可用"，不算失败）。
//
// Windows 专属模块（koffi/advapi32）只在 win32 分支里动态 import——
// 顶层 static import 会让 Linux 上直接崩。
import { currentTheme, refreshTheme, startThemeWatch, stopThemeWatch } from '../lib/theme.js'
import { iconPathsFor } from '../lib/icons.js'

const PROBE_KEY = 'Software\\dsh-desktop-notify-theme-probe'
let failed = 0

function report(label, value) {
  console.log(`  ${label}: ${value}`)
}
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed += 1
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log(`[theme-probe] platform=${process.platform}`)

console.log('1) 模式检查')
const theme = await startThemeWatch()
report('当前系统主题', theme)
check('主题取值合法', theme === 'dark' || theme === 'light', String(theme))

console.log('2) 图标解析')
for (const variant of ['dark', 'light']) {
  const icons = iconPathsFor(variant)
  report(`${variant} png`, icons.png || '(缺失)')
  report(`${variant} ico`, icons.ico || '(缺失)')
  check(`${variant} 图标齐全`, !!icons.png && !!icons.ico && !icons.legacy)
}

console.log('3) 切换事件跟踪')
if (process.platform === 'win32') {
  const reg = await import('../lib/win32-registry.js')
  // ⚠️ RegNotifyChangeKeyValue 要求键句柄带 KEY_NOTIFY（只有 SET/QUERY 会返回失败）
  const hkey = reg.createKey(reg.HKEY_CURRENT_USER, PROBE_KEY, reg.KEY_SET_VALUE | reg.KEY_QUERY_VALUE | reg.KEY_NOTIFY)
  if (!hkey) {
    check('建立临时注册表键', false, 'RegCreateKeyExW 失败')
  } else {
    let stopWatch = () => {}
    try {
      reg.setString(hkey, 'probe', 'before')
      const event = reg.createEvent()
      let fired = 0
      let armed = reg.notifyKeyChange(hkey, event)
      if (!armed) {
        check('注册表变更事件', false, 'RegNotifyChangeKeyValue 注册失败')
      } else {
        const timer = setInterval(() => {
          if (!reg.isEventSignaled(event)) return
          fired += 1
          armed = reg.notifyKeyChange(hkey, event)   // 一次性注册：触发后重新挂
          if (!armed) clearInterval(timer)
        }, 200)
        timer.unref()
        stopWatch = () => { clearInterval(timer); reg.closeHandle(event) }
        await sleep(800)
        reg.setString(hkey, 'probe', 'after-' + Date.now())
        for (let i = 0; i < 40 && fired === 0; i += 1) await sleep(200)
        check('注册表变更事件把回调唤醒', fired > 0, fired > 0 ? `触发 ${fired} 次` : '8s 内未收到通知')
        check('事件注册可重复挂载', armed, armed ? '' : '重新注册失败')
      }
    } finally {
      stopWatch()
      reg.closeKey(hkey)
      check('清理临时注册表键', reg.deleteKey(reg.HKEY_CURRENT_USER, PROBE_KEY))
    }
  }
} else if (process.platform === 'linux') {
  const before = currentTheme()
  const read = await refreshTheme()
  report('portal / 环境变量读取结果', read === null ? 'null（portal 不可用，回退深色）' : read)
  const themeLinux = await import('../lib/theme-linux.js')
  const unsubscribe = themeLinux.watch(() => {})
  check('SettingChanged 信号订阅可挂载/可取消', typeof unsubscribe === 'function')
  unsubscribe()
  report('主题状态未被误改', String(before === currentTheme()))
} else {
  report('跳过', `当前平台（${process.platform}）没有主题后端`)
}

stopThemeWatch()
console.log(failed === 0 ? '[theme-probe] 全部通过' : `[theme-probe] ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
