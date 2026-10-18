/*
 * stub/Adafruit_NeoPixel.h — Adafruit_NeoPixel 的最小桩（PC 侧编译草图用）
 *
 * 只实现草图用到的那几个成员，并把 setPixelColor/show 的结果记进全局缓冲，
 * 供 sketch_check.cpp 断言"灯真的变了"。
 */
#ifndef ADAFRUIT_NEOPIXEL_STUB_H
#define ADAFRUIT_NEOPIXEL_STUB_H

#include <stdint.h>
#include <stddef.h>
#include "Arduino.h"

#define NEO_GRB 0x52
#define NEO_RGB 0x06
#define NEO_KHZ800 0x0000
#define NEO_KHZ400 0x0100

#define STUB_NEOPIXEL_MAX 256
extern uint8_t g_stripR[STUB_NEOPIXEL_MAX];
extern uint8_t g_stripG[STUB_NEOPIXEL_MAX];
extern uint8_t g_stripB[STUB_NEOPIXEL_MAX];
extern uint16_t g_stripCount;
extern uint32_t g_stripShows;

class Adafruit_NeoPixel {
 public:
  Adafruit_NeoPixel(uint16_t count, uint8_t pin, uint8_t type) {
    (void)pin;
    (void)type;
    count_ = (count > STUB_NEOPIXEL_MAX) ? STUB_NEOPIXEL_MAX : count;
    g_stripCount = count_;
  }
  void begin(void) {}
  void show(void) { g_stripShows++; }
  void setBrightness(uint8_t value) { (void)value; }
  void setPixelColor(uint16_t index, uint8_t r, uint8_t g, uint8_t b) {
    if (index >= count_) return;
    g_stripR[index] = r;
    g_stripG[index] = g;
    g_stripB[index] = b;
  }

 private:
  uint16_t count_;
};

#endif /* ADAFRUIT_NEOPIXEL_STUB_H */
