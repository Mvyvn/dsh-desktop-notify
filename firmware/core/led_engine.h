/*
 * led_engine.h — 灯带渲染引擎（纯 C99，无 Arduino 依赖，可在主机上编译自测）
 *
 * 设计要点：**表现力在固件里，线上一律只传语义**。
 * 主机一次状态变化只发 11 个字节（SCENE 帧），之后所有动画、缓动、亮度曲线
 * 都由这里按本地时钟渲染 —— 主机卡顿不影响观感，串口带宽也几乎不占。
 *
 * 引擎不认识 Arduino，也不认识灯珠型号：它只往一块 `count * 3` 的 RGB 缓冲里写颜色。
 * 具体怎么把缓冲推给 WS2812 / 三色 PWM，是 .ino 的事。
 */
#ifndef LED_ENGINE_H
#define LED_ENGINE_H

#include <stdint.h>
#include "led_protocol.h"

typedef struct {
  uint8_t state;      /* LED_STATE_* */
  uint8_t flags;      /* LED_FLAG_* 位 */
  uint8_t brightness; /* 0..255（LED_BRIGHT_DEFAULT = 用设备默认） */
  uint8_t accent;     /* RGB332；LED_BRIGHT_DEFAULT = 用该状态的默认色 */
  uint8_t progress;   /* 0..100；LED_PROGRESS_NONE = 无 */
  uint32_t changed_ms;
} led_scene_t;

typedef struct {
  /* 配置 */
  uint16_t count;          /* 灯珠数量 */
  uint8_t max_bright;      /* 全局亮度上限 */
  uint8_t gamma;           /* 0=线性 1=γ2 近似 */
  uint8_t reverse;         /* 1=反转灯序（灯带装反了不用重焊） */
  uint8_t default_bright;  /* SCENE.brightness = 0xFF 时用它 */
  uint32_t link_timeout_ms;/* 静默多久算"主机失联"（0=永不） */

  /* 当前画面 */
  led_scene_t scene;

  /* 覆盖层（带 TTL，到期自动回落 —— 主机不必发"撤销"帧） */
  uint8_t ov_active;
  uint8_t ov_effect;
  uint8_t ov_speed;
  uint8_t ov_bright;
  uint8_t ov_color;
  uint8_t ov_param;
  uint8_t ov_repeat;
  uint32_t ov_until_ms;
  uint32_t ov_started_ms;

  /* 进度条（独立于 SCENE，方便和任何底色叠加） */
  uint8_t progress;
  uint8_t progress_color;

  /* 链路 */
  uint32_t last_rx_ms;
  uint8_t link_up;         /* 1=收到过主机帧，0=从未收到 */
  uint32_t frames_rx;

  /* 伪随机（sparkle 用；不引 rand() 以免平台差异） */
  uint32_t rng;
} led_engine_t;

void led_engine_init(led_engine_t *e, uint16_t count);
void led_engine_set_scene(led_engine_t *e, const led_scene_t *scene, uint32_t now_ms);
void led_engine_set_overlay(led_engine_t *e, uint8_t effect, uint8_t speed, uint8_t brightness,
                            uint8_t color332, uint8_t param, uint16_t ttl_ms, uint8_t repeat, uint32_t now_ms);
void led_engine_clear_overlay(led_engine_t *e);
void led_engine_set_progress(led_engine_t *e, uint8_t percent, uint8_t color332);
void led_engine_set_brightness(led_engine_t *e, uint8_t level);
/* @return 1 = 配置已应用，0 = 键不认识 */
int led_engine_config(led_engine_t *e, uint8_t key, uint32_t value);
void led_engine_note_rx(led_engine_t *e, uint32_t now_ms);

/*
 * 渲染一帧到 out（长度必须 ≥ count*3，顺序为 R,G,B）。
 * 纯函数式：同样的 (engine, now) 一定得到同样的像素，方便主机侧自测。
 */
void led_engine_render(led_engine_t *e, uint32_t now_ms, uint8_t *out);

/* 当前有效的亮度（已含全局上限与夜间模式）。 */
uint8_t led_engine_effective_brightness(const led_engine_t *e);

/* 状态 → 默认色（供 .ino 显示"当前语义色"用）。 */
void led_engine_state_color(uint8_t state, uint8_t *r, uint8_t *g, uint8_t *b);

#endif /* LED_ENGINE_H */
