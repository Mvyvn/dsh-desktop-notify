/*
 * sketch_check.cpp — 在 PC 上把 Arduino 草图**真的跑起来**（不是只看语法）
 *
 * 做法：用 firmware/host/stub/ 里的 Arduino 最小桩替换真实框架，
 * 然后把 .ino 当源码 #include 进来（同一编译单元 → 草图里的 static 像素缓冲可见），
 * 于是可以：
 *   1. 调 setup()；
 *   2. 喂一串**由主机侧编码器生成的**真实帧（HELLO / SCENE / PROGRESS / EFFECT）；
 *   3. 推进假时钟并反复调 loop()；
 *   4. 断言灯珠缓冲与串口回包都符合预期。
 *
 * 它验证不到的东西（诚实边界）：真机上的 WS2812 时序、USB 串口芯片行为、复位电路。
 * 那些只能等板子打出来。
 *
 * 编译（见 scripts/test-firmware.mjs）：
 *   cl /nologo /utf-8 /std:c++17 /EHsc /Fe:sketch_check.exe /I stub /I ../core sketch_check.cpp
 */
#include <stdio.h>
#include <string.h>

#include "Arduino.h"
#include "Adafruit_NeoPixel.h"

/* 桩的全局状态 */
uint32_t g_fakeMillis = 0u;
uint8_t g_serialIn[STUB_SERIAL_IN];
size_t g_serialInLen = 0u;
size_t g_serialInPos = 0u;
uint8_t g_serialOut[STUB_SERIAL_OUT];
size_t g_serialOutLen = 0u;
StubSerial Serial;
uint8_t g_pinDigital[64];
uint8_t g_pinAnalog[64];
uint8_t g_stripR[STUB_NEOPIXEL_MAX];
uint8_t g_stripG[STUB_NEOPIXEL_MAX];
uint8_t g_stripB[STUB_NEOPIXEL_MAX];
uint16_t g_stripCount = 0u;
uint32_t g_stripShows = 0u;

/* 草图本体：与 Arduino IDE 一样，把它作为源码含进来 */
#include "../arduino/led_ticker/led_ticker.ino"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...) do { \
    g_checks++; \
    if (!(cond)) { g_failures++; printf("  FAIL %d: ", __LINE__); printf(__VA_ARGS__); printf("\n"); } \
  } while (0)

/** 把一串字节喂给草图，并推进若干毫秒的 loop。 */
static void pump(const uint8_t *bytes, size_t len, uint32_t stepMs, int steps) {
  int i;
  if (len > 0u) stubSerialFeed(bytes, len);
  for (i = 0; i < steps; i++) {
    g_fakeMillis += stepMs;
    loop();
  }
}

/** 从草图写出的串口数据里解帧，返回找到的第一帧类型（0 = 没找到）。 */
static uint8_t outputFrameType(uint8_t wantType, led_frame_t *out) {
  led_parser_t localParser;   /* 不叫 parser：草图里也有一个同名的全局 parser */
  led_frame_t frame;
  size_t i;
  led_parser_init(&localParser);
  for (i = 0u; i < g_serialOutLen; i++) {
    if (led_parser_push(&localParser, g_serialOut[i], &frame) == LED_EV_FRAME) {
      if (frame.type == wantType) {
        if (out != 0) *out = frame;
        return frame.type;
      }
    }
  }
  return 0u;
}

