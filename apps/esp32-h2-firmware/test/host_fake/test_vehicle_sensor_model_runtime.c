#include "fake_esp_idf.h"
#include "vehicle_sensor_mesh_adapter.h"
#include "vehicle_sensor_runtime.h"

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
  uint32_t active;
  uint32_t history;
  uint32_t seen_active;
  uint32_t changes;
} fault_log_t;

typedef struct {
  uint32_t opcode;
  uint8_t payload[16];
  size_t size;
} response_log_t;

static bool mesh_provisioned;
static bool driver_available;
static bool driver_level;
static uint32_t driver_dropped;
static uint32_t random_value;
static esp_err_t sensor_publish_result;
static esp_err_t vendor_publish_result;
static size_t sensor_publish_count;
static size_t vendor_publish_count;
static response_log_t responses[64];
static size_t response_count;
static vehicle_sensor_mesh_adapter_t adapter;
static esp_ble_mesh_model_pub_t sensor_pub;
static esp_ble_mesh_model_pub_t vendor_pub;
static esp_ble_mesh_model_t sensor_model;
static esp_ble_mesh_model_t vendor_model;
static struct net_buf_simple sensor_raw;
static uint8_t sensor_raw_storage[1];
static fault_log_t fault_log;
static esp_err_t nested_stop_result;

bool vehicle_sensor_driver_get_current_level(bool *level) {
  if (!driver_available || level == NULL) {
    return false;
  }
  *level = driver_level;
  return true;
}

uint32_t vehicle_sensor_driver_dropped_edge_count(void) {
  return driver_dropped;
}

bool esp_ble_mesh_node_is_provisioned(void) {
  return mesh_provisioned;
}

uint16_t esp_ble_mesh_get_primary_element_address(void) {
  return 0x1201;
}

uint32_t esp_random(void) {
  return ++random_value;
}

esp_err_t esp_ble_mesh_server_model_send_msg(
    esp_ble_mesh_model_t *model,
    esp_ble_mesh_msg_ctx_t *context,
    uint32_t opcode,
    uint16_t length,
    uint8_t *data) {
  (void)model;
  (void)context;
  assert(response_count < sizeof(responses) / sizeof(responses[0]));
  responses[response_count].opcode = opcode;
  responses[response_count].size = length;
  memcpy(responses[response_count].payload, data, length);
  response_count += 1;
  return ESP_OK;
}

esp_err_t esp_ble_mesh_model_publish(
    esp_ble_mesh_model_t *model,
    uint32_t opcode,
    uint16_t length,
    uint8_t *data,
    int role) {
  (void)opcode;
  (void)length;
  (void)data;
  assert(role == ROLE_NODE);
  if (model == &sensor_model) {
    sensor_publish_count += 1;
    return sensor_publish_result;
  }
  assert(model == &vendor_model);
  vendor_publish_count += 1;
  return vendor_publish_result;
}

static void record_faults(uint32_t active, uint32_t history, void *context) {
  fault_log_t *log = context;
  log->active = active;
  log->history = history;
  log->seen_active |= active;
  log->changes += 1;
}

static void set_configured(bool configured) {
  mesh_provisioned = configured;
  sensor_model.keys[0] = configured ? 0 : ESP_BLE_MESH_KEY_UNUSED;
  vendor_model.keys[0] = configured ? 0 : ESP_BLE_MESH_KEY_UNUSED;
  sensor_pub.publish_addr = configured ? 0x0001 : ESP_BLE_MESH_ADDR_UNASSIGNED;
  vendor_pub.publish_addr = configured ? 0x0001 : ESP_BLE_MESH_ADDR_UNASSIGNED;
  sensor_pub.app_idx = configured ? 0 : ESP_BLE_MESH_KEY_UNUSED;
  vendor_pub.app_idx = configured ? 0 : ESP_BLE_MESH_KEY_UNUSED;
  sensor_pub.period = 0;
  vendor_pub.period = 0;
}

