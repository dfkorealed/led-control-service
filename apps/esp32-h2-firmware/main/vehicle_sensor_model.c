#include "vehicle_sensor_model.h"

#include <inttypes.h>
#include <limits.h>
#include <string.h>

#ifdef ESP_PLATFORM
#include "esp_ble_mesh_sensor_model_api.h"
#include "mesh/device_property.h"

_Static_assert(BLE_MESH_PRESENCE_DETECTED_LEN == 1, "Presence Detected must be one byte");
#define VEHICLE_SENSOR_PRESENCE_PROPERTY_ID BLE_MESH_PRESENCE_DETECTED
#define VEHICLE_SENSOR_PRESENCE_MPID() \
  ESP_BLE_MESH_SENSOR_DATA_FORMAT_A_MPID(0, BLE_MESH_PRESENCE_DETECTED)
#else
/* Host tests mirror the v5.5.1 assigned-number and MPID macros used by the ESP build above. */
#define VEHICLE_SENSOR_PRESENCE_PROPERTY_ID 0x004DU
#define VEHICLE_SENSOR_PRESENCE_MPID() ((VEHICLE_SENSOR_PRESENCE_PROPERTY_ID << 5U))
#endif

#define VEHICLE_SENSOR_EVENT_DETECTED_WIRE 1U
#define VEHICLE_SENSOR_EVENT_CLEARED_WIRE 2U

static const uint32_t retry_delays_ms[VEHICLE_SENSOR_MAX_RETRIES] = {
    250U,
    500U,
    1000U,
    2000U,
    4000U,
    8000U,
};

static void increment_saturating(uint32_t *value) {
  if (*value != UINT32_MAX) {
    (*value)++;
  }
}

static void write_le32(uint8_t *output, uint32_t value) {
  output[0] = (uint8_t)value;
  output[1] = (uint8_t)(value >> 8U);
  output[2] = (uint8_t)(value >> 16U);
  output[3] = (uint8_t)(value >> 24U);
}

static uint32_t read_le32(const uint8_t *input) {
  return (uint32_t)input[0] |
         ((uint32_t)input[1] << 8U) |
         ((uint32_t)input[2] << 16U) |
         ((uint32_t)input[3] << 24U);
}

static bool event_is_valid(vehicle_sensor_event_kind_t kind, bool level) {
  return (kind == VEHICLE_SENSOR_DETECTED && level) ||
         (kind == VEHICLE_SENSOR_CLEARED && !level);
}

static uint8_t event_kind_to_wire(vehicle_sensor_event_kind_t kind) {
  return kind == VEHICLE_SENSOR_DETECTED ?
      VEHICLE_SENSOR_EVENT_DETECTED_WIRE : VEHICLE_SENSOR_EVENT_CLEARED_WIRE;
}

static vehicle_sensor_event_kind_t event_kind_from_wire(uint8_t kind) {
  return kind == VEHICLE_SENSOR_EVENT_DETECTED_WIRE ?
      VEHICLE_SENSOR_DETECTED : VEHICLE_SENSOR_CLEARED;
}

static void record_send_result(vehicle_sensor_model_t *model, vehicle_sensor_send_result_t result) {
  if (result == VEHICLE_SENSOR_SEND_ERROR) {
    increment_saturating(&model->send_error_count);
  } else if (result == VEHICLE_SENSOR_SEND_UNCONFIGURED) {
    increment_saturating(&model->unconfigured_send_count);
  }
}

static void send_pending(vehicle_sensor_model_t *model, vehicle_sensor_pending_t *pending) {
  uint8_t payload[VEHICLE_SENSOR_PACKET_SIZE];
  if (vehicle_sensor_packet_encode(&pending->packet, payload, sizeof(payload)) != sizeof(payload)) {
    increment_saturating(&model->send_error_count);
    return;
  }
  if (model->send == NULL) {
    increment_saturating(&model->unconfigured_send_count);
    return;
  }
  record_send_result(model, model->send(payload, model->send_context));
}

vehicle_sensor_packet_t vehicle_sensor_packet_make(
    uint32_t boot_id,
    uint32_t sequence,
    vehicle_sensor_event_kind_t kind,
    bool level) {
  return (vehicle_sensor_packet_t){
      .boot_id = boot_id,
      .sequence = sequence,
      .kind = kind,
      .level = level,
  };
}

size_t vehicle_sensor_packet_encode(
    const vehicle_sensor_packet_t *packet,
    uint8_t *output,
    size_t output_size) {
  if (packet == NULL || output == NULL || output_size < VEHICLE_SENSOR_PACKET_SIZE ||
      !event_is_valid(packet->kind, packet->level)) {
    return 0;
  }

  output[0] = VEHICLE_SENSOR_PROTOCOL_VERSION;
  write_le32(output + 1, packet->boot_id);
  write_le32(output + 5, packet->sequence);
  output[9] = event_kind_to_wire(packet->kind);
  output[10] = packet->level ? 1U : 0U;
  return VEHICLE_SENSOR_PACKET_SIZE;
}

