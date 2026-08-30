#include "ble_mesh_node.h"

#include <inttypes.h>
#include <string.h>

#include "ble_mesh_platform.h"
#include "control_state.h"
#include "device_identity.h"
#include "esp_ble_mesh_common_api.h"
#include "esp_ble_mesh_config_model_api.h"
#include "esp_ble_mesh_defs.h"
#include "esp_ble_mesh_generic_model_api.h"
#include "esp_ble_mesh_health_model_api.h"
#include "esp_ble_mesh_lighting_model_api.h"
#include "esp_ble_mesh_local_data_operation_api.h"
#include "esp_ble_mesh_networking_api.h"
#include "esp_ble_mesh_provisioning_api.h"
#include "esp_ble_mesh_sensor_model_api.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "identify.h"
#include "led_driver.h"
#include "mesh/device_property.h"
#include "mesh_publication_jitter.h"
#include "mesh_state.h"
#include "mesh_transaction_cache.h"
#include "persistent_state.h"
#include "vehicle_sensor_model.h"
#include "vehicle_sensor_health.h"
#include "vehicle_sensor_mesh_adapter.h"
#include "vehicle_sensor_runtime.h"

#if defined(CONFIG_LED_CONTROL_TEST_BUILD)
#if !defined(CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID) || CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID != 0xFFFF
#error "Test builds must use only the reserved 0xFFFF Company ID fixture"
#endif
#elif !defined(CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID) || \
    CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID == 0 || \
    CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID == 0x02E5 || \
    CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID == 0xFFFF
#error "A Bluetooth SIG company identifier assigned to this product owner is required"
#endif

#define LED_CONTROL_COMPANY_ID CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID
#define LED_CONTROL_UNPROV_NAME "DFK-LED-H2"
#define LED_CONTROL_HEALTH_TEST_ID 0x01
#define VEHICLE_SENSOR_VENDOR_EVENT_OPCODE \
  ESP_BLE_MESH_MODEL_OP_3(VEHICLE_SENSOR_VENDOR_EVENT_OPCODE_BYTE & 0x3FU, LED_CONTROL_COMPANY_ID)
#define VEHICLE_SENSOR_VENDOR_ACK_OPCODE \
  ESP_BLE_MESH_MODEL_OP_3(VEHICLE_SENSOR_VENDOR_ACK_OPCODE_BYTE & 0x3FU, LED_CONTROL_COMPANY_ID)

_Static_assert(
    (VEHICLE_SENSOR_VENDOR_EVENT_OPCODE >> 16U) == VEHICLE_SENSOR_VENDOR_EVENT_OPCODE_BYTE,
    "vendor event opcode must match the Gateway wire contract");
_Static_assert(
    (VEHICLE_SENSOR_VENDOR_ACK_OPCODE >> 16U) == VEHICLE_SENSOR_VENDOR_ACK_OPCODE_BYTE,
    "vendor ACK opcode must match the Gateway wire contract");
_Static_assert(BLE_MESH_PRESENCE_DETECTED_LEN == 1, "Presence Detected must be one byte");

enum root_model_index {
  ROOT_MODEL_CONFIG_SERVER = 0,
  ROOT_MODEL_HEALTH_SERVER,
  ROOT_MODEL_ONOFF_SERVER,
  ROOT_MODEL_LIGHTNESS_SERVER,
  ROOT_MODEL_LIGHTNESS_SETUP_SERVER,
  ROOT_MODEL_SENSOR_SERVER,
};

static const char *TAG = "ble_mesh_node";

static uint8_t dev_uuid[16] = {0};
static uint8_t health_test_ids[] = {LED_CONTROL_HEALTH_TEST_ID};
static control_state_t mesh_control_state;
static esp_timer_handle_t group_lightness_publish_timer;
static mesh_lightness_transaction_cache_t lightness_transaction_cache;
static portMUX_TYPE health_fault_mux = portMUX_INITIALIZER_UNLOCKED;
static vehicle_sensor_mesh_adapter_t vehicle_sensor_mesh_adapter;
static uint32_t vehicle_sensor_active_fault_mask;
static uint32_t vehicle_sensor_history_fault_mask;
static bool system_fault_active;
static bool system_fault_registered;

