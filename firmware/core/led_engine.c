/* led_engine.c — 见 led_engine.h 的说明
 *
 * 渲染管线（每个像素一次算完，不需要整帧缓冲，AVR 上也放得下）：
 *   1. 失联兜底：主机不说话了 → 低亮蓝呼吸（与任何"AI 状态色"都不撞色）
 *   2. 覆盖层（若在 TTL 内）→ 直接写进 out
 *   3. 底色（状态色 / accent）以 **取较大值** 的方式合成上去 ——
 *      这样覆盖层的亮点不会被底色吃掉，也不需要一个额外的整帧缓冲
 *   4. 进度条（1 字节百分比 → 灯带填充）
 *   5. 统一亮度 → γ → 灯序反转（最后的出口，保证所有图层观感一致）
 */
#include "led_engine.h"

/* ---- 整数小工具（不引浮点：AVR 没有 FPU，浮点会把整帧渲染拖慢一个数量级）---- */

/* γ≈2 的廉价近似：低亮时不会一跳一跳地难看（人眼对暗部非线性） */
static uint8_t gamma_apply(uint8_t value, uint8_t enabled) {
  if (!enabled) return value;
  return (uint8_t)(((uint16_t)value * (uint16_t)value + 127u) / 255u);
}

/* 三角波：在 [0, span) 内 0→255→0 */
static uint8_t triangle(uint32_t phase, uint32_t span) {
  uint32_t half;
  if (span < 2u) return 255u;
  half = span / 2u;
  phase = phase % span;
  if (phase < half) return (uint8_t)((phase * 255u) / half);
  return (uint8_t)(((span - phase) * 255u) / half);
}

/* speed 越大越快：所有动画共用这一个换算，观感才统一（speed=5 → 基准速度） */
static uint32_t speed_period(uint32_t base_ms, uint8_t speed) {
  uint32_t s = (speed == 0u) ? 5u : (uint32_t)speed;
  uint32_t period = (base_ms * 5u) / s;
  if (period < 60u) period = 60u;   /* 再快也不能超过 ~16Hz，否则人眼只能看到糊成一片 */
  return period;
}

static void hsv_to_rgb(uint8_t h, uint8_t s, uint8_t v, uint8_t *r, uint8_t *g, uint8_t *b) {
  uint8_t region = (uint8_t)(h / 43u);
  uint8_t rem = (uint8_t)((h - region * 43u) * 6u);
  uint8_t p = (uint8_t)(((uint16_t)v * (255u - s)) / 255u);
  uint8_t q = (uint8_t)(((uint16_t)v * (255u - ((uint16_t)s * rem) / 255u)) / 255u);
  uint8_t t = (uint8_t)(((uint16_t)v * (255u - ((uint16_t)s * (255u - rem)) / 255u)) / 255u);
  switch (region) {
    case 0u: *r = v; *g = t; *b = p; break;
    case 1u: *r = q; *g = v; *b = p; break;
    case 2u: *r = p; *g = v; *b = t; break;
    case 3u: *r = p; *g = q; *b = v; break;
    case 4u: *r = t; *g = p; *b = v; break;
    default: *r = v; *g = p; *b = q; break;
  }
}

void led_engine_state_color(uint8_t state, uint8_t *r, uint8_t *g, uint8_t *b) {
  switch (state) {
    case LED_STATE_RUNNING: *r = 255u; *g = 255u; *b = 255u; break; /* 白：左右流动 */
    case LED_STATE_WAITING: *r = 255u; *g = 176u; *b = 0u; break;   /* 黄：等你 */
    case LED_STATE_DONE:    *r = 0u;   *g = 255u; *b = 64u; break;  /* 绿：完成 */
    case LED_STATE_ERROR:   *r = 255u; *g = 0u;   *b = 0u; break;   /* 红：异常 */
    default:                *r = 0u;   *g = 0u;   *b = 0u; break;   /* 灭 */
  }
}

