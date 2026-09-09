#include "led_driver.h"

#include <stddef.h>

#include "driver/ledc.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "led_output_state.h"

#define LED_CONTROL_PWM_GPIO CONFIG_LED_CONTROL_PWM_GPIO
#define LED_CONTROL_PWM_TIMER LEDC_TIMER_0
#define LED_CONTROL_PWM_CHANNEL LEDC_CHANNEL_0
#define LED_CONTROL_PWM_MODE LEDC_LOW_SPEED_MODE
#define LED_CONTROL_PWM_FREQ_HZ 5000
#define LED_CONTROL_PWM_RESOLUTION LEDC_TIMER_10_BIT
#define LED_CONTROL_PWM_MAX_DUTY 1023

static StaticSemaphore_t output_mutex_storage;
static SemaphoreHandle_t output_mutex;
static led_output_state_t output_state;
static uint8_t applied_percent;
static bool applied_valid;

esp_err_t led_driver_init(void) {
  if (output_mutex != NULL) {
    return ESP_OK;
  }
  ledc_timer_config_t timer_config = {
      .speed_mode = LED_CONTROL_PWM_MODE,
      .duty_resolution = LED_CONTROL_PWM_RESOLUTION,
      .timer_num = LED_CONTROL_PWM_TIMER,
      .freq_hz = LED_CONTROL_PWM_FREQ_HZ,
      .clk_cfg = LEDC_AUTO_CLK,
  };
  esp_err_t error = ledc_timer_config(&timer_config);
  if (error != ESP_OK) {
    return error;
  }

  ledc_channel_config_t channel_config = {
      .gpio_num = LED_CONTROL_PWM_GPIO,
      .speed_mode = LED_CONTROL_PWM_MODE,
      .channel = LED_CONTROL_PWM_CHANNEL,
      .intr_type = LEDC_INTR_DISABLE,
      .timer_sel = LED_CONTROL_PWM_TIMER,
      .duty = 0,
      .hpoint = 0,
  };
  error = ledc_channel_config(&channel_config);
  if (error != ESP_OK) {
    return error;
  }
  output_mutex = xSemaphoreCreateMutexStatic(&output_mutex_storage);
  if (output_mutex == NULL) {
    return ESP_ERR_NO_MEM;
  }
  applied_valid = true;
  return ESP_OK;
}

/* Caller holds output_mutex across state evaluation and BOTH LEDC operations.
 * No critical section/ISR context is used around potentially blocking SDK APIs. */
static esp_err_t apply_output_locked(int64_t now_us) {
  uint8_t brightness_percent = led_output_state_brightness(&output_state, now_us);
  if (applied_valid && applied_percent == brightness_percent) {
    return ESP_OK;
  }

  /* Mesh/control의 0~100%를 LEDC 10-bit duty(0~1023)로 바꾼다. 이 변환을 driver 경계에
   * 고정해 호출자가 하드웨어 분해능을 가정하거나 100%를 최대 duty보다 작게 만드는 실수를 막는다. */
  uint32_t duty = ((uint32_t)brightness_percent * LED_CONTROL_PWM_MAX_DUTY) / 100;
  /* A failed update may have changed hardware state. Retry the latest goal on
   * the next refresh, including after attention expires or is explicitly off. */
  applied_valid = false;
  esp_err_t error = ledc_set_duty(LED_CONTROL_PWM_MODE, LED_CONTROL_PWM_CHANNEL, duty);
  if (error != ESP_OK) {
    return error;
  }
  error = ledc_update_duty(LED_CONTROL_PWM_MODE, LED_CONTROL_PWM_CHANNEL);
  if (error == ESP_OK) {
    applied_percent = brightness_percent;
    applied_valid = true;
  }
  return error;
}

esp_err_t led_driver_set_brightness(uint8_t brightness_percent) {
  if (output_mutex == NULL) {
    return ESP_ERR_INVALID_STATE;
  }
  xSemaphoreTake(output_mutex, portMAX_DELAY);
  led_output_state_set_target(&output_state, brightness_percent);
  esp_err_t error = apply_output_locked(esp_timer_get_time());
  xSemaphoreGive(output_mutex);
  return error;
}

esp_err_t led_driver_set_attention(uint8_t seconds) {
  if (output_mutex == NULL) {
    return ESP_ERR_INVALID_STATE;
  }
  xSemaphoreTake(output_mutex, portMAX_DELAY);
  int64_t now_us = esp_timer_get_time();
  led_output_state_set_attention(&output_state, seconds, now_us);
  esp_err_t error = apply_output_locked(now_us);
  xSemaphoreGive(output_mutex);
  return error;
}

esp_err_t led_driver_refresh(void) {
  if (output_mutex == NULL) {
    return ESP_ERR_INVALID_STATE;
  }
  xSemaphoreTake(output_mutex, portMAX_DELAY);
  /* Sampling time inside the lock prevents a queued old tick from evaluating
   * a restarted session with a timestamp taken before that session began. */
  esp_err_t error = apply_output_locked(esp_timer_get_time());
  xSemaphoreGive(output_mutex);
  return error;
}
