/*
 * led_ticker.ino — DSH 任务状态提示器固件（Arduino 草图）
 *
 * 一块 USB 转串口 + 彩色灯珠（WS2812/SK6812 等）的板子：绿=完成、红=异常、
 * 黄=等你操作、白=左右流动（AI 在跑）。灯本身不需要你盯着屏幕 —— 这就是它的全部意义。
 *
 * ── 它为什么这么"小" ──────────────────────────────────────────────────────
 * 所有动画都在**固件里**按本地时钟渲染，串口只传语义（见 core/led_protocol.h）：
 * 主机一次状态变化只发 11 个字节，稳态下平均不到 20 B/s —— 9600 波特都绰绰有余。
 *
 * ── 依赖 ──────────────────────────────────────────────────────────────────
 * · 本仓库的 core/ 目录（纯 C 引擎）。把它复制/软链到 Arduino 的 libraries/LedTickerCore，
 *   或用 arduino-cli 的 --library 指过去（细节见 firmware/README.md）。
 * · 默认后端 Adafruit_NeoPixel（库管理器里装 Adafruit NeoPixel）；
 *   不想装库就把 LED_BACKEND 改成 LED_BACKEND_PWM，用三个 PWM 脚驱动共阳/共阴 RGB 灯珠。
 *
 * ── 烧录 ──────────────────────────────────────────────────────────────────
 * Arduino IDE 选板 → 选口 → 上传。注意很多 USB 串口芯片的 DTR/RTS 接了复位脚，
 * 打开串口会复位一次（正常现象：主机侧看到的就是"固件刚上电"）。
 */

#include <Arduino.h>
extern "C" {
#include <led_protocol.h>
#include <led_engine.h>
}

/* ---- 配置：按你的板子改这几行 ---- */
#ifndef LED_PIN
#define LED_PIN 6
#endif
#ifndef LED_COUNT
#define LED_COUNT 60
#endif
#ifndef LED_BAUD
#define LED_BAUD 115200
#endif
/** 板上按键（对地，内部上拉）：短按 = "我知道了"（让主机解除提醒）。-1 = 没有按键。 */
#ifndef LED_BUTTON_PIN
#define LED_BUTTON_PIN -1
#endif
/** 灯珠颜色顺序：绝大多数 WS2812 是 GRB。 */
#ifndef LED_COLOR_ORDER
#define LED_COLOR_ORDER NEO_GRB + NEO_KHZ800
#endif
/** 渲染间隔（毫秒）：25ms ≈ 40fps，肉眼足够流畅，也给串口解析留足时间。 */
#ifndef LED_RENDER_MS
#define LED_RENDER_MS 25
#endif

#define LED_BACKEND_NEOPIXEL 1
#define LED_BACKEND_PWM 3
#ifndef LED_BACKEND
#define LED_BACKEND LED_BACKEND_NEOPIXEL
#endif

#if LED_BACKEND == LED_BACKEND_NEOPIXEL
#include <Adafruit_NeoPixel.h>
static Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, LED_COLOR_ORDER);
#else
/* 三路 PWM：R/G/B 各一个脚（共阴接法；共阳把 RGB_PWM_INVERT 打开） */
#ifndef LED_PIN_R
#define LED_PIN_R 9
#endif
#ifndef LED_PIN_G
#define LED_PIN_G 10
#endif
#ifndef LED_PIN_B
#define LED_PIN_B 11
#endif
#ifndef RGB_PWM_INVERT
#define RGB_PWM_INVERT 0
#endif
#endif

/* ---- 状态 ---- */
static led_parser_t parser;
static led_engine_t engine;
static uint8_t pixels[LED_COUNT * 3u];
static uint32_t lastRender = 0;
static uint8_t lastSeq = 0;

/* PIXELS 直写：手动模式（直到下一条 SCENE/CLEAR 才回到语义渲染） */
static uint8_t manualMode = 0;

#if LED_BUTTON_PIN >= 0
static uint8_t lastButtonRaw = 1;
static uint32_t buttonDownAt = 0;
#endif

