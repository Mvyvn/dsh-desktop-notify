# 串口 LED 状态灯协议（本分支专属）

> 这一份是 `feat/led-serial-ticker` 分支特有的协议说明，**不并入主线**。
> 它描述两件事：一根 USB 转串口线上跑的**帧格式**，以及其它插件通过
> `ctx.get('desktopNotify').led` 能用的**对外 API**。

## 0. 它解决什么

人躺床上时看不到屏幕：AI 是不是还在跑、是不是在等你回话、是不是已经做完了、
是不是出错了 —— 这些原本只能靠系统通知（弹一下就没了）。这块板子把状态变成
**一直亮着的颜色**：

| 语义 | 颜色 / 表现 | 什么时候出现 |
| --- | --- | --- |
| `running` | **白**，左右往复流动 | AI 仍在运行（含等待子代理、后台任务、未完成目标） |
| `waiting` | **黄**，呼吸 | 在等你：提问 / 审批 / 目标被阻塞 |
| `done` | **绿**，呼吸 | 真正完成（没有任何未结算工作） |
| `error` | **红**，闪烁 | 异常：审批被拒 / 后台任务失败 / 目标阻塞 |
| `off` | 熄灭 | 未启用、或已完成且你已看过一段时间 |

外加两个"一直提醒"的机制：

* **聚焦提醒**（`ATTENTION` 位）：自你上次聚焦 DSH 页面之后再没回来，画面就带上
  呼吸 + 周期性双闪 —— 提醒**不会自己过期**，只有你回到页面、或按板上按键才解除；
* **失联兜底**：主机超过 3× 心跳没说话，固件自己切换到低亮蓝呼吸，
  绝不会继续显示"AI 在跑"骗你。

## 1. 为什么这么省带宽

串口带宽是硬约束（115200 8N1 ≈ 11.5 KB/s）。一条 60 灯珠的 WS2812 每帧就要 180 字节，
30fps 就是 5.4 KB/s —— 一半带宽只够点亮一条灯带，而且主机一卡灯就卡。

所以协议把**表现力放在固件里**，线上一律只传语义：

| 手段 | 收益 |
| --- | --- |
| 语义帧（状态 + 少量参数），动画由固件按本地时钟渲染 | 一次状态变化 = 11 字节，之后不用再说话 |
| 只在画面签名变化时写帧 + 5s 心跳 | 稳态平均 **< 20 B/s**（1 分钟约 660 字节） |
| 颜色压成 RGB332（1 字节 256 色） | 每帧省 2 字节 |
| 覆盖层自带 TTL，固件到期自己回落 | 省掉"撤销帧"这类往返 |
| 1 字节百分比进度 | "跑了多少"也能表达，不必回传任务详情 |
| 亮度分级（场景亮度 × 全局上限 × 夜间） | 一个字节控制观感，不必重传颜色 |

实测（`tests/serial-link.test.mjs` 的稳态带宽断言）：60 次心跳 × 11 字节 / 300 秒 ≈ **2.2 B/s**。
9600 波特的老式 USB-TTL 也绰绰有余。

## 2. 帧格式

```
SOF0 SOF1 | TYPE | SEQ | LEN | PAYLOAD(LEN) | CRC8
 0xA5 0x5A
```

* **双字节魔数**：设备可能在半帧处上电（USB 枚举时主机已经在写），单字节魔数会被误同步；
* `SEQ` 主机自增（回绕），固件只在 ACK 里回带，不参与渲染；
* `LEN` 是**载荷长度**（0..32），整帧 = `6 + LEN`；
* `CRC8`（poly `0x07`、init `0x00`）覆盖 `TYPE/SEQ/LEN/PAYLOAD`，**不含魔数**；
  标准校验值：`crc8("123456789") == 0xF4`（两端单测都锁了这条）。

解析器必须是**状态机**而不是"收满缓冲再解"：任何一个"相信 LEN 字段"的实现在遇到
错位字节后都会被永久带偏。固件实现见 `firmware/core/led_protocol.c`，
主机实现见 `src/led-protocol.ts` 的 `createFrameParser()`（同样可重同步、坏帧只丢一帧）。

### 两个哨兵值（有故事，别改）

