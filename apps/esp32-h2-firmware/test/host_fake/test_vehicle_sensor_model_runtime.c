#include "fake_esp_idf.h"
#include "vehicle_sensor_mesh_adapter.h"
#include "vehicle_sensor_runtime.h"

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
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
static bool sensor_publish_auto_complete;
static bool vendor_publish_auto_complete;
static size_t sensor_publish_count;
static size_t vendor_publish_count;
static uint32_t vendor_publish_sequences[128];
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
static uint8_t health_server_current_faults[5];
static uint8_t health_server_registered_faults[5];
static esp_err_t nested_stop_result;
static bool fake_runtime_initialized;

static uint32_t read_le32(const uint8_t *input) {
  return (uint32_t)input[0] |
         ((uint32_t)input[1] << 8U) |
         ((uint32_t)input[2] << 16U) |
         ((uint32_t)input[3] << 24U);
}

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
    if (sensor_publish_result == ESP_OK && sensor_publish_auto_complete) {
      vehicle_sensor_model_runtime_record_send_result(
          &sensor_model, true);
    }
    return sensor_publish_result;
  }
  assert(model == &vendor_model);
  assert(length == VEHICLE_SENSOR_PACKET_SIZE);
  assert(vendor_publish_count < sizeof(vendor_publish_sequences) /
      sizeof(vendor_publish_sequences[0]));
  vendor_publish_sequences[vendor_publish_count] = read_le32(data + 5);
  vendor_publish_count += 1;
  if (vendor_publish_result == ESP_OK && vendor_publish_auto_complete) {
    vehicle_sensor_model_runtime_record_send_result(
        &vendor_model, true);
  }
  return vendor_publish_result;
}

static void record_faults(uint32_t active, uint32_t history, void *context) {
  fault_log_t *log = context;
  log->active = active;
  log->history = history;
  log->seen_active |= active;
  log->changes += 1;

  const vehicle_sensor_health_t health = {
      .active_mask = active,
      .history_mask = history,
  };
  memset(health_server_current_faults, 0, sizeof(health_server_current_faults));
  memset(health_server_registered_faults, 0, sizeof(health_server_registered_faults));
  (void)vehicle_sensor_health_build_current(
      &health, health_server_current_faults, sizeof(health_server_current_faults));
  (void)vehicle_sensor_health_build_registered(
      &health, health_server_registered_faults, sizeof(health_server_registered_faults));
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
  if (fake_runtime_initialized) {
    fake_esp_idf_reset_preserving_rtos(level);
  } else {
    fake_esp_idf_reset(level);
    fake_runtime_initialized = true;
  }
  mesh_provisioned = false;
  driver_available = true;
  driver_level = level;
  driver_dropped = 0;
  sensor_publish_result = ESP_OK;
  vendor_publish_result = ESP_OK;
  sensor_publish_auto_complete = true;
  vendor_publish_auto_complete = true;
  sensor_publish_count = 0;
  vendor_publish_count = 0;
  memset(vendor_publish_sequences, 0, sizeof(vendor_publish_sequences));
  response_count = 0;
  memset(&fault_log, 0, sizeof(fault_log));
  memset(health_server_current_faults, 0, sizeof(health_server_current_faults));
  memset(health_server_registered_faults, 0, sizeof(health_server_registered_faults));
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

static void restart_fixture_without_reset(void) {
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

static void test_static_worker_parks_and_restarts_one_hundred_times_without_stale_commands(void) {
  esp_ble_mesh_msg_ctx_t context = {.addr = 0x0001};
  reset_fixture(true, false);
  const unsigned int creates_before = fake_esp_idf_task_create_count();
  assert(creates_before == 1);

  for (size_t iteration = 0; iteration < 100; iteration++) {
    const size_t responses_before = response_count;
    const uint32_t boot_before = vehicle_sensor_model_runtime_test_boot_id();
    assert(vehicle_sensor_model_runtime_request(
        &context, VEHICLE_SENSOR_REQUEST_DESCRIPTOR, false, 0));

    fake_esp_idf_run_task_on_next_delay();
    assert(vehicle_sensor_model_runtime_stop() == ESP_OK);
    assert(vehicle_sensor_model_runtime_start(
               &(vehicle_sensor_model_runtime_config_t){
                   .mesh_adapter = &adapter,
                   .fault_handler = record_faults,
                   .fault_context = &fault_log,
               }) == ESP_OK);
    assert(vehicle_sensor_model_runtime_activate() == ESP_OK);
    vehicle_sensor_model_runtime_test_process_once();

    assert(response_count == responses_before);
    assert(vehicle_sensor_model_runtime_test_boot_id() != boot_before);
  }

  assert(fake_esp_idf_task_create_count() == creates_before);
  assert(fake_esp_idf_task_delete_count() == 0);
  stop_fixture();
}

static void test_vendor_send_fault_survives_sensor_success_until_vendor_recovers(void) {
  reset_fixture(true, true);
  vendor_publish_result = ESP_FAIL;

  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  vehicle_sensor_model_runtime_test_process_once();
  assert(vendor_publish_count == 1);
  assert(sensor_publish_count == 1);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);

  vehicle_sensor_model_runtime_record_send_result(
      &sensor_model, true);
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);

  vendor_publish_result = ESP_OK;
  vendor_publish_auto_complete = false;
  fake_esp_idf_set_time_us(250000);
  vehicle_sensor_model_runtime_test_process_once();
  assert(vendor_publish_count == 2);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);

  vehicle_sensor_model_runtime_clear_fault_history();
  vehicle_sensor_model_runtime_test_process_once();
  assert(fault_log.active == 0);
  assert(fault_log.history == 0);
  stop_fixture();
}