/* ---- 回包 ---- */
static void reply(uint8_t type, const uint8_t *payload, uint8_t len) {
  uint8_t frame[LED_MAX_FRAME];
  uint8_t n = led_build_frame(frame, type, lastSeq, payload, len);
  if (n > 0u) Serial.write(frame, n);
}

static void replyHelloAck(void) {
  /* [wireVersion, leds, maxBright, capsLo, capsHi]
   * caps 位：EFFECTS=0x01 PIXELS=0x02 PROGRESS=0x04 CONFIG=0x08 BUTTON=0x10 */
  uint8_t payload[5];
  uint16_t caps = 0x0001u | 0x0004u | 0x0008u;   /* 效果 / 进度 / 配置 */
  if (LED_COUNT <= 255) {
    payload[0] = LED_WIRE_VERSION;
    payload[1] = (uint8_t)LED_COUNT;
  } else {
    payload[0] = LED_WIRE_VERSION;
    payload[1] = 255u;
  }
  payload[2] = 254u;                             /* 显式亮度上限（255 是哨兵） */
  payload[3] = caps & 0xFFu;
  payload[4] = (uint8_t)((caps >> 8) & 0xFFu);
  reply(LED_REPLY_HELLO_ACK, payload, 5u);
}

static void replyPong(uint32_t now) {
  uint8_t payload[3];
  payload[0] = (uint8_t)(now & 0xFFu);
  payload[1] = (uint8_t)((now >> 8) & 0xFFu);
  payload[2] = (uint8_t)((now >> 16) & 0xFFu);
  reply(LED_REPLY_PONG, payload, 3u);
}

static void replyAck(uint8_t seq) {
  uint8_t payload[1];
  payload[0] = seq;
  reply(LED_REPLY_ACK, payload, 1u);
}

#if LED_BUTTON_PIN >= 0
static void replyEvent(uint8_t code, uint8_t arg) {
  uint8_t payload[2];
  payload[0] = code;
  payload[1] = arg;
  reply(LED_REPLY_EVENT, payload, 2u);
}
#endif

