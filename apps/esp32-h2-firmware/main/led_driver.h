#pragma once

#include <stdint.h>
#include "esp_err.h"

esp_err_t led_driver_init(void);
esp_err_t led_driver_set_brightness(uint8_t brightness_percent);