/* 该状态默认用哪个效果（SCENE 帧不带效果：效果由固件按语义自选，省带宽） */
static uint8_t default_effect(const led_engine_t *e) {
  switch (e->scene.state) {
    case LED_STATE_RUNNING: return LED_EFFECT_FLOW_BOTH;  /* 白色左右流动 */
    case LED_STATE_WAITING: return LED_EFFECT_BREATHE;
    case LED_STATE_DONE:    return (e->scene.flags & LED_FLAG_MUTED) ? LED_EFFECT_SOLID : LED_EFFECT_BREATHE;
    case LED_STATE_ERROR:   return LED_EFFECT_BLINK;
    default:                return LED_EFFECT_SOLID;
  }
}

static uint8_t default_speed(const led_engine_t *e) {
  switch (e->scene.state) {
    case LED_STATE_RUNNING: return 5u;
    case LED_STATE_WAITING: return 3u;
    case LED_STATE_DONE:    return 2u;
    case LED_STATE_ERROR:   return 8u;
    default:                return 1u;
  }
}

/*
 * "提醒中"的强度包络（flags & ATTENTION）。
 * 语义：**一直在提醒**——先呼吸（画面永不静止），再周期性双闪（扎眼但不晃瞎）。
 * 人回到 DSH 页面或按板上按键后主机把 ATTENTION 位去掉，这里自然安静下来。
 */
static uint8_t attention_level(uint32_t now, uint8_t speed) {
  uint8_t base = triangle(now, speed_period(1800u, speed));
  uint32_t t = now % 3000u;
  if (t < 140u) return 255u;      /* 第一道闪 */
  if (t < 260u) return base;
  if (t < 400u) return 255u;      /* 第二道闪 */
  return base;                    /* 其余时间保持呼吸：不静止 = 一直在提醒 */
}

/*
 * 渲染一个效果到 out。
 * @param blend 0 = 直接写；1 = 与现有像素取较大值（用于把底色合成到覆盖层之上）
 */
