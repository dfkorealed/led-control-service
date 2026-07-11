#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
  uint8_t brightness_percent;
  uint8_t previous_brightness_percent;
  bool power_on;
  uint32_t last_command_sequence;
} control_state_t;

control_state_t control_state_create(void);
void control_state_apply_brightness(control_state_t *state, int brightness_percent);
bool command_sequence_accept(control_state_t *state, uint32_t sequence);
