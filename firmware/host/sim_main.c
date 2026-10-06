/*
 * sim_main.c — 主机侧固件自测 / 预览器（板子还没打也能验证固件核心）
 *
 * 为什么值得写这个：
 *   · 固件里真正容易出错的不是"点亮灯"，而是**协议解析、状态映射、亮度与合成**——
 *     这些全在 core/ 的纯 C 里，不依赖 Arduino，可以在 PC 上编译并逐条断言；
 *   · vectors.h 由主机侧编码器生成（scripts/gen-led-vectors.mjs），
 *     这里反向解码并逐字段核对 —— 两端编码/解码只要有一处漂移，测试立刻红。
 *
 * 用法：
 *   sim --selftest                 跑全部断言（CI 用）
 *   sim --scene running --frames 8 打印若干帧的文本预览（肉眼看看动画对不对）
 *   sim --hex "A5 5A 02 01 05 ..." 喂原始字节，打印解析结果
 *
 * 编译（见 scripts/test-firmware.mjs）：
 *   cl /nologo /std:c11 /W4 /Fe:sim.exe sim_main.c ../core/led_protocol.c ../core/led_engine.c
 *   gcc -std=c99 -Wall -Wextra -o sim sim_main.c ../core/led_protocol.c ../core/led_engine.c
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../core/led_protocol.h"
#include "../core/led_engine.h"
#include "vectors.h"

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond, ...) do { \
    g_checks++; \
    if (!(cond)) { \
      g_failures++; \
      printf("  FAIL %s:%d: ", __FILE__, __LINE__); \
      printf(__VA_ARGS__); \
      printf("\n"); \
    } \
  } while (0)

/* ---- 1) 测试向量：主机编码 → 固件解码，逐字段核对 ---- */
static void test_vectors(void) {
  unsigned i;
  printf("[1] 测试向量（主机编码的字节流 → 固件解析）\n");
  for (i = 0u; i < LED_VECTORS_COUNT; i++) {
    const led_vector_t *v = &LED_VECTORS[i];
    led_parser_t parser;
    led_frame_t frame;
    led_ev_t ev = LED_EV_NONE;
    uint16_t k;
    int got = 0;
    memset(&frame, 0, sizeof(frame));
    led_parser_init(&parser);
    for (k = 0u; k < v->len; k++) {
      ev = led_parser_push(&parser, v->bytes[k], &frame);
      if (ev == LED_EV_FRAME) got++;
    }
    CHECK(got == 1, "%s: 期望解出 1 帧，实际 %d", v->name, got);
    CHECK(ev == LED_EV_FRAME, "%s: 最后一个字节应产生帧事件", v->name);
    if (got == 1) {
      CHECK(frame.type == v->type, "%s: type 期望 0x%02X 实际 0x%02X", v->name, v->type, frame.type);
      CHECK(frame.seq == v->seq, "%s: seq 期望 %u 实际 %u", v->name, v->seq, frame.seq);
      CHECK(frame.len == v->plen, "%s: len 期望 %u 实际 %u", v->name, v->plen, frame.len);
      CHECK(memcmp(frame.payload, v->payload, v->plen) == 0, "%s: 载荷不一致", v->name);
    }
    CHECK(parser.crc_errors == 0u, "%s: 不该有 CRC 错", v->name);
  }
  printf("    %u 个向量检查完成\n", (unsigned)LED_VECTORS_COUNT);
}

