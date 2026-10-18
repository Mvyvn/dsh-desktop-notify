/* led_protocol.c — 见 led_protocol.h 的说明 */
#include "led_protocol.h"

void led_parser_init(led_parser_t *p) {
  if (p == 0) return;
  p->state = 0u;
  p->type = 0u;
  p->seq = 0u;
  p->len = 0u;
  p->got = 0u;
  p->line_len = 0u;
  p->frames = 0u;
  p->crc_errors = 0u;
  p->dropped = 0u;
  p->lines = 0u;
}

static uint8_t led_type_known(uint8_t type) {
  switch (type) {
    case LED_FRAME_HELLO:
    case LED_FRAME_SCENE:
    case LED_FRAME_EFFECT:
    case LED_FRAME_BRIGHT:
    case LED_FRAME_OVERLAY:
    case LED_FRAME_PROGRESS:
    case LED_FRAME_CONFIG:
    case LED_FRAME_PING:
    case LED_FRAME_CLEAR:
    case LED_FRAME_PIXELS:
    case LED_FRAME_BYE:
    case LED_REPLY_ACK:
    case LED_REPLY_NAK:
    case LED_REPLY_HELLO_ACK:
    case LED_REPLY_PONG:
    case LED_REPLY_EVENT:
      return 1u;
    default:
      return 0u;
  }
}

static uint8_t led_is_printable(uint8_t byte) {
  return (byte >= 0x20u && byte <= 0x7Eu) ? 1u : 0u;
}

led_ev_t led_parser_push(led_parser_t *p, uint8_t byte, led_frame_t *out) {
  if (p == 0) return LED_EV_NONE;
  switch (p->state) {
    case 0u:
      if (byte == LED_SOF0) {
        p->state = 1u;
        return LED_EV_NONE;
      }
      /* ASCII 兜底：非魔数字节按行收集（0xA5 不可打印，两条路径不会打架） */
      if (byte == (uint8_t)'\n' || byte == (uint8_t)'\r') {
        if (p->line_len == 0u) return LED_EV_NONE;
        p->line[p->line_len] = '\0';
        p->line_len = 0u;
        p->lines++;
        return LED_EV_LINE;
      }
      if (led_is_printable(byte)) {
        if (p->line_len + 1u < LED_ASCII_MAX) {
          p->line[p->line_len] = (char)byte;
          p->line_len++;
        } else {
          p->line_len = 0u;   /* 行太长：丢掉这一行，不要写越界 */
        }
      }
      return LED_EV_NONE;

    case 1u:
      if (byte == LED_SOF1) { p->state = 2u; return LED_EV_NONE; }
      /* 可能是 `A5 A5 5A`：把当前字节当新的 SOF0 再看一眼 */
      p->state = (byte == LED_SOF0) ? 1u : 0u;
      return LED_EV_NONE;

    case 2u:
      if (!led_type_known(byte)) {   /* 类型不认识：重同步，不猜 */
        p->dropped++;
        p->state = (byte == LED_SOF0) ? 1u : 0u;
        return LED_EV_NONE;
      }
      p->type = byte;
      p->state = 3u;
      return LED_EV_NONE;

    case 3u:
      p->seq = byte;
      p->state = 4u;
      return LED_EV_NONE;

    case 4u:
      if (byte > LED_MAX_PAYLOAD) {   /* 长度不合法：重同步 */
        p->dropped++;
        p->state = (byte == LED_SOF0) ? 1u : 0u;
        return LED_EV_NONE;
      }
      p->len = byte;
      p->got = 0u;
      p->state = (byte == 0u) ? 6u : 5u;
      return LED_EV_NONE;

    case 5u:
      p->payload[p->got] = byte;
      p->got++;
      if (p->got >= p->len) p->state = 6u;
      return LED_EV_NONE;

    case 6u: {
      uint8_t body[3u + LED_MAX_PAYLOAD];
      uint8_t i;
      uint8_t expect = byte;
      body[0] = p->type;
      body[1] = p->seq;
      body[2] = p->len;
      for (i = 0u; i < p->len; i++) body[3u + i] = p->payload[i];
      if (led_crc8(body, (size_t)(3u + p->len)) != expect) {
        p->crc_errors++;
        p->state = (byte == LED_SOF0) ? 1u : 0u;
        return LED_EV_NONE;
      }
      if (out != 0) {
        out->type = p->type;
        out->seq = p->seq;
        out->len = p->len;
        for (i = 0u; i < p->len; i++) out->payload[i] = p->payload[i];
      }
      p->frames++;
      p->state = 0u;
      return LED_EV_FRAME;
    }

    default:
      p->state = 0u;
      return LED_EV_NONE;
  }
}

const char *led_parser_line(const led_parser_t *p) {
  return (p == 0) ? "" : p->line;
}

