#include "vehicle_sensor_mesh_adapter.h"

#include <string.h>

#include "vehicle_sensor_model.h"

#ifdef ESP_PLATFORM
#include "esp_ble_mesh_local_data_operation_api.h"
#include "esp_ble_mesh_networking_api.h"
#include "esp_ble_mesh_provisioning_api.h"
#include "esp_ble_mesh_sensor_model_api.h"
#define SENSOR_DESCRIPTOR_STATUS_OPCODE ESP_BLE_MESH_MODEL_OP_SENSOR_DESCRIPTOR_STATUS
#define SENSOR_STATUS_OPCODE ESP_BLE_MESH_MODEL_OP_SENSOR_STATUS
#define SENSOR_COLUMN_STATUS_OPCODE ESP_BLE_MESH_MODEL_OP_SENSOR_COLUMN_STATUS
#define SENSOR_SERIES_STATUS_OPCODE ESP_BLE_MESH_MODEL_OP_SENSOR_SERIES_STATUS
#define SENSOR_ZERO_LENGTH ESP_BLE_MESH_SENSOR_DATA_ZERO_LEN
#define SENSOR_FORMAT_B_MPID(length, property_id) \
  ESP_BLE_MESH_SENSOR_DATA_FORMAT_B_MPID((length), (property_id))
#define SENSOR_SAMPLE_FUNCTION ESP_BLE_MESH_SAMPLE_FUNC_INSTANTANEOUS
#else
#define SENSOR_DESCRIPTOR_STATUS_OPCODE 0x51U
#define SENSOR_STATUS_OPCODE 0x52U
#define SENSOR_COLUMN_STATUS_OPCODE 0x53U
#define SENSOR_SERIES_STATUS_OPCODE 0x54U
#define SENSOR_ZERO_LENGTH 0x7FU
#define SENSOR_FORMAT_B_MPID(length, property_id) \
  (((uint32_t)(property_id) << 8U) | (((uint32_t)(length) & 0x7FU) << 1U) | 1U)
#define SENSOR_SAMPLE_FUNCTION 0x01U
#endif

#define VEHICLE_SENSOR_NET_KEY_INDEX 0U

static void write_le16(uint8_t *output, uint16_t value) {
  output[0] = (uint8_t)value;
  output[1] = (uint8_t)(value >> 8U);
}

static vehicle_sensor_response_result_t encode_descriptor(
    bool property_id_present,
    uint16_t property_id,
    vehicle_sensor_response_t *response) {
  response->opcode = SENSOR_DESCRIPTOR_STATUS_OPCODE;
  uint16_t response_property = property_id_present ? property_id : VEHICLE_SENSOR_PRESENCE_PROPERTY_ID;
  write_le16(response->payload, response_property);
  if (response_property != VEHICLE_SENSOR_PRESENCE_PROPERTY_ID) {
    response->size = 2;
    return VEHICLE_SENSOR_RESPONSE_READY;
  }
  memset(response->payload + 2, 0, 6);
  response->payload[5] = SENSOR_SAMPLE_FUNCTION;
  response->size = 8;
  return VEHICLE_SENSOR_RESPONSE_READY;
}

static vehicle_sensor_response_result_t encode_sensor_get(
    bool property_id_present,
    uint16_t property_id,
    bool current_available,
    bool current_level,
    vehicle_sensor_response_t *response) {
  response->opcode = SENSOR_STATUS_OPCODE;
  if (property_id_present && property_id != VEHICLE_SENSOR_PRESENCE_PROPERTY_ID) {
    uint32_t mpid = SENSOR_FORMAT_B_MPID(SENSOR_ZERO_LENGTH, property_id);
    response->payload[0] = (uint8_t)mpid;
    response->payload[1] = (uint8_t)(mpid >> 8U);
    response->payload[2] = (uint8_t)(mpid >> 16U);
    response->size = 3;
    return VEHICLE_SENSOR_RESPONSE_READY;
  }
  if (!current_available) {
    return VEHICLE_SENSOR_RESPONSE_DEFER;
  }
  response->size = vehicle_sensor_presence_status_encode(
      current_level,
      response->payload,
      sizeof(response->payload));
  return response->size == 0 ? VEHICLE_SENSOR_RESPONSE_INVALID : VEHICLE_SENSOR_RESPONSE_READY;
}