static size_t vendor_publish_count_for_sequence(uint32_t sequence) {
  size_t count = 0;
  for (size_t index = 0; index < vendor_publish_count; index++) {
    count += vendor_publish_sequences[index] == sequence ? 1U : 0U;
  }
  return count;
}

static void test_vendor_publishes_each_initial_and_retry_without_completions(void) {
  static const uint64_t retry_deadlines_ms[] = {
      250, 750, 1750, 3750, 7750, 15750,
  };
  reset_fixture(true, true);
  vendor_publish_auto_complete = false;

  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_CLEARED, .level = false}));
  vehicle_sensor_model_runtime_test_process_once();
  assert(vendor_publish_count == 2);
  assert(vendor_publish_count_for_sequence(1) == 1);
  assert(vendor_publish_count_for_sequence(2) == 1);

  for (size_t index = 0;
       index < sizeof(retry_deadlines_ms) / sizeof(retry_deadlines_ms[0]);
       index++) {
    fake_esp_idf_set_time_us((int64_t)(retry_deadlines_ms[index] * 1000U));
    vehicle_sensor_model_runtime_test_process_once();
    assert(vendor_publish_count == 2U + (2U * (index + 1U)));
  }
  assert(vendor_publish_count_for_sequence(1) == 7);
  assert(vendor_publish_count_for_sequence(2) == 7);

  fake_esp_idf_set_time_us(23750000);
  vehicle_sensor_model_runtime_test_process_once();
  assert(vendor_publish_count == 14);
  stop_fixture();
}

static void test_lost_sensor_completion_does_not_block_the_next_cadence(void) {
  reset_fixture(true, false);
  sensor_publish_auto_complete = false;

  const uint64_t first_deadline = vehicle_sensor_model_runtime_test_next_publication_ms();
  fake_esp_idf_set_time_us((int64_t)(first_deadline * 1000U));
  vehicle_sensor_model_runtime_test_process_once();
  assert(sensor_publish_count == 1);

  const uint64_t second_deadline = vehicle_sensor_model_runtime_test_next_publication_ms();
  fake_esp_idf_set_time_us((int64_t)(second_deadline * 1000U));
  vehicle_sensor_model_runtime_test_process_once();
  assert(sensor_publish_count == 2);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);
  stop_fixture();
}

static void write_le32(uint8_t *output, uint32_t value) {
  output[0] = (uint8_t)value;
  output[1] = (uint8_t)(value >> 8U);
  output[2] = (uint8_t)(value >> 16U);
  output[3] = (uint8_t)(value >> 24U);
}

static void test_only_exact_ack_recovers_the_vendor_send_fault(void) {
  uint8_t ack[VEHICLE_SENSOR_ACK_SIZE] = {VEHICLE_SENSOR_PROTOCOL_VERSION};
  reset_fixture(true, true);
  vendor_publish_result = ESP_FAIL;

  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);

  write_le32(ack + 1, vehicle_sensor_model_runtime_test_boot_id());
  write_le32(ack + 5, 2);
  assert(vehicle_sensor_model_runtime_receive_ack(ack, sizeof(ack)));
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);

  write_le32(ack + 5, 1);
  assert(vehicle_sensor_model_runtime_receive_ack(ack, sizeof(ack)));
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);
  stop_fixture();
}

