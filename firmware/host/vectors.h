/*
 * vectors.h — 主机侧编码器产出的测试向量（自动生成，请勿手改）
 *
 *   生成：node scripts/gen-led-vectors.mjs
 *   真源：src/led-protocol.ts
 *   守护：tests/firmware.test.mjs 会重新生成并比对，改坏了两边都会红
 *
 * 固件侧（firmware/host/sim_main.c --selftest）逐字段解码这些字节，
 * 两端编码/解码只要有一处漂移，测试立刻失败。
 */
#ifndef LED_VECTORS_H
#define LED_VECTORS_H

#include <stdint.h>

typedef struct {
  const char *name;
  const uint8_t *bytes;
  uint16_t len;
  uint8_t type;
  uint8_t seq;
  uint8_t plen;
  uint8_t payload[32];
} led_vector_t;

/* hello: 8 字节，CRC=0xB7 */
static const uint8_t VEC_0[] = { 0xA5, 0x5A, 0x01, 0x01, 0x02, 0x01, 0x00, 0xB7 };
/* scene-running: 11 字节，CRC=0x1C */
static const uint8_t VEC_1[] = { 0xA5, 0x5A, 0x02, 0x02, 0x05, 0x01, 0x00, 0xA0, 0xFF, 0xFF, 0x1C };
/* scene-done-attention: 11 字节，CRC=0x76 */
static const uint8_t VEC_2[] = { 0xA5, 0x5A, 0x02, 0x03, 0x05, 0x03, 0x01, 0xD0, 0xFF, 0xFF, 0x76 };
/* scene-waiting-muted: 11 字节，CRC=0x86 */
static const uint8_t VEC_3[] = { 0xA5, 0x5A, 0x02, 0x04, 0x05, 0x02, 0x02, 0x68, 0xFF, 0xFF, 0x86 };
/* scene-error: 11 字节，CRC=0x9C */
static const uint8_t VEC_4[] = { 0xA5, 0x5A, 0x02, 0x05, 0x05, 0x04, 0x00, 0xFE, 0x64, 0xFF, 0x9C };
/* effect-flow-both: 11 字节，CRC=0xEA */
static const uint8_t VEC_5[] = { 0xA5, 0x5A, 0x03, 0x06, 0x05, 0x05, 0x09, 0x80, 0xFF, 0x03, 0xEA };
/* overlay-double-flash: 14 字节，CRC=0xBD */
static const uint8_t VEC_6[] = { 0xA5, 0x5A, 0x05, 0x07, 0x08, 0x0B, 0x0C, 0xFE, 0xE0, 0x00, 0x05, 0xDC, 0x03, 0xBD };
/* progress-42: 9 字节，CRC=0x22 */
static const uint8_t VEC_7[] = { 0xA5, 0x5A, 0x06, 0x08, 0x03, 0x2A, 0x1B, 0xFF, 0x22 };
/* config-link-timeout: 11 字节，CRC=0xCE */
static const uint8_t VEC_8[] = { 0xA5, 0x5A, 0x07, 0x09, 0x05, 0x04, 0x98, 0x3A, 0x00, 0x00, 0xCE };
/* ping: 6 字节，CRC=0xD3 */
static const uint8_t VEC_9[] = { 0xA5, 0x5A, 0x08, 0x0A, 0x00, 0xD3 };

static const led_vector_t LED_VECTORS[] = {
  { "hello", VEC_0, 8, 0x01, 1, 2, { 1, 0 } },
  { "scene-running", VEC_1, 11, 0x02, 2, 5, { 1, 0, 160, 255, 255 } },
  { "scene-done-attention", VEC_2, 11, 0x02, 3, 5, { 3, 1, 208, 255, 255 } },
  { "scene-waiting-muted", VEC_3, 11, 0x02, 4, 5, { 2, 2, 104, 255, 255 } },
  { "scene-error", VEC_4, 11, 0x02, 5, 5, { 4, 0, 254, 100, 255 } },
  { "effect-flow-both", VEC_5, 11, 0x03, 6, 5, { 5, 9, 128, 255, 3 } },
  { "overlay-double-flash", VEC_6, 14, 0x05, 7, 8, { 11, 12, 254, 224, 0, 5, 220, 3 } },
  { "progress-42", VEC_7, 9, 0x06, 8, 3, { 42, 27, 255 } },
  { "config-link-timeout", VEC_8, 11, 0x07, 9, 5, { 4, 152, 58, 0, 0 } },
  { "ping", VEC_9, 6, 0x08, 10, 0, {  } },
};

#define LED_VECTORS_COUNT (sizeof(LED_VECTORS) / sizeof(LED_VECTORS[0]))

#endif /* LED_VECTORS_H */
