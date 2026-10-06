/*
 * led_protocol.h — LED 串口线协议 v1 的固件侧解析（纯 C99，无 Arduino 依赖）
 *
 * 与主机侧 src/led-protocol.ts 是同一份契约的两端：
 *   帧： SOF0 SOF1 | TYPE | SEQ | LEN | PAYLOAD(LEN) | CRC8
 *         0xA5 0x5A
 *   线长：整帧 = 6 + LEN，LEN ≤ 32
 *   CRC8：poly 0x07 / init 0x00，覆盖 TYPE..PAYLOAD（不含魔数）
 *
 * 为什么用状态机而不是"收满缓冲区再解"：
 *   设备可能在**半帧处**上电（USB 枚举时主机已经在写），任何"信 LEN 字段"的实现
 *   都会被一个错位的长度字段永久带偏。状态机遇到魔数不匹配就回到起点，
 *   最坏情况只丢当前这一帧。
 *
 * ASCII 兜底：0xA5 不是可打印字符，因此固件可以按首字节分流 ——
 * 手头只有串口助手时用 `S:RUN` / `B:128` / `E:3,255,255,255,5` 就能先点灯。
 */
#ifndef LED_PROTOCOL_H
#define LED_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#define LED_SOF0 0xA5u
#define LED_SOF1 0x5Au
#define LED_MAX_PAYLOAD 32u
#define LED_FRAME_OVERHEAD 6u
#define LED_MAX_FRAME (LED_FRAME_OVERHEAD + LED_MAX_PAYLOAD)
#define LED_ASCII_MAX 48u
#define LED_ASCII_ARGS 8u
#define LED_WIRE_VERSION 1u

/* 主机 → 设备 */
#define LED_FRAME_HELLO 0x01u
#define LED_FRAME_SCENE 0x02u
#define LED_FRAME_EFFECT 0x03u
#define LED_FRAME_BRIGHT 0x04u
#define LED_FRAME_OVERLAY 0x05u
#define LED_FRAME_PROGRESS 0x06u
#define LED_FRAME_CONFIG 0x07u
#define LED_FRAME_PING 0x08u
#define LED_FRAME_CLEAR 0x09u
#define LED_FRAME_PIXELS 0x0Au
#define LED_FRAME_BYE 0x0Bu

/* 设备 → 主机 */
#define LED_REPLY_ACK 0x81u
#define LED_REPLY_NAK 0x82u
#define LED_REPLY_HELLO_ACK 0x83u
#define LED_REPLY_PONG 0x84u
#define LED_REPLY_EVENT 0x85u

/* 语义状态（与 led-protocol.ts 的 LED_STATE_CODE 一一对应） */
#define LED_STATE_OFF 0x00u
#define LED_STATE_RUNNING 0x01u
#define LED_STATE_WAITING 0x02u
#define LED_STATE_DONE 0x03u
#define LED_STATE_ERROR 0x04u

/* SCENE.flags 位 */
#define LED_FLAG_ATTENTION 0x01u
#define LED_FLAG_MUTED 0x02u
#define LED_FLAG_NIGHT 0x04u
#define LED_FLAG_TRANSIENT 0x08u

/* 效果词表 */
#define LED_EFFECT_SOLID 0x00u
#define LED_EFFECT_BREATHE 0x01u
#define LED_EFFECT_BLINK 0x02u
#define LED_EFFECT_FLOW 0x03u
#define LED_EFFECT_FLOW_BACK 0x04u
#define LED_EFFECT_FLOW_BOTH 0x05u
#define LED_EFFECT_CHASE 0x06u
#define LED_EFFECT_RAINBOW 0x07u
#define LED_EFFECT_SPARKLE 0x08u
#define LED_EFFECT_WIPE 0x09u
#define LED_EFFECT_PROGRESS 0x0Au
#define LED_EFFECT_DOUBLE_FLASH 0x0Bu

/* CONFIG 键 */
#define LED_CFG_LED_COUNT 1u
#define LED_CFG_MAX_BRIGHTNESS 2u
#define LED_CFG_GAMMA 3u
#define LED_CFG_LINK_TIMEOUT 4u
#define LED_CFG_REVERSE 5u
#define LED_CFG_DEFAULT_BRIGHT 6u

/* 亮度 0xFF = 用设备端默认亮度；进度 0xFF = 无进度 */
#define LED_BRIGHT_DEFAULT 0xFFu
#define LED_PROGRESS_NONE 0xFFu

/* 解析器产生的事件类型 */
typedef enum {
  LED_EV_NONE = 0,
  LED_EV_FRAME = 1,
  LED_EV_LINE = 2
} led_ev_t;

typedef struct {
  uint8_t type;
  uint8_t seq;
  uint8_t len;
  uint8_t payload[LED_MAX_PAYLOAD];
} led_frame_t;

typedef struct {
  uint8_t state;   /* 状态机：0=找 SOF0 1=找 SOF1 2=TYPE 3=SEQ 4=LEN 5=载荷 6=CRC */
  uint8_t type;
  uint8_t seq;
  uint8_t len;
  uint8_t got;
  uint8_t payload[LED_MAX_PAYLOAD];
  char line[LED_ASCII_MAX];
  uint8_t line_len;
  /* 诊断计数：链路不对劲时先看它们（见 /dnotify/led 与固件回包） */
  uint32_t frames;
  uint32_t crc_errors;
  uint32_t dropped;
  uint32_t lines;
} led_parser_t;

void led_parser_init(led_parser_t *p);

/*
 * 喂一个字节。
 * @return LED_EV_FRAME（*out 有效）/ LED_EV_LINE（led_parser_line() 有效）/ LED_EV_NONE
 */
led_ev_t led_parser_push(led_parser_t *p, uint8_t byte, led_frame_t *out);

/* 最近一次 LED_EV_LINE 的整行文本（以 '\0' 结尾）。 */
const char *led_parser_line(const led_parser_t *p);

/* CRC8 (poly 0x07, init 0x00) */
uint8_t led_crc8(const uint8_t *data, size_t len);

/* ---- ASCII 兜底命令 ---- */
typedef struct {
  char cmd;          /* 'S' 'B' 'P' 'A' 'E' 'C' '?' */
  uint8_t has_state; /* cmd=='S' 时有效 */
  uint8_t state;     /* LED_STATE_* */
  uint8_t argc;
  int32_t args[LED_ASCII_ARGS];
} led_ascii_cmd_t;

/* @return 1 = 解析成功，0 = 不认识（固件回一行 "# unknown"） */
int led_ascii_parse(const char *line, led_ascii_cmd_t *out);

/* 组一帧到 buf（buf 至少 LED_MAX_FRAME），返回整帧长度。 */
uint8_t led_build_frame(uint8_t *buf, uint8_t type, uint8_t seq, const uint8_t *payload, uint8_t len);

/* 颜色：RGB888 → RGB332（线上 1 字节 256 色） */
uint8_t led_rgb_to_332(uint8_t r, uint8_t g, uint8_t b);
void led_332_to_rgb(uint8_t v, uint8_t *r, uint8_t *g, uint8_t *b);

#endif /* LED_PROTOCOL_H */
