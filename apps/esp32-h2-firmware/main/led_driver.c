#include "led_driver.h"

#include "driver/ledc.h"

#define LED_CONTROL_PWM_GPIO CONFIG_LED_CONTROL_PWM_GPIO
#define LED_CONTROL_PWM_TIMER LEDC_TIMER_0
#define LED_CONTROL_PWM_CHANNEL LEDC_CHANNEL_0
#define LED_CONTROL_PWM_MODE LEDC_LOW_SPEED_MODE
#define LED_CONTROL_PWM_FREQ_HZ 5000
#define LED_CONTROL_PWM_RESOLUTION LEDC_TIMER_10_BIT
#define LED_CONTROL_PWM_MAX_DUTY 1023

esp_err_t led_driver_init(void) {
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
  return ledc_channel_config(&channel_config);
}

esp_err_t led_driver_set_brightness(uint8_t brightness_percent) {
  if (brightness_percent > 100) {
    brightness_percent = 100;
  }

  /* Mesh/control의 0~100%를 LEDC 10-bit duty(0~1023)로 바꾼다. 이 변환을 driver 경계에
   * 고정해 호출자가 하드웨어 분해능을 가정하거나 100%를 최대 duty보다 작게 만드는 실수를 막는다. */
  uint32_t duty = ((uint32_t)brightness_percent * LED_CONTROL_PWM_MAX_DUTY) / 100;
  esp_err_t error = ledc_set_duty(LED_CONTROL_PWM_MODE, LED_CONTROL_PWM_CHANNEL, duty);
  if (error != ESP_OK) {
    return error;
  }
  return ledc_update_duty(LED_CONTROL_PWM_MODE, LED_CONTROL_PWM_CHANNEL);
}