static void reset_fixture(bool configured, bool level) {
  fake_esp_idf_reset(level);
  mesh_provisioned = false;
  driver_available = true;
  driver_level = level;
  driver_dropped = 0;
  sensor_publish_result = ESP_OK;
  vendor_publish_result = ESP_OK;
  sensor_publish_count = 0;
  vendor_publish_count = 0;
  response_count = 0;
  memset(&fault_log, 0, sizeof(fault_log));
  memset(&sensor_pub, 0, sizeof(sensor_pub));
  memset(&vendor_pub, 0, sizeof(vendor_pub));
  memset(&sensor_model, 0, sizeof(sensor_model));
  memset(&vendor_model, 0, sizeof(vendor_model));
  sensor_model.pub = &sensor_pub;
  vendor_model.pub = &vendor_pub;
  for (size_t index = 0; index < CONFIG_BLE_MESH_MODEL_KEY_COUNT; index++) {
    sensor_model.keys[index] = ESP_BLE_MESH_KEY_UNUSED;
    vendor_model.keys[index] = ESP_BLE_MESH_KEY_UNUSED;
  }
  sensor_raw.data = sensor_raw_storage;
  sensor_raw.len = 0;
  sensor_raw.size = sizeof(sensor_raw_storage);
  set_configured(configured);
  vehicle_sensor_mesh_adapter_init(
      &adapter,
      &(vehicle_sensor_mesh_adapter_config_t){
          .sensor_model = &sensor_model,
          .vendor_model = &vendor_model,
          .sensor_raw_value = &sensor_raw,
          .vendor_event_opcode = 0xc1ffffU,
      });
  fake_esp_idf_preempt_task_create_once();
  assert(vehicle_sensor_model_runtime_start(
             &(vehicle_sensor_model_runtime_config_t){
                 .mesh_adapter = &adapter,
                 .fault_handler = record_faults,
                 .fault_context = &fault_log,
             }) == ESP_OK);
  assert(vehicle_sensor_model_runtime_activate() == ESP_OK);
  vehicle_sensor_model_runtime_test_process_once();
}

static void stop_fixture(void) {
  fake_esp_idf_run_task_on_next_delay();
  assert(vehicle_sensor_model_runtime_stop() == ESP_OK);
}

static void test_config_latch_converges_after_command_queue_saturation_and_reboot(void) {
  esp_ble_mesh_msg_ctx_t context = {.addr = 0x0001};
  reset_fixture(false, true);
  for (size_t index = 0; index < VEHICLE_SENSOR_COMMAND_QUEUE_LENGTH; index++) {
    assert(vehicle_sensor_model_runtime_request(
        &context, VEHICLE_SENSOR_REQUEST_GET, true, 0x1234));
  }
  assert(vehicle_sensor_model_runtime_test_queue_count() == VEHICLE_SENSOR_COMMAND_QUEUE_LENGTH);

  set_configured(true);
  vehicle_sensor_model_runtime_configuration_changed();
  vehicle_sensor_model_runtime_test_process_once();
  assert(vehicle_sensor_model_runtime_test_configuration_converged());
  assert(vehicle_sensor_model_runtime_test_sensor_ready());
  assert(vehicle_sensor_model_runtime_test_vendor_ready());
  assert(sensor_publish_count == 1);
  assert(response_count == VEHICLE_SENSOR_COMMAND_QUEUE_LENGTH);
  uint32_t first_boot = vehicle_sensor_model_runtime_test_boot_id();
  stop_fixture();

  assert(vehicle_sensor_model_runtime_start(
             &(vehicle_sensor_model_runtime_config_t){
                 .mesh_adapter = &adapter,
                 .fault_handler = record_faults,
                 .fault_context = &fault_log,
             }) == ESP_OK);
  assert(vehicle_sensor_model_runtime_activate() == ESP_OK);
  vehicle_sensor_model_runtime_test_process_once();
  assert(vehicle_sensor_model_runtime_test_sensor_ready());
  assert(vehicle_sensor_model_runtime_test_vendor_ready());
  assert(vehicle_sensor_model_runtime_test_boot_id() != first_boot);
  stop_fixture();
}

static void test_custom_publication_is_single_and_uses_authoritative_current(void) {
  reset_fixture(true, false);
  const uint64_t first_deadline = vehicle_sensor_model_runtime_test_next_publication_ms();
  assert(first_deadline == vehicle_sensor_publication_interval_ms(0x1201));

  driver_level = true;
  fake_esp_idf_set_time_us((int64_t)(first_deadline * 1000U) - 1);
  vehicle_sensor_model_runtime_test_process_once();
  assert(sensor_publish_count == 1);
  assert(sensor_raw.len == 1 && sensor_raw.data[0] == 1);
  vehicle_sensor_model_runtime_test_process_once();
  assert(sensor_publish_count == 1);

  const uint64_t second_deadline = vehicle_sensor_model_runtime_test_next_publication_ms();
  fake_esp_idf_set_time_us((int64_t)(second_deadline * 1000U) - 1);
  driver_level = false;
  vehicle_sensor_model_runtime_test_process_once();
  assert(sensor_publish_count == 2);
  assert(sensor_raw.data[0] == 0);
  stop_fixture();
}