static void test_duplicate_completion_after_reuse_does_not_change_the_next_event(void) {
  uint8_t ack[VEHICLE_SENSOR_ACK_SIZE] = {VEHICLE_SENSOR_PROTOCOL_VERSION};
  reset_fixture(true, true);
  vendor_publish_auto_complete = false;

  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  vehicle_sensor_model_runtime_test_process_once();
  assert(vendor_publish_count == 1);
  vehicle_sensor_model_runtime_record_send_result(&vendor_model, true);

  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_CLEARED, .level = false}));
  vehicle_sensor_model_runtime_test_process_once();
  assert(vendor_publish_count == 2);

  write_le32(ack + 1, vehicle_sensor_model_runtime_test_boot_id());
  write_le32(ack + 5, 1);
  assert(vehicle_sensor_model_runtime_receive_ack(ack, sizeof(ack)));
  vehicle_sensor_model_runtime_test_process_once();

  vehicle_sensor_model_runtime_record_send_result(&vendor_model, false);
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);
  vehicle_sensor_model_runtime_record_send_result(&vendor_model, true);
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);

  fake_esp_idf_set_time_us(250000);
  vehicle_sensor_model_runtime_test_process_once();
  assert(vendor_publish_count == 3);
  assert(vendor_publish_count_for_sequence(1) == 1);
  assert(vendor_publish_count_for_sequence(2) == 2);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);

  write_le32(ack + 5, 2);
  assert(vehicle_sensor_model_runtime_receive_ack(ack, sizeof(ack)));
  vehicle_sensor_model_runtime_test_process_once();
  fake_esp_idf_set_time_us(750000);
  vehicle_sensor_model_runtime_test_process_once();
  assert(vendor_publish_count == 3);
  stop_fixture();
}

static void test_health_recovers_immediate_send_drop_and_retry_faults(void) {
  static const uint64_t retry_offsets_ms[] = {
      250, 750, 1750, 3750, 7750, 15750, 23750,
  };
  reset_fixture(true, true);

  sensor_publish_result = ESP_FAIL;
  sensor_publish_auto_complete = false;
  const uint64_t publication_deadline_ms =
      vehicle_sensor_model_runtime_test_next_publication_ms();
  fake_esp_idf_set_time_us((int64_t)(publication_deadline_ms * 1000U));
  vehicle_sensor_model_runtime_test_process_once();
  assert(sensor_publish_count == 1);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);

  sensor_publish_result = ESP_OK;
  fake_esp_idf_set_time_us((int64_t)((publication_deadline_ms + 1000U) * 1000U));
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.seen_active & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);
  assert(sensor_publish_count == 2);

  vehicle_sensor_model_runtime_record_send_result(&sensor_model, false);
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);

  driver_dropped = 1;
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.seen_active & VEHICLE_SENSOR_FAULT_DROPPED) != 0);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_DROPPED) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_DROPPED) != 0);
  assert(sensor_publish_count == 3);

  const uint64_t retry_base_ms = publication_deadline_ms + 1001U;
  fake_esp_idf_set_time_us((int64_t)(retry_base_ms * 1000U));
  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  vehicle_sensor_model_runtime_test_process_once();
  for (size_t index = 0; index < sizeof(retry_offsets_ms) / sizeof(retry_offsets_ms[0]); index++) {
    fake_esp_idf_set_time_us(
        (int64_t)((retry_base_ms + retry_offsets_ms[index]) * 1000U) - 1);
    vehicle_sensor_model_runtime_test_process_once();
  }
  assert((fault_log.seen_active & VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED) != 0);
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED) != 0);
  assert(sensor_publish_count == 4);
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