bool vehicle_sensor_packet_decode(
    const uint8_t *payload,
    size_t payload_size,
    vehicle_sensor_packet_t *packet) {
  if (payload == NULL || packet == NULL || payload_size != VEHICLE_SENSOR_PACKET_SIZE ||
      payload[0] != VEHICLE_SENSOR_PROTOCOL_VERSION ||
      (payload[9] != VEHICLE_SENSOR_EVENT_DETECTED_WIRE &&
       payload[9] != VEHICLE_SENSOR_EVENT_CLEARED_WIRE) ||
      payload[10] > 1U) {
    return false;
  }

  vehicle_sensor_event_kind_t kind = event_kind_from_wire(payload[9]);
  bool level = payload[10] != 0;
  if (!event_is_valid(kind, level)) {
    return false;
  }

  *packet = vehicle_sensor_packet_make(
      read_le32(payload + 1),
      read_le32(payload + 5),
      kind,
      level);
  return true;
}

bool vehicle_sensor_ack_decode(
    const uint8_t *payload,
    size_t payload_size,
    uint32_t *boot_id,
    uint32_t *sequence) {
  if (payload == NULL || boot_id == NULL || sequence == NULL ||
      payload_size != VEHICLE_SENSOR_ACK_SIZE ||
      payload[0] != VEHICLE_SENSOR_PROTOCOL_VERSION) {
    return false;
  }
  *boot_id = read_le32(payload + 1);
  *sequence = read_le32(payload + 5);
  return true;
}

size_t vehicle_sensor_presence_status_encode(bool level, uint8_t *output, size_t output_size) {
  if (output == NULL || output_size < VEHICLE_SENSOR_STATUS_SIZE) {
    return 0;
  }
  uint16_t mpid = (uint16_t)VEHICLE_SENSOR_PRESENCE_MPID();
  output[0] = (uint8_t)mpid;
  output[1] = (uint8_t)(mpid >> 8U);
  output[2] = level ? 1U : 0U;
  return VEHICLE_SENSOR_STATUS_SIZE;
}

uint32_t vehicle_sensor_publication_interval_ms(uint16_t primary_unicast) {
  uint32_t hash = 2166136261U;
  hash = (hash ^ (uint8_t)primary_unicast) * 16777619U;
  hash = (hash ^ (uint8_t)(primary_unicast >> 8U)) * 16777619U;
  return VEHICLE_SENSOR_PUBLICATION_BASE_MS + (hash % VEHICLE_SENSOR_PUBLICATION_JITTER_MS);
}

void vehicle_sensor_model_init(
    vehicle_sensor_model_t *model,
    uint32_t boot_id,
    vehicle_sensor_send_fn_t send,
    void *send_context) {
  if (model == NULL) {
    return;
  }
  memset(model, 0, sizeof(*model));
  model->boot_id = boot_id;
  model->next_sequence = 1;
  model->send = send;
  model->send_context = send_context;
}

vehicle_sensor_submit_result_t vehicle_sensor_model_submit_event(
    vehicle_sensor_model_t *model,
    vehicle_sensor_event_kind_t kind,
    bool level,
    uint64_t now_ms,
    uint32_t *sequence) {
  if (model == NULL || !event_is_valid(kind, level)) {
    return VEHICLE_SENSOR_SUBMIT_INVALID;
  }

  model->current_level_valid = true;
  model->current_level = level;

  vehicle_sensor_pending_t *available = NULL;
  for (size_t i = 0; i < VEHICLE_SENSOR_PENDING_CAPACITY; i++) {
    if (!model->pending[i].occupied) {
      available = &model->pending[i];
      break;
    }
  }
  if (available == NULL) {
    increment_saturating(&model->pending_full_count);
    return VEHICLE_SENSOR_SUBMIT_PENDING_FULL;
  }
  if (model->sequence_exhausted) {
    increment_saturating(&model->sequence_exhausted_count);
    return VEHICLE_SENSOR_SUBMIT_SEQUENCE_EXHAUSTED;
  }

  uint32_t assigned_sequence = model->next_sequence;
  if (assigned_sequence == UINT32_MAX) {
    model->sequence_exhausted = true;
  } else {
    model->next_sequence = assigned_sequence + 1U;
  }
  available->occupied = true;
  available->packet = vehicle_sensor_packet_make(
      model->boot_id, assigned_sequence, kind, level);
  available->retry_due_ms = now_ms + retry_delays_ms[0];
  available->retries_sent = 0;
  if (sequence != NULL) {
    *sequence = assigned_sequence;
  }
  send_pending(model, available);
  return VEHICLE_SENSOR_SUBMIT_OK;
}

