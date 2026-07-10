#include "ble_mesh_node.h"
#include "ble_mesh_platform.h"
#include "control_state.h"
#include "led_driver.h"

#include "esp_log.h"
#include "nvs_flash.h"

static const char *TAG = "led_control_node";

void app_main(void) {
  esp_err_t error = nvs_flash_init();
  if (error == ESP_ERR_NVS_NO_FREE_PAGES || error == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    error = nvs_flash_init();
  }
  ESP_ERROR_CHECK(error);

  ESP_ERROR_CHECK(led_driver_init());

  control_state_t state = control_state_create();
  control_state_apply_brightness(&state, 30);
  ESP_ERROR_CHECK(led_driver_set_brightness(state.brightness_percent));

  ESP_ERROR_CHECK(ble_mesh_platform_bluetooth_init());
  ESP_ERROR_CHECK(ble_mesh_node_init());

  ESP_LOGI(TAG, "ESP32-H2 LED node started, brightness=%u%% power_on=%s", state.brightness_percent, state.power_on ? "true" : "false");
}