vehicle_sensor_response_result_t vehicle_sensor_mesh_encode_response(
    vehicle_sensor_request_kind_t kind,
    bool property_id_present,
    uint16_t property_id,
    bool current_available,
    bool current_level,
    vehicle_sensor_response_t *response) {
  if (response == NULL || (property_id_present && property_id == 0)) {
    return VEHICLE_SENSOR_RESPONSE_INVALID;
  }
  memset(response, 0, sizeof(*response));
  switch (kind) {
  case VEHICLE_SENSOR_REQUEST_DESCRIPTOR:
    return encode_descriptor(property_id_present, property_id, response);
  case VEHICLE_SENSOR_REQUEST_GET:
    return encode_sensor_get(
        property_id_present,
        property_id,
        current_available,
        current_level,
        response);
  case VEHICLE_SENSOR_REQUEST_COLUMN:
    response->opcode = SENSOR_COLUMN_STATUS_OPCODE;
    break;
  case VEHICLE_SENSOR_REQUEST_SERIES:
    response->opcode = SENSOR_SERIES_STATUS_OPCODE;
    break;
  default:
    return VEHICLE_SENSOR_RESPONSE_INVALID;
  }
  if (!property_id_present) {
    return VEHICLE_SENSOR_RESPONSE_INVALID;
  }
  write_le16(response->payload, property_id);
  response->size = 2;
  return VEHICLE_SENSOR_RESPONSE_READY;
}

#ifdef ESP_PLATFORM
static bool model_has_key(const esp_ble_mesh_model_t *model, uint16_t app_idx) {
  if (model == NULL || app_idx == ESP_BLE_MESH_KEY_UNUSED) {
    return false;
  }
  for (size_t index = 0; index < CONFIG_BLE_MESH_MODEL_KEY_COUNT; index++) {
    if (model->keys[index] == app_idx) {
      return true;
    }
  }
  return false;
}

static bool model_publication_ready(const esp_ble_mesh_model_t *model) {
  return model != NULL && model->pub != NULL &&
         model->pub->publish_addr != ESP_BLE_MESH_ADDR_UNASSIGNED &&
         model->pub->period == 0 && model->pub->retransmit == 0 &&
         model_has_key(model, model->pub->app_idx);
}

static bool model_publication_context(
    const esp_ble_mesh_model_t *model,
    esp_ble_mesh_msg_ctx_t *context) {
  if (!model_publication_ready(model) || context == NULL) {
    return false;
  }
  memset(context, 0, sizeof(*context));
  /* Gateway provisioning reserves NetKey 0; the remaining fields mirror the
     live publication config so application sends preserve its wire context. */
  context->net_idx = VEHICLE_SENSOR_NET_KEY_INDEX;
  context->app_idx = model->pub->app_idx;
  context->addr = model->pub->publish_addr;
  context->send_ttl = model->pub->ttl;
  context->send_cred = model->pub->cred;
  context->send_szmic = model->pub->send_szmic;
  return true;
}

static void update_raw_value(vehicle_sensor_mesh_adapter_t *adapter, bool level) {
  struct net_buf_simple *raw = adapter->config.sensor_raw_value;
  if (raw != NULL) {
    net_buf_simple_reset(raw);
    net_buf_simple_add_u8(raw, level ? 1U : 0U);
  }
}

void vehicle_sensor_mesh_adapter_init(
    vehicle_sensor_mesh_adapter_t *adapter,
    const vehicle_sensor_mesh_adapter_config_t *config) {
  if (adapter != NULL && config != NULL) {
    adapter->config = *config;
  }
}

