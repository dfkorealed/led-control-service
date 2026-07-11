#include "identify.h"

#include <stdbool.h>

#include "esp_timer.h"
#include "led_driver.h"

#define IDENTIFY_INTERVAL_US (250 * 1000)

static esp_timer_handle_t identify_timer;
static uint8_t original_brightness;
static bool high_phase;

static void identify_tick(void *argument) {
  (void)argument;
  high_phase = !high_phase;
  led_driver_set_brightness(high_phase ? 100 : 5);
}

esp_err_t identify_init(void) {
  const esp_timer_create_args_t args = {
      .callback = identify_tick,
      .name = "identify",
  };
  return esp_timer_create(&args, &identify_timer);
}

esp_err_t identify_start(uint8_t seconds, uint8_t restore_brightness) {
  (void)seconds;
  original_brightness = restore_brightness;
  high_phase = false;
  esp_timer_stop(identify_timer);
  return esp_timer_start_periodic(identify_timer, IDENTIFY_INTERVAL_US);
}

esp_err_t identify_stop(void) {
  esp_err_t error = esp_timer_stop(identify_timer);
  if (error != ESP_OK && error != ESP_ERR_INVALID_STATE) {
    return error;
  }
  return led_driver_set_brightness(original_brightness);
}
