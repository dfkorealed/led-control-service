#pragma once

#include <stdint.h>
#include "esp_err.h"

esp_err_t led_driver_init(void);
/* Initialize once at boot before Mesh/timer tasks. APIs below are task-only and
 * serialize target, attention lifetime, and the complete LEDC write together. */
esp_err_t led_driver_set_brightness(uint8_t brightness_percent);
esp_err_t led_driver_set_attention(uint8_t seconds);
esp_err_t led_driver_refresh(void);
