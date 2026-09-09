#pragma once
#include <stdint.h>
#include "esp_err.h"

enum {
  LEDC_TIMER_0, LEDC_CHANNEL_0, LEDC_LOW_SPEED_MODE, LEDC_TIMER_10_BIT,
  LEDC_AUTO_CLK, LEDC_INTR_DISABLE
};
typedef struct {
  int speed_mode, duty_resolution, timer_num, freq_hz, clk_cfg;
} ledc_timer_config_t;
typedef struct {
  int gpio_num, speed_mode, channel, intr_type, timer_sel, duty, hpoint;
} ledc_channel_config_t;

esp_err_t ledc_timer_config(const ledc_timer_config_t *);
esp_err_t ledc_channel_config(const ledc_channel_config_t *);
esp_err_t ledc_set_duty(int, int, uint32_t);
esp_err_t ledc_update_duty(int, int);
