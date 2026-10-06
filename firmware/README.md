# firmware/ — 板子还没打就能验证的固件部分

这块固件干的事：从 USB 转串口收**语义帧**，把它变成一个一眼能看懂的颜色（白=在跑、
黄=等你、绿=完成、红=异常），并且在你没回来看屏幕时**一直提醒**。

协议细节见 [`docs/serial-protocol.md`](../docs/serial-protocol.md)；这一篇讲**怎么跑起来**。

```
firmware/
├─ core/                     纯 C99 引擎（同时就是一个 Arduino 库）
│  ├─ led_protocol.h/.c      帧解析（状态机 + 可重同步）、CRC8、ASCII 兜底
│  ├─ led_engine.h/.c        状态→动画渲染、亮度/γ、覆盖层 TTL、失联兜底
│  └─ library.properties     给 Arduino IDE 当库用
├─ arduino/led_ticker/
│  └─ led_ticker.ino         Arduino 草图（WS2812 或三路 PWM）
├─ host/                     PC 侧自测与预览（不烧进板子）
│  ├─ sim_main.c             核心自测 + 文本预览器
│  ├─ sketch_check.cpp       把 .ino 在 Arduino 桩上**真的跑起来**
│  ├─ stub/                  Arduino / Adafruit_NeoPixel 最小桩
│  └─ vectors.h              由 scripts/gen-led-vectors.mjs 生成（勿手改）
└─ README.md
```

## 1. 先在 PC 上验证（不需要板子）

```bash
npm run test:firmware        # 编译 + 跑：核心 119 项断言、草图 17 项断言
npm run gen:vectors          # 改了协议之后重新生成测试向量
```

没有 C/C++ 编译器时会**明确跳过**并打印原因（不会伪装成通过）；Windows 上装
Visual Studio（含 C++ 工具链）或 LLVM/MinGW 即可自动启用。

肉眼看看动画对不对（不用板子）：

```bash
cd firmware/host && ./sim --scene running 12 40     # 12 帧 × 40 灯珠的文本预览
./sim --scene waiting 8 24
./sim --hex "A5 5A 02 01 05 01 00 FE FF FF 6C"      # 喂一串原始字节看解析结果
```

输出里每个字符是一个灯珠：`.` 暗 `-` 微亮 `+` 中亮 `#` 很亮，右边是峰值像素的 RGB。

## 2. 硬件假设

**接线（典型接法）**

| 板子 | 灯带 | 说明 |
| --- | --- | --- |
| `D6`（可改 `LED_PIN`） | WS2812/SK6812 的 `DIN` | 数据线；建议串 300~500Ω |
| `5V` | `5V` | 60 灯珠全白约 3.6A —— 别从 USB 口直接供 |
| `GND` | `GND` | **必须共地**，否则数据线电平漂移、灯乱闪 |
| `D2`（可改 `LED_BUTTON_PIN`） | 按键到 GND | 可选：短按 = "我知道了"（解除提醒） |

* **USB 转串口芯片**：CH340 / CP2102 / FT232 都行；主机侧不需要额外驱动包（koffi 直调 Win32）；
* **波特率**：默认 115200（协议稳态 < 20 B/s，9600 也够）；
* **MCU**：任何 Arduino 兼容板（AVR / ESP32 / STM32 / RP2040）。60 灯珠 × 3 字节 = 180 B
  的渲染缓冲，AVR 上建议 ≤ 100 灯珠；ESP32 随便。

**没有 WS2812、只有三色 RGB 灯珠**：把草图里的 `LED_BACKEND` 改成 `LED_BACKEND_PWM`，
并定义 `LED_PIN_R/LED_PIN_G/LED_PIN_B`（共阳的话再打开 `RGB_PWM_INVERT`）。
这条路只能表达"整条一个颜色"（取平均亮度），花样会少一些。

## 3. 编译烧录

**Arduino IDE**

1. 把 `firmware/core` 复制或软链到 Arduino 的 `libraries/LedTickerCore/`；
2. 库管理器装 **Adafruit NeoPixel**（不想装就用 `LED_BACKEND_PWM`）；
3. 打开 `firmware/arduino/led_ticker/led_ticker.ino`，按需改顶部几个 `#define`；
4. 选板 → 选口 → 上传。

**arduino-cli**

```bash
arduino-cli compile --fqbn arduino:avr:nano \
  --library firmware/core --library <你的库目录> \
  firmware/arduino/led_ticker
arduino-cli upload -p COM5 --fqbn arduino:avr:nano firmware/arduino/led_ticker
```

**烧完先自己点灯**（不用等插件）：打开串口助手（115200、8N1、加换行）敲

```
S:RUN      白，左右流动
S:WAIT     黄，呼吸
S:DONE     绿，呼吸
S:ERR      红，闪烁
B:80       调暗
```

看到对的颜色，说明板子这一半通了。接下来在 DSH 设置页打开「启用串口状态灯」即可。

> 很多 USB 串口芯片把 DTR/RTS 接到了复位脚：**打开串口会复位一次板子**，
> 这是正常现象（主机侧看到的就是"固件刚上电"）。主机的默认行为是**不置 DTR/RTS**，
> 避免每次启动都复位。

## 4. 各平台能力边界（诚实说明）

| 能力 | 状态 |
| --- | --- |
| Windows 串口（打开/配置/写/非阻塞读/枚举） | 已实现（koffi 直调 kernel32，无需原生依赖）。**在真机上验证过"打不开端口"的错误路径**；成功路径要等板子 |
| Linux / macOS 串口 | 已实现（`stty` 配置 + fs 读写），**未在真机验证** |
| 协议解析 / 状态映射 / 亮度 / 覆盖层 / 失联兜底 | 已在 PC 上编译并逐条断言（119 项） |
| Arduino 草图的逻辑（收帧→渲染→回包） | 已在 Arduino 桩上真跑（17 项） |
| WS2812 时序、USB 串口芯片行为、复位电路 | **未验证** —— 只能等板子打出来 |

## 5. 出问题时怎么查

1. 串口助手敲 `?`：应回 `# LED ticker wire v1 leds=60`。没回 → 板子没起来或波特率不对；
2. DSH 设置页的灯带卡片：显示"已连接 COMx / 固件尚未握手"→ 说明口开了但没收到 `HELLO_ACK`
   （多半是波特率或 TX/RX 接反）；
3. `GET /dnotify/led?t=<令牌>`：看 `link.parser` 的 `crcErrors` / `resyncs` ——
   持续增长说明波特率或线序不对（收到字节但解不出帧）；
4. `link.state = error` 且 `lastError` 里有 `打不开串口` → 端口被别的软件占用（串口助手没关）；
5. 灯在"主机还在跑"的时候变成低亮蓝呼吸 → 主机超过 3× 心跳没说话，检查插件是否还在运行。
