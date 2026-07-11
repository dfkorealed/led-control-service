#pragma once

#include <stdint.h>

#include "esp_err.h"

esp_err_t identify_init(void);
esp_err_t identify_start(uint8_t seconds, uint8_t restore_brightness);
esp_err_t identify_stop(void);
