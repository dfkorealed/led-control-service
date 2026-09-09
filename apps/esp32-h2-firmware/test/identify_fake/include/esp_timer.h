#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

typedef struct fake_timer *esp_timer_handle_t;
typedef enum { ESP_TIMER_TASK, ESP_TIMER_ISR } esp_timer_dispatch_t;
typedef struct {
  void (*callback)(void *);
  void *arg;
  esp_timer_dispatch_t dispatch_method;
  const char *name;
  bool skip_unhandled_events;
} esp_timer_create_args_t;

int64_t esp_timer_get_time(void);
esp_err_t esp_timer_create(const esp_timer_create_args_t *, esp_timer_handle_t *);
esp_err_t esp_timer_start_periodic(esp_timer_handle_t, uint64_t);
esp_err_t esp_timer_stop(esp_timer_handle_t);
esp_err_t esp_timer_delete(esp_timer_handle_t);