/* ---- 2) 解析器：坏帧/垃圾/半帧都不能把状态机带偏 ---- */
static void test_parser_robustness(void) {
  led_parser_t parser;
  led_frame_t frame;
  uint8_t corrupt[LED_MAX_FRAME];
  uint16_t i;
  int got;

  printf("[2] 解析器健壮性（CRC 错、垃圾字节、跨包半帧）\n");
  if (LED_VECTORS_COUNT == 0u) { CHECK(0, "没有测试向量"); return; }

  /* CRC 错：整帧长度不变，只翻掉校验字节 → 必须丢帧且计数 */
  memcpy(corrupt, LED_VECTORS[0].bytes, LED_VECTORS[0].len);
  corrupt[LED_VECTORS[0].len - 1u] ^= 0xFFu;
  led_parser_init(&parser);
  got = 0;
  for (i = 0u; i < LED_VECTORS[0].len; i++) {
    if (led_parser_push(&parser, corrupt[i], &frame) == LED_EV_FRAME) got++;
  }
  CHECK(got == 0, "CRC 错的帧不该被接受");
  CHECK(parser.crc_errors == 1u, "CRC 错应计数 1，实际 %u", (unsigned)parser.crc_errors);

  /* 垃圾前缀 + 好帧：必须重同步并解出后面的好帧 */
  led_parser_init(&parser);
  got = 0;
  for (i = 0u; i < 9u; i++) (void)led_parser_push(&parser, (uint8_t)"garbage!\n"[i], &frame);
  for (i = 0u; i < LED_VECTORS[0].len; i++) {
    if (led_parser_push(&parser, LED_VECTORS[0].bytes[i], &frame) == LED_EV_FRAME) got++;
  }
  CHECK(got == 1, "垃圾前缀之后应仍能解出好帧，实际 %d", got);

  /* 跨包半帧：先喂前半，再喂后半 */
  led_parser_init(&parser);
  got = 0;
  for (i = 0u; i < 3u; i++) (void)led_parser_push(&parser, LED_VECTORS[0].bytes[i], &frame);
  for (i = 3u; i < LED_VECTORS[0].len; i++) {
    if (led_parser_push(&parser, LED_VECTORS[0].bytes[i], &frame) == LED_EV_FRAME) got++;
  }
  CHECK(got == 1, "跨包半帧应能拼起来");

  /* 未知类型 / 超长长度：丢帧且不崩 */
  led_parser_init(&parser);
  (void)led_parser_push(&parser, LED_SOF0, &frame);
  (void)led_parser_push(&parser, LED_SOF1, &frame);
  (void)led_parser_push(&parser, 0x77u, &frame);
  CHECK(parser.dropped == 1u, "未知类型应计入 dropped");
  (void)led_parser_push(&parser, LED_SOF0, &frame);
  (void)led_parser_push(&parser, LED_SOF1, &frame);
  (void)led_parser_push(&parser, LED_FRAME_SCENE, &frame);
  (void)led_parser_push(&parser, 1u, &frame);
  (void)led_parser_push(&parser, 200u, &frame);   /* LEN > 32 */
  CHECK(parser.dropped == 2u, "超长 LEN 应计入 dropped");
}

/* ---- 3) CRC 与颜色换算：与主机侧同一套系数 ---- */
static void test_primitives(void) {
  const uint8_t digits[] = { '1','2','3','4','5','6','7','8','9' };
  uint8_t r, g, b;
  printf("[3] CRC8 与颜色换算\n");
  CHECK(led_crc8(digits, 9u) == 0xF4u, "CRC8(\"123456789\") 应为 0xF4，实际 0x%02X", led_crc8(digits, 9u));
  CHECK(led_rgb_to_332(255u, 255u, 255u) == 0xFFu, "白应压成 0xFF");
  CHECK(led_rgb_to_332(0u, 0u, 0u) == 0x00u, "黑应压成 0x00");
  led_332_to_rgb(led_rgb_to_332(255u, 176u, 0u), &r, &g, &b);
  CHECK(r >= 219u && r <= 255u, "R 量化误差过大：%u", r);
  CHECK(g >= 140u && g <= 212u, "G 量化误差过大：%u", g);
  CHECK(b <= 85u, "B 量化误差过大：%u", b);
}

/* ---- 4) 引擎：状态映射、提醒、失联、亮度、进度、反转 ---- */
static uint32_t sum_brightness(const uint8_t *px, uint16_t count) {
  uint32_t sum = 0u;
  uint16_t i;
  for (i = 0u; i < count * 3u; i++) sum += px[i];
  return sum;
}

