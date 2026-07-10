#include "control_state.h"

control_state_t control_state_create(void) {
  control_state_t state = {
      .brightness_percent = 0,
      .power_on = false,
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
  state->power_on = brightness_percent > 0;
}
