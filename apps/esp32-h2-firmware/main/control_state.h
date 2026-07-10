#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
  uint8_t brightness_percent;
  bool power_on;
} control_state_t;

control_state_t control_state_create(void);
void control_state_apply_brightness(control_state_t *state, int brightness_percent);