| 字段 | 哨兵 | 含义 |
| --- | --- | --- |
| `brightness` | `0xFF` | **用设备端配置的默认亮度** |
| `accent` / `color` | `0xFF` | **用该状态的默认色** |

因此**显式亮度范围是 0..254**（`MAX_EXPLICIT_BRIGHTNESS`）。
这不是洁癖：固件自测抓到过真实事故 —— 主机发"最亮(255)"，固件按哨兵解释成
"用我的默认亮度(160)"，表现就是"调到最亮反而变暗"。现在线上出现 255 就一定是
"设备自己决定"，语义没有歧义（`firmware/host/sim_main.c` 的 4.11 是这条的回归测试）。
同理，想要"接近白"的自定义色用 `0xFE`（252,252,255）。

## 3. 帧类型

### 主机 → 设备

| 类型 | 值 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `HELLO` | `0x01` | `[wireVersion, flags]` | 握手；设备回 `HELLO_ACK` |
| `SCENE` | `0x02` | `[state, flags, brightness, progress, accent]` | **主力帧**，语义状态 |
| `EFFECT` | `0x03` | `[effect, speed, brightness, color, param]` | 显式效果（无 TTL，直到 `CLEAR`/`SCENE`） |
| `BRIGHT` | `0x04` | `[level]` | 全局亮度上限 |
| `OVERLAY` | `0x05` | `[effect, speed, brightness, color, ttlHi, ttlLo, repeat]` | 瞬态覆盖层，TTL 到期自动回落 |
| `PROGRESS` | `0x06` | `[percent, color, brightness]` | 进度条（0..100） |
| `CONFIG` | `0x07` | `[key, u32le]` | 设备配置（见 §5） |
| `PING` | `0x08` | `[]` | 心跳；设备回 `PONG` |
| `CLEAR` | `0x09` | `[]` | 清覆盖层 + 进度 |
| `PIXELS` | `0x0A` | `[start, count, r, g, b]` | 直写一段灯珠（能力位 `PIXELS`） |
| `BYE` | `0x0B` | `[reason]` | 主动离线：熄灭 + 进入"主机已退出"态 |

### 设备 → 主机

| 类型 | 值 | 载荷 | 说明 |
| --- | --- | --- | --- |
| `ACK` | `0x81` | `[seq]` | |
| `NAK` | `0x82` | `[seq, code]` | |
| `HELLO_ACK` | `0x83` | `[wireVersion, leds, maxBright, capsLo, capsHi]` | 能力协商 |
| `PONG` | `0x84` | `[uptimeLo, mid, hi]` | |
| `EVENT` | `0x85` | `[code, arg]` | 按键等（`0x01` 短按 = "我知道了"） |

`SCENE.flags`：`0x01 ATTENTION`（一直提醒）、`0x02 MUTED`（已看过，安静版）、
`0x04 NIGHT`（夜间再暗一档）、`0x08 TRANSIENT`（过场）。

## 4. 效果与状态映射

`state` 线码：`off=0 running=1 waiting=2 done=3 error=4`。

SCENE 帧**不带效果**：固件按语义自己选（这正是省带宽的关键）。

| 状态 | 默认效果 | 默认色 |
| --- | --- | --- |
| `running` | `flow-both`（左右往复流动） | 白 |
| `waiting` | `breathe` | 黄 (255,176,0) |
| `done` | `breathe`（`MUTED` 时 `solid`） | 绿 (0,255,64) |
| `error` | `blink` | 红 |

带 `ATTENTION` 时：`running` 只抬高亮度（不盖掉"在干活"这个事实），
其余状态切到 `double-flash`（呼吸 + 周期双闪，画面永不静止 = 一直在提醒）。

显式效果词表（`EFFECT`/`OVERLAY` 用）：
`solid breathe blink flow flow-back flow-both chase rainbow sparkle wipe progress double-flash`。

## 5. 设备配置键（`CONFIG` 帧）

| 键 | 值 | 说明 |
| --- | --- | --- |
| 1 | `LED_COUNT` | 灯珠数量 |
| 2 | `MAX_BRIGHTNESS` | 全局亮度上限（0..255） |
| 3 | `GAMMA` | 0=线性 1=γ2 近似（默认开） |
| 4 | `LINK_TIMEOUT_MS` | 静默多久算失联（默认 15000 = 3× 心跳；0=永不） |
| 5 | `REVERSE` | 灯带装反了不用重焊 |
| 6 | `DEFAULT_BRIGHT` | `brightness=0xFF` 时用的默认亮度 |

