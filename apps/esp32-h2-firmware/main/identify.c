#include "identify.h"

#include <stddef.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "led_driver.h"

#define IDENTIFY_INTERVAL_US (50 * 1000)

static esp_timer_handle_t identify_timer;

static void identify_tick(void *argument) {
  (void)argument;
  ESP_ERROR_CHECK_WITHOUT_ABORT(led_driver_refresh());
}

esp_err_t identify_init(void) {
  if (identify_timer != NULL) {
    return ESP_OK;
  }
  const esp_timer_create_args_t args = {
      .callback = identify_tick,
      .dispatch_method = ESP_TIMER_TASK,
      .name = "identify",
      .skip_unhandled_events = true,
  };
  esp_err_t error = esp_timer_create(&args, &identify_timer);
  if (error != ESP_OK) {
    return error;
  }
  /* One boot-lifetime sampler, not a timer per request. A queued callback only
   * evaluates the current driver state; it cannot stop a newer timer/session.
   * Idle refreshes do not rewrite PWM, but can retry a failed final restore. */
  error = esp_timer_start_periodic(identify_timer, IDENTIFY_INTERVAL_US);
  if (error != ESP_OK) {
    esp_timer_delete(identify_timer);
    identify_timer = NULL;
  }
  return error;
}

esp_err_t identify_start(uint8_t seconds) {
  if (identify_timer == NULL) {
    return ESP_ERR_INVALID_STATE;
  }
  return led_driver_set_attention(seconds);
}

esp_err_t identify_stop(void) {
  return led_driver_set_attention(0);
}