static void test_old_generation_publish_completions_do_not_change_new_fault_state(void) {
  reset_fixture(true, true);
  vendor_publish_auto_complete = false;
  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  vehicle_sensor_model_runtime_test_process_once();
  assert(vendor_publish_count == 1);

  stop_fixture();
  restart_fixture_without_reset();
  vendor_publish_result = ESP_FAIL;
  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_CLEARED, .level = false}));
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);

  vehicle_sensor_model_runtime_record_send_result(
      &vendor_model, true);
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);

  vehicle_sensor_model_runtime_record_send_result(
      &vendor_model, false);
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) != 0);

  vendor_publish_result = ESP_OK;
  vendor_publish_auto_complete = true;
  fake_esp_idf_set_time_us(250000);
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);
  stop_fixture();

  reset_fixture(true, true);
  vendor_publish_auto_complete = false;
  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  vehicle_sensor_model_runtime_test_process_once();
  stop_fixture();
  restart_fixture_without_reset();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);

  vehicle_sensor_model_runtime_record_send_result(
      &vendor_model, false);
  vehicle_sensor_model_runtime_test_process_once();
  assert((fault_log.active & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);
  assert((fault_log.history & VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0);
  stop_fixture();
}

static void test_restart_clears_stale_external_health_fault_arrays(void) {
  static const uint8_t no_faults[5] = {0};
  reset_fixture(true, true);
  vendor_publish_result = ESP_FAIL;
  assert(vehicle_sensor_model_runtime_submit_event(
      &(vehicle_sensor_event_t){.kind = VEHICLE_SENSOR_DETECTED, .level = true}));
  vehicle_sensor_model_runtime_test_process_once();
  assert(health_server_current_faults[0] == VEHICLE_SENSOR_HEALTH_CODE_SEND_ERROR);
  assert(health_server_registered_faults[0] == VEHICLE_SENSOR_HEALTH_CODE_SEND_ERROR);

  stop_fixture();
  const uint32_t changes_before_restart = fault_log.changes;
  restart_fixture_without_reset();
  assert(fault_log.changes > changes_before_restart);
  assert(memcmp(health_server_current_faults, no_faults, sizeof(no_faults)) == 0);
  assert(memcmp(health_server_registered_faults, no_faults, sizeof(no_faults)) == 0);
  stop_fixture();
}

int main(void) {
  const char *fix3_test = getenv("VEHICLE_SENSOR_FIX3_TEST");
  const char *fix4_test = getenv("VEHICLE_SENSOR_FIX4_TEST");
  if (fix4_test != NULL && strcmp(fix4_test, "vendor-liveness") == 0) {
    test_vendor_publishes_each_initial_and_retry_without_completions();
    return 0;
  }
  if (fix4_test != NULL && strcmp(fix4_test, "sensor-liveness") == 0) {
    test_lost_sensor_completion_does_not_block_the_next_cadence();
    return 0;
  }
  if (fix4_test != NULL && strcmp(fix4_test, "duplicate") == 0) {
    test_duplicate_completion_after_reuse_does_not_change_the_next_event();
    return 0;
  }
  if (fix4_test != NULL && strcmp(fix4_test, "immediate-failure") == 0) {
    test_health_recovers_immediate_send_drop_and_retry_faults();
    return 0;
  }
  if (fix3_test != NULL && strcmp(fix3_test, "generation") == 0) {
    test_old_generation_publish_completions_do_not_change_new_fault_state();
    return 0;
  }
  if (fix3_test != NULL && strcmp(fix3_test, "health") == 0) {
    test_restart_clears_stale_external_health_fault_arrays();
    return 0;
  }
  test_config_latch_converges_after_command_queue_saturation_and_reboot();
  test_custom_publication_is_single_and_uses_authoritative_current();
  test_sensor_requests_use_official_status_semantics_and_authoritative_current();
  test_exact_model_configuration_and_reprovision_lifecycle();
  test_shutdown_closes_intake_drains_producers_and_restarts();
  test_worker_context_stop_is_rejected_without_closing_intake();
  test_static_worker_parks_and_restarts_one_hundred_times_without_stale_commands();
  test_vendor_send_fault_survives_sensor_success_until_vendor_recovers();
  test_vendor_publishes_each_initial_and_retry_without_completions();
  test_lost_sensor_completion_does_not_block_the_next_cadence();
  test_only_exact_ack_recovers_the_vendor_send_fault();
  test_duplicate_completion_after_reuse_does_not_change_the_next_event();
  test_health_recovers_immediate_send_drop_and_retry_faults();
  test_health_recovers_transient_faults_and_keeps_sequence_exhaustion();
  test_old_generation_publish_completions_do_not_change_new_fault_state();
  test_restart_clears_stale_external_health_fault_arrays();
  return 0;
}