static void render_effect(led_engine_t *e, uint8_t effect, uint8_t speed, uint32_t now,
                          uint8_t r, uint8_t g, uint8_t b, uint8_t *out, uint8_t blend) {
  uint16_t count = e->count;
  uint16_t i;
  if (count == 0u) return;

  for (i = 0u; i < count; i++) {
    uint8_t rr = 0u, gg = 0u, bb = 0u;
    switch (effect) {
      case LED_EFFECT_SOLID: {
        rr = r; gg = g; bb = b;
        break;
      }
      case LED_EFFECT_BREATHE: {
        uint8_t level = triangle(now, speed_period(2400u, speed));
        rr = (uint8_t)(((uint16_t)r * level) / 255u);
        gg = (uint8_t)(((uint16_t)g * level) / 255u);
        bb = (uint8_t)(((uint16_t)b * level) / 255u);
        break;
      }
      case LED_EFFECT_BLINK: {
        uint32_t period = speed_period(1600u, speed);
        if ((now % period) < (period / 2u)) { rr = r; gg = g; bb = b; }
        break;
      }
      case LED_EFFECT_FLOW:
      case LED_EFFECT_FLOW_BACK:
      case LED_EFFECT_FLOW_BOTH: {
        /* 彗星：头 + 渐隐尾；FLOW_BOTH 让头左右往复（需求里的"白色左右流动"） */
        uint32_t step = speed_period(120u, speed);
        uint32_t tick = now / step;
        uint16_t head;
        int32_t d;
        uint8_t level = 0u;
        if (effect == LED_EFFECT_FLOW) {
          head = (uint16_t)(tick % count);
        } else if (effect == LED_EFFECT_FLOW_BACK) {
          head = (uint16_t)((count - 1u) - (tick % count));
        } else {
          uint16_t span = (uint16_t)(count + 5u);
          uint16_t cycle = (uint16_t)(span * 2u);
          uint16_t pos = (uint16_t)(tick % cycle);
          head = (pos < span) ? pos : (uint16_t)(cycle - pos - 1u);
        }
        d = (int32_t)head - (int32_t)i;
        if (d < 0) d = -d;
        if (d < 6) level = (uint8_t)(255 - (d * 255) / 6);
        rr = (uint8_t)(((uint16_t)r * level) / 255u);
        gg = (uint8_t)(((uint16_t)g * level) / 255u);
        bb = (uint8_t)(((uint16_t)b * level) / 255u);
        break;
      }
      case LED_EFFECT_CHASE: {
        uint32_t step = speed_period(90u, speed);
        if (i == (uint16_t)((now / step) % count)) { rr = r; gg = g; bb = b; }
        break;
      }
      case LED_EFFECT_RAINBOW: {
        uint32_t period = speed_period(6000u, speed);
        uint8_t shift = (uint8_t)(((now % period) * 256u) / period);
        uint8_t hue = (uint8_t)(shift + (uint8_t)((i * 256u) / count));
        hsv_to_rgb(hue, 255u, 255u, &rr, &gg, &bb);
        break;
      }
      case LED_EFFECT_SPARKLE: {
        /* 按时间片伪随机点亮少数几个点：安静但有生气（不需要 rng 状态） */
        uint32_t x = (now / 40u) * 2654435761u + (uint32_t)i * 2246822519u;
        if (((x >> 24) & 0x7Fu) < 20u) { rr = r; gg = g; bb = b; }
        break;
      }
      case LED_EFFECT_WIPE: {
        uint32_t period = speed_period(1500u, speed);
        if ((uint32_t)i <= ((now % period) * (uint32_t)count) / period) { rr = r; gg = g; bb = b; }
        break;
      }
      case LED_EFFECT_PROGRESS: {
        uint8_t percent = (e->progress > 100u) ? 100u : e->progress;
        uint8_t pr, pg, pb;
        led_332_to_rgb(e->progress_color, &pr, &pg, &pb);
        if ((uint32_t)i * 100u < (uint32_t)percent * count) { rr = pr; gg = pg; bb = pb; }
        else { rr = (uint8_t)(r / 6u); gg = (uint8_t)(g / 6u); bb = (uint8_t)(b / 6u); }
        break;
      }
      case LED_EFFECT_DOUBLE_FLASH: {
        uint8_t level = attention_level(now, speed);
        rr = (uint8_t)(((uint16_t)r * level) / 255u);
        gg = (uint8_t)(((uint16_t)g * level) / 255u);
        bb = (uint8_t)(((uint16_t)b * level) / 255u);
        break;
      }
      default: {
        rr = r; gg = g; bb = b;
        break;
      }
    }
    if (blend != 0u) {
      if (rr > out[i * 3u]) out[i * 3u] = rr;
      if (gg > out[i * 3u + 1u]) out[i * 3u + 1u] = gg;
      if (bb > out[i * 3u + 2u]) out[i * 3u + 2u] = bb;
    } else {
      out[i * 3u] = rr;
      out[i * 3u + 1u] = gg;
      out[i * 3u + 2u] = bb;
    }
  }
}

/* 失联表现：主机 3× 心跳没说话时，低亮蓝色慢呼吸 */
static void render_link_lost(led_engine_t *e, uint32_t now, uint8_t *out) {
  uint16_t i;
  uint8_t level = triangle(now, 3000u);
  uint8_t b = (uint8_t)(((uint16_t)level * 90u) / 255u);
  for (i = 0u; i < e->count; i++) {
    out[i * 3u] = 0u;
    out[i * 3u + 1u] = (uint8_t)(b / 3u);
    out[i * 3u + 2u] = b;
  }
}

void led_engine_init(led_engine_t *e, uint16_t count) {
  if (e == 0) return;
  e->count = count;
  e->max_bright = 255u;
  e->gamma = 1u;
  e->reverse = 0u;
  e->default_bright = 160u;
  e->link_timeout_ms = 15000u;   /* 3× 心跳（主机每 5s 一次） */

  e->scene.state = LED_STATE_OFF;
  e->scene.flags = 0u;
  e->scene.brightness = LED_BRIGHT_DEFAULT;
  e->scene.accent = LED_BRIGHT_DEFAULT;
  e->scene.progress = LED_PROGRESS_NONE;
  e->scene.changed_ms = 0u;

  e->ov_active = 0u;
  e->ov_effect = LED_EFFECT_DOUBLE_FLASH;
  e->ov_speed = 5u;
  e->ov_bright = LED_BRIGHT_DEFAULT;
  e->ov_color = 0xFFu;
  e->ov_param = 0u;
  e->ov_repeat = 0u;
  e->ov_until_ms = 0u;
  e->ov_started_ms = 0u;

  e->progress = LED_PROGRESS_NONE;
  e->progress_color = 0x1Fu;   /* 亮青 */

  e->last_rx_ms = 0u;
  e->link_up = 0u;
  e->frames_rx = 0u;
  e->rng = 0x1234567u;
}