static void test_engine(void) {
  led_engine_t e;
  led_scene_t scene;
  uint8_t px[24];   /* 8 灯珠 */
  uint32_t bright_quiet, bright_lost;
  uint16_t i;

  printf("[4] 渲染引擎\n");

  /* 4.1 完成 + 已看过（MUTED）→ 常亮绿 */
  led_engine_init(&e, 8u);
  led_engine_config(&e, LED_CFG_LINK_TIMEOUT, 0u);   /* 本组测试不测失联，显式关掉 */
  memset(&scene, 0, sizeof(scene));
  scene.state = LED_STATE_DONE;
  scene.flags = LED_FLAG_MUTED;
  scene.brightness = 254u;   /* 254 才是"最亮"：255 是"用设备默认"的哨兵 */
  scene.accent = LED_BRIGHT_DEFAULT;
  scene.progress = LED_PROGRESS_NONE;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_note_rx(&e, 0u);
  led_engine_render(&e, 100u, px);
  CHECK(px[1] > px[0] && px[1] > px[2], "完成态应偏绿：r=%u g=%u b=%u", px[0], px[1], px[2]);
  for (i = 0u; i < 8u; i++) {
    CHECK(px[i * 3u] == px[0] && px[i * 3u + 1u] == px[1], "MUTED 完成态应整条同色");
  }

  /* 4.2 运行中 → 白色流动：同一时刻必须有明暗差（真的在动） */
  scene.state = LED_STATE_RUNNING;
  scene.flags = 0u;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_render(&e, 1000u, px);
  {
    uint8_t minv = 255u, maxv = 0u;
    for (i = 0u; i < 8u; i++) {
      uint8_t v = px[i * 3u + 1u];
      if (v < minv) minv = v;
      if (v > maxv) maxv = v;
    }
    CHECK(maxv > minv, "流动效果应产生明暗对比（min=%u max=%u）", minv, maxv);
    CHECK(px[0] == px[1] && px[1] == px[2], "运行态应是白光（R=G=B）");
  }
  /* 再往后一点，亮的位置要移动 */
  {
    uint8_t first[24];
    led_engine_render(&e, 1000u + 120u, first);
    CHECK(memcmp(first, px, sizeof(px)) != 0, "流动效果应随时间变化");
  }

  /* 4.3 提醒中 vs 安静：提醒态必须**一直有光**（不熄灭）且**在动**（双闪），
   *     而安静态是恒定的常亮 —— 这正是"自上次聚焦未回来则一直提醒"的固件侧含义。 */
  scene.state = LED_STATE_DONE;
  scene.flags = LED_FLAG_MUTED;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_render(&e, 5000u, px);
  bright_quiet = sum_brightness(px, 8u);
  scene.flags = LED_FLAG_ATTENTION;
  led_engine_set_scene(&e, &scene, 0u);
  {
    uint32_t minv = 0xFFFFFFFFu;
    uint32_t maxv = 0u;
    uint32_t t;
    for (t = 5000u; t < 8000u; t += 50u) {
      uint32_t sum;
      led_engine_render(&e, t, px);
      sum = sum_brightness(px, 8u);
      if (sum < minv) minv = sum;
      if (sum > maxv) maxv = sum;
    }
    CHECK(minv > 0u, "提醒态在整段时间里都不该熄灭（min=%u）", (unsigned)minv);
    CHECK(maxv >= bright_quiet / 2u, "提醒态的峰值应足够亮（max=%u quiet=%u）", (unsigned)maxv, (unsigned)bright_quiet);
    CHECK(maxv - minv > bright_quiet / 4u, "提醒态应在动（双闪/呼吸），不能像安静态那样恒定（max-min=%u）", (unsigned)(maxv - minv));
  }
  /* 提醒不会随时间消失：10 分钟后仍然亮着 */
  led_engine_render(&e, 600000u, px);
  CHECK(sum_brightness(px, 8u) > 0u, "提醒态十分钟后仍应亮着（一直提醒）");

  /* 4.4 异常 → 闪（红） */
  scene.state = LED_STATE_ERROR;
  scene.flags = 0u;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_render(&e, 0u, px);
  CHECK(px[0] > 0u && px[1] == 0u && px[2] == 0u, "异常态亮相应为纯红：r=%u g=%u b=%u", px[0], px[1], px[2]);
  led_engine_render(&e, 600u, px);   /* 半周期 → 灭 */
  CHECK(sum_brightness(px, 8u) == 0u, "异常态应在后半周期熄灭（闪）");

  /* 4.5 等待你 → 暖黄 */
  scene.state = LED_STATE_WAITING;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_render(&e, 500u, px);
  CHECK(px[0] > px[2] && px[1] > px[2], "等待态应偏黄：r=%u g=%u b=%u", px[0], px[1], px[2]);

  /* 4.6 失联兜底：静默超过 link_timeout 后改成低亮蓝呼吸 */
  led_engine_init(&e, 8u);
  led_engine_config(&e, LED_CFG_LINK_TIMEOUT, 1000u);
  memset(&scene, 0, sizeof(scene));
  scene.state = LED_STATE_RUNNING;
  scene.brightness = 254u;
  scene.accent = LED_BRIGHT_DEFAULT;
  scene.progress = LED_PROGRESS_NONE;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_note_rx(&e, 0u);
  led_engine_render(&e, 20000u, px);
  CHECK(px[2] > px[0], "失联表现应偏蓝：r=%u b=%u", px[0], px[2]);
  bright_lost = sum_brightness(px, 8u);
  CHECK(bright_lost < 8u * 3u * 60u, "失联表现应明显更暗（sum=%u）", (unsigned)bright_lost);

  /* 4.7 亮度上限与夜间模式 */
  led_engine_init(&e, 8u);
  led_engine_config(&e, LED_CFG_LINK_TIMEOUT, 0u);
  led_engine_config(&e, LED_CFG_MAX_BRIGHTNESS, 64u);
  memset(&scene, 0, sizeof(scene));
  scene.state = LED_STATE_DONE;
  scene.flags = LED_FLAG_MUTED;
  scene.brightness = 254u;
  scene.accent = LED_BRIGHT_DEFAULT;
  scene.progress = LED_PROGRESS_NONE;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_note_rx(&e, 0u);
  led_engine_render(&e, 100u, px);
  CHECK(px[1] <= 64u, "全局亮度上限未生效：g=%u", px[1]);
  scene.flags = (uint8_t)(LED_FLAG_MUTED | LED_FLAG_NIGHT);
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_render(&e, 100u, px);
  CHECK(px[1] <= 22u, "夜间模式应再打一档：g=%u", px[1]);

  /* 4.8 进度条：50% 时前半段用进度色 */
  led_engine_init(&e, 8u);
  led_engine_config(&e, LED_CFG_LINK_TIMEOUT, 0u);
  memset(&scene, 0, sizeof(scene));
  scene.state = LED_STATE_RUNNING;
  scene.brightness = 254u;
  scene.accent = LED_BRIGHT_DEFAULT;
  scene.progress = LED_PROGRESS_NONE;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_note_rx(&e, 0u);
  led_engine_set_progress(&e, 50u, led_rgb_to_332(0u, 0u, 255u));
  led_engine_render(&e, 100u, px);
  CHECK(px[2] > 200u && px[0] < 60u, "进度条前半段应偏蓝：r=%u b=%u", px[0], px[2]);

  /* 4.9 灯序反转 */
  led_engine_init(&e, 4u);
  led_engine_config(&e, LED_CFG_LINK_TIMEOUT, 0u);
  led_engine_config(&e, LED_CFG_REVERSE, 1u);
  memset(&scene, 0, sizeof(scene));
  scene.state = LED_STATE_DONE;
  scene.flags = LED_FLAG_MUTED;
  scene.brightness = 254u;
  scene.accent = LED_BRIGHT_DEFAULT;
  scene.progress = LED_PROGRESS_NONE;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_note_rx(&e, 0u);
  {
    uint8_t forward[12];
    uint8_t reversed[12];
    led_engine_render(&e, 100u, forward);
    led_engine_config(&e, LED_CFG_REVERSE, 0u);
    led_engine_render(&e, 100u, reversed);
    CHECK(forward[0] == reversed[9] && forward[1] == reversed[10], "反转应把灯序倒过来");
  }

  /* 4.10 覆盖层 TTL：到期自动回落，不需要主机发撤销帧 */
  led_engine_init(&e, 4u);
  led_engine_config(&e, LED_CFG_LINK_TIMEOUT, 0u);
  memset(&scene, 0, sizeof(scene));
  scene.state = LED_STATE_OFF;
  scene.brightness = 254u;
  scene.accent = LED_BRIGHT_DEFAULT;
  scene.progress = LED_PROGRESS_NONE;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_note_rx(&e, 0u);
  led_engine_set_overlay(&e, LED_EFFECT_SOLID, 5u, 255u, led_rgb_to_332(255u, 0u, 0u), 0u, 500u, 0u, 0u);
  led_engine_render(&e, 100u, px);
  CHECK(px[0] > 100u, "覆盖层应可见：r=%u", px[0]);
  led_engine_render(&e, 1000u, px);
  CHECK(sum_brightness(px, 4u) == 0u, "覆盖层过期后应自动消失");

  /* 4.11 亮度哨兵回归：SCENE.brightness=255 必须解释为"设备默认"，254 才是"最亮"。
   *     这条是固件自测抓到的真实事故：主机发"最亮(255)"，固件当成"用我的默认(160)"，
   *     表现就是"调到最亮反而变暗"。 */
  led_engine_init(&e, 4u);
  led_engine_config(&e, LED_CFG_LINK_TIMEOUT, 0u);
  led_engine_config(&e, LED_CFG_DEFAULT_BRIGHT, 100u);
  memset(&scene, 0, sizeof(scene));
  scene.state = LED_STATE_DONE;
  scene.flags = LED_FLAG_MUTED;
  scene.brightness = 254u;   /* 显式最亮 */
  scene.accent = LED_BRIGHT_DEFAULT;
  scene.progress = LED_PROGRESS_NONE;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_note_rx(&e, 0u);
  led_engine_render(&e, 100u, px);
  {
    uint8_t explicit_max = px[1];
    scene.brightness = LED_BRIGHT_DEFAULT;   /* 255 = 用设备默认(100) */
    led_engine_set_scene(&e, &scene, 0u);
    led_engine_render(&e, 100u, px);
    CHECK(explicit_max > px[1], "显式 254 应比\"设备默认(100)\"更亮（%u vs %u）", explicit_max, px[1]);
  }
}

