// 通知载荷模型 — 系统通知后端（WinRT Toast / D-Bus）拿到的就是它
//
// 与旧的 `{ title, message, urgency, url }` 相比，这里把"点击要做什么"抽成 ClickTarget：
//   · 不再有"url 为空但 sessionId 存在 ⇒ 自动生成会话链接"这种隐式语义；
//   · 点击行为完全由 click 决定，缺省即 none（不可点击）——这就是"配置留空不跳转"。

import type { ClickTarget } from './protocol.js'

export type Urgency = 'low' | 'normal' | 'critical'

/** 一条待投递到系统通知后端的通知（不可变）。 */
export interface NotificationItem {
  readonly title: string
  readonly message: string
  readonly urgency: Urgency
  readonly click: ClickTarget
}
