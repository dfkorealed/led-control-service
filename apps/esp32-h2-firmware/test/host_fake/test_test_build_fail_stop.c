#include <assert.h>
#include <setjmp.h>
#include <stdbool.h>
#include <string.h>

#include "ble_mesh_node.h"
#include "ble_mesh_platform.h"
#include "control_state.h"
#include "factory_reset.h"
#include "identify.h"
#include "led_driver.h"
#include "nvs_flash.h"
#include "persistent_state.h"
#include "esp_system.h"
#include "vehicle_sensor_driver.h"

static jmp_buf abort_target;
static bool aborted;
static unsigned int side_effect_count;

void app_main(void);

_Noreturn void esp_system_abort(const char *details) {
  assert(strstr(details, "TEST BUILD") != NULL);
  assert(side_effect_count == 0);
  aborted = true;
  longjmp(abort_target, 1);
}

esp_err_t nvs_flash_init(void) {
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t nvs_flash_erase(void) {
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t led_driver_init(void) {
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t led_driver_set_brightness(uint8_t brightness_percent) {
  (void)brightness_percent;
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t persistent_state_init(void) {
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t persistent_state_load(control_state_t *state, bool *found) {
  (void)state;
  *found = false;
  side_effect_count += 1;
  return ESP_OK;
}

void control_state_apply_brightness(control_state_t *state, int brightness_percent) {
  (void)state;
  (void)brightness_percent;
  side_effect_count += 1;
}

control_state_t control_state_create(void) {
  const control_state_t state = {0};
  side_effect_count += 1;
  return state;
}

esp_err_t identify_init(void) {
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t ble_mesh_platform_bluetooth_init(void) {
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t ble_mesh_node_init(void) {
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t vehicle_sensor_driver_start(vehicle_sensor_event_handler_t handler, void *context) {
  (void)handler;
  (void)context;
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t vehicle_sensor_driver_stop(void) {
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t esp_register_shutdown_handler(void (*handler)(void)) {
  (void)handler;
  side_effect_count += 1;
  return ESP_OK;
}

esp_err_t factory_reset_init(void) {
  side_effect_count += 1;
  return ESP_OK;
}

esp_reset_reason_t esp_reset_reason(void) {
  side_effect_count += 1;
  return 0;
}

int main(void) {
  if (setjmp(abort_target) == 0) {
    app_main();
    assert(false);
  }
  assert(aborted);
  assert(side_effect_count == 0);
  return 0;
}