static esp_ble_mesh_cfg_srv_t config_server = {
    .net_transmit = ESP_BLE_MESH_TRANSMIT(2, 20),
    .relay = ESP_BLE_MESH_RELAY_ENABLED,
    .relay_retransmit = ESP_BLE_MESH_TRANSMIT(2, 20),
    .beacon = ESP_BLE_MESH_BEACON_ENABLED,
#if defined(CONFIG_BLE_MESH_GATT_PROXY_SERVER)
    .gatt_proxy = ESP_BLE_MESH_GATT_PROXY_ENABLED,
#else
    .gatt_proxy = ESP_BLE_MESH_GATT_PROXY_NOT_SUPPORTED,
#endif
#if defined(CONFIG_BLE_MESH_FRIEND)
    .friend_state = ESP_BLE_MESH_FRIEND_ENABLED,
#else
    .friend_state = ESP_BLE_MESH_FRIEND_NOT_SUPPORTED,
#endif
    .default_ttl = 7,
};

ESP_BLE_MESH_HEALTH_PUB_DEFINE(health_pub, 8, ROLE_NODE);
static esp_ble_mesh_health_srv_t health_server = {
    .health_test = {
        .id_count = 1,
        .test_ids = health_test_ids,
        .company_id = LED_CONTROL_COMPANY_ID,
    },
};

ESP_BLE_MESH_MODEL_PUB_DEFINE(onoff_pub, 2 + 3, ROLE_NODE);
static esp_ble_mesh_gen_onoff_srv_t onoff_server = {
    .rsp_ctrl = {
        .get_auto_rsp = ESP_BLE_MESH_SERVER_RSP_BY_APP,
        .set_auto_rsp = ESP_BLE_MESH_SERVER_RSP_BY_APP,
    },
};

static esp_ble_mesh_light_lightness_state_t lightness_state = {
    .lightness_range_min = 1,
    .lightness_range_max = 65535,
};

ESP_BLE_MESH_MODEL_PUB_DEFINE(lightness_pub, 2 + 5, ROLE_NODE);
static esp_ble_mesh_light_lightness_srv_t lightness_server = {
    .rsp_ctrl = {
        .get_auto_rsp = ESP_BLE_MESH_SERVER_RSP_BY_APP,
        .set_auto_rsp = ESP_BLE_MESH_SERVER_RSP_BY_APP,
    },
    .state = &lightness_state,
};

ESP_BLE_MESH_MODEL_PUB_DEFINE(lightness_setup_pub, 2 + 5, ROLE_NODE);
static esp_ble_mesh_light_lightness_setup_srv_t lightness_setup_server = {
    .rsp_ctrl = {
        .get_auto_rsp = ESP_BLE_MESH_SERVER_RSP_BY_APP,
        .set_auto_rsp = ESP_BLE_MESH_SERVER_RSP_BY_APP,
    },
    .state = &lightness_state,
};

NET_BUF_SIMPLE_DEFINE_STATIC(vehicle_presence_raw, BLE_MESH_PRESENCE_DETECTED_LEN);
static esp_ble_mesh_sensor_state_t vehicle_sensor_states[] = {
    {
        .sensor_property_id = BLE_MESH_PRESENCE_DETECTED,
        .descriptor = {
            .positive_tolerance = ESP_BLE_MESH_SENSOR_UNSPECIFIED_POS_TOLERANCE,
            .negative_tolerance = ESP_BLE_MESH_SENSOR_UNSPECIFIED_NEG_TOLERANCE,
            .sampling_function = ESP_BLE_MESH_SAMPLE_FUNC_INSTANTANEOUS,
            .measure_period = ESP_BLE_MESH_SENSOR_NOT_APPL_MEASURE_PERIOD,
            .update_interval = ESP_BLE_MESH_SENSOR_NOT_APPL_UPDATE_INTERVAL,
        },
        .sensor_data = {
            .format = ESP_BLE_MESH_SENSOR_DATA_FORMAT_A,
            .length = 0,
            .raw_value = &vehicle_presence_raw,
        },
    },
};

ESP_BLE_MESH_MODEL_PUB_DEFINE(vehicle_sensor_pub, 1 + VEHICLE_SENSOR_STATUS_SIZE, ROLE_NODE);
static esp_ble_mesh_sensor_srv_t vehicle_sensor_server = {
    .rsp_ctrl = {
        .get_auto_rsp = ESP_BLE_MESH_SERVER_RSP_BY_APP,
        .set_auto_rsp = ESP_BLE_MESH_SERVER_RSP_BY_APP,
    },
    .state_count = ARRAY_SIZE(vehicle_sensor_states),
    .states = vehicle_sensor_states,
};