/* ---- 5) ASCII 兜底 ---- */
static void test_ascii(void) {
  led_ascii_cmd_t cmd;
  printf("[5] ASCII 兜底命令\n");
  CHECK(led_ascii_parse("S:RUN", &cmd) == 1 && cmd.cmd == 'S' && cmd.state == LED_STATE_RUNNING, "S:RUN");
  CHECK(led_ascii_parse("s:done", &cmd) == 1 && cmd.state == LED_STATE_DONE, "大小写不敏感");
  CHECK(led_ascii_parse("B:128", &cmd) == 1 && cmd.args[0] == 128, "B:128");
  CHECK(led_ascii_parse("E:3,255,176,0,5", &cmd) == 1 && cmd.argc == 5 && cmd.args[4] == 5, "E:...");
  CHECK(led_ascii_parse("P:42", &cmd) == 1 && cmd.args[0] == 42, "P:42");
  CHECK(led_ascii_parse("?", &cmd) == 1 && cmd.cmd == '?', "?");
  CHECK(led_ascii_parse("X:1", &cmd) == 0, "未知命令应被拒绝");
  CHECK(led_ascii_parse("S:NOPE", &cmd) == 0, "未知状态名应被拒绝");
  CHECK(led_ascii_parse("# 注释", &cmd) == 0, "注释行忽略");
}

