// dsh-desktop-notify — WinRT 直调冒烟测试：注册 AUMID 图标 + 发一条真实 Toast。
//
// 与插件运行时走完全相同的代码路径（lib/winrt.js），用于合并/安装前的验证：
//   node scripts/winrt-probe.mjs
// 成功输出 [probe] AUMID {...} 与 [probe] SHOW OK，并在桌面右下角弹出 Toast。
import { registerAumid, sendToast } from '../lib/winrt.js'

const aumid = registerAumid()
console.log('[probe] AUMID:', JSON.stringify(aumid))
if (!aumid.ok) {
  // 注册表写入失败只影响通知中心图标，不影响 Toast 本身
  console.error('[probe] AUMID 注册失败：' + aumid.error)
}

sendToast({
  title: 'DSH 桌面通知冒烟测试',
  message: 'koffi 直调 WinRT，无 Python、无子进程',
})
console.log('[probe] SHOW OK')