/* ---- 帧处理 ---- */
static void applyFrame(const led_frame_t *frame, uint32_t now) {
  const uint8_t *p = frame->payload;
  uint8_t len = frame->len;
  lastSeq = frame->seq;

  switch (frame->type) {
    case LED_FRAME_HELLO:
      replyHelloAck();
      break;

    case LED_FRAME_SCENE:
      if (len >= 5u) {
        led_scene_t scene;
        scene.state = p[0];
        scene.flags = p[1];
        scene.brightness = p[2];
        scene.accent = p[4];
        scene.progress = p[3];
        scene.changed_ms = now;
        led_engine_set_scene(&engine, &scene, now);
        /* SCENE 里的进度字段与独立的 PROGRESS 帧共用同一个引擎字段 */
        engine.progress = p[3];
        manualMode = 0u;
        replyAck(frame->seq);
      }
      break;

    case LED_FRAME_EFFECT:
      /* 显式效果：无 TTL 的覆盖层（一直显示到 CLEAR / 被新的 EFFECT / SCENE 取代） */
      if (len >= 5u) {
        led_engine_set_overlay(&engine, p[0], p[1], p[2], p[3], p[4], 0u, 0u, now);
        manualMode = 0u;
        replyAck(frame->seq);
      }
      break;

    case LED_FRAME_BRIGHT:
      if (len >= 1u) led_engine_set_brightness(&engine, p[0]);
      replyAck(frame->seq);
      break;

    case LED_FRAME_OVERLAY:
      if (len >= 8u) {
        uint16_t ttl = (uint16_t)(((uint16_t)p[5] << 8) | p[6]);
        led_engine_set_overlay(&engine, p[0], p[1], p[2], p[3], p[4], ttl, p[7], now);
        manualMode = 0u;
      }
      replyAck(frame->seq);
      break;

    case LED_FRAME_PROGRESS:
      if (len >= 2u) {
        led_engine_set_progress(&engine, p[0], p[1]);
        if (len >= 3u && p[2] != 0xFFu) led_engine_set_brightness(&engine, p[2]);
      }
      replyAck(frame->seq);
      break;

    case LED_FRAME_CONFIG: {
      uint32_t value = 0u;
      if (len >= 5u) {
        value = (uint32_t)p[1] | ((uint32_t)p[2] << 8) | ((uint32_t)p[3] << 16) | ((uint32_t)p[4] << 24);
      }
      if (len >= 5u && led_engine_config(&engine, p[0], value)) replyAck(frame->seq);
      else reply(LED_REPLY_NAK, p, (uint8_t)(len < 2u ? len : 2u));
      break;
    }

    case LED_FRAME_PING:
      replyPong(now);
      break;

    case LED_FRAME_CLEAR:
      led_engine_clear_overlay(&engine);
      engine.progress = LED_PROGRESS_NONE;
      manualMode = 0u;
      replyAck(frame->seq);
      break;

    case LED_FRAME_PIXELS:
      /* [start, count, r, g, b]：直接改一段像素（手动模式，直到下一条 SCENE/CLEAR） */
      if (len >= 5u) {
        uint16_t start = p[0];
        uint16_t n = p[1];
        uint16_t i;
        for (i = 0u; i < n; i++) {
          uint16_t idx = (uint16_t)(start + i);
          if (idx >= LED_COUNT) break;
          pixels[idx * 3u] = p[2];
          pixels[idx * 3u + 1u] = p[3];
          pixels[idx * 3u + 2u] = p[4];
        }
        manualMode = 1u;
        replyAck(frame->seq);
      }
      break;

    case LED_FRAME_BYE: {
      led_scene_t off;
      off.state = LED_STATE_OFF;
      off.flags = 0u;
      off.brightness = 0u;
      off.accent = 0xFFu;
      off.progress = LED_PROGRESS_NONE;
      off.changed_ms = now;
      led_engine_set_scene(&engine, &off, now);
      break;
    }

    default:
      break;
  }
}

/* ---- ASCII 兜底（手头只有串口助手时用）---- */
static void applyAscii(const char *line, uint32_t now) {
  led_ascii_cmd_t cmd;
  if (!led_ascii_parse(line, &cmd)) {
    Serial.print(F("# unknown\n"));
    return;
  }
  switch (cmd.cmd) {
    case 'S': {
      led_scene_t scene;
      scene.state = cmd.state;
      scene.flags = 0u;
      scene.brightness = 200u;
      scene.accent = 0xFFu;
      scene.progress = LED_PROGRESS_NONE;
      scene.changed_ms = now;
      led_engine_set_scene(&engine, &scene, now);
      break;
    }
    case 'B':
      if (cmd.argc >= 1) led_engine_set_brightness(&engine, (uint8_t)cmd.args[0]);
      break;
    case 'P':
      if (cmd.argc >= 1) led_engine_set_progress(&engine, (uint8_t)cmd.args[0], 0x1Fu);
      break;
    case 'E':
      if (cmd.argc >= 5) {
        led_engine_set_overlay(&engine, (uint8_t)cmd.args[0], (uint8_t)cmd.args[4], 254u,
                               led_rgb_to_332((uint8_t)cmd.args[1], (uint8_t)cmd.args[2], (uint8_t)cmd.args[3]),
                               0u, 0u, 0u, now);
      }
      break;
    case 'C':
      led_engine_clear_overlay(&engine);
      break;
    default:
      Serial.print(F("# LED ticker wire v"));
      Serial.print(LED_WIRE_VERSION);
      Serial.print(F(" leds="));
      Serial.println(LED_COUNT);
      break;
  }
}

