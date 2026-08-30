#include "ble_mesh_node.h"
#include "ble_mesh_platform.h"
#include "control_state.h"
#include "factory_reset.h"
#include "identify.h"
#include "led_driver.h"
#include "persistent_state.h"

#include <stdbool.h>
#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"

#if defined(CONFIG_LED_CONTROL_TEST_BUILD)
static volatile bool test_build_must_fail_stop = true;
#endif

static const char *TAG = "led_control_node";

static void stop_vehicle_sensor_on_shutdown(void) {
  (void)ble_mesh_node_shutdown();
}

void app_main(void) {
#if defined(CONFIG_LED_CONTROL_TEST_BUILD)
  if (test_build_must_fail_stop) {
    esp_system_abort("TEST BUILD: reserved Company ID fixture; RF, sensor, NVS, HIL and production use are prohibited");
  }
#endif

  esp_err_t error = nvs_flash_init();
  if (error == ESP_ERR_NVS_NO_FREE_PAGES || error == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    error = nvs_flash_init();
  }
  ESP_ERROR_CHECK(error);

  ESP_ERROR_CHECK(led_driver_init());
  ESP_ERROR_CHECK(persistent_state_init());
  ESP_ERROR_CHECK(identify_init());

  control_state_t state = control_state_create();
  bool restored = false;
  ESP_ERROR_CHECK(persistent_state_load(&state, &restored));
  if (!restored) {
    control_state_apply_brightness(&state, 30);
  }
  ESP_ERROR_CHECK(led_driver_set_brightness(state.brightness_percent));

  ESP_ERROR_CHECK(ble_mesh_platform_bluetooth_init());
  ESP_ERROR_CHECK(ble_mesh_node_init());
  ESP_ERROR_CHECK(esp_register_shutdown_handler(stop_vehicle_sensor_on_shutdown));
  ESP_ERROR_CHECK(factory_reset_init());

  ESP_LOGI(TAG, "ESP32-H2 LED node started, brightness=%u%% power_on=%s restored=%s reset_reason=%d",
           state.brightness_percent,
           state.power_on ? "true" : "false",
           restored ? "true" : "false",
           esp_reset_reason());
}