static esp_ble_mesh_model_t root_models[] = {
    ESP_BLE_MESH_MODEL_CFG_SRV(&config_server),
    ESP_BLE_MESH_MODEL_HEALTH_SRV(&health_server, &health_pub),
    ESP_BLE_MESH_MODEL_GEN_ONOFF_SRV(&onoff_pub, &onoff_server),
    ESP_BLE_MESH_MODEL_LIGHT_LIGHTNESS_SRV(&lightness_pub, &lightness_server),
    ESP_BLE_MESH_MODEL_LIGHT_LIGHTNESS_SETUP_SRV(&lightness_setup_pub, &lightness_setup_server),
    ESP_BLE_MESH_MODEL_SENSOR_SRV(&vehicle_sensor_pub, &vehicle_sensor_server),
};

static esp_ble_mesh_model_op_t vehicle_sensor_vendor_ops[] = {
    ESP_BLE_MESH_MODEL_OP(VEHICLE_SENSOR_VENDOR_ACK_OPCODE, VEHICLE_SENSOR_ACK_SIZE),
    ESP_BLE_MESH_MODEL_OP_END,
};

ESP_BLE_MESH_MODEL_PUB_DEFINE(
    vehicle_sensor_vendor_pub,
    3 + VEHICLE_SENSOR_PACKET_SIZE,
    ROLE_NODE);
static esp_ble_mesh_model_t vendor_models[] = {
    ESP_BLE_MESH_VENDOR_MODEL(
        LED_CONTROL_COMPANY_ID,
        VEHICLE_SENSOR_VENDOR_SERVER_MODEL_ID,
        vehicle_sensor_vendor_ops,
        &vehicle_sensor_vendor_pub,
        NULL),
};

static esp_ble_mesh_elem_t elements[] = {
    ESP_BLE_MESH_ELEMENT(0, root_models, vendor_models),
};

static esp_ble_mesh_comp_t composition = {
    .cid = LED_CONTROL_COMPANY_ID,
    .element_count = ARRAY_SIZE(elements),
    .elements = elements,
};

static esp_ble_mesh_prov_t provision = {
    .uuid = dev_uuid,
    .output_size = 0,
    .output_actions = 0,
};

static void update_bound_mesh_state(void) {
  uint16_t actual = mesh_state_percent_to_lightness(mesh_control_state.brightness_percent);

  lightness_state.lightness_actual = actual;
  lightness_state.target_lightness_actual = actual;
  lightness_state.lightness_linear = actual;
  lightness_state.target_lightness_linear = actual;
  if (actual > 0) {
    lightness_state.lightness_last = actual;
  }

  onoff_server.state.onoff = mesh_control_state.power_on ? 1 : 0;
}

static void apply_control_state(void) {
  ESP_ERROR_CHECK_WITHOUT_ABORT(led_driver_set_brightness(mesh_control_state.brightness_percent));
  ESP_ERROR_CHECK_WITHOUT_ABORT(persistent_state_schedule_save(&mesh_control_state));
  update_bound_mesh_state();
}

static void publish_control_state(esp_ble_mesh_model_t *model) {
  uint8_t onoff = onoff_server.state.onoff;
  uint16_t lightness = lightness_state.lightness_actual;
  esp_ble_mesh_model_publish(&root_models[ROOT_MODEL_ONOFF_SERVER], ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_STATUS, sizeof(onoff), &onoff, ROLE_NODE);
  esp_ble_mesh_model_publish(model != NULL ? model : &root_models[ROOT_MODEL_LIGHTNESS_SERVER], ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_STATUS, sizeof(lightness), (uint8_t *)&lightness, ROLE_NODE);
}

static void apply_control_state_and_publish(esp_ble_mesh_model_t *model) {
  apply_control_state();
  publish_control_state(model);
}

static void publish_group_lightness_status(void *argument) {
  (void)argument;
  uint16_t lightness = lightness_state.lightness_actual;
  esp_err_t error = esp_ble_mesh_model_publish(
      &root_models[ROOT_MODEL_LIGHTNESS_SERVER],
      ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_STATUS,
      sizeof(lightness),
      (uint8_t *)&lightness,
      ROLE_NODE);
  if (error != ESP_OK) {
    ESP_LOGE(TAG, "Failed to publish delayed group lightness status: %s", esp_err_to_name(error));
  }
}