static void handleSerial(uint32_t now) {
  led_frame_t frame;
  while (Serial.available() > 0) {
    int value = Serial.read();
    if (value < 0) break;
    switch (led_parser_push(&parser, (uint8_t)value, &frame)) {
      case LED_EV_FRAME:
        led_engine_note_rx(&engine, now);
        applyFrame(&frame, now);
        break;
      case LED_EV_LINE:
        led_engine_note_rx(&engine, now);
        applyAscii(led_parser_line(&parser), now);
        break;
      default:
        break;
    }
  }
}

#if LED_BUTTON_PIN >= 0
static void handleButton(uint32_t now) {
  uint8_t raw = (uint8_t)digitalRead(LED_BUTTON_PIN);
  if (raw == 0u && lastButtonRaw == 1u) {
    buttonDownAt = now;
  } else if (raw == 1u && lastButtonRaw == 0u) {
    uint32_t held = now - buttonDownAt;
    if (held >= 20u && held < 1500u) {
      replyEvent(0x01u, 0u);           /* BUTTON_PRESS：主机据此解除提醒 */
    } else if (held >= 1500u) {
      led_engine_clear_overlay(&engine);
      engine.progress = LED_PROGRESS_NONE;
      replyEvent(0x02u, 0u);           /* BUTTON_HOLD：本地清屏 */
    }
  }
  lastButtonRaw = raw;
}
#endif

/* ---- 输出 ---- */
static void pushPixels(void) {
#if LED_BACKEND == LED_BACKEND_NEOPIXEL
  uint16_t i;
  for (i = 0u; i < LED_COUNT; i++) {
    strip.setPixelColor(i, pixels[i * 3u], pixels[i * 3u + 1u], pixels[i * 3u + 2u]);
  }
  strip.show();
#else
  uint16_t i;
  uint32_t sumR = 0u, sumG = 0u, sumB = 0u;
  /* 三路 PWM 只能表达"整条一个颜色"：取平均亮度，保证不会比真实更刺眼 */
  for (i = 0u; i < LED_COUNT; i++) {
    sumR += pixels[i * 3u];
    sumG += pixels[i * 3u + 1u];
    sumB += pixels[i * 3u + 2u];
  }
#if RGB_PWM_INVERT
  analogWrite(LED_PIN_R, 255 - (int)(sumR / LED_COUNT));
  analogWrite(LED_PIN_G, 255 - (int)(sumG / LED_COUNT));
  analogWrite(LED_PIN_B, 255 - (int)(sumB / LED_COUNT));
#else
  analogWrite(LED_PIN_R, (int)(sumR / LED_COUNT));
  analogWrite(LED_PIN_G, (int)(sumG / LED_COUNT));
  analogWrite(LED_PIN_B, (int)(sumB / LED_COUNT));
#endif
#endif
}

void setup(void) {
  Serial.begin(LED_BAUD);
#if LED_BACKEND == LED_BACKEND_NEOPIXEL
  strip.begin();
  strip.show();                     /* 上电先全灭：避免灯带残留上一条数据 */
#else
  pinMode(LED_PIN_R, OUTPUT);
  pinMode(LED_PIN_G, OUTPUT);
  pinMode(LED_PIN_B, OUTPUT);
#endif
#if LED_BUTTON_PIN >= 0
  pinMode(LED_BUTTON_PIN, INPUT_PULLUP);
#endif
  led_parser_init(&parser);
  led_engine_init(&engine, LED_COUNT);
  /* 上电即"未连接"：主机一说话就会被 SCENE 接管；在此之前保持熄灭而不是假装有状态 */
  engine.link_up = 0u;
  engine.link_timeout_ms = 0u;      /* 还没握过手，不做失联判定 */
  lastRender = millis();
}

void loop(void) {
  uint32_t now = millis();
  handleSerial(now);
#if LED_BUTTON_PIN >= 0
  handleButton(now);
#endif
  if (now - lastRender < LED_RENDER_MS) return;
  lastRender = now;

  if (manualMode != 0u) {
    pushPixels();                   /* PIXELS 直写：交给上面写的像素，别覆盖 */
    return;
  }
  led_engine_render(&engine, now, pixels);
  pushPixels();
}
