// dsh-desktop-notify — WinRT 直调冒烟测试：注册 AUMID 图标 + 发一条真实 Toast。
//
// 与插件运行时走完全相同的代码路径（lib/winrt.js），用于合并/安装前的验证：
//   node scripts/winrt-probe.mjs
// 成功输出 [probe] AUMID {...} 与 [probe] SHOW OK，并在桌面右下角弹出 Toast。
// 图标按当前系统主题选（info.theme/icons 会打印实际用的那一套）。
import { registerAumid, sendToast } from '../lib/winrt.js'
import { currentTheme, startThemeWatch, stopThemeWatch } from '../lib/theme.js'
import { iconPathsFor } from '../lib/icons.js'

await startThemeWatch()
const theme = currentTheme()
const icons = iconPathsFor(theme)
console.log('[probe] theme:', theme, '->', icons.png, '/', icons.ico)

const aumid = registerAumid()
console.log('[probe] AUMID:', JSON.stringify(aumid))
if (!aumid.ok) {
  // 注册表写入失败只影响通知中心图标，不影响 Toast 本身
  console.error('[probe] AUMID 注册失败：' + aumid.error)
}

sendToast({
  title: 'DSH 桌面通知冒烟测试',
  message: `koffi 直调 WinRT，无 Python、无子进程（${theme === 'light' ? '浅色主题→黑鱼' : '深色主题→白鱼'}）`,
})
console.log('[probe] SHOW OK')
stopThemeWatch()