static void schedule_group_lightness_status(void) {
  uint16_t primary_unicast = esp_ble_mesh_get_primary_element_address();
  uint32_t delay_ms = mesh_group_publication_jitter_ms(primary_unicast);
  esp_err_t error = esp_timer_stop(group_lightness_publish_timer);
  if (error != ESP_OK && error != ESP_ERR_INVALID_STATE) {
    ESP_LOGW(TAG, "Failed to stop pending group status timer: %s", esp_err_to_name(error));
  }
  error = esp_timer_start_once(group_lightness_publish_timer, (uint64_t)delay_ms * 1000U);
  if (error != ESP_OK) {
    ESP_LOGE(TAG, "Failed to schedule group lightness status: %s", esp_err_to_name(error));
    publish_group_lightness_status(NULL);
    return;
  }
  ESP_LOGI(TAG, "Group lightness applied, status publication scheduled in %" PRIu32 "ms", delay_ms);
}

static void send_onoff_status(esp_ble_mesh_model_t *model, esp_ble_mesh_msg_ctx_t *ctx) {
  uint8_t onoff = onoff_server.state.onoff;
  esp_ble_mesh_server_model_send_msg(model, ctx, ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_STATUS, sizeof(onoff), &onoff);
}

static void send_lightness_status(esp_ble_mesh_model_t *model, esp_ble_mesh_msg_ctx_t *ctx) {
  uint16_t lightness = lightness_state.lightness_actual;
  esp_ble_mesh_server_model_send_msg(model, ctx, ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_STATUS, sizeof(lightness), (uint8_t *)&lightness);
}

static void provisioning_cb(esp_ble_mesh_prov_cb_event_t event, esp_ble_mesh_prov_cb_param_t *param) {
  switch (event) {
  case ESP_BLE_MESH_PROV_REGISTER_COMP_EVT:
    ESP_LOGI(TAG, "Provisioning callback registered, err=%d", param->prov_register_comp.err_code);
    break;
  case ESP_BLE_MESH_NODE_PROV_ENABLE_COMP_EVT:
    ESP_LOGI(TAG, "Provisioning bearers enabled, err=%d", param->node_prov_enable_comp.err_code);
    break;
  case ESP_BLE_MESH_NODE_PROV_LINK_OPEN_EVT:
    ESP_LOGI(TAG, "Provisioning link open, bearer=%s", param->node_prov_link_open.bearer == ESP_BLE_MESH_PROV_ADV ? "PB-ADV" : "PB-GATT");
    break;
  case ESP_BLE_MESH_NODE_PROV_LINK_CLOSE_EVT:
    ESP_LOGI(TAG, "Provisioning link close, bearer=%s", param->node_prov_link_close.bearer == ESP_BLE_MESH_PROV_ADV ? "PB-ADV" : "PB-GATT");
    break;
  case ESP_BLE_MESH_NODE_PROV_COMPLETE_EVT:
    ESP_LOGI(TAG, "Provisioned net_idx=0x%04x addr=0x%04x flags=0x%02x iv_index=0x%08" PRIx32,
             param->node_prov_complete.net_idx,
             param->node_prov_complete.addr,
             param->node_prov_complete.flags,
             param->node_prov_complete.iv_index);
    apply_control_state_and_publish(&root_models[ROOT_MODEL_LIGHTNESS_SERVER]);
    vehicle_sensor_model_runtime_provisioned();
    break;
  case ESP_BLE_MESH_NODE_PROV_RESET_EVT:
    ESP_LOGW(TAG, "Provisioning reset requested");
    vehicle_sensor_model_runtime_reset();
    esp_ble_mesh_node_prov_enable((esp_ble_mesh_prov_bearer_t)(ESP_BLE_MESH_PROV_ADV | ESP_BLE_MESH_PROV_GATT));
    break;
  case ESP_BLE_MESH_NODE_SET_UNPROV_DEV_NAME_COMP_EVT:
    ESP_LOGI(TAG, "Unprovisioned device name set, err=%d", param->node_set_unprov_dev_name_comp.err_code);
    break;
  default:
    break;
  }
}