void vehicle_sensor_model_process_time(vehicle_sensor_model_t *model, uint64_t now_ms) {
  if (model == NULL) {
    return;
  }

  for (size_t i = 0; i < VEHICLE_SENSOR_PENDING_CAPACITY; i++) {
    vehicle_sensor_pending_t *pending = &model->pending[i];
    if (!pending->occupied || now_ms < pending->retry_due_ms) {
      continue;
    }
    if (pending->retries_sent == VEHICLE_SENSOR_MAX_RETRIES) {
      pending->occupied = false;
      increment_saturating(&model->retry_exhausted_count);
      continue;
    }

    send_pending(model, pending);
    pending->retries_sent++;
    uint8_t delay_index = pending->retries_sent < VEHICLE_SENSOR_MAX_RETRIES ?
        pending->retries_sent : VEHICLE_SENSOR_MAX_RETRIES - 1U;
    pending->retry_due_ms = now_ms + retry_delays_ms[delay_index];
  }
}

bool vehicle_sensor_model_on_ack(vehicle_sensor_model_t *model, uint32_t boot_id, uint32_t sequence) {
  if (model == NULL || boot_id != model->boot_id) {
    return false;
  }
  for (size_t i = 0; i < VEHICLE_SENSOR_PENDING_CAPACITY; i++) {
    vehicle_sensor_pending_t *pending = &model->pending[i];
    if (pending->occupied && pending->packet.boot_id == boot_id &&
        pending->packet.sequence == sequence) {
      pending->occupied = false;
      return true;
    }
  }
  return false;
}

void vehicle_sensor_model_record_send_error(vehicle_sensor_model_t *model) {
  if (model != NULL) {
    increment_saturating(&model->send_error_count);
  }
}

void vehicle_sensor_model_reset_pending(vehicle_sensor_model_t *model) {
  if (model != NULL) {
    memset(model->pending, 0, sizeof(model->pending));
  }
}

size_t vehicle_sensor_model_pending_count(const vehicle_sensor_model_t *model) {
  size_t count = 0;
  if (model == NULL) {
    return 0;
  }
  for (size_t i = 0; i < VEHICLE_SENSOR_PENDING_CAPACITY; i++) {
    count += model->pending[i].occupied ? 1U : 0U;
  }
  return count;
}

bool vehicle_sensor_model_current_level(const vehicle_sensor_model_t *model) {
  return model != NULL && model->current_level;
}

bool vehicle_sensor_model_current_level_valid(const vehicle_sensor_model_t *model) {
  return model != NULL && model->current_level_valid;
}

uint64_t vehicle_sensor_model_next_deadline_ms(const vehicle_sensor_model_t *model) {
  uint64_t deadline = UINT64_MAX;
  if (model == NULL) {
    return deadline;
  }
  for (size_t i = 0; i < VEHICLE_SENSOR_PENDING_CAPACITY; i++) {
    if (model->pending[i].occupied && model->pending[i].retry_due_ms < deadline) {
      deadline = model->pending[i].retry_due_ms;
    }
  }
  return deadline;
}

uint32_t vehicle_sensor_model_pending_full_count(const vehicle_sensor_model_t *model) {
  return model == NULL ? 0 : model->pending_full_count;
}

uint32_t vehicle_sensor_model_retry_exhausted_count(const vehicle_sensor_model_t *model) {
  return model == NULL ? 0 : model->retry_exhausted_count;
}

uint32_t vehicle_sensor_model_send_error_count(const vehicle_sensor_model_t *model) {
  return model == NULL ? 0 : model->send_error_count;
}

uint32_t vehicle_sensor_model_unconfigured_send_count(const vehicle_sensor_model_t *model) {
  return model == NULL ? 0 : model->unconfigured_send_count;
}

uint32_t vehicle_sensor_model_sequence_exhausted_count(const vehicle_sensor_model_t *model) {
  return model == NULL ? 0 : model->sequence_exhausted_count;
}

#ifdef ESP_PLATFORM

#include <stdatomic.h>

#include "esp_ble_mesh_local_data_operation_api.h"
#include "esp_ble_mesh_networking_api.h"
#include "esp_ble_mesh_provisioning_api.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "mesh/kernel.h"

#define VEHICLE_SENSOR_COMMAND_QUEUE_LENGTH 32U
#define VEHICLE_SENSOR_EVENT_QUEUE_LIMIT 24U
#define VEHICLE_SENSOR_MODEL_TASK_STACK_DEPTH 4096U
#define VEHICLE_SENSOR_MODEL_TASK_PRIORITY 5U
#define VEHICLE_SENSOR_MODEL_IDLE_POLL_MS 1000U
#define VEHICLE_SENSOR_MODEL_STOP_TIMEOUT_MS 1000U

