#include "ble_mesh_node.h"
#include "ble_mesh_platform.h"
#include "control_state.h"
#include "factory_reset.h"
#include "identify.h"
#include "led_driver.h"
#include "persistent_state.h"
#include "vehicle_sensor_driver.h"

#include <inttypes.h>
#include "esp_log.h"
#include "esp_system.h"
#include "nvs_flash.h"

static const char *TAG = "led_control_node";

static void handle_vehicle_sensor_event(const vehicle_sensor_event_t *event, void *context) {
  (void)context;
  ESP_LOGI(
      TAG,
      "Vehicle sensor %s level=%s monotonic_us=%" PRIu64,
      event->kind == VEHICLE_SENSOR_DETECTED ? "detected" : "cleared",
      event->level ? "high" : "low",
      event->monotonic_us);
}

void app_main(void) {
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
  ESP_ERROR_CHECK(vehicle_sensor_driver_start(handle_vehicle_sensor_event, NULL));
  ESP_ERROR_CHECK(esp_register_shutdown_handler(vehicle_sensor_driver_stop));
  ESP_ERROR_CHECK(factory_reset_init());

#if defined(CONFIG_LED_CONTROL_TEST_BUILD)
  ESP_LOGE(TAG, "TEST BUILD: reserved Company ID fixture; HIL and production flash are prohibited");
#endif

  ESP_LOGI(TAG, "ESP32-H2 LED node started, brightness=%u%% power_on=%s restored=%s reset_reason=%d",
           state.brightness_percent,
           state.power_on ? "true" : "false",
           restored ? "true" : "false",
           esp_reset_reason());
}
