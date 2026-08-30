#pragma once

#include <stdarg.h>

static inline void fake_esp_log(const char *tag, const char *format, ...) {
  (void)tag;
  (void)format;
}

#define ESP_LOGE(...) fake_esp_log(__VA_ARGS__)
#define ESP_LOGI(...) fake_esp_log(__VA_ARGS__)