static void config_server_cb(esp_ble_mesh_cfg_server_cb_event_t event, esp_ble_mesh_cfg_server_cb_param_t *param) {
  if (event != ESP_BLE_MESH_CFG_SERVER_STATE_CHANGE_EVT) {
    return;
  }

  switch (param->ctx.recv_op) {
  case ESP_BLE_MESH_MODEL_OP_APP_KEY_ADD:
    ESP_LOGI(TAG, "AppKey added net_idx=0x%04x app_idx=0x%04x",
             param->value.state_change.appkey_add.net_idx,
             param->value.state_change.appkey_add.app_idx);
    break;
  case ESP_BLE_MESH_MODEL_OP_MODEL_APP_BIND:
    ESP_LOGI(TAG, "Model bound elem=0x%04x app_idx=0x%04x cid=0x%04x model=0x%04x",
             param->value.state_change.mod_app_bind.element_addr,
             param->value.state_change.mod_app_bind.app_idx,
             param->value.state_change.mod_app_bind.company_id,
             param->value.state_change.mod_app_bind.model_id);
    break;
  case ESP_BLE_MESH_MODEL_OP_MODEL_SUB_ADD:
    ESP_LOGI(TAG, "Model subscribed elem=0x%04x sub=0x%04x cid=0x%04x model=0x%04x",
             param->value.state_change.mod_sub_add.element_addr,
             param->value.state_change.mod_sub_add.sub_addr,
             param->value.state_change.mod_sub_add.company_id,
             param->value.state_change.mod_sub_add.model_id);
    break;
  case ESP_BLE_MESH_MODEL_OP_NODE_IDENTITY_SET:
    ESP_LOGI(TAG, "Node identity set received");
    break;
  default:
    break;
  }
  vehicle_sensor_model_runtime_configuration_changed();
}

static void generic_server_cb(esp_ble_mesh_generic_server_cb_event_t event, esp_ble_mesh_generic_server_cb_param_t *param) {
  switch (event) {
  case ESP_BLE_MESH_GENERIC_SERVER_RECV_GET_MSG_EVT:
    if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_GET) {
      send_onoff_status(param->model, &param->ctx);
    }
    break;
  case ESP_BLE_MESH_GENERIC_SERVER_RECV_SET_MSG_EVT:
    if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_SET ||
        param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_SET_UNACK) {
      mesh_state_apply_onoff(&mesh_control_state, param->value.set.onoff.onoff);
      apply_control_state_and_publish(&root_models[ROOT_MODEL_LIGHTNESS_SERVER]);
      if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_SET) {
        send_onoff_status(param->model, &param->ctx);
      }
    }
    break;
  case ESP_BLE_MESH_GENERIC_SERVER_STATE_CHANGE_EVT:
    if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_SET ||
        param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_SET_UNACK) {
      mesh_state_apply_onoff(&mesh_control_state, param->value.state_change.onoff_set.onoff);
      apply_control_state_and_publish(&root_models[ROOT_MODEL_LIGHTNESS_SERVER]);
    }
    break;
  default:
    break;
  }
}

static void lighting_server_cb(esp_ble_mesh_lighting_server_cb_event_t event, esp_ble_mesh_lighting_server_cb_param_t *param) {
  switch (event) {
  case ESP_BLE_MESH_LIGHTING_SERVER_RECV_GET_MSG_EVT:
    if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_GET) {
      send_lightness_status(param->model, &param->ctx);
    }
    break;
  case ESP_BLE_MESH_LIGHTING_SERVER_RECV_SET_MSG_EVT:
    if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_SET ||
        param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_SET_UNACK) {
      bool duplicate = mesh_lightness_transaction_is_duplicate(
          &lightness_transaction_cache,
          param->ctx.addr,
          param->ctx.recv_dst,
          param->value.set.lightness.tid,
          (uint64_t)(esp_timer_get_time() / 1000));
      if (duplicate) {
        if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_SET) {
          send_lightness_status(param->model, &param->ctx);
        }
        ESP_LOGD(
            TAG,
            "Ignored duplicate Lightness Set src=0x%04x dst=0x%04x tid=%u",
            param->ctx.addr,
            param->ctx.recv_dst,
            param->value.set.lightness.tid);
        break;
      }
      mesh_state_apply_lightness(&mesh_control_state, param->value.set.lightness.lightness);
      bool delayed_group_publication =
          param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_SET_UNACK &&
          ESP_BLE_MESH_ADDR_IS_GROUP(param->ctx.recv_dst);
      if (delayed_group_publication) {
        apply_control_state();
        schedule_group_lightness_status();
      } else {
        apply_control_state_and_publish(param->model);
      }
      if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_SET) {
        send_lightness_status(param->model, &param->ctx);
      }
    }
    break;
  case ESP_BLE_MESH_LIGHTING_SERVER_STATE_CHANGE_EVT:
    /* RSP_BY_APP handles accepted Set messages above; publishing here would duplicate status. */
    break;
  default:
    break;
  }
}

static void rebuild_health_fault_arrays(void);

