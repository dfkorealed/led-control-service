#pragma once

#include <stdint.h>

#include "control_state.h"

uint16_t mesh_state_percent_to_lightness(int brightness_percent);
uint8_t mesh_state_lightness_to_percent(uint16_t lightness);
void mesh_state_apply_lightness(control_state_t *state, uint16_t lightness);
void mesh_state_apply_onoff(control_state_t *state, uint8_t onoff);