void led_engine_set_scene(led_engine_t *e, const led_scene_t *scene, uint32_t now_ms) {
  if (e == 0 || scene == 0) return;
  e->scene = *scene;
  e->scene.changed_ms = now_ms;
}

void led_engine_set_overlay(led_engine_t *e, uint8_t effect, uint8_t speed, uint8_t brightness,
                            uint8_t color332, uint8_t param, uint16_t ttl_ms, uint8_t repeat, uint32_t now_ms) {
  if (e == 0) return;
  e->ov_active = 1u;
  e->ov_effect = effect;
  e->ov_speed = (speed == 0u) ? 5u : speed;
  e->ov_bright = brightness;
  e->ov_color = color332;
  e->ov_param = param;
  e->ov_repeat = repeat;
  e->ov_started_ms = now_ms;
  /* TTL = 0 表示"一直显示到 CLEAR" —— 主机想撤就得显式发 CLEAR */
  e->ov_until_ms = (ttl_ms == 0u) ? 0u : (now_ms + (uint32_t)ttl_ms);
}

void led_engine_clear_overlay(led_engine_t *e) {
  if (e == 0) return;
  e->ov_active = 0u;
  e->ov_until_ms = 0u;
}

void led_engine_set_progress(led_engine_t *e, uint8_t percent, uint8_t color332) {
  if (e == 0) return;
  e->progress = (percent > 100u) ? 100u : percent;
  e->progress_color = color332;
}

void led_engine_set_brightness(led_engine_t *e, uint8_t level) {
  if (e == 0) return;
  e->max_bright = level;
}

int led_engine_config(led_engine_t *e, uint8_t key, uint32_t value) {
  if (e == 0) return 0;
  switch (key) {
    case LED_CFG_LED_COUNT:      e->count = (uint16_t)value; break;
    case LED_CFG_MAX_BRIGHTNESS: e->max_bright = (uint8_t)(value > 255u ? 255u : value); break;
    case LED_CFG_GAMMA:          e->gamma = (value != 0u) ? 1u : 0u; break;
    case LED_CFG_LINK_TIMEOUT:   e->link_timeout_ms = value; break;
    case LED_CFG_REVERSE:        e->reverse = (value != 0u) ? 1u : 0u; break;
    case LED_CFG_DEFAULT_BRIGHT: e->default_bright = (uint8_t)(value > 255u ? 255u : value); break;
    default: return 0;
  }
  return 1;
}

void led_engine_note_rx(led_engine_t *e, uint32_t now_ms) {
  if (e == 0) return;
  e->last_rx_ms = now_ms;
  e->link_up = 1u;
  e->frames_rx++;
}

uint8_t led_engine_effective_brightness(const led_engine_t *e) {
  uint32_t bright;
  if (e == 0) return 0u;
  bright = (e->scene.brightness == LED_BRIGHT_DEFAULT) ? e->default_bright : e->scene.brightness;
  bright = (bright * e->max_bright) / 255u;
  if ((e->scene.flags & LED_FLAG_NIGHT) != 0u) bright = bright / 3u;   /* 夜间再打一档 */
  if (bright > 255u) bright = 255u;
  return (uint8_t)bright;
}