static void health_server_cb(esp_ble_mesh_health_server_cb_event_t event, esp_ble_mesh_health_server_cb_param_t *param) {
  switch (event) {
  case ESP_BLE_MESH_HEALTH_SERVER_FAULT_CLEAR_EVT:
    portENTER_CRITICAL(&health_fault_mux);
    system_fault_registered = false;
    vehicle_sensor_history_fault_mask = 0;
    rebuild_health_fault_arrays();
    portEXIT_CRITICAL(&health_fault_mux);
    vehicle_sensor_model_runtime_clear_fault_history();
    ESP_LOGI(TAG, "Health registered faults cleared; active faults retained");
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_ble_mesh_health_server_fault_update(&elements[0]));
    break;
  case ESP_BLE_MESH_HEALTH_SERVER_FAULT_TEST_EVT:
    health_server.health_test.prev_test_id = param->fault_test.test_id;
    ESP_LOGI(TAG, "Health fault test executed, test_id=0x%02x", param->fault_test.test_id);
    esp_ble_mesh_health_server_fault_update(&elements[0]);
    break;
  case ESP_BLE_MESH_HEALTH_SERVER_ATTENTION_ON_EVT:
    ESP_LOGI(TAG, "Health attention on, seconds=%u", param->attention_on.time);
    ESP_ERROR_CHECK_WITHOUT_ABORT(identify_start(param->attention_on.time, mesh_control_state.brightness_percent));
    break;
  case ESP_BLE_MESH_HEALTH_SERVER_ATTENTION_OFF_EVT:
    ESP_LOGI(TAG, "Health attention off");
    ESP_ERROR_CHECK_WITHOUT_ABORT(identify_stop());
    break;
  case ESP_BLE_MESH_HEALTH_SERVER_FAULT_UPDATE_COMP_EVT:
    ESP_LOGI(TAG, "Health fault update complete, err=%d", param->fault_update_comp.error_code);
    break;
  default:
    break;
  }
}

static size_t append_system_fault(uint8_t *faults, size_t capacity, bool present) {
  if (present && capacity != 0) {
    faults[0] = 0x01;
    return 1;
  }
  return 0;
}

static void rebuild_health_fault_arrays(void) {
  vehicle_sensor_health_t sensor_health = {
      .active_mask = vehicle_sensor_active_fault_mask,
      .history_mask = vehicle_sensor_history_fault_mask,
  };
  uint8_t sensor_current[5] = {0};
  uint8_t sensor_registered[5] = {0};
  size_t current_count = vehicle_sensor_health_build_current(
      &sensor_health, sensor_current, sizeof(sensor_current));
  size_t registered_count = vehicle_sensor_health_build_registered(
      &sensor_health, sensor_registered, sizeof(sensor_registered));

  memset(health_server.health_test.current_faults, 0, sizeof(health_server.health_test.current_faults));
  memset(health_server.health_test.registered_faults, 0, sizeof(health_server.health_test.registered_faults));
  size_t current_offset = append_system_fault(
      health_server.health_test.current_faults,
      sizeof(health_server.health_test.current_faults),
      system_fault_active);
  size_t registered_offset = append_system_fault(
      health_server.health_test.registered_faults,
      sizeof(health_server.health_test.registered_faults),
      system_fault_registered);
  memcpy(
      health_server.health_test.current_faults + current_offset,
      sensor_current,
      current_count);
  memcpy(
      health_server.health_test.registered_faults + registered_offset,
      sensor_registered,
      registered_count);
}

static void vehicle_sensor_health_faults_changed(
    uint32_t active_mask,
    uint32_t history_mask,
    void *context) {
  (void)context;
  portENTER_CRITICAL(&health_fault_mux);
  vehicle_sensor_active_fault_mask = active_mask;
  vehicle_sensor_history_fault_mask = history_mask;
  rebuild_health_fault_arrays();
  portEXIT_CRITICAL(&health_fault_mux);

  if (esp_ble_mesh_node_is_provisioned()) {
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_ble_mesh_health_server_fault_update(&elements[0]));
  }
}

static void sensor_server_cb(
    esp_ble_mesh_sensor_server_cb_event_t event,
    esp_ble_mesh_sensor_server_cb_param_t *param) {
  if (event != ESP_BLE_MESH_SENSOR_SERVER_RECV_GET_MSG_EVT) {
    return;
  }
  vehicle_sensor_request_kind_t kind;
  bool property_id_present = true;
  uint16_t property_id = 0;
  switch (param->ctx.recv_op) {
  case ESP_BLE_MESH_MODEL_OP_SENSOR_DESCRIPTOR_GET:
    kind = VEHICLE_SENSOR_REQUEST_DESCRIPTOR;
    property_id_present = param->value.get.sensor_descriptor.op_en;
    property_id = param->value.get.sensor_descriptor.property_id;
    break;
  case ESP_BLE_MESH_MODEL_OP_SENSOR_GET:
    kind = VEHICLE_SENSOR_REQUEST_GET;
    property_id_present = param->value.get.sensor_data.op_en;
    property_id = param->value.get.sensor_data.property_id;
    break;
  case ESP_BLE_MESH_MODEL_OP_SENSOR_COLUMN_GET:
    kind = VEHICLE_SENSOR_REQUEST_COLUMN;
    property_id = param->value.get.sensor_column.property_id;
    break;
  case ESP_BLE_MESH_MODEL_OP_SENSOR_SERIES_GET:
    kind = VEHICLE_SENSOR_REQUEST_SERIES;
    property_id = param->value.get.sensor_series.property_id;
    break;
  default:
    return;
  }
  if (!vehicle_sensor_model_runtime_request(
          &param->ctx, kind, property_id_present, property_id)) {
    ESP_LOGW(TAG, "Vehicle Sensor request dropped because runtime intake is unavailable");
  }
}