typedef enum {
  VEHICLE_SENSOR_COMMAND_EVENT,
  VEHICLE_SENSOR_COMMAND_ACK,
  VEHICLE_SENSOR_COMMAND_STATUS_GET,
  VEHICLE_SENSOR_COMMAND_SYNC,
  VEHICLE_SENSOR_COMMAND_RESET,
  VEHICLE_SENSOR_COMMAND_SEND_ERROR,
  VEHICLE_SENSOR_COMMAND_STOP,
} vehicle_sensor_command_kind_t;

typedef struct {
  vehicle_sensor_command_kind_t kind;
  union {
    struct {
      vehicle_sensor_event_t event;
      uint32_t lifecycle_epoch;
    } sensor_event;
    struct {
      uint32_t boot_id;
      uint32_t sequence;
    } ack;
    struct {
      esp_ble_mesh_msg_ctx_t context;
      bool property_id_present;
      uint16_t property_id;
    } status_get;
  } value;
} vehicle_sensor_command_t;

typedef struct {
  vehicle_sensor_model_runtime_config_t config;
  vehicle_sensor_model_t model;
  QueueHandle_t queue;
  TaskHandle_t task;
  bool started;
  bool task_gate_open;
  bool provisioned;
  bool sensor_ready;
  bool vendor_ready;
  bool configuration_fault_active;
  uint64_t next_publication_ms;
  uint32_t reported_fault_mask;
  uint32_t publication_unconfigured_count;
  _Atomic bool observed_level_valid;
  _Atomic bool observed_level;
  _Atomic bool recovery_needed;
  _Atomic bool stopped;
  _Atomic uint32_t queue_dropped;
  _Atomic uint32_t lifecycle_epoch;
} vehicle_sensor_model_runtime_t;

static const char *MODEL_TAG = "vehicle_sensor_model";
_Static_assert(ATOMIC_BOOL_LOCK_FREE == 2, "sensor callback bool atomics must be lock-free");
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "sensor callback counters must be lock-free");
static vehicle_sensor_model_runtime_t runtime;
static StaticQueue_t command_queue_storage;
static uint8_t command_queue_buffer[
    VEHICLE_SENSOR_COMMAND_QUEUE_LENGTH * sizeof(vehicle_sensor_command_t)];
static StaticTask_t model_task_storage;
static StackType_t model_task_stack[VEHICLE_SENSOR_MODEL_TASK_STACK_DEPTH];

static uint64_t runtime_now_ms(void) {
  return (uint64_t)esp_timer_get_time() / 1000U;
}

static void atomic_increment_saturating(_Atomic uint32_t *value) {
  uint32_t current = atomic_load_explicit(value, memory_order_relaxed);
  while (current != UINT32_MAX &&
         !atomic_compare_exchange_weak_explicit(
             value,
             &current,
             current + 1U,
             memory_order_relaxed,
             memory_order_relaxed)) {
  }
}

static bool model_has_key(const esp_ble_mesh_model_t *model, uint16_t app_idx) {
  if (model == NULL || app_idx == ESP_BLE_MESH_KEY_UNUSED) {
    return false;
  }
  for (size_t i = 0; i < CONFIG_BLE_MESH_MODEL_KEY_COUNT; i++) {
    if (model->keys[i] == app_idx) {
      return true;
    }
  }
  return false;
}

static bool model_publication_ready(const esp_ble_mesh_model_t *model) {
  return model != NULL && model->pub != NULL &&
         model->pub->publish_addr != ESP_BLE_MESH_ADDR_UNASSIGNED &&
         model_has_key(model, model->pub->app_idx);
}

static void update_sensor_raw_value(bool level) {
  struct net_buf_simple *raw = runtime.config.sensor_raw_value;
  if (raw == NULL) {
    return;
  }
  net_buf_simple_reset(raw);
  net_buf_simple_add_u8(raw, level ? 1U : 0U);
}

static bool current_level(bool *level) {
  if (atomic_load_explicit(&runtime.observed_level_valid, memory_order_acquire)) {
    *level = atomic_load_explicit(&runtime.observed_level, memory_order_relaxed);
    return true;
  }
  if (vehicle_sensor_driver_get_current_level(level)) {
    atomic_store_explicit(&runtime.observed_level, *level, memory_order_relaxed);
    atomic_store_explicit(&runtime.observed_level_valid, true, memory_order_release);
    return true;
  }
  return false;
}

