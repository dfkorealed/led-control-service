#pragma once

#include "esp_ble_mesh_defs.h"
#include "esp_err.h"

#define ESP_BLE_MESH_MODEL_OP_SENSOR_DESCRIPTOR_STATUS 0x51U
#define ESP_BLE_MESH_MODEL_OP_SENSOR_STATUS 0x52U
#define ESP_BLE_MESH_MODEL_OP_SENSOR_COLUMN_STATUS 0x53U
#define ESP_BLE_MESH_MODEL_OP_SENSOR_SERIES_STATUS 0x54U
#define ESP_BLE_MESH_SENSOR_DATA_ZERO_LEN 0x7fU
#define ESP_BLE_MESH_SENSOR_DATA_FORMAT_A_MPID(length, property_id) \
  ((((uint32_t)(property_id) & 0x7ffU) << 5U) | (((uint32_t)(length) & 0x0fU) << 1U))
#define ESP_BLE_MESH_SENSOR_DATA_FORMAT_B_MPID(length, property_id) \
  (((uint32_t)(property_id) << 8U) | (((uint32_t)(length) & 0x7fU) << 1U) | 1U)
#define ESP_BLE_MESH_SAMPLE_FUNC_INSTANTANEOUS 1U

esp_err_t esp_ble_mesh_server_model_send_msg(
    esp_ble_mesh_model_t *model,
    esp_ble_mesh_msg_ctx_t *context,
    uint32_t opcode,
    uint16_t length,
    uint8_t *data);