/* ---- 预览：肉眼看动画 ---- */
static void preview(uint8_t state, uint8_t flags, int frames, uint16_t count) {
  led_engine_t e;
  led_scene_t scene;
  uint8_t px[300];
  int f;
  uint16_t i;
  if (count > 100u) count = 100u;
  led_engine_init(&e, count);
  led_engine_config(&e, LED_CFG_LINK_TIMEOUT, 0u);
  memset(&scene, 0, sizeof(scene));
  scene.state = state;
  scene.flags = flags;
  scene.brightness = 254u;   /* 254 才是"最亮"：255 是"用设备默认"的哨兵 */
  scene.accent = LED_BRIGHT_DEFAULT;
  scene.progress = LED_PROGRESS_NONE;
  led_engine_set_scene(&e, &scene, 0u);
  led_engine_note_rx(&e, 0u);
  printf("state=%u flags=0x%02X（%s）\n", state, flags,
         (flags & LED_FLAG_ATTENTION) ? "提醒中：呼吸+周期双闪" : "普通");
  for (f = 0; f < frames; f++) {
    uint32_t now = (uint32_t)(f * 150);
    led_engine_render(&e, now, px);
    printf("t=%5ums  ", (unsigned)now);
    for (i = 0u; i < count; i++) {
      unsigned v = (unsigned)px[i * 3u] + (unsigned)px[i * 3u + 1u] + (unsigned)px[i * 3u + 2u];
      char c = '.';
      if (v > 600u) c = '#';
      else if (v > 300u) c = '+';
      else if (v > 60u) c = '-';
      putchar(c);
    }
    {
      uint16_t best = 0u;
      uint32_t bestv = 0u;
      for (i = 0u; i < count; i++) {
        uint32_t v = (uint32_t)px[i * 3u] + px[i * 3u + 1u] + px[i * 3u + 2u];
        if (v > bestv) { bestv = v; best = i; }
      }
      printf("   peak[%u]=(%u,%u,%u)\n", (unsigned)best, px[best * 3u], px[best * 3u + 1u], px[best * 3u + 2u]);
    }
  }
}