/* ESP-IDF asks us to refresh the publication buffer; the Mesh stack sends it after this callback returns. */
static void model_publish_cb(esp_ble_mesh_model_cb_event_t event, esp_ble_mesh_model_cb_param_t *param) {
  esp_ble_mesh_model_t *model;

  if (event == ESP_BLE_MESH_MODEL_OPERATION_EVT) {
    if (param->model_operation.model == &vendor_models[0] &&
        param->model_operation.opcode == VEHICLE_SENSOR_VENDOR_ACK_OPCODE &&
        !vehicle_sensor_model_runtime_receive_ack(
            param->model_operation.msg,
            param->model_operation.length)) {
      ESP_LOGW(TAG, "Ignored malformed or unqueueable vehicle sensor ACK");
    }
    return;
  }
  if (event == ESP_BLE_MESH_MODEL_PUBLISH_COMP_EVT) {
    if (param->model_publish_comp.model == &vendor_models[0] ||
        param->model_publish_comp.model == &root_models[ROOT_MODEL_SENSOR_SERVER]) {
      vehicle_sensor_model_runtime_record_send_result(
          param->model_publish_comp.model,
          param->model_publish_comp.err_code == 0);
    }
    return;
  }
  if (event != ESP_BLE_MESH_MODEL_PUBLISH_UPDATE_EVT) {
    return;
  }
  model = param->model_publish_update.model;
  if (model == &root_models[ROOT_MODEL_HEALTH_SERVER]) {
    return;
  }
  if (model == &root_models[ROOT_MODEL_SENSOR_SERVER]) {
    /* Gateway configures period zero; only the runtime custom scheduler publishes Sensor Status. */
    return;
  }
  if (model->pub == NULL || model->pub->msg == NULL) {
    return;
  }
  if (model == &root_models[ROOT_MODEL_ONOFF_SERVER]) {
    uint8_t onoff = onoff_server.state.onoff;
    net_buf_simple_reset(model->pub->msg);
    net_buf_simple_add_u8(model->pub->msg, 0x82);
    net_buf_simple_add_u8(model->pub->msg, 0x04);
    net_buf_simple_add_u8(model->pub->msg, onoff);
    return;
  }
  if (model == &root_models[ROOT_MODEL_LIGHTNESS_SERVER]) {
    uint16_t lightness = lightness_state.lightness_actual;
    net_buf_simple_reset(model->pub->msg);
    net_buf_simple_add_u8(model->pub->msg, 0x82);
    net_buf_simple_add_u8(model->pub->msg, 0x4e);
    net_buf_simple_add_le16(model->pub->msg, lightness);
  }
}

static void vehicle_sensor_driver_event(const vehicle_sensor_event_t *event, void *context) {
  (void)context;
  (void)vehicle_sensor_model_runtime_submit_event(event);
}