static void test_sensor_requests_use_official_status_semantics_and_authoritative_current(void) {
  esp_ble_mesh_msg_ctx_t context = {.addr = 0x0001};
  reset_fixture(true, false);

  assert(vehicle_sensor_model_runtime_request(
      &context, VEHICLE_SENSOR_REQUEST_DESCRIPTOR, false, 0));
  vehicle_sensor_model_runtime_test_process_once();
  assert(response_count == 1);
  assert(responses[0].opcode == 0x51);
  assert(responses[0].size == 8);
  assert(memcmp(
             responses[0].payload,
             (uint8_t[]){0x4d, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00},
             8) == 0);

  assert(vehicle_sensor_model_runtime_request(
      &context, VEHICLE_SENSOR_REQUEST_GET, false, 0));
  driver_level = true;
  vehicle_sensor_model_runtime_test_process_once();
  assert(response_count == 2);
  assert(responses[1].opcode == 0x52);
  assert(memcmp(responses[1].payload, (uint8_t[]){0xa0, 0x09, 0x01}, 3) == 0);
  assert(sensor_raw.len == 1 && sensor_raw.data[0] == 1);

  driver_available = false;
  assert(vehicle_sensor_model_runtime_request(
      &context, VEHICLE_SENSOR_REQUEST_GET, true, 0x1234));
  vehicle_sensor_model_runtime_test_process_once();
  assert(response_count == 3);
  assert(responses[2].opcode == 0x52);
  assert(memcmp(responses[2].payload, (uint8_t[]){0xff, 0x34, 0x12}, 3) == 0);

  assert(vehicle_sensor_model_runtime_request(
      &context, VEHICLE_SENSOR_REQUEST_GET, false, 0));
  vehicle_sensor_model_runtime_test_process_once();
  assert(response_count == 3);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_DROPPED) != 0);

  driver_available = true;
  assert(vehicle_sensor_model_runtime_request(
      &context, VEHICLE_SENSOR_REQUEST_COLUMN, true, VEHICLE_SENSOR_PRESENCE_PROPERTY_ID));
  vehicle_sensor_model_runtime_test_process_once();
  assert(response_count == 4);
  assert(responses[3].opcode == 0x53);
  assert(memcmp(responses[3].payload, (uint8_t[]){0x4d, 0x00}, 2) == 0);

  assert(vehicle_sensor_model_runtime_request(
      &context, VEHICLE_SENSOR_REQUEST_SERIES, true, 0x1234));
  vehicle_sensor_model_runtime_test_process_once();
  assert(response_count == 5);
  assert(responses[4].opcode == 0x54);
  assert(memcmp(responses[4].payload, (uint8_t[]){0x34, 0x12}, 2) == 0);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_DROPPED) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_DROPPED) != 0);
  stop_fixture();
}

static void test_exact_model_configuration_and_reprovision_lifecycle(void) {
  reset_fixture(true, true);

  sensor_pub.period = 0x86;
  vehicle_sensor_model_runtime_configuration_changed();
  vehicle_sensor_model_runtime_test_process_once();
  assert(!vehicle_sensor_model_runtime_test_sensor_ready());
  assert(vehicle_sensor_model_runtime_test_vendor_ready());
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED) != 0);

  sensor_pub.period = 0;
  sensor_model.keys[0] = ESP_BLE_MESH_KEY_UNUSED;
  vehicle_sensor_model_runtime_configuration_changed();
  vehicle_sensor_model_runtime_test_process_once();
  assert(!vehicle_sensor_model_runtime_test_sensor_ready());

  sensor_model.keys[0] = 0;
  vehicle_sensor_model_runtime_configuration_changed();
  vehicle_sensor_model_runtime_test_process_once();
  assert(vehicle_sensor_model_runtime_test_sensor_ready());
  assert(sensor_publish_count == 1);

  set_configured(false);
  vehicle_sensor_model_runtime_reset();
  vehicle_sensor_model_runtime_test_process_once();
  assert(!vehicle_sensor_model_runtime_test_sensor_ready());
  assert(!vehicle_sensor_model_runtime_test_vendor_ready());

  set_configured(true);
  vehicle_sensor_model_runtime_provisioned();
  vehicle_sensor_model_runtime_test_process_once();
  assert(vehicle_sensor_model_runtime_test_sensor_ready());
  assert(vehicle_sensor_model_runtime_test_vendor_ready());
  assert(sensor_publish_count == 2);
  stop_fixture();
}