static void feed_hex(const char *text) {
  led_parser_t parser;
  led_frame_t frame;
  unsigned value = 0u;
  int have = 0;
  const char *s = text;
  led_parser_init(&parser);
  while (*s != '\0') {
    char c = *s++;
    int digit = -1;
    if (c >= '0' && c <= '9') digit = c - '0';
    else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
    else { have = 0; value = 0u; continue; }
    if (!have) { value = (unsigned)digit; have = 1; }
    else {
      uint8_t byte = (uint8_t)((value << 4) | (unsigned)digit);
      led_ev_t ev = led_parser_push(&parser, byte, &frame);
      if (ev == LED_EV_FRAME) {
        uint8_t i;
        printf("FRAME type=0x%02X seq=%u len=%u payload=[", frame.type, frame.seq, frame.len);
        for (i = 0u; i < frame.len; i++) printf("%s%u", i ? "," : "", frame.payload[i]);
        printf("]\n");
      } else if (ev == LED_EV_LINE) {
        printf("LINE  %s\n", led_parser_line(&parser));
      }
      have = 0; value = 0u;
    }
  }
  printf("stats: frames=%u crc_errors=%u dropped=%u lines=%u\n",
         (unsigned)parser.frames, (unsigned)parser.crc_errors,
         (unsigned)parser.dropped, (unsigned)parser.lines);
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--selftest") == 0) {
    printf("=== 固件核心自测（wire v%u，%u 个测试向量）===\n", (unsigned)LED_WIRE_VERSION, (unsigned)LED_VECTORS_COUNT);
    test_vectors();
    test_parser_robustness();
    test_primitives();
    test_engine();
    test_ascii();
    printf("=== %d 项检查，%d 项失败 ===\n", g_checks, g_failures);
    return (g_failures == 0) ? 0 : 1;
  }
  if (argc > 2 && strcmp(argv[1], "--hex") == 0) {
    feed_hex(argv[2]);
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "--scene") == 0) {
    uint8_t state = LED_STATE_RUNNING;
    uint8_t flags = 0u;
    int frames = 8;
    uint16_t count = 24u;
    if (argc > 2) {
      /* 支持 `done+alert`：带"提醒中"位，用来预览"自上次聚焦未回来"的双闪 */
      char name[24];
      size_t n = strlen(argv[2]);
      if (n >= sizeof(name)) n = sizeof(name) - 1u;
      memcpy(name, argv[2], n);
      name[n] = '\0';
      {
        char *plus = strchr(name, '+');
        if (plus != 0) {
          *plus = '\0';
          if (strcmp(plus + 1, "alert") == 0 || strcmp(plus + 1, "attention") == 0) flags |= LED_FLAG_ATTENTION;
          else if (strcmp(plus + 1, "muted") == 0) flags |= LED_FLAG_MUTED;
          else if (strcmp(plus + 1, "night") == 0) flags |= LED_FLAG_NIGHT;
        }
      }
      if (strcmp(name, "off") == 0) state = LED_STATE_OFF;
      else if (strcmp(name, "run") == 0) state = LED_STATE_RUNNING;
      else if (strcmp(name, "wait") == 0) state = LED_STATE_WAITING;
      else if (strcmp(name, "done") == 0) state = LED_STATE_DONE;
      else if (strcmp(name, "err") == 0) state = LED_STATE_ERROR;
    }
    if (argc > 3) frames = atoi(argv[3]);
    if (argc > 4) count = (uint16_t)atoi(argv[4]);
    preview(state, flags, frames, count);
    return 0;
  }
  printf("用法：\n  sim --selftest\n  sim --scene running|waiting|done|error|off[+alert|+muted|+night] [帧数] [灯珠数]\n  sim --hex \"A5 5A 02 01 05 ...\"\n");
  return 2;
}