## 6. ASCII 兜底（bring-up 用）

板子刚打出来、或手头只有串口助手时，固件接受按行读取的 ASCII 命令
（`0xA5` 不是可打印字符，两条路径不冲突）：

```
S:RUN      S:WAIT   S:DONE   S:ERR   S:OFF
B:128      亮度
P:42       进度
E:5,255,255,255,9     效果, r, g, b, 速度
C          清覆盖层
?          打印版本与灯珠数
```

## 7. 对外 API（本分支的"特殊版本"）

三个版本号各自表达一件事，**不要混用**：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `NOTIFY_API_VERSION` | `1.1.0-led.1` | 通知 API 的版本（主版本仍是 1，老调用方的降级判定不受影响） |
| `LED_API_VERSION` | `1.0.0-led.1` | **串口控制协议的特殊版本（本分支专属）** |
| `LED_WIRE_VERSION` | `1` | 真正上串口的帧版本（固件在 `HELLO_ACK` 里回报） |

```js
const notify = ctx.get('desktopNotify')
notify.apiVersion        // '1.1.0-led.1'
notify.capabilities      // [..., 'led.serial', 'led.scene', 'led.effect', ...]

const led = notify.led   // ⚠️ 灯带未启用 / 平台不支持时为 null：必须判空
led.protocolVersion      // '1.0.0-led.1'
led.wireVersion          // 1

led.status()                                     // 链路 + 判定 + 设备信息
led.scene({ state: 'waiting', color: '#ffb000' })// 语义帧（走完整判定链）
led.effect({ effect: 'rainbow', speed: 3 })      // 显式效果
led.overlay({ effect: 'double-flash', ttlMs: 1500, repeat: 3 })
led.brightness(120)
led.progress(42, '#00c8ff')
led.frame({ type: 0x08, payload: [] })           // 白名单原始帧（类型受限、载荷先校验）
led.acknowledge()                                // 解除"自上次聚焦未回来"的提醒
led.preview('done', 90)                          // 手动点灯（诊断/bring-up）
```

每次调用返回：

```js
{ ok: true, queued: true, reason: '', protocolVersion: '1.0.0-led.1' }
```

* `ok` = 请求本身合法；`queued` = 真的写进串口了；
* `reason`：`''` | `invalid-payload` | `led-disabled` | `link-down` | `unsupported-frame`；
* 非法载荷**一个字节都不会写出去**（`tests/api.test.mjs` 锁了这条）。

> 为什么不直接暴露"写字节"：裸字节会让调用方绕过 LEN/CRC/类型校验，
> 一路把设备写进没人能复现的状态。`frame()` 只放行主机→设备的白名单类型，
> 且载荷仍然先过一遍编码校验。

## 8. 主机侧的自诊断端点

`/dnotify` 路由上新增（进程令牌保护，和 `/status` 同级）：

```
GET  /dnotify/status?t=<令牌>         # 含 led: { scene, link, verdicts, device }
GET  /dnotify/led?t=<令牌>            # 只看灯带
POST /dnotify/led?t=<令牌>  {"op":"status"}
POST /dnotify/led?t=<令牌>  {"op":"ack"}
POST /dnotify/led?t=<令牌>  {"op":"preview","state":"running","brightness":120}
```

板子还没打的时候，这是唯一能"看不到灯也能调试"的入口：链路通没通、固件握手没有、
每个会话被判成什么状态，全在这里。设置页的灯带卡片每 3s 轮询的就是它。

## 9. 版本与兼容

* 帧类型、状态码、效果码**只增不改**：加新码不破坏老固件（老固件忽略未知类型并重同步）；
* `HELLO_ACK` 回报的 `wireVersion` 高于主机认识的版本时，主机只记一条警告，
  继续用自己认识的部分（`serial-link.ts` 有这条分支）；
* 本分支**不并入主线**，所以对外 API 版本带 `-led.1` 后缀：主线若将来要合，
  先把后缀去掉、并把 `NOTIFY_API_VERSION` 的次版本按主线语义重排。
