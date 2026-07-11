#include "factory_reset.h"

#include "esp_ble_mesh_networking_api.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "persistent_state.h"

#define FACTORY_RESET_GPIO ((gpio_num_t)CONFIG_LED_CONTROL_FACTORY_RESET_GPIO)
#define FACTORY_RESET_HOLD_MS CONFIG_LED_CONTROL_FACTORY_RESET_HOLD_MS
#define POLL_MS 100

static const char *TAG = "factory_reset";

static void factory_reset_task(void *argument) {
  (void)argument;
  uint32_t held_ms = 0;
  while (true) {
    if (gpio_get_level(FACTORY_RESET_GPIO) == 0) {
      held_ms += POLL_MS;
      if (held_ms >= FACTORY_RESET_HOLD_MS) {
        ESP_LOGW(TAG, "Physical factory reset confirmed");
        ESP_ERROR_CHECK_WITHOUT_ABORT(persistent_state_erase());
        ESP_ERROR_CHECK_WITHOUT_ABORT(esp_ble_mesh_node_local_reset());
        vTaskDelay(pdMS_TO_TICKS(500));
        esp_restart();
      }
    } else {
      held_ms = 0;
    }
    vTaskDelay(pdMS_TO_TICKS(POLL_MS));
  }
}

esp_err_t factory_reset_init(void) {
  const gpio_config_t config = {
      .pin_bit_mask = 1ULL << FACTORY_RESET_GPIO,
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
  };
  ESP_RETURN_ON_ERROR(gpio_config(&config), TAG, "configure factory reset input");
  return xTaskCreate(factory_reset_task, "factory_reset", 3072, NULL, 5, NULL) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
