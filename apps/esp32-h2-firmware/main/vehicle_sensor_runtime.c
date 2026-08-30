#include "vehicle_sensor_runtime.h"

#ifdef ESP_PLATFORM

#include <limits.h>
#include <stdatomic.h>

#include "esp_ble_mesh_sensor_model_api.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "vehicle_sensor_model.h"

#define VEHICLE_SENSOR_EVENT_QUEUE_LIMIT 24U
#define VEHICLE_SENSOR_MODEL_TASK_STACK_DEPTH 4096U
#define VEHICLE_SENSOR_MODEL_TASK_PRIORITY 5U
#define VEHICLE_SENSOR_MODEL_IDLE_POLL_MS 1000U
#define VEHICLE_SENSOR_MODEL_STOP_TIMEOUT_MS 1000U
#define VEHICLE_SENSOR_CURRENT_RETRY_MS 1000U

typedef enum {
  VEHICLE_SENSOR_COMMAND_EVENT = 0,
  VEHICLE_SENSOR_COMMAND_ACK,
  VEHICLE_SENSOR_COMMAND_REQUEST,
} vehicle_sensor_command_kind_t;

typedef struct {
  vehicle_sensor_command_kind_t kind;
  uint32_t lifecycle_epoch;
  union {
    vehicle_sensor_event_t event;
    struct {
      uint32_t boot_id;
      uint32_t sequence;
    } ack;
    struct {
      esp_ble_mesh_msg_ctx_t context;
      vehicle_sensor_request_kind_t kind;
      bool property_id_present;
      uint16_t property_id;
    } request;
  } value;
} vehicle_sensor_command_t;

typedef enum {
  VEHICLE_SENSOR_RUNTIME_STOPPED = 0,
  VEHICLE_SENSOR_RUNTIME_OPEN,
  VEHICLE_SENSOR_RUNTIME_CLOSING,
} vehicle_sensor_runtime_state_t;

typedef struct {
  vehicle_sensor_model_runtime_config_t config;
  vehicle_sensor_model_t model;
  vehicle_sensor_health_t health;
  QueueHandle_t queue;
  TaskHandle_t task;
  bool sensor_ready;
  bool vendor_ready;
  uint16_t primary_unicast;
  uint64_t next_publication_ms;
  uint32_t applied_configuration_generation;
  uint32_t applied_reset_generation;
  uint32_t observed_driver_drop_count;
  uint32_t reported_active_mask;
  uint32_t reported_history_mask;
  uint32_t worker_generation;
  bool infrastructure_initialized;
  _Atomic int state;
  _Atomic uint32_t producers;
  _Atomic uint32_t configuration_generation;
  _Atomic uint32_t reset_generation;
  _Atomic uint32_t lifecycle_epoch;
  _Atomic uint32_t queue_dropped;
  _Atomic uint32_t async_fault_mask;
  _Atomic uint32_t run_generation;
  _Atomic uint32_t parked_generation;
  _Atomic bool activated;
  _Atomic bool recovery_needed;
  _Atomic bool sensor_send_fault_active;
  _Atomic bool vendor_send_fault_active;
  _Atomic bool stop_requested;
  _Atomic bool clear_history_needed;
} vehicle_sensor_runtime_t;

static const char *RUNTIME_TAG = "vehicle_sensor_runtime";
static vehicle_sensor_runtime_t runtime;
static StaticQueue_t command_queue_storage;
static uint8_t command_queue_buffer[
    VEHICLE_SENSOR_COMMAND_QUEUE_LENGTH * sizeof(vehicle_sensor_command_t)];
static StaticTask_t model_task_storage;
static StackType_t model_task_stack[VEHICLE_SENSOR_MODEL_TASK_STACK_DEPTH];

#ifdef VEHICLE_SENSOR_HOST_TEST
static void (*after_acquire_hook)(void);
#endif

_Static_assert(ATOMIC_BOOL_LOCK_FREE == 2, "runtime bool atomics must be lock-free");
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "runtime counters must be lock-free");

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

static void notify_faults(bool force) {
  uint32_t active = vehicle_sensor_health_active_mask(&runtime.health);
  uint32_t history = vehicle_sensor_health_history_mask(&runtime.health);
  if (!force && active == runtime.reported_active_mask &&
      history == runtime.reported_history_mask) {
    return;
  }
  runtime.reported_active_mask = active;
  runtime.reported_history_mask = history;
  if (runtime.config.fault_handler != NULL) {
    runtime.config.fault_handler(active, history, runtime.config.fault_context);
  }
}