static size_t encode_status(bool property_id_present, uint16_t property_id, uint8_t status[3]) {
  bool level = false;
  if (property_id_present && property_id != BLE_MESH_PRESENCE_DETECTED) {
    uint32_t mpid = ESP_BLE_MESH_SENSOR_DATA_FORMAT_B_MPID(
        ESP_BLE_MESH_SENSOR_DATA_ZERO_LEN, property_id);
    memcpy(status, &mpid, ESP_BLE_MESH_SENSOR_DATA_FORMAT_B_MPID_LEN);
    return ESP_BLE_MESH_SENSOR_DATA_FORMAT_B_MPID_LEN;
  }

  (void)current_level(&level);
  update_sensor_raw_value(level);
  return vehicle_sensor_presence_status_encode(level, status, VEHICLE_SENSOR_STATUS_SIZE);
}

static esp_err_t send_sensor_status_response(
    const esp_ble_mesh_msg_ctx_t *context,
    bool property_id_present,
    uint16_t property_id) {
  uint8_t status[VEHICLE_SENSOR_STATUS_SIZE];
  size_t status_size = encode_status(property_id_present, property_id, status);
  return esp_ble_mesh_server_model_send_msg(
      runtime.config.sensor_model,
      (esp_ble_mesh_msg_ctx_t *)context,
      ESP_BLE_MESH_MODEL_OP_SENSOR_STATUS,
      status_size,
      status);
}

static esp_err_t publish_sensor_status(void) {
  if (!runtime.sensor_ready) {
    if (!runtime.configuration_fault_active) {
      increment_saturating(&runtime.publication_unconfigured_count);
      runtime.configuration_fault_active = true;
    }
    return ESP_ERR_INVALID_STATE;
  }

  uint8_t status[VEHICLE_SENSOR_STATUS_SIZE];
  size_t status_size = encode_status(false, 0, status);
  return esp_ble_mesh_model_publish(
      runtime.config.sensor_model,
      ESP_BLE_MESH_MODEL_OP_SENSOR_STATUS,
      status_size,
      status,
      ROLE_NODE);
}

static vehicle_sensor_send_result_t send_vendor_event(
    const uint8_t payload[VEHICLE_SENSOR_PACKET_SIZE],
    void *context) {
  (void)context;
  if (!runtime.vendor_ready) {
    return VEHICLE_SENSOR_SEND_UNCONFIGURED;
  }
  esp_err_t error = esp_ble_mesh_model_publish(
      runtime.config.vendor_model,
      runtime.config.vendor_event_opcode,
      VEHICLE_SENSOR_PACKET_SIZE,
      (uint8_t *)payload,
      ROLE_NODE);
  return error == ESP_OK ? VEHICLE_SENSOR_SEND_OK : VEHICLE_SENSOR_SEND_ERROR;
}

static void cancel_stack_sensor_publication(void) {
  if (runtime.config.sensor_model != NULL && runtime.config.sensor_model->pub != NULL) {
    /* The Gateway-visible 60 s period remains stored; the app owns the deterministic jitter timer. */
    (void)k_delayed_work_cancel(&runtime.config.sensor_model->pub->timer);
  }
}

static void sync_configuration(uint64_t now_ms, bool publish_current) {
  runtime.provisioned = esp_ble_mesh_node_is_provisioned();
  runtime.sensor_ready = runtime.provisioned &&
      model_publication_ready(runtime.config.sensor_model);
  runtime.vendor_ready = runtime.provisioned &&
      model_publication_ready(runtime.config.vendor_model);
  cancel_stack_sensor_publication();

  if (runtime.sensor_ready) {
    uint16_t unicast = esp_ble_mesh_get_primary_element_address();
    runtime.next_publication_ms = now_ms + vehicle_sensor_publication_interval_ms(unicast);
    runtime.configuration_fault_active = false;
    if (publish_current) {
      esp_err_t error = publish_sensor_status();
      if (error != ESP_OK) {
        vehicle_sensor_model_record_send_error(&runtime.model);
      }
    }
  } else {
    runtime.next_publication_ms = UINT64_MAX;
  }

}

static uint32_t current_fault_mask(void) {
  uint32_t mask = 0;
  if (atomic_load_explicit(&runtime.queue_dropped, memory_order_relaxed) != 0 ||
      vehicle_sensor_driver_dropped_edge_count() != 0 ||
      vehicle_sensor_model_pending_full_count(&runtime.model) != 0) {
    mask |= VEHICLE_SENSOR_FAULT_DROPPED;
  }
  if (vehicle_sensor_model_retry_exhausted_count(&runtime.model) != 0) {
    mask |= VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED;
  }
  if (vehicle_sensor_model_send_error_count(&runtime.model) != 0) {
    mask |= VEHICLE_SENSOR_FAULT_SEND_ERROR;
  }
  if (vehicle_sensor_model_unconfigured_send_count(&runtime.model) != 0 ||
      runtime.publication_unconfigured_count != 0) {
    mask |= VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED;
  }
  if (vehicle_sensor_model_sequence_exhausted_count(&runtime.model) != 0) {
    mask |= VEHICLE_SENSOR_FAULT_SEQUENCE_EXHAUSTED;
  }
  return mask;
}