static void stop_from_inflight_producer(void) {
  vehicle_sensor_model_runtime_test_set_after_acquire_hook(NULL);
  nested_stop_result = vehicle_sensor_model_runtime_stop();
}

static void test_shutdown_closes_intake_drains_producers_and_restarts(void) {
  esp_ble_mesh_msg_ctx_t context = {.addr = 0x0001};
  reset_fixture(true, false);
  nested_stop_result = ESP_OK;
  vehicle_sensor_model_runtime_test_set_after_acquire_hook(stop_from_inflight_producer);
  assert(vehicle_sensor_model_runtime_request(
      &context, VEHICLE_SENSOR_REQUEST_DESCRIPTOR, false, 0));
  assert(nested_stop_result == ESP_ERR_TIMEOUT);
  assert(!vehicle_sensor_model_runtime_request(
      &context, VEHICLE_SENSOR_REQUEST_DESCRIPTOR, false, 0));

  fake_esp_idf_run_task_on_next_delay();
  assert(vehicle_sensor_model_runtime_stop() == ESP_OK);
  assert(fake_esp_idf_queue_delete_count() == 0);
  assert(vehicle_sensor_model_runtime_start(
             &(vehicle_sensor_model_runtime_config_t){
                 .mesh_adapter = &adapter,
                 .fault_handler = record_faults,
                 .fault_context = &fault_log,
             }) == ESP_OK);
  assert(vehicle_sensor_model_runtime_activate() == ESP_OK);
  stop_fixture();
}

static void test_worker_context_stop_is_rejected_without_closing_intake(void) {
  esp_ble_mesh_msg_ctx_t context = {.addr = 0x0001};
  reset_fixture(true, false);
  fake_esp_idf_set_created_task_as_current(true);
  assert(vehicle_sensor_model_runtime_stop() == ESP_ERR_INVALID_STATE);
  fake_esp_idf_set_created_task_as_current(false);
  assert(vehicle_sensor_model_runtime_request(
      &context, VEHICLE_SENSOR_REQUEST_DESCRIPTOR, false, 0));
  vehicle_sensor_model_runtime_test_process_once();
  assert(response_count == 1);
  stop_fixture();
}

static void test_health_recovers_async_send_drop_and_retry_faults(void) {
  static const uint64_t retry_deadlines_ms[] = {
      250, 750, 1750, 3750, 7750, 15750, 23750,
  };
  reset_fixture(true, true);

  vehicle_sensor_model_runtime_record_send_error();
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.seen_active & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);
  assert(sensor_publish_count == 1);

  driver_dropped = 1;
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.seen_active & VEHICLE_SENSOR_FAULT_DROPPED) != 0);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_DROPPED) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_DROPPED) != 0);
  assert(sensor_publish_count == 2);

  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  vehicle_sensor_model_runtime_test_process_once();
  for (size_t index = 0; index < sizeof(retry_deadlines_ms) / sizeof(retry_deadlines_ms[0]); index++) {
    fake_esp_idf_set_time_us((int64_t)(retry_deadlines_ms[index] * 1000U) - 1);
    vehicle_sensor_model_runtime_test_process_once();
  }
  assert((fault_log.seen_active & VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED) != 0);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED) != 0);
  assert(sensor_publish_count == 3);
  stop_fixture();
}

static void test_health_recovers_transient_faults_and_keeps_sequence_exhaustion(void) {
  reset_fixture(false, true);
  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED) != 0);

  set_configured(true);
  vehicle_sensor_model_runtime_configuration_changed();
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED) != 0);

  vehicle_sensor_model_runtime_test_set_next_sequence(UINT32_MAX);
  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_CLEARED, .level = false}));
  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEQUENCE_EXHAUSTED) != 0);

  vehicle_sensor_model_runtime_clear_fault_history();
  vehicle_sensor_model_runtime_test_process_once();
  assert(fault_log.history == 0);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEQUENCE_EXHAUSTED) != 0);
  stop_fixture();
}

int main(void) {
  test_config_latch_converges_after_command_queue_saturation_and_reboot();
  test_custom_publication_is_single_and_uses_authoritative_current();
  test_sensor_requests_use_official_status_semantics_and_authoritative_current();
  test_exact_model_configuration_and_reprovision_lifecycle();
  test_shutdown_closes_intake_drains_producers_and_restarts();
  test_worker_context_stop_is_rejected_without_closing_intake();
  test_health_recovers_async_send_drop_and_retry_faults();
  test_health_recovers_transient_faults_and_keeps_sequence_exhaustion();
  return 0;
}
