/*
 * stub/Arduino.h — 只够让 led_ticker.ino 在 PC 上编译并跑起来的 Arduino 最小桩
 *
 * 目的：草图（.ino）本来是最容易"写完没人验证"的一层 —— 没有板子、也没有
 * arduino-cli 的时候就只能靠肉眼。这个桩把 Arduino 用到的那几个 API 落成可执行实现，
 * 于是 firmware/host/sketch_check.cpp 可以真的调用 setup()/loop()，
 * 喂一串真实的 SCENE 帧，再检查像素变成什么样。
 *
 * 桩只覆盖本草图**实际用到**的 API；不做通用兼容层。
 */
#ifndef ARDUINO_STUB_H
#define ARDUINO_STUB_H

#include <stdint.h>
#include <stddef.h>
#include <string.h>

#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define F(x) x

/* ---- 假时钟：测试可以手动推进 ---- */
extern uint32_t g_fakeMillis;
static inline uint32_t millis(void) { return g_fakeMillis; }
static inline void delay(uint32_t ms) { g_fakeMillis += ms; }

/* ---- 假串口：输入环形缓冲 + 输出记录 ---- */
#define STUB_SERIAL_IN 512
#define STUB_SERIAL_OUT 512
extern uint8_t g_serialIn[STUB_SERIAL_IN];
extern size_t g_serialInLen;
extern size_t g_serialInPos;
extern uint8_t g_serialOut[STUB_SERIAL_OUT];
extern size_t g_serialOutLen;

static inline void stubSerialFeed(const uint8_t *data, size_t len) {
  size_t i;
  for (i = 0; i < len && g_serialInLen < STUB_SERIAL_IN; i++) g_serialIn[g_serialInLen++] = data[i];
}
static inline void stubSerialReset(void) {
  g_serialInLen = 0;
  g_serialInPos = 0;
  g_serialOutLen = 0;
}

class StubSerial {
 public:
  void begin(uint32_t) {}
  int available(void) { return (int)(g_serialInLen - g_serialInPos); }
  int read(void) { return (g_serialInPos < g_serialInLen) ? (int)g_serialIn[g_serialInPos++] : -1; }
  size_t write(uint8_t byte) {
    if (g_serialOutLen < STUB_SERIAL_OUT) g_serialOut[g_serialOutLen++] = byte;
    return 1u;
  }
  size_t write(const uint8_t *data, size_t len) {
    size_t i;
    for (i = 0; i < len; i++) (void)write(data[i]);
    return len;
  }
  size_t print(const char *text) {
    size_t i = 0;
    while (text[i] != '\0') { (void)write((uint8_t)text[i]); i++; }
    return i;
  }
  size_t print(unsigned long value) {
    char buf[16];
    int n = 0;
    if (value == 0ul) { (void)write((uint8_t)'0'); return 1u; }
    while (value > 0ul && n < 15) { buf[n++] = (char)('0' + (value % 10ul)); value /= 10ul; }
    while (n > 0) (void)write((uint8_t)buf[--n]);
    return 1u;
  }
  size_t print(int value) { return print((unsigned long)(value < 0 ? 0 : value)); }
  /* 真实 Arduino 的 Print 也有 unsigned int / long 重载；少了它们，
   * `Serial.print(LED_COUNT)` 这类调用会在 int 与 unsigned long 之间二义。 */
  size_t print(unsigned int value) { return print((unsigned long)value); }
  size_t print(long value) { return print((unsigned long)(value < 0 ? 0 : value)); }
  size_t println(const char *text) { size_t n = print(text); n += write((uint8_t)'\n'); return n; }
  size_t println(unsigned long value) { size_t n = print(value); n += write((uint8_t)'\n'); return n; }
  size_t println(unsigned int value) { size_t n = print(value); n += write((uint8_t)'\n'); return n; }
  size_t println(int value) { size_t n = print(value); n += write((uint8_t)'\n'); return n; }
};

extern StubSerial Serial;

/* ---- GPIO ---- */
extern uint8_t g_pinDigital[64];
extern uint8_t g_pinAnalog[64];
static inline void pinMode(uint8_t pin, uint8_t mode) { (void)pin; (void)mode; }
static inline int digitalRead(uint8_t pin) { return (pin < 64u) ? (int)g_pinDigital[pin] : HIGH; }
static inline void digitalWrite(uint8_t pin, uint8_t value) { if (pin < 64u) g_pinDigital[pin] = value; }
static inline void analogWrite(uint8_t pin, int value) {
  if (pin < 64u) g_pinAnalog[pin] = (uint8_t)(value < 0 ? 0 : (value > 255 ? 255 : value));
}

#endif /* ARDUINO_STUB_H */