static void notify_faults_if_changed(void) {
  notify_faults(false);
}

static void activate_fault(uint32_t mask) {
  vehicle_sensor_health_activate(&runtime.health, mask);
  notify_faults_if_changed();
}

static void recover_fault(uint32_t mask) {
  vehicle_sensor_health_recover_transient(&runtime.health, mask);
  notify_faults_if_changed();
}

static void sync_send_fault_health(void) {
  bool active = atomic_load_explicit(
      &runtime.sensor_send_fault_active, memory_order_acquire) ||
      atomic_load_explicit(&runtime.vendor_send_fault_active, memory_order_acquire);
  if (active) {
    if ((vehicle_sensor_health_active_mask(&runtime.health) &
         VEHICLE_SENSOR_FAULT_SEND_ERROR) == 0) {
      activate_fault(VEHICLE_SENSOR_FAULT_SEND_ERROR);
    }
  } else {
    recover_fault(VEHICLE_SENSOR_FAULT_SEND_ERROR);
  }
}

static void set_send_channel_fault(vehicle_sensor_send_channel_t channel, bool active) {
  _Atomic bool *channel_fault = channel == VEHICLE_SENSOR_SEND_CHANNEL_SENSOR ?
      &runtime.sensor_send_fault_active : &runtime.vendor_send_fault_active;
  atomic_store_explicit(channel_fault, active, memory_order_release);
  sync_send_fault_health();
}

static void wake_worker(void) {
  if (runtime.task != NULL) {
    (void)xTaskNotifyGive(runtime.task);
  }
}

static bool producer_acquire(void) {
  if (atomic_load_explicit(&runtime.state, memory_order_acquire) != VEHICLE_SENSOR_RUNTIME_OPEN) {
    return false;
  }
  atomic_fetch_add_explicit(&runtime.producers, 1U, memory_order_acq_rel);
  if (atomic_load_explicit(&runtime.state, memory_order_acquire) != VEHICLE_SENSOR_RUNTIME_OPEN) {
    atomic_fetch_sub_explicit(&runtime.producers, 1U, memory_order_acq_rel);
    return false;
  }
#ifdef VEHICLE_SENSOR_HOST_TEST
  if (after_acquire_hook != NULL) {
    after_acquire_hook();
  }
#endif
  return true;
}

static void producer_release(void) {
  atomic_fetch_sub_explicit(&runtime.producers, 1U, memory_order_acq_rel);
}

static bool enqueue_command(const vehicle_sensor_command_t *command, bool front, bool sensor_event) {
  if (command == NULL || !producer_acquire()) {
    return false;
  }
  bool accepted = false;
  if (sensor_event && uxQueueMessagesWaiting(runtime.queue) >= VEHICLE_SENSOR_EVENT_QUEUE_LIMIT) {
    atomic_increment_saturating(&runtime.queue_dropped);
    atomic_fetch_or_explicit(
        &runtime.async_fault_mask,
        VEHICLE_SENSOR_FAULT_DROPPED,
        memory_order_release);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
  } else {
    BaseType_t result = front ?
        xQueueSendToFront(runtime.queue, command, 0) : xQueueSend(runtime.queue, command, 0);
    accepted = result == pdTRUE;
    if (!accepted) {
      atomic_increment_saturating(&runtime.queue_dropped);
      atomic_fetch_or_explicit(
          &runtime.async_fault_mask,
          VEHICLE_SENSOR_FAULT_DROPPED,
          memory_order_release);
      atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
    }
  }
  wake_worker();
  producer_release();
  return accepted;
}

