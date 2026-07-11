#include "control_state.h"

control_state_t control_state_create(void) {
  control_state_t state = {
      .brightness_percent = 0,
      .previous_brightness_percent = 0,
      .power_on = false,
      .last_command_sequence = 0,
  };
  return state;
}

void control_state_apply_brightness(control_state_t *state, int brightness_percent) {
  if (brightness_percent < 0) {
    brightness_percent = 0;
  }
  if (brightness_percent > 100) {
    brightness_percent = 100;
  }

  state->brightness_percent = (uint8_t)brightness_percent;
  if (brightness_percent > 0) {
    state->previous_brightness_percent = (uint8_t)brightness_percent;
  }
  state->power_on = brightness_percent > 0;
}

bool command_sequence_accept(control_state_t *state, uint32_t sequence) {
  if (sequence <= state->last_command_sequence) {
    return false;
  }
  state->last_command_sequence = sequence;
  return true;
}