static void report_fault_changes(void) {
  uint32_t mask = current_fault_mask();
  if (mask != runtime.reported_fault_mask) {
    runtime.reported_fault_mask = mask;
    if (runtime.config.fault_handler != NULL) {
      runtime.config.fault_handler(mask, runtime.config.fault_context);
    }
  }
}

static void recover_current_state_if_needed(void) {
  if (!atomic_exchange_explicit(&runtime.recovery_needed, false, memory_order_acq_rel)) {
    return;
  }
  bool level = false;
  if (current_level(&level)) {
    runtime.model.current_level_valid = true;
    runtime.model.current_level = level;
    update_sensor_raw_value(level);
  }
  esp_err_t error = publish_sensor_status();
  if (error != ESP_OK && error != ESP_ERR_INVALID_STATE) {
    vehicle_sensor_model_record_send_error(&runtime.model);
  }
}

static void handle_command(const vehicle_sensor_command_t *command, uint64_t now_ms) {
  switch (command->kind) {
  case VEHICLE_SENSOR_COMMAND_EVENT:
    if (command->value.sensor_event.lifecycle_epoch !=
        atomic_load_explicit(&runtime.lifecycle_epoch, memory_order_acquire)) {
      break;
    }
    if (vehicle_sensor_model_submit_event(
            &runtime.model,
            command->value.sensor_event.event.kind,
            command->value.sensor_event.event.level,
            now_ms,
            NULL) != VEHICLE_SENSOR_SUBMIT_OK) {
      atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
    }
    break;
  case VEHICLE_SENSOR_COMMAND_ACK:
    (void)vehicle_sensor_model_on_ack(
        &runtime.model,
        command->value.ack.boot_id,
        command->value.ack.sequence);
    break;
  case VEHICLE_SENSOR_COMMAND_STATUS_GET: {
    esp_err_t error = send_sensor_status_response(
        &command->value.status_get.context,
        command->value.status_get.property_id_present,
        command->value.status_get.property_id);
    if (error != ESP_OK) {
      vehicle_sensor_model_record_send_error(&runtime.model);
    }
    break;
  }
  case VEHICLE_SENSOR_COMMAND_SYNC:
    sync_configuration(now_ms, true);
    break;
  case VEHICLE_SENSOR_COMMAND_RESET:
    runtime.provisioned = false;
    runtime.sensor_ready = false;
    runtime.vendor_ready = false;
    runtime.next_publication_ms = UINT64_MAX;
    runtime.configuration_fault_active = false;
    vehicle_sensor_model_reset_pending(&runtime.model);
    cancel_stack_sensor_publication();
    break;
  case VEHICLE_SENSOR_COMMAND_SEND_ERROR:
    vehicle_sensor_model_record_send_error(&runtime.model);
    break;
  case VEHICLE_SENSOR_COMMAND_STOP:
    break;
  }
}

static TickType_t next_wait_ticks(uint64_t now_ms) {
  uint64_t deadline = vehicle_sensor_model_next_deadline_ms(&runtime.model);
  if (runtime.next_publication_ms < deadline) {
    deadline = runtime.next_publication_ms;
  }
  uint64_t wait_ms = VEHICLE_SENSOR_MODEL_IDLE_POLL_MS;
  if (deadline != UINT64_MAX) {
    wait_ms = deadline <= now_ms ? 0 : deadline - now_ms;
    if (wait_ms > VEHICLE_SENSOR_MODEL_IDLE_POLL_MS) {
      wait_ms = VEHICLE_SENSOR_MODEL_IDLE_POLL_MS;
    }
  }
  if (wait_ms == 0) {
    return 0;
  }
  TickType_t ticks = pdMS_TO_TICKS(wait_ms);
  return ticks == 0 ? 1 : ticks;
}