esp_err_t ble_mesh_node_init(void) {
  const esp_timer_create_args_t group_publish_timer_args = {
      .callback = publish_group_lightness_status,
      .name = "mesh_group_pub",
  };
  ESP_RETURN_ON_ERROR(
      esp_timer_create(&group_publish_timer_args, &group_lightness_publish_timer),
      TAG,
      "create group publication timer");

  mesh_control_state = control_state_create();
  bool restored = false;
  ESP_RETURN_ON_ERROR(persistent_state_load(&mesh_control_state, &restored), TAG, "load persisted state");
  if (!restored) {
    control_state_apply_brightness(&mesh_control_state, 30);
  }
  update_bound_mesh_state();

  net_buf_simple_reset(&vehicle_presence_raw);
  net_buf_simple_add_u8(&vehicle_presence_raw, 0);

  device_identity_build(dev_uuid);

  ESP_ERROR_CHECK(esp_ble_mesh_register_prov_callback(provisioning_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_config_server_callback(config_server_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_generic_server_callback(generic_server_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_lighting_server_callback(lighting_server_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_health_server_callback(health_server_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_sensor_server_callback(sensor_server_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_custom_model_callback(model_publish_cb));

  vehicle_sensor_mesh_adapter_init(
      &vehicle_sensor_mesh_adapter,
      &(vehicle_sensor_mesh_adapter_config_t){
          .sensor_model = &root_models[ROOT_MODEL_SENSOR_SERVER],
          .vendor_model = &vendor_models[0],
          .sensor_raw_value = &vehicle_presence_raw,
          .vendor_event_opcode = VEHICLE_SENSOR_VENDOR_EVENT_OPCODE,
      });
  const vehicle_sensor_model_runtime_config_t sensor_model_config = {
      .mesh_adapter = &vehicle_sensor_mesh_adapter,
      .fault_handler = vehicle_sensor_health_faults_changed,
      .fault_context = NULL,
  };
  esp_err_t err = vehicle_sensor_model_runtime_start(&sensor_model_config);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "Failed to create vehicle sensor runtime, err=%d", err);
    return err;
  }

  err = vehicle_sensor_driver_start(vehicle_sensor_driver_event, NULL);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "Failed to start vehicle sensor driver, err=%d", err);
    ESP_ERROR_CHECK_WITHOUT_ABORT(vehicle_sensor_model_runtime_stop());
    return err;
  }

  err = esp_ble_mesh_init(&provision, &composition);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "Failed to initialize BLE Mesh, err=%d", err);
    ESP_ERROR_CHECK_WITHOUT_ABORT(vehicle_sensor_driver_stop());
    ESP_ERROR_CHECK_WITHOUT_ABORT(vehicle_sensor_model_runtime_stop());
    return err;
  }

  err = vehicle_sensor_model_runtime_activate();
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "Failed to activate vehicle sensor runtime, err=%d", err);
    ESP_ERROR_CHECK_WITHOUT_ABORT(vehicle_sensor_driver_stop());
    ESP_ERROR_CHECK_WITHOUT_ABORT(vehicle_sensor_model_runtime_stop());
    return err;
  }

  err = esp_ble_mesh_set_unprovisioned_device_name(LED_CONTROL_UNPROV_NAME);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "Failed to set unprovisioned name, err=%d", err);
  }

  err = esp_ble_mesh_node_prov_enable((esp_ble_mesh_prov_bearer_t)(ESP_BLE_MESH_PROV_ADV | ESP_BLE_MESH_PROV_GATT));
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "Failed to enable provisioning, err=%d", err);
    ESP_ERROR_CHECK_WITHOUT_ABORT(vehicle_sensor_driver_stop());
    ESP_ERROR_CHECK_WITHOUT_ABORT(vehicle_sensor_model_runtime_stop());
    return err;
  }

  esp_reset_reason_t reset_reason = esp_reset_reason();
  if (reset_reason == ESP_RST_PANIC || reset_reason == ESP_RST_TASK_WDT || reset_reason == ESP_RST_WDT) {
    portENTER_CRITICAL(&health_fault_mux);
    system_fault_active = true;
    system_fault_registered = true;
    rebuild_health_fault_arrays();
    portEXIT_CRITICAL(&health_fault_mux);
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_ble_mesh_health_server_fault_update(&elements[0]));
  }

  ESP_LOGI(TAG, "BLE Mesh node initialized name=%s uuid=%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x",
           LED_CONTROL_UNPROV_NAME,
           dev_uuid[0],
           dev_uuid[1],
           dev_uuid[2],
           dev_uuid[3],
           dev_uuid[4],
           dev_uuid[5],
           dev_uuid[6],
           dev_uuid[7],
           dev_uuid[8],
           dev_uuid[9],
           dev_uuid[10],
           dev_uuid[11],
           dev_uuid[12],
           dev_uuid[13],
           dev_uuid[14],
           dev_uuid[15]);
  return ESP_OK;
}

bool ble_mesh_node_submit_vehicle_sensor_event(const vehicle_sensor_event_t *event) {
  return vehicle_sensor_model_runtime_submit_event(event);
}

esp_err_t ble_mesh_node_shutdown(void) {
  esp_err_t runtime_error = vehicle_sensor_model_runtime_stop();
  esp_err_t driver_error = vehicle_sensor_driver_stop();
  return runtime_error != ESP_OK ? runtime_error : driver_error;
}
