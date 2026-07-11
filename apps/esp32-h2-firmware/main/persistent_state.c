#include "persistent_state.h"

#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"

#define STATE_NAMESPACE "led_state"
#define STATE_KEY "control"
#define STATE_VERSION 1
#define SAVE_DEBOUNCE_US (2 * 1000 * 1000)

typedef struct {
  uint8_t version;
  control_state_t control;
} stored_state_t;

static const char *TAG = "persistent_state";
static nvs_handle_t state_handle;
static esp_timer_handle_t save_timer;
static stored_state_t pending_state;

static void commit_pending_state(void *argument) {
  (void)argument;
  esp_err_t error = nvs_set_blob(state_handle, STATE_KEY, &pending_state, sizeof(pending_state));
  if (error == ESP_OK) {
    error = nvs_commit(state_handle);
  }
  if (error != ESP_OK) {
    ESP_LOGE(TAG, "Failed to persist control state: %s", esp_err_to_name(error));
  }
}

esp_err_t persistent_state_init(void) {
  ESP_RETURN_ON_ERROR(nvs_open(STATE_NAMESPACE, NVS_READWRITE, &state_handle), TAG, "open NVS namespace");
  const esp_timer_create_args_t timer_args = {
      .callback = commit_pending_state,
      .name = "state_commit",
  };
  return esp_timer_create(&timer_args, &save_timer);
}

esp_err_t persistent_state_load(control_state_t *state, bool *found) {
  stored_state_t stored = {0};
  size_t size = sizeof(stored);
  esp_err_t error = nvs_get_blob(state_handle, STATE_KEY, &stored, &size);
  if (error == ESP_ERR_NVS_NOT_FOUND) {
    *found = false;
    return ESP_OK;
  }
  if (error != ESP_OK) {
    return error;
  }
  if (size != sizeof(stored) || stored.version != STATE_VERSION) {
    *found = false;
    return ESP_OK;
  }
  memcpy(state, &stored.control, sizeof(*state));
  *found = true;
  return ESP_OK;
}

esp_err_t persistent_state_schedule_save(const control_state_t *state) {
  pending_state.version = STATE_VERSION;
  memcpy(&pending_state.control, state, sizeof(*state));
  esp_timer_stop(save_timer);
  return esp_timer_start_once(save_timer, SAVE_DEBOUNCE_US);
}

esp_err_t persistent_state_erase(void) {
  esp_timer_stop(save_timer);
  ESP_RETURN_ON_ERROR(nvs_erase_all(state_handle), TAG, "erase app state");
  return nvs_commit(state_handle);
}