void led_engine_render(led_engine_t *e, uint32_t now_ms, uint8_t *out) {
  uint8_t r, g, b;
  uint8_t effect, speed, bright;
  uint16_t i;
  if (e == 0 || out == 0 || e->count == 0u) return;

  /* 1) 失联兜底：主机不说话了，就别再假装"AI 在跑" */
  if (e->link_timeout_ms > 0u && e->link_up != 0u &&
      (now_ms - e->last_rx_ms) > e->link_timeout_ms) {
    render_link_lost(e, now_ms, out);
    return;
  }

  /* 2) 底层：覆盖层（带 TTL，到期自动回落，主机不必发撤销帧） */
  for (i = 0u; i < e->count * 3u; i++) out[i] = 0u;
  if (e->ov_active != 0u) {
    if (e->ov_until_ms != 0u && now_ms >= e->ov_until_ms) {
      e->ov_active = 0u;
    } else {
      uint8_t orr, ogg, obb;
      uint8_t ob = (e->ov_bright == LED_BRIGHT_DEFAULT) ? 255u : e->ov_bright;
      if (e->ov_color == 0xFFu) { orr = 255u; ogg = 255u; obb = 255u; }
      else led_332_to_rgb(e->ov_color, &orr, &ogg, &obb);
      /* 覆盖层自己的亮度：主机可以在"很亮的告警"和"轻描淡写"之间选 */
      orr = (uint8_t)(((uint16_t)orr * ob) / 255u);
      ogg = (uint8_t)(((uint16_t)ogg * ob) / 255u);
      obb = (uint8_t)(((uint16_t)obb * ob) / 255u);
      render_effect(e, e->ov_effect, e->ov_speed, now_ms, orr, ogg, obb, out, 0u);
    }
  }

  /* 3) 底色（状态色或 accent）；提醒位在运行时只抬亮度，不改语义色 */
  if (e->scene.accent == LED_BRIGHT_DEFAULT) {
    led_engine_state_color(e->scene.state, &r, &g, &b);
  } else {
    led_332_to_rgb(e->scene.accent, &r, &g, &b);
  }
  effect = default_effect(e);
  speed = default_speed(e);
  if ((e->scene.flags & LED_FLAG_ATTENTION) != 0u) {
    if (e->scene.state == LED_STATE_RUNNING) {
      uint8_t up = (uint8_t)(attention_level(now_ms, speed) / 2u + 128u);
      r = (uint8_t)(((uint16_t)r * up) / 255u);
      g = (uint8_t)(((uint16_t)g * up) / 255u);
      b = (uint8_t)(((uint16_t)b * up) / 255u);
    } else {
      /* 完成/等待/异常 + 提醒 = 双闪（"一直提醒"的可见部分；呼吸由 attention_level 保证） */
      effect = LED_EFFECT_DOUBLE_FLASH;
    }
  }
  render_effect(e, effect, speed, now_ms, r, g, b, out, 1u);

  /* 4) 进度条：有进度就画在最上面（1 字节百分比就能表达"跑了多少"） */
  if (e->progress != LED_PROGRESS_NONE) {
    uint8_t pr, pg, pb;
    uint8_t percent = (e->progress > 100u) ? 100u : e->progress;
    led_332_to_rgb(e->progress_color, &pr, &pg, &pb);
    for (i = 0u; i < e->count; i++) {
      if ((uint32_t)i * 100u >= (uint32_t)percent * e->count) continue;
      out[i * 3u] = pr; out[i * 3u + 1u] = pg; out[i * 3u + 2u] = pb;
    }
  }

  /* 5) 统一亮度 + γ + 灯序反转（最后的出口，保证所有图层观感一致） */
  bright = led_engine_effective_brightness(e);
  for (i = 0u; i < e->count; i++) {
    uint8_t rr = (uint8_t)(((uint16_t)out[i * 3u] * bright) / 255u);
    uint8_t gg = (uint8_t)(((uint16_t)out[i * 3u + 1u] * bright) / 255u);
    uint8_t bb = (uint8_t)(((uint16_t)out[i * 3u + 2u] * bright) / 255u);
    out[i * 3u] = gamma_apply(rr, e->gamma);
    out[i * 3u + 1u] = gamma_apply(gg, e->gamma);
    out[i * 3u + 2u] = gamma_apply(bb, e->gamma);
  }
  if (e->reverse != 0u) {
    for (i = 0u; i < e->count / 2u; i++) {
      uint16_t j = (uint16_t)(e->count - 1u - i);
      uint8_t t0 = out[i * 3u], t1 = out[i * 3u + 1u], t2 = out[i * 3u + 2u];
      out[i * 3u] = out[j * 3u]; out[i * 3u + 1u] = out[j * 3u + 1u]; out[i * 3u + 2u] = out[j * 3u + 2u];
      out[j * 3u] = t0; out[j * 3u + 1u] = t1; out[j * 3u + 2u] = t2;
    }
  }
}
