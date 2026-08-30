#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef ESP_PLATFORM
#include "mesh/device_property.h"
#define VEHICLE_SENSOR_PRESENCE_PROPERTY_ID BLE_MESH_PRESENCE_DETECTED
#else
/* Mirrors the official assigned property used by the ESP-IDF build. */
#define VEHICLE_SENSOR_PRESENCE_PROPERTY_ID 0x004DU
#endif

#define VEHICLE_SENSOR_RESPONSE_MAX_SIZE 8U

typedef enum {
  VEHICLE_SENSOR_REQUEST_DESCRIPTOR = 0,
  VEHICLE_SENSOR_REQUEST_GET,
  VEHICLE_SENSOR_REQUEST_COLUMN,
  VEHICLE_SENSOR_REQUEST_SERIES,
} vehicle_sensor_request_kind_t;

typedef enum {
  VEHICLE_SENSOR_RESPONSE_READY = 0,
  VEHICLE_SENSOR_RESPONSE_DEFER,
  VEHICLE_SENSOR_RESPONSE_INVALID,
} vehicle_sensor_response_result_t;

typedef struct {
  uint32_t opcode;
  size_t size;
  uint8_t payload[VEHICLE_SENSOR_RESPONSE_MAX_SIZE];
} vehicle_sensor_response_t;

vehicle_sensor_response_result_t vehicle_sensor_mesh_encode_response(
    vehicle_sensor_request_kind_t kind,
    bool property_id_present,
    uint16_t property_id,
    bool current_available,
    bool current_level,
    vehicle_sensor_response_t *response);

#ifdef ESP_PLATFORM
#include "esp_ble_mesh_defs.h"
#include "esp_err.h"

#include "vehicle_sensor_model.h"

typedef struct {
  esp_ble_mesh_model_t *sensor_model;
  esp_ble_mesh_model_t *vendor_model;
  struct net_buf_simple *sensor_raw_value;
  uint32_t vendor_event_opcode;
} vehicle_sensor_mesh_adapter_config_t;

typedef struct {
  vehicle_sensor_mesh_adapter_config_t config;
} vehicle_sensor_mesh_adapter_t;

typedef struct {
  bool provisioned;
  bool sensor_ready;
  bool vendor_ready;
  uint16_t primary_unicast;
} vehicle_sensor_mesh_readiness_t;

void vehicle_sensor_mesh_adapter_init(
    vehicle_sensor_mesh_adapter_t *adapter,
    const vehicle_sensor_mesh_adapter_config_t *config);
void vehicle_sensor_mesh_adapter_sync(
    const vehicle_sensor_mesh_adapter_t *adapter,
    vehicle_sensor_mesh_readiness_t *readiness);
esp_err_t vehicle_sensor_mesh_adapter_send_response(
    vehicle_sensor_mesh_adapter_t *adapter,
    const esp_ble_mesh_msg_ctx_t *context,
    vehicle_sensor_request_kind_t kind,
    bool property_id_present,
    uint16_t property_id,
    bool current_available,
    bool current_level);
esp_err_t vehicle_sensor_mesh_adapter_publish_current(
    vehicle_sensor_mesh_adapter_t *adapter,
    bool current_level);
vehicle_sensor_send_result_t vehicle_sensor_mesh_adapter_publish_event(
    vehicle_sensor_mesh_adapter_t *adapter,
    bool configured,
    const uint8_t payload[VEHICLE_SENSOR_PACKET_SIZE]);
#endif