uint8_t led_crc8(const uint8_t *data, size_t len) {
  uint8_t crc = 0u;
  size_t i;
  uint8_t bit;
  for (i = 0u; i < len; i++) {
    crc ^= data[i];
    for (bit = 0u; bit < 8u; bit++) {
      crc = (uint8_t)((crc & 0x80u) ? ((crc << 1) ^ 0x07u) : (crc << 1));
    }
  }
  return crc;
}

static int32_t led_atoi(const char *s, uint8_t *ok) {
  int32_t value = 0;
  uint8_t neg = 0u;
  uint8_t digits = 0u;
  if (*s == '-') { neg = 1u; s++; }
  while (*s >= '0' && *s <= '9') {
    value = value * 10 + (int32_t)(*s - '0');
    digits++;
    s++;
    if (digits > 7u) break;
  }
  *ok = (digits > 0u) ? 1u : 0u;
  return neg ? -value : value;
}

static uint8_t led_state_from_name(const char *s, uint8_t *out) {
  /* 只认大写三字母缩写；大小写不敏感 */
  char a = s[0];
  char b = s[1];
  char c = s[2];
  if (a >= 'a' && a <= 'z') a = (char)(a - 32);
  if (b >= 'a' && b <= 'z') b = (char)(b - 32);
  if (c >= 'a' && c <= 'z') c = (char)(c - 32);
  if (a == 'O' && b == 'F' && c == 'F') { *out = LED_STATE_OFF; return 1u; }
  if (a == 'R' && b == 'U' && c == 'N') { *out = LED_STATE_RUNNING; return 1u; }
  if (a == 'W' && b == 'A' && c == 'I') { *out = LED_STATE_WAITING; return 1u; }
  if (a == 'D' && b == 'O' && c == 'N') { *out = LED_STATE_DONE; return 1u; }
  if (a == 'E' && b == 'R' && c == 'R') { *out = LED_STATE_ERROR; return 1u; }
  return 0u;
}

int led_ascii_parse(const char *line, led_ascii_cmd_t *out) {
  const char *s = line;
  char cmd;
  if (line == 0 || out == 0) return 0;
  while (*s == ' ' || *s == '\t') s++;
  if (*s == '\0' || *s == '#') return 0;
  cmd = *s;
  if (cmd >= 'a' && cmd <= 'z') cmd = (char)(cmd - 32);
  s++;
  out->cmd = cmd;
  out->argc = 0u;
  out->has_state = 0u;
  if (cmd == '?') return 1;
  if (*s == ':' || *s == '=') s++;
  if (cmd == 'S') {
    uint8_t state = 0u;
    if (!led_state_from_name(s, &state)) return 0;
    out->has_state = 1u;
    out->state = state;
    return 1;
  }
  while (*s != '\0') {
    uint8_t ok = 0u;
    int32_t value;
    if (*s == ',') { s++; continue; }
    value = led_atoi(s, &ok);
    if (!ok) return 0;
    if (out->argc < LED_ASCII_ARGS) {
      out->args[out->argc] = value;
      out->argc++;
    }
    while (*s == '-' || (*s >= '0' && *s <= '9')) s++;
  }
  if (cmd == 'B' || cmd == 'P' || cmd == 'A' || cmd == 'E' || cmd == 'C') return 1;
  return 0;
}

uint8_t led_build_frame(uint8_t *buf, uint8_t type, uint8_t seq, const uint8_t *payload, uint8_t len) {
  uint8_t body[3u + LED_MAX_PAYLOAD];
  uint8_t i;
  if (buf == 0 || len > LED_MAX_PAYLOAD) return 0u;
  buf[0] = LED_SOF0;
  buf[1] = LED_SOF1;
  buf[2] = type;
  buf[3] = seq;
  buf[4] = len;
  body[0] = type;
  body[1] = seq;
  body[2] = len;
  for (i = 0u; i < len; i++) {
    buf[5u + i] = (payload == 0) ? 0u : payload[i];
    body[3u + i] = buf[5u + i];
  }
  buf[5u + len] = led_crc8(body, (size_t)(3u + len));
  return (uint8_t)(6u + len);
}

uint8_t led_rgb_to_332(uint8_t r, uint8_t g, uint8_t b) {
  return (uint8_t)(((r >> 5) << 5) | ((g >> 5) << 2) | (b >> 6));
}

void led_332_to_rgb(uint8_t v, uint8_t *r, uint8_t *g, uint8_t *b) {
  /* 位扩展：与主机侧 rgb332ToRgb 用同一套系数（7*36=252 / 3*85=255） */
  if (r != 0) *r = (uint8_t)(((v >> 5) & 0x07u) * 36u);
  if (g != 0) *g = (uint8_t)(((v >> 2) & 0x07u) * 36u);
  if (b != 0) *b = (uint8_t)((v & 0x03u) * 85u);
}
