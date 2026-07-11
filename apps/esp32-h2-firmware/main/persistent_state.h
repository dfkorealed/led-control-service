#pragma once

#include "control_state.h"
#include "esp_err.h"

esp_err_t persistent_state_init(void);
esp_err_t persistent_state_load(control_state_t *state, bool *found);
esp_err_t persistent_state_schedule_save(const control_state_t *state);
esp_err_t persistent_state_erase(void);