static void vehicle_sensor_model_task(void *argument) {
  (void)argument;
  if (!runtime.task_gate_open) {
    if (ulTaskNotifyTake(pdTRUE, portMAX_DELAY) == 0) {
      atomic_store_explicit(&runtime.stopped, true, memory_order_release);
      vTaskDelete(NULL);
      return;
    }
    runtime.task_gate_open = true;
  }

  sync_configuration(runtime_now_ms(), false);
  for (;;) {
    uint64_t now_ms = runtime_now_ms();
    vehicle_sensor_command_t command;
    if (xQueueReceive(runtime.queue, &command, next_wait_ticks(now_ms)) == pdTRUE) {
      if (command.kind == VEHICLE_SENSOR_COMMAND_STOP) {
        break;
      }
      handle_command(&command, runtime_now_ms());
    }

    now_ms = runtime_now_ms();
    vehicle_sensor_model_process_time(&runtime.model, now_ms);
    if (runtime.next_publication_ms != UINT64_MAX && now_ms >= runtime.next_publication_ms) {
      esp_err_t error = publish_sensor_status();
      if (error != ESP_OK) {
        vehicle_sensor_model_record_send_error(&runtime.model);
      }
      runtime.next_publication_ms = now_ms + vehicle_sensor_publication_interval_ms(
          esp_ble_mesh_get_primary_element_address());
    }
    if (uxQueueMessagesWaiting(runtime.queue) == 0) {
      recover_current_state_if_needed();
    }
    report_fault_changes();
  }

  cancel_stack_sensor_publication();
  atomic_store_explicit(&runtime.stopped, true, memory_order_release);
  vTaskDelete(NULL);
}

static bool enqueue_command(const vehicle_sensor_command_t *command, bool front, bool sensor_event) {
  if (!runtime.started || runtime.queue == NULL ||
      atomic_load_explicit(&runtime.stopped, memory_order_acquire)) {
    return false;
  }
  if (sensor_event && uxQueueMessagesWaiting(runtime.queue) >= VEHICLE_SENSOR_EVENT_QUEUE_LIMIT) {
    atomic_increment_saturating(&runtime.queue_dropped);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
    return false;
  }
  BaseType_t result = front ?
      xQueueSendToFront(runtime.queue, command, 0) :
      xQueueSend(runtime.queue, command, 0);
  if (result != pdTRUE) {
    atomic_increment_saturating(&runtime.queue_dropped);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
    return false;
  }
  return true;
}

esp_err_t vehicle_sensor_model_runtime_start(const vehicle_sensor_model_runtime_config_t *config) {
  if (config == NULL || config->sensor_model == NULL || config->vendor_model == NULL ||
      config->sensor_raw_value == NULL || config->vendor_event_opcode == 0) {
    return ESP_ERR_INVALID_ARG;
  }
  if (runtime.started) {
    return ESP_ERR_INVALID_STATE;
  }

  memset(&runtime, 0, sizeof(runtime));
  runtime.config = *config;
  runtime.next_publication_ms = UINT64_MAX;
  atomic_init(&runtime.observed_level_valid, false);
  atomic_init(&runtime.observed_level, false);
  atomic_init(&runtime.recovery_needed, false);
  atomic_init(&runtime.stopped, false);
  atomic_init(&runtime.queue_dropped, 0);
  atomic_init(&runtime.lifecycle_epoch, 0);
  vehicle_sensor_model_init(&runtime.model, esp_random(), send_vendor_event, NULL);

  runtime.queue = xQueueCreateStatic(
      VEHICLE_SENSOR_COMMAND_QUEUE_LENGTH,
      sizeof(vehicle_sensor_command_t),
      command_queue_buffer,
      &command_queue_storage);
  if (runtime.queue == NULL) {
    return ESP_ERR_NO_MEM;
  }
  runtime.started = true;
  runtime.task_gate_open = false;
  TaskHandle_t task = xTaskCreateStatic(
      vehicle_sensor_model_task,
      "vehicle_sensor_model",
      VEHICLE_SENSOR_MODEL_TASK_STACK_DEPTH,
      NULL,
      VEHICLE_SENSOR_MODEL_TASK_PRIORITY,
      model_task_stack,
      &model_task_storage);
  if (task == NULL) {
    runtime.started = false;
    vQueueDelete(runtime.queue);
    runtime.queue = NULL;
    return ESP_ERR_NO_MEM;
  }
  runtime.task = task;
  xTaskNotifyGive(task);
  ESP_LOGI(MODEL_TAG, "Vehicle sensor model worker started boot_id=%" PRIu32, runtime.model.boot_id);
  return ESP_OK;
}

