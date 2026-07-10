#include "mesh_state.h"

uint16_t mesh_state_percent_to_lightness(int brightness_percent) {
  if (brightness_percent < 0) {
    brightness_percent = 0;
  }
  if (brightness_percent > 100) {
    brightness_percent = 100;
  }

  return (uint16_t)(((uint32_t)brightness_percent * 65535U + 50U) / 100U);
}

uint8_t mesh_state_lightness_to_percent(uint16_t lightness) {
  return (uint8_t)(((uint32_t)lightness * 100U + 32767U) / 65535U);
}

void mesh_state_apply_lightness(control_state_t *state, uint16_t lightness) {
  control_state_apply_brightness(state, mesh_state_lightness_to_percent(lightness));
}

void mesh_state_apply_onoff(control_state_t *state, uint8_t onoff) {
  control_state_apply_brightness(state, onoff ? 100 : 0);
}