void vehicle_sensor_mesh_adapter_sync(
    const vehicle_sensor_mesh_adapter_t *adapter,
    vehicle_sensor_mesh_readiness_t *readiness) {
  if (adapter == NULL || readiness == NULL) {
    return;
  }
  readiness->provisioned = esp_ble_mesh_node_is_provisioned();
  readiness->sensor_ready = readiness->provisioned &&
      model_publication_ready(adapter->config.sensor_model);
  readiness->vendor_ready = readiness->provisioned &&
      model_publication_ready(adapter->config.vendor_model);
  readiness->primary_unicast = readiness->provisioned ?
      esp_ble_mesh_get_primary_element_address() : ESP_BLE_MESH_ADDR_UNASSIGNED;
}

esp_err_t vehicle_sensor_mesh_adapter_send_response(
    vehicle_sensor_mesh_adapter_t *adapter,
    const esp_ble_mesh_msg_ctx_t *context,
    vehicle_sensor_request_kind_t kind,
    bool property_id_present,
    uint16_t property_id,
    bool current_available,
    bool current_level) {
  if (adapter == NULL || context == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  vehicle_sensor_response_t response;
  vehicle_sensor_response_result_t result = vehicle_sensor_mesh_encode_response(
      kind,
      property_id_present,
      property_id,
      current_available,
      current_level,
      &response);
  if (result == VEHICLE_SENSOR_RESPONSE_DEFER) {
    return ESP_ERR_INVALID_STATE;
  }
  if (result != VEHICLE_SENSOR_RESPONSE_READY) {
    return ESP_ERR_INVALID_ARG;
  }
  if (kind == VEHICLE_SENSOR_REQUEST_GET && current_available &&
      (!property_id_present || property_id == VEHICLE_SENSOR_PRESENCE_PROPERTY_ID)) {
    update_raw_value(adapter, current_level);
  }
  return esp_ble_mesh_server_model_send_msg(
      adapter->config.sensor_model,
      (esp_ble_mesh_msg_ctx_t *)context,
      response.opcode,
      response.size,
      response.payload);
}

esp_err_t vehicle_sensor_mesh_adapter_publish_current(
    vehicle_sensor_mesh_adapter_t *adapter,
    bool current_level) {
  if (adapter == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  uint8_t status[VEHICLE_SENSOR_STATUS_SIZE];
  size_t size = vehicle_sensor_presence_status_encode(current_level, status, sizeof(status));
  if (size == 0) {
    return ESP_ERR_INVALID_STATE;
  }
  update_raw_value(adapter, current_level);
  esp_ble_mesh_msg_ctx_t context;
  if (!model_publication_context(adapter->config.sensor_model, &context)) {
    return ESP_ERR_INVALID_STATE;
  }
  return esp_ble_mesh_server_model_send_msg(
      adapter->config.sensor_model,
      &context,
      ESP_BLE_MESH_MODEL_OP_SENSOR_STATUS,
      size,
      status);
}

vehicle_sensor_send_result_t vehicle_sensor_mesh_adapter_publish_event(
    vehicle_sensor_mesh_adapter_t *adapter,
    bool configured,
    const uint8_t payload[VEHICLE_SENSOR_PACKET_SIZE]) {
  if (adapter == NULL || payload == NULL || !configured) {
    return VEHICLE_SENSOR_SEND_UNCONFIGURED;
  }
  esp_ble_mesh_msg_ctx_t context;
  if (!model_publication_context(adapter->config.vendor_model, &context)) {
    return VEHICLE_SENSOR_SEND_UNCONFIGURED;
  }
  esp_err_t error = esp_ble_mesh_server_model_send_msg(
      adapter->config.vendor_model,
      &context,
      adapter->config.vendor_event_opcode,
      VEHICLE_SENSOR_PACKET_SIZE,
      (uint8_t *)payload);
  return error == ESP_OK ? VEHICLE_SENSOR_SEND_OK : VEHICLE_SENSOR_SEND_ERROR;
}
#endif