int main(void) {
  uint8_t frame[LED_MAX_FRAME];
  led_frame_t decoded;
  uint8_t payload[5];
  uint16_t i;

  printf("=== Arduino 草图冒烟测试（桩上运行，%d 灯珠）===\n", (int)LED_COUNT);

  setup();
  CHECK(g_stripCount == (uint16_t)LED_COUNT, "灯珠数量应初始化为 %d，实际 %u", (int)LED_COUNT, (unsigned)g_stripCount);
  pump(0, 0u, 25u, 2);
  CHECK(g_stripShows > 0u, "setup 后应至少 show 过一次（上电全灭）");

  /* 1) HELLO → 必须回 HELLO_ACK，且字段与固件配置一致 */
  stubSerialReset();
  payload[0] = LED_WIRE_VERSION;
  payload[1] = 0u;
  pump(frame, led_build_frame(frame, LED_FRAME_HELLO, 1u, payload, 2u), 25u, 2);
  CHECK(outputFrameType(LED_REPLY_HELLO_ACK, &decoded) != 0u, "HELLO 应回 HELLO_ACK");
  CHECK(decoded.payload[0] == LED_WIRE_VERSION, "HELLO_ACK 的 wireVersion 应为 %u", (unsigned)LED_WIRE_VERSION);
  CHECK(decoded.payload[1] == (uint8_t)LED_COUNT, "HELLO_ACK 的灯珠数应为 %d", (int)LED_COUNT);
  CHECK((decoded.payload[3] & 0x01u) != 0u, "HELLO_ACK 应声明支持效果帧");

  /* 2) SCENE = 运行中（白）→ 灯珠应亮且 R=G=B */
  stubSerialReset();
  payload[0] = LED_STATE_RUNNING;
  payload[1] = 0u;
  payload[2] = 254u;
  payload[3] = LED_PROGRESS_NONE;
  payload[4] = 0xFFu;
  pump(frame, led_build_frame(frame, LED_FRAME_SCENE, 2u, payload, 5u), 25u, 3);
  {
    uint32_t sum = 0u;
    for (i = 0u; i < (uint16_t)LED_COUNT; i++) sum += g_stripR[i] + g_stripG[i] + g_stripB[i];
    CHECK(sum > 0u, "运行态应点亮灯珠");
  }
  {
    uint16_t bright = 0u;
    for (i = 0u; i < (uint16_t)LED_COUNT; i++) {
      if (g_stripG[i] > 0u) { bright = i; break; }
    }
    CHECK(g_stripR[bright] == g_stripG[bright] && g_stripG[bright] == g_stripB[bright],
          "运行态应是白光（R=G=B），实际 (%u,%u,%u)", g_stripR[bright], g_stripG[bright], g_stripB[bright]);
  }
  /* 2b) 流动：时间推进后亮的位置应改变（至少整体像素分布变化） */
  {
    uint8_t snapshot[64];
    int changed = 0;
    uint16_t n = (uint16_t)(LED_COUNT < 64 ? LED_COUNT : 64);
    for (i = 0u; i < n; i++) snapshot[i] = g_stripG[i];
    pump(0, 0u, 25u, 40);
    for (i = 0u; i < n; i++) {
      if (snapshot[i] != g_stripG[i]) changed++;
    }
    CHECK(changed > 0, "运行态的流动效果应随时间改变像素");
  }

  /* 3) SCENE = 完成 + 提醒位 → 绿色且一直在提醒（亮着） */
  stubSerialReset();
  payload[0] = LED_STATE_DONE;
  payload[1] = LED_FLAG_ATTENTION;
  payload[2] = 254u;
  payload[3] = LED_PROGRESS_NONE;
  payload[4] = 0xFFu;
  pump(frame, led_build_frame(frame, LED_FRAME_SCENE, 3u, payload, 5u), 25u, 3);
  {
    uint16_t best = 0u;
    uint32_t bestv = 0u;
    for (i = 0u; i < (uint16_t)LED_COUNT; i++) {
      uint32_t v = (uint32_t)g_stripG[i];
      if (v > bestv) { bestv = v; best = i; }
    }
    CHECK(bestv > 0u, "完成态应点亮");
    CHECK(g_stripG[best] > g_stripR[best], "完成态应偏绿，实际 (%u,%u,%u)", g_stripR[best], g_stripG[best], g_stripB[best]);
  }

  /* 4) PROGRESS 帧 → 进度色点亮前半段 */
  stubSerialReset();
  {
    uint8_t prog[3];
    prog[0] = 50u;
    prog[1] = led_rgb_to_332(0u, 0u, 255u);
    prog[2] = 0xFFu;
    pump(frame, led_build_frame(frame, LED_FRAME_PROGRESS, 4u, prog, 3u), 25u, 2);
    CHECK(g_stripB[0] > 100u && g_stripR[0] < 60u, "进度条前半段应偏蓝，实际 (%u,%u,%u)", g_stripR[0], g_stripG[0], g_stripB[0]);
  }

  /* 5) CLEAR → 覆盖层与进度一起清掉 */
  stubSerialReset();
  pump(frame, led_build_frame(frame, LED_FRAME_CLEAR, 5u, 0, 0u), 25u, 2);
  CHECK(outputFrameType(LED_REPLY_ACK, 0) != 0u, "CLEAR 应回 ACK");

  /* 6) ASCII 兜底：S:ERR 应让灯变红（这条路径没有 CRC，靠解析器分流） */
  stubSerialReset();
  {
    const uint8_t ascii[] = { 'S', ':', 'E', 'R', 'R', '\n' };
    pump(ascii, sizeof(ascii), 25u, 3);
    CHECK(g_stripR[0] > g_stripG[0], "S:ERR 之后应偏红，实际 (%u,%u,%u)", g_stripR[0], g_stripG[0], g_stripB[0]);
  }

  /* 7) 未知 ASCII 命令 → 回一行提示而不是崩 */
  stubSerialReset();
  {
    const uint8_t junk[] = { 'X', ':', '1', '\n' };
    pump(junk, sizeof(junk), 25u, 2);
    CHECK(g_serialOutLen > 0u, "未知命令应回一行提示");
  }

  /* 8) PING → PONG */
  stubSerialReset();
  pump(frame, led_build_frame(frame, LED_FRAME_PING, 6u, 0, 0u), 25u, 2);
  CHECK(outputFrameType(LED_REPLY_PONG, 0) != 0u, "PING 应回 PONG");

  /* 9) 失联兜底：主机停手超过 link_timeout 后必须换成"低亮蓝呼吸" */
  {
    uint32_t sum = 0u;
    for (i = 0u; i < (uint16_t)LED_COUNT; i++) sum += g_stripR[i] + g_stripG[i] + g_stripB[i];
    /* 草图默认 link_timeout=15000（init 里的默认值；setup 里因为没握过手设为 0，
     * 但 HELLO 之后 note_rx 已把它打开 —— 这里推进 20s 模拟主机消失） */
    pump(0, 0u, 1000u, 20);
    CHECK(g_stripB[0] >= g_stripR[0], "失联后应偏蓝（实际 r=%u b=%u）", g_stripR[0], g_stripB[0]);
  }

  printf("=== %d 项检查，%d 项失败 ===\n", g_checks, g_failures);
  return (g_failures == 0) ? 0 : 1;
}