static vehicle_sensor_send_result_t send_vendor_event(
    const uint8_t payload[VEHICLE_SENSOR_PACKET_SIZE],
    void *context) {
  (void)context;
  vehicle_sensor_send_result_t result = VEHICLE_SENSOR_SEND_UNCONFIGURED;
  if (runtime.vendor_ready) {
    result = vehicle_sensor_mesh_adapter_publish_event(
        runtime.config.mesh_adapter,
        true,
        payload);
  }
  if (result == VEHICLE_SENSOR_SEND_OK) {
    set_send_channel_fault(VEHICLE_SENSOR_SEND_CHANNEL_VENDOR, false);
    if (runtime.sensor_ready && runtime.vendor_ready) {
      recover_fault(VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED);
    }
  } else if (result == VEHICLE_SENSOR_SEND_UNCONFIGURED) {
    activate_fault(VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
  } else {
    set_send_channel_fault(VEHICLE_SENSOR_SEND_CHANNEL_VENDOR, true);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
  }
  return result;
}

static bool publish_authoritative_current(uint64_t now_ms) {
  bool level = false;
  if (!vehicle_sensor_driver_get_current_level(&level)) {
    activate_fault(VEHICLE_SENSOR_FAULT_DROPPED);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
    runtime.next_publication_ms = now_ms + VEHICLE_SENSOR_CURRENT_RETRY_MS;
    return false;
  }
  if (!runtime.sensor_ready) {
    activate_fault(VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
    return false;
  }
  atomic_store_explicit(&runtime.recovery_needed, false, memory_order_release);
  esp_err_t error = vehicle_sensor_mesh_adapter_publish_current(runtime.config.mesh_adapter, level);
  if (error != ESP_OK) {
    vehicle_sensor_model_record_send_error(&runtime.model);
    set_send_channel_fault(VEHICLE_SENSOR_SEND_CHANNEL_SENSOR, true);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
    runtime.next_publication_ms = now_ms + VEHICLE_SENSOR_CURRENT_RETRY_MS;
    return false;
  }
  set_send_channel_fault(VEHICLE_SENSOR_SEND_CHANNEL_SENSOR, false);
  runtime.next_publication_ms = now_ms +
      vehicle_sensor_publication_interval_ms(runtime.primary_unicast);
  recover_fault(
      VEHICLE_SENSOR_FAULT_DROPPED |
      VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED);
  if (runtime.vendor_ready) {
    recover_fault(VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED);
  }
  return true;
}

static void sync_configuration(uint64_t now_ms, bool publish_current) {
  vehicle_sensor_mesh_readiness_t readiness = {0};
  vehicle_sensor_mesh_adapter_sync(runtime.config.mesh_adapter, &readiness);
  bool sensor_became_ready = !runtime.sensor_ready && readiness.sensor_ready;
  runtime.sensor_ready = readiness.sensor_ready;
  runtime.vendor_ready = readiness.vendor_ready;
  runtime.primary_unicast = readiness.primary_unicast;
  if (!runtime.sensor_ready) {
    runtime.next_publication_ms = UINT64_MAX;
  } else if (sensor_became_ready || runtime.next_publication_ms == UINT64_MAX) {
    runtime.next_publication_ms = now_ms +
        vehicle_sensor_publication_interval_ms(runtime.primary_unicast);
  }
  if (runtime.sensor_ready && runtime.vendor_ready) {
    recover_fault(VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED);
  } else if (readiness.provisioned) {
    activate_fault(VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED);
  } else {
    recover_fault(VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED);
  }
  if (publish_current && runtime.sensor_ready) {
    (void)publish_authoritative_current(now_ms);
  }
}

static void apply_latches(uint64_t now_ms) {
  uint32_t async_faults = atomic_exchange_explicit(
      &runtime.async_fault_mask, 0, memory_order_acq_rel);
  if (async_faults != 0) {
    activate_fault(async_faults);
  }
  sync_send_fault_health();
  if (atomic_exchange_explicit(&runtime.clear_history_needed, false, memory_order_acq_rel)) {
    vehicle_sensor_health_clear_history(&runtime.health);
    notify_faults_if_changed();
  }

  uint32_t reset_generation = atomic_load_explicit(&runtime.reset_generation, memory_order_acquire);
  if (reset_generation != runtime.applied_reset_generation) {
    runtime.applied_reset_generation = reset_generation;
    runtime.sensor_ready = false;
    runtime.vendor_ready = false;
    runtime.primary_unicast = ESP_BLE_MESH_ADDR_UNASSIGNED;
    runtime.next_publication_ms = UINT64_MAX;
    vehicle_sensor_model_reset_pending(&runtime.model);
  }

  uint32_t configuration_generation = atomic_load_explicit(
      &runtime.configuration_generation, memory_order_acquire);
  if (configuration_generation != runtime.applied_configuration_generation) {
    bool publish_current = runtime.applied_configuration_generation != 0;
    sync_configuration(now_ms, publish_current);
    runtime.applied_configuration_generation = configuration_generation;
  }

  uint32_t driver_drop_count = vehicle_sensor_driver_dropped_edge_count();
  if (driver_drop_count != runtime.observed_driver_drop_count) {
    runtime.observed_driver_drop_count = driver_drop_count;
    activate_fault(VEHICLE_SENSOR_FAULT_DROPPED);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
  }
}

static void handle_event(const vehicle_sensor_event_t *event, uint64_t now_ms) {
  vehicle_sensor_submit_result_t result = vehicle_sensor_model_submit_event(
      &runtime.model, event->kind, event->level, now_ms, NULL);
  if (result == VEHICLE_SENSOR_SUBMIT_PENDING_FULL) {
    activate_fault(VEHICLE_SENSOR_FAULT_DROPPED);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
  } else if (result == VEHICLE_SENSOR_SUBMIT_SEQUENCE_EXHAUSTED ||
             runtime.model.sequence_exhausted) {
    activate_fault(VEHICLE_SENSOR_FAULT_SEQUENCE_EXHAUSTED);
  }
}

static void handle_request(const vehicle_sensor_command_t *command) {
  const bool needs_current = command->value.request.kind == VEHICLE_SENSOR_REQUEST_GET &&
      (!command->value.request.property_id_present ||
       command->value.request.property_id == VEHICLE_SENSOR_PRESENCE_PROPERTY_ID);
  bool level = false;
  bool available = !needs_current || vehicle_sensor_driver_get_current_level(&level);
  esp_err_t error = vehicle_sensor_mesh_adapter_send_response(
      runtime.config.mesh_adapter,
      &command->value.request.context,
      command->value.request.kind,
      command->value.request.property_id_present,
      command->value.request.property_id,
      available,
      level);
  if (error == ESP_ERR_INVALID_STATE && needs_current) {
    activate_fault(VEHICLE_SENSOR_FAULT_DROPPED);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
  } else if (error != ESP_OK) {
    vehicle_sensor_model_record_send_error(&runtime.model);
    set_send_channel_fault(VEHICLE_SENSOR_SEND_CHANNEL_SENSOR, true);
  } else {
    set_send_channel_fault(VEHICLE_SENSOR_SEND_CHANNEL_SENSOR, false);
  }
}

static void handle_command(const vehicle_sensor_command_t *command, uint64_t now_ms) {
  if (command->lifecycle_epoch !=
      atomic_load_explicit(&runtime.lifecycle_epoch, memory_order_acquire)) {
    return;
  }
  switch (command->kind) {
  case VEHICLE_SENSOR_COMMAND_EVENT:
    handle_event(&command->value.event, now_ms);
    break;
  case VEHICLE_SENSOR_COMMAND_ACK:
    if (vehicle_sensor_model_on_ack(
            &runtime.model, command->value.ack.boot_id, command->value.ack.sequence)) {
      set_send_channel_fault(VEHICLE_SENSOR_SEND_CHANNEL_VENDOR, false);
    }
    break;
  case VEHICLE_SENSOR_COMMAND_REQUEST:
    handle_request(command);
    break;
  }
}

static void process_runtime_once(void) {
  uint64_t now_ms = runtime_now_ms();
  apply_latches(now_ms);
  vehicle_sensor_command_t command;
  for (size_t count = 0; count < VEHICLE_SENSOR_COMMAND_QUEUE_LENGTH; count++) {
    if (atomic_load_explicit(&runtime.stop_requested, memory_order_acquire) ||
        xQueueReceive(runtime.queue, &command, 0) != pdTRUE) {
      break;
    }
    handle_command(&command, runtime_now_ms());
    apply_latches(runtime_now_ms());
  }

  now_ms = runtime_now_ms();
  uint32_t retry_exhausted_before = runtime.model.retry_exhausted_count;
  vehicle_sensor_model_process_time(&runtime.model, now_ms);
  if (runtime.model.retry_exhausted_count != retry_exhausted_before) {
    activate_fault(VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED);
    atomic_store_explicit(&runtime.recovery_needed, true, memory_order_release);
  }
  if (runtime.next_publication_ms != UINT64_MAX && now_ms >= runtime.next_publication_ms) {
    (void)publish_authoritative_current(now_ms);
  } else if (atomic_load_explicit(&runtime.recovery_needed, memory_order_acquire) &&
             uxQueueMessagesWaiting(runtime.queue) == 0) {
    (void)publish_authoritative_current(now_ms);
  }
  apply_latches(runtime_now_ms());
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
  for (;;) {
    uint32_t requested_generation = atomic_load_explicit(
        &runtime.run_generation, memory_order_acquire);
    while (requested_generation == runtime.worker_generation) {
      (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
      requested_generation = atomic_load_explicit(
          &runtime.run_generation, memory_order_acquire);
    }
    runtime.worker_generation = requested_generation;

    while (!atomic_load_explicit(&runtime.activated, memory_order_acquire) &&
           !atomic_load_explicit(&runtime.stop_requested, memory_order_acquire)) {
      (void)ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    }
    while (!atomic_load_explicit(&runtime.stop_requested, memory_order_acquire)) {
      process_runtime_once();
      if (!atomic_load_explicit(&runtime.stop_requested, memory_order_acquire)) {
        (void)ulTaskNotifyTake(pdTRUE, next_wait_ticks(runtime_now_ms()));
      }
    }
    (void)xQueueReset(runtime.queue);
    atomic_store_explicit(
        &runtime.parked_generation, runtime.worker_generation, memory_order_release);
  }
}

static esp_err_t ensure_runtime_infrastructure(void) {
  if (runtime.infrastructure_initialized) {
    return ESP_OK;
  }
  atomic_init(&runtime.state, VEHICLE_SENSOR_RUNTIME_STOPPED);
  atomic_init(&runtime.producers, 0);
  atomic_init(&runtime.configuration_generation, 0);
  atomic_init(&runtime.reset_generation, 0);
  atomic_init(&runtime.lifecycle_epoch, 0);
  atomic_init(&runtime.queue_dropped, 0);
  atomic_init(&runtime.async_fault_mask, 0);
  atomic_init(&runtime.run_generation, 0);
  atomic_init(&runtime.parked_generation, 0);
  atomic_init(&runtime.activated, false);
  atomic_init(&runtime.recovery_needed, false);
  atomic_init(&runtime.sensor_send_fault_active, false);
  atomic_init(&runtime.vendor_send_fault_active, false);
  atomic_init(&runtime.stop_requested, false);
  atomic_init(&runtime.clear_history_needed, false);

  runtime.queue = xQueueCreateStatic(
      VEHICLE_SENSOR_COMMAND_QUEUE_LENGTH,
      sizeof(vehicle_sensor_command_t),
      command_queue_buffer,
      &command_queue_storage);
  if (runtime.queue == NULL) {
    return ESP_ERR_NO_MEM;
  }
  runtime.task = xTaskCreateStatic(
      vehicle_sensor_model_task,
      "vehicle_sensor_model",
      VEHICLE_SENSOR_MODEL_TASK_STACK_DEPTH,
      NULL,
      VEHICLE_SENSOR_MODEL_TASK_PRIORITY,
      model_task_stack,
      &model_task_storage);
  if (runtime.task == NULL) {
    runtime.queue = NULL;
    return ESP_ERR_NO_MEM;
  }
  runtime.infrastructure_initialized = true;
  return ESP_OK;
}

static void reset_runtime_session(
    const vehicle_sensor_model_runtime_config_t *config,
    uint32_t generation) {
  runtime.config = *config;
  runtime.sensor_ready = false;
  runtime.vendor_ready = false;
  runtime.primary_unicast = ESP_BLE_MESH_ADDR_UNASSIGNED;
  runtime.next_publication_ms = UINT64_MAX;
  runtime.applied_configuration_generation = 0;
  runtime.applied_reset_generation = 0;
  runtime.observed_driver_drop_count = 0;
  (void)xQueueReset(runtime.queue);
  vehicle_sensor_health_init(&runtime.health);
  notify_faults(true);
  vehicle_sensor_model_init(&runtime.model, esp_random(), send_vendor_event, NULL);
  atomic_store_explicit(&runtime.producers, 0, memory_order_relaxed);
  atomic_store_explicit(&runtime.configuration_generation, 1, memory_order_relaxed);
  atomic_store_explicit(&runtime.reset_generation, 0, memory_order_relaxed);
  atomic_store_explicit(&runtime.lifecycle_epoch, generation, memory_order_relaxed);
  atomic_store_explicit(&runtime.queue_dropped, 0, memory_order_relaxed);
  atomic_store_explicit(&runtime.async_fault_mask, 0, memory_order_relaxed);
  atomic_store_explicit(&runtime.activated, false, memory_order_relaxed);
  atomic_store_explicit(&runtime.recovery_needed, false, memory_order_relaxed);
  atomic_store_explicit(&runtime.sensor_send_fault_active, false, memory_order_relaxed);
  atomic_store_explicit(&runtime.vendor_send_fault_active, false, memory_order_relaxed);
  atomic_store_explicit(&runtime.stop_requested, false, memory_order_relaxed);
  atomic_store_explicit(&runtime.clear_history_needed, false, memory_order_relaxed);
}

esp_err_t vehicle_sensor_model_runtime_start(const vehicle_sensor_model_runtime_config_t *config) {
  if (config == NULL || config->mesh_adapter == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  if (atomic_load_explicit(&runtime.state, memory_order_acquire) != VEHICLE_SENSOR_RUNTIME_STOPPED) {
    return ESP_ERR_INVALID_STATE;
  }
  esp_err_t infrastructure_error = ensure_runtime_infrastructure();
  if (infrastructure_error != ESP_OK) {
    return infrastructure_error;
  }
  uint32_t generation = atomic_load_explicit(&runtime.run_generation, memory_order_acquire);
  if (atomic_load_explicit(&runtime.parked_generation, memory_order_acquire) != generation ||
      generation == UINT32_MAX) {
    return ESP_ERR_INVALID_STATE;
  }
  generation += 1U;
  reset_runtime_session(config, generation);
  atomic_store_explicit(&runtime.run_generation, generation, memory_order_release);
  atomic_store_explicit(&runtime.state, VEHICLE_SENSOR_RUNTIME_OPEN, memory_order_release);
  wake_worker();
  ESP_LOGI(RUNTIME_TAG, "Vehicle sensor runtime started");
  return ESP_OK;
}

esp_err_t vehicle_sensor_model_runtime_activate(void) {
  if (atomic_load_explicit(&runtime.state, memory_order_acquire) != VEHICLE_SENSOR_RUNTIME_OPEN) {
    return ESP_ERR_INVALID_STATE;
  }
  atomic_store_explicit(&runtime.activated, true, memory_order_release);
  wake_worker();
  return ESP_OK;
}

esp_err_t vehicle_sensor_model_runtime_stop(void) {
  int state = atomic_load_explicit(&runtime.state, memory_order_acquire);
  if (state == VEHICLE_SENSOR_RUNTIME_STOPPED) {
    return ESP_OK;
  }
  if (xTaskGetCurrentTaskHandle() == runtime.task) {
    return ESP_ERR_INVALID_STATE;
  }

  int expected = VEHICLE_SENSOR_RUNTIME_OPEN;
  (void)atomic_compare_exchange_strong_explicit(
      &runtime.state,
      &expected,
      VEHICLE_SENSOR_RUNTIME_CLOSING,
      memory_order_acq_rel,
      memory_order_acquire);

  TickType_t waited = 0;
  TickType_t timeout = pdMS_TO_TICKS(VEHICLE_SENSOR_MODEL_STOP_TIMEOUT_MS);
  while (atomic_load_explicit(&runtime.producers, memory_order_acquire) != 0 && waited < timeout) {
    vTaskDelay(1);
    waited++;
  }
  if (atomic_load_explicit(&runtime.producers, memory_order_acquire) != 0) {
    return ESP_ERR_TIMEOUT;
  }
  atomic_store_explicit(&runtime.stop_requested, true, memory_order_release);
  wake_worker();
  uint32_t generation = atomic_load_explicit(&runtime.run_generation, memory_order_acquire);
  while (atomic_load_explicit(&runtime.parked_generation, memory_order_acquire) != generation &&
         waited < timeout) {
    vTaskDelay(1);
    waited++;
  }
  if (atomic_load_explicit(&runtime.parked_generation, memory_order_acquire) != generation) {
    return ESP_ERR_TIMEOUT;
  }
  atomic_store_explicit(&runtime.state, VEHICLE_SENSOR_RUNTIME_STOPPED, memory_order_release);
  return ESP_OK;
}

bool vehicle_sensor_model_runtime_submit_event(const vehicle_sensor_event_t *event) {
  if (event == NULL) {
    return false;
  }
  vehicle_sensor_command_t command = {
      .kind = VEHICLE_SENSOR_COMMAND_EVENT,
      .lifecycle_epoch = atomic_load_explicit(&runtime.lifecycle_epoch, memory_order_acquire),
      .value.event = *event,
  };
  return enqueue_command(&command, false, true);
}

bool vehicle_sensor_model_runtime_request(
    const esp_ble_mesh_msg_ctx_t *context,
    vehicle_sensor_request_kind_t kind,
    bool property_id_present,
    uint16_t property_id) {
  if (context == NULL) {
    return false;
  }
  vehicle_sensor_command_t command = {
      .kind = VEHICLE_SENSOR_COMMAND_REQUEST,
      .lifecycle_epoch = atomic_load_explicit(&runtime.lifecycle_epoch, memory_order_acquire),
      .value.request = {
          .context = *context,
          .kind = kind,
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
      .lifecycle_epoch = atomic_load_explicit(&runtime.lifecycle_epoch, memory_order_acquire),
      .value.ack = {.boot_id = boot_id, .sequence = sequence},
  };
  return enqueue_command(&command, true, false);
}

static void request_configuration_sync(void) {
  if (!producer_acquire()) {
    return;
  }
  atomic_fetch_add_explicit(&runtime.configuration_generation, 1U, memory_order_acq_rel);
  wake_worker();
  producer_release();
}

void vehicle_sensor_model_runtime_provisioned(void) {
  request_configuration_sync();
}

void vehicle_sensor_model_runtime_reset(void) {
  if (!producer_acquire()) {
    return;
  }
  atomic_fetch_add_explicit(&runtime.lifecycle_epoch, 1U, memory_order_acq_rel);
  atomic_fetch_add_explicit(&runtime.reset_generation, 1U, memory_order_acq_rel);
  atomic_fetch_add_explicit(&runtime.configuration_generation, 1U, memory_order_acq_rel);
  wake_worker();
  producer_release();
}

void vehicle_sensor_model_runtime_configuration_changed(void) {
  request_configuration_sync();
}

void vehicle_sensor_model_runtime_record_send_result(
    esp_ble_mesh_model_t *model,
    bool successful) {
  (void)model;
  (void)successful;
  /* ESP-IDF v5.5.1 exposes only model/error here, so this callback cannot be
     correlated to an individual publish. Delivery state comes from the
     synchronous API result and, for vendor events, exact ACK/retry exhaustion. */
}

void vehicle_sensor_model_runtime_clear_fault_history(void) {
  if (!producer_acquire()) {
    return;
  }
  atomic_store_explicit(&runtime.clear_history_needed, true, memory_order_release);
  wake_worker();
  producer_release();
}

uint32_t vehicle_sensor_model_runtime_queue_dropped_count(void) {
  return atomic_load_explicit(&runtime.queue_dropped, memory_order_relaxed);
}

#ifdef VEHICLE_SENSOR_HOST_TEST
void vehicle_sensor_model_runtime_test_process_once(void) {
  process_runtime_once();
}

size_t vehicle_sensor_model_runtime_test_queue_count(void) {
  return uxQueueMessagesWaiting(runtime.queue);
}

bool vehicle_sensor_model_runtime_test_configuration_converged(void) {
  return runtime.applied_configuration_generation ==
      atomic_load_explicit(&runtime.configuration_generation, memory_order_acquire);
}

bool vehicle_sensor_model_runtime_test_sensor_ready(void) {
  return runtime.sensor_ready;
}

bool vehicle_sensor_model_runtime_test_vendor_ready(void) {
  return runtime.vendor_ready;
}

uint32_t vehicle_sensor_model_runtime_test_boot_id(void) {
  return runtime.model.boot_id;
}

uint64_t vehicle_sensor_model_runtime_test_next_publication_ms(void) {
  return runtime.next_publication_ms;
}

void vehicle_sensor_model_runtime_test_set_after_acquire_hook(void (*hook)(void)) {
  after_acquire_hook = hook;
}

void vehicle_sensor_model_runtime_test_set_next_sequence(uint32_t sequence) {
  runtime.model.next_sequence = sequence;
  runtime.model.sequence_exhausted = false;
}
#endif

#endif
