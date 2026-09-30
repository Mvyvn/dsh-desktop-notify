# TypeScript 6 → TS7 迁移记录

## 为什么迁

这个插件的复杂度不在语法，而在**状态组合**：多标签页、SSE 连接、点击事件、Promise、超时、清理
之间的非法组合。类型系统的价值在于"让非法状态写不出来"，而不是"自动找 bug"——它**不能**消灭
运行时竞态（`location.reload()` 或广播抢 claim 换成 TS 一样错），但能迫使先把状态模型定义清楚。

排序是：**TS6 → 更严格的数据模型 → 明确的状态机 → 更容易发现非法状态 → 更容易做并发/生命周期重构**。

## 工具链

- `typescript@6.0.3`（TS6 是 5.9 → 7.0 的过渡版；TS7 已是 latest，官方说明干净通过 TS6 的代码原则上可直接进 TS7）。
- `tsconfig.json`：`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
  `erasableSyntaxOnly`（禁止 enum/namespace/参数属性等会改变运行时的 TS 语法，与 TS7 的类型擦除方向一致）+
  `verbatimModuleSyntax` + `isolatedModules` + `module: nodenext`（输出真 ESM，DSH 的 Node 直接加载）。
- `src/**/*.ts` → `lib/**/*.js`；**构建产物提交进仓库**，并随包分发（DSH 不编译插件，只加载 `lib/`）。
- `npm run build` 编译；`npm test` 会先构建再跑测试（测试直接测构建产物，等于把"源码与产物一致"也纳入回归）。

## 已完成（第一阶段：状态机 + 协议）

| 模块 | 内容 |
| --- | --- |
| `src/protocol.ts` | `ClickTarget` 四态（none/session/page/url）+ 线格式编解码；**严格白名单**，认不出就 `null`，不猜测意图 |
| `src/pages.ts` | `PageRegistry`：`{pageId, seq, focused, sessionId, streams, lastSeen}`；seq 乱序保护、连接计数、`focusedLive()` / `lastFocusedLive()` 两种选页语义 |
| `src/activation.ts` | `planActivation()` 纯函数：`ignore` / `deliver(pageId)` / `open-app(url)` / `open-url(url)` —— 三态互斥且可证明 |
| `src/gate.ts` | 聚焦门控（只决定"弹不弹"，与点击无关） |
| `src/api.ts` | 对外推送 API：`click` 显式声明；`sessionId` 只管门控 |
| `src/notify.ts` / `src/text.ts` | 通知载荷模型 / 截断 |

对应测试：`tests/protocol.test.mjs`、`tests/activation.test.mjs`（注册表 + 决策），宿主路由行为在
`tests/host.test.mjs` 里按三态逐条锁住。

## 已完成（第二阶段：平台后端 + 宿主与浏览器半区）

全部 20 个模块都在 `src/`：`protocol / pages / activation / gate / api / notify / text / state / icons / theme-codec /
 toast-xml`（核心层，`tsconfig.json`，**strict**）＋ `theme / theme-win32 / theme-linux / win32-registry / dbus /
 winrt / toast-linux / index`（`tsconfig.platform.json`，先关 strict、逐步收紧）＋ `client`（`tsconfig.client.json`，
 `moduleDetection: "legacy"` 按脚本编译，避免 TS 在尾巴上加 `export {}` 破坏脚本式加载）。

`npm run build` 依次跑这三个配置；产物落在 `lib/`（提交进仓库并随包分发）。
验证：迁移前后 `git diff --ignore-all-space lib/` 只有缩进/分号/`"use strict"` 这类格式差异，行为由全部单测 +
 `dsh-runtime-probe`（真 cordis）+ `theme-probe`（真注册表）共同锁定。

## 现状：全部模块已在 `src/`，平台层未开 strict

`tsconfig.platform.json` 目前显式关掉 `strict` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`（`erasableSyntaxOnly` 仍然打开）：平台层大量与 WinRT / D-Bus 的 ABI 打交道，那里 `any` 是诚实的语义（指针、变体、HRESULT），一次性 strict 化只会写出一堆掩护性质的断言。要继续收紧就从这里开始——下面保留的是平台层抽象成接口时的草图：

对应的就是现在这几个模块——`lib/winrt.js`（koffi 直调 WinRT）、`lib/toast-linux.js` + `lib/dbus.js`（手写 D-Bus 编解码）、`lib/theme*.js`、`lib/win32-registry.js`。真要再收紧，第一步是让它们对核心层只暴露明确接口：

```ts
interface NotificationBackend {
  send(item: NotificationItem): void
  close(): void
  registerClickProtocol?(endpoint: string): boolean
}
interface ActivationBackend {
  plan(target: ClickTarget, registry: PageRegistry, now: number): ActivationPlan
}
```

核心逻辑（协议 / 注册表 / 决策）**不应该知道** WinRT、D-Bus、portal 是什么；若继续拆分，平台目录按
`platform/windows/*` 与 `platform/linux/*` 分开。

## 下一步：宿主生命周期

`lib/index.js`（约 1900 行）与 `lib/client.js`（浏览器半区）按领域拆：通知队列、会话事件订阅、
启动播报、路由、客户端状态上报各自成模块；`client.js` 保持**零依赖**（浏览器半区由 DSH 打包，
只允许 import 纯函数模块，例如现在的 `lib/protocol.js`）。

## 约束

- 不要为"用上 TS6"而写 TS6 特有写法；TS6 是迁移基线，不是终点。
- 每次迁移都必须保持 `npm test` 全绿，并且**行为不变**（迁移与重构分开提交）。
- 公共 API 的形状（`desktopNotify` 的载荷）一旦发布就按版本号规则变更（见 `versioning` 技能）。