esp_err_t vehicle_sensor_model_runtime_stop(void) {
  if (!runtime.started) {
    return ESP_OK;
  }
  if (xTaskGetCurrentTaskHandle() == runtime.task) {
    return ESP_ERR_INVALID_STATE;
  }
  /* Shutdown owns the worker after the driver is stopped; queued RF work must not delay teardown. */
  xQueueReset(runtime.queue);
  vehicle_sensor_command_t command = {.kind = VEHICLE_SENSOR_COMMAND_STOP};
  if (xQueueSendToFront(runtime.queue, &command, 0) != pdTRUE) {
    return ESP_ERR_TIMEOUT;
  }
  TickType_t waited = 0;
  TickType_t timeout = pdMS_TO_TICKS(VEHICLE_SENSOR_MODEL_STOP_TIMEOUT_MS);
  while (!atomic_load_explicit(&runtime.stopped, memory_order_acquire) && waited < timeout) {
    vTaskDelay(1);
    waited++;
  }
  if (!atomic_load_explicit(&runtime.stopped, memory_order_acquire)) {
    return ESP_ERR_TIMEOUT;
  }
  runtime.task = NULL;
  runtime.started = false;
  vQueueDelete(runtime.queue);
  runtime.queue = NULL;
  return ESP_OK;
}

bool vehicle_sensor_model_runtime_submit_event(const vehicle_sensor_event_t *event) {
  if (event == NULL) {
    return false;
  }
  atomic_store_explicit(&runtime.observed_level, event->level, memory_order_relaxed);
  atomic_store_explicit(&runtime.observed_level_valid, true, memory_order_release);
  vehicle_sensor_command_t command = {
      .kind = VEHICLE_SENSOR_COMMAND_EVENT,
      .value.sensor_event = {
          .event = *event,
          .lifecycle_epoch = atomic_load_explicit(&runtime.lifecycle_epoch, memory_order_acquire),
      },
  };
  return enqueue_command(&command, false, true);
}

bool vehicle_sensor_model_runtime_request_status(
    const esp_ble_mesh_msg_ctx_t *context,
    bool property_id_present,
    uint16_t property_id) {
  if (context == NULL) {
    return false;
  }
  vehicle_sensor_command_t command = {
      .kind = VEHICLE_SENSOR_COMMAND_STATUS_GET,
      .value.status_get = {
          .context = *context,
          .property_id_present = property_id_present,
          .property_id = property_id,
      },
  };
  return enqueue_command(&command, true, false);
}

bool vehicle_sensor_model_runtime_receive_ack(const uint8_t *payload, size_t payload_size) {
  uint32_t boot_id = 0;
  uint32_t sequence = 0;
  if (!vehicle_sensor_ack_decode(payload, payload_size, &boot_id, &sequence)) {
    return false;
  }
  vehicle_sensor_command_t command = {
      .kind = VEHICLE_SENSOR_COMMAND_ACK,
      .value.ack = {.boot_id = boot_id, .sequence = sequence},
  };
  return enqueue_command(&command, true, false);
}

void vehicle_sensor_model_runtime_provisioned(void) {
  vehicle_sensor_command_t command = {.kind = VEHICLE_SENSOR_COMMAND_SYNC};
  (void)enqueue_command(&command, false, false);
}

void vehicle_sensor_model_runtime_reset(void) {
  atomic_fetch_add_explicit(&runtime.lifecycle_epoch, 1U, memory_order_acq_rel);
  if (!runtime.started || runtime.queue == NULL) {
    return;
  }
  /* Reset invalidates every queued command and reserves the next worker action for cleanup. */
  xQueueReset(runtime.queue);
  vehicle_sensor_command_t command = {.kind = VEHICLE_SENSOR_COMMAND_RESET};
  (void)enqueue_command(&command, true, false);
}

void vehicle_sensor_model_runtime_configuration_changed(void) {
  vehicle_sensor_command_t command = {.kind = VEHICLE_SENSOR_COMMAND_SYNC};
  (void)enqueue_command(&command, false, false);
}

void vehicle_sensor_model_runtime_record_send_error(void) {
  vehicle_sensor_command_t command = {.kind = VEHICLE_SENSOR_COMMAND_SEND_ERROR};
  (void)enqueue_command(&command, true, false);
}

bool vehicle_sensor_model_runtime_prepare_publication(esp_ble_mesh_model_t *model) {
  if (model == NULL || model != runtime.config.sensor_model || model->pub == NULL ||
      model->pub->msg == NULL) {
    return false;
  }
  uint8_t status[VEHICLE_SENSOR_STATUS_SIZE];
  bool level = atomic_load_explicit(&runtime.observed_level, memory_order_relaxed);
  if (!atomic_load_explicit(&runtime.observed_level_valid, memory_order_acquire)) {
    level = false;
  }
  size_t status_size = vehicle_sensor_presence_status_encode(level, status, sizeof(status));
  net_buf_simple_reset(model->pub->msg);
  net_buf_simple_add_u8(model->pub->msg, ESP_BLE_MESH_MODEL_OP_SENSOR_STATUS);
  net_buf_simple_add_mem(model->pub->msg, status, status_size);
  return true;
}

uint32_t vehicle_sensor_model_runtime_queue_dropped_count(void) {
  return atomic_load_explicit(&runtime.queue_dropped, memory_order_relaxed);
}

#endif
