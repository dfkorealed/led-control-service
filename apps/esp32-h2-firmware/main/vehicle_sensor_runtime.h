#pragma once

#ifdef ESP_PLATFORM

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_ble_mesh_defs.h"
#include "esp_err.h"

#include "vehicle_sensor_driver.h"
#include "vehicle_sensor_health.h"
#include "vehicle_sensor_mesh_adapter.h"

#define VEHICLE_SENSOR_COMMAND_QUEUE_LENGTH 32U

typedef void (*vehicle_sensor_fault_handler_t)(
    uint32_t active_mask,
    uint32_t history_mask,
    void *context);

typedef struct {
  vehicle_sensor_mesh_adapter_t *mesh_adapter;
  vehicle_sensor_fault_handler_t fault_handler;
  void *fault_context;
} vehicle_sensor_model_runtime_config_t;

esp_err_t vehicle_sensor_model_runtime_start(const vehicle_sensor_model_runtime_config_t *config);
esp_err_t vehicle_sensor_model_runtime_activate(void);
esp_err_t vehicle_sensor_model_runtime_stop(void);
bool vehicle_sensor_model_runtime_submit_event(const vehicle_sensor_event_t *event);
bool vehicle_sensor_model_runtime_request(
    const esp_ble_mesh_msg_ctx_t *context,
    vehicle_sensor_request_kind_t kind,
    bool property_id_present,
    uint16_t property_id);
bool vehicle_sensor_model_runtime_receive_ack(const uint8_t *payload, size_t payload_size);
void vehicle_sensor_model_runtime_provisioned(void);
void vehicle_sensor_model_runtime_reset(void);
void vehicle_sensor_model_runtime_configuration_changed(void);
void vehicle_sensor_model_runtime_record_send_error(void);
void vehicle_sensor_model_runtime_clear_fault_history(void);
uint32_t vehicle_sensor_model_runtime_queue_dropped_count(void);

#ifdef VEHICLE_SENSOR_HOST_TEST
void vehicle_sensor_model_runtime_test_process_once(void);
size_t vehicle_sensor_model_runtime_test_queue_count(void);
bool vehicle_sensor_model_runtime_test_configuration_converged(void);
bool vehicle_sensor_model_runtime_test_sensor_ready(void);
bool vehicle_sensor_model_runtime_test_vendor_ready(void);
uint32_t vehicle_sensor_model_runtime_test_boot_id(void);
uint64_t vehicle_sensor_model_runtime_test_next_publication_ms(void);
void vehicle_sensor_model_runtime_test_set_after_acquire_hook(void (*hook)(void));
void vehicle_sensor_model_runtime_test_set_next_sequence(uint32_t sequence);
#endif

#endif
