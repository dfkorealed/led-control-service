#include "ble_mesh_node.h"

#include <inttypes.h>
#include <string.h>

#include "ble_mesh_platform.h"
#include "control_state.h"
#include "esp_ble_mesh_common_api.h"
#include "esp_ble_mesh_config_model_api.h"
#include "esp_ble_mesh_defs.h"
#include "esp_ble_mesh_generic_model_api.h"
#include "esp_ble_mesh_health_model_api.h"
#include "esp_ble_mesh_lighting_model_api.h"
#include "esp_ble_mesh_local_data_operation_api.h"
#include "esp_ble_mesh_networking_api.h"
#include "esp_ble_mesh_provisioning_api.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_system.h"
#include "identify.h"
#include "led_driver.h"
#include "mesh_state.h"
#include "persistent_state.h"

#define LED_CONTROL_COMPANY_ID 0x02E5
#define LED_CONTROL_UNPROV_NAME "DFK-LED-H2"
#define LED_CONTROL_HEALTH_TEST_ID 0x01

static const char *TAG = "ble_mesh_node";

static uint8_t dev_uuid[16] = {0};
static uint8_t health_test_ids[] = {LED_CONTROL_HEALTH_TEST_ID};
static control_state_t mesh_control_state;

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

ESP_BLE_MESH_HEALTH_PUB_DEFINE(health_pub, 4, ROLE_NODE);
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

static esp_ble_mesh_model_t root_models[] = {
    ESP_BLE_MESH_MODEL_CFG_SRV(&config_server),
    ESP_BLE_MESH_MODEL_HEALTH_SRV(&health_server, &health_pub),
    ESP_BLE_MESH_MODEL_GEN_ONOFF_SRV(&onoff_pub, &onoff_server),
    ESP_BLE_MESH_MODEL_LIGHT_LIGHTNESS_SRV(&lightness_pub, &lightness_server),
    ESP_BLE_MESH_MODEL_LIGHT_LIGHTNESS_SETUP_SRV(&lightness_setup_pub, &lightness_setup_server),
};

static esp_ble_mesh_elem_t elements[] = {
    ESP_BLE_MESH_ELEMENT(0, root_models, ESP_BLE_MESH_MODEL_NONE),
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
  esp_ble_mesh_server_state_value_t state = {0};
  uint16_t actual = mesh_state_percent_to_lightness(mesh_control_state.brightness_percent);

  lightness_state.lightness_actual = actual;
  lightness_state.target_lightness_actual = actual;
  lightness_state.lightness_linear = actual;
  lightness_state.target_lightness_linear = actual;
  if (actual > 0) {
    lightness_state.lightness_last = actual;
  }

  onoff_server.state.onoff = mesh_control_state.power_on ? 1 : 0;

  if (onoff_server.model != NULL) {
    state.gen_onoff.onoff = onoff_server.state.onoff;
    esp_ble_mesh_server_model_update_state(onoff_server.model, ESP_BLE_MESH_GENERIC_ONOFF_STATE, &state);
  }

  if (lightness_server.model != NULL) {
    state.light_lightness_actual.lightness = actual;
    esp_ble_mesh_server_model_update_state(lightness_server.model, ESP_BLE_MESH_LIGHT_LIGHTNESS_ACTUAL_STATE, &state);

    state.light_lightness_linear.lightness = actual;
    esp_ble_mesh_server_model_update_state(lightness_server.model, ESP_BLE_MESH_LIGHT_LIGHTNESS_LINEAR_STATE, &state);
  }
}

static void apply_control_state_and_publish(esp_ble_mesh_model_t *model) {
  ESP_ERROR_CHECK_WITHOUT_ABORT(led_driver_set_brightness(mesh_control_state.brightness_percent));
  ESP_ERROR_CHECK_WITHOUT_ABORT(persistent_state_schedule_save(&mesh_control_state));
  update_bound_mesh_state();

  uint8_t onoff = onoff_server.state.onoff;
  uint16_t lightness = lightness_state.lightness_actual;
  esp_ble_mesh_model_publish(&root_models[2], ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_STATUS, sizeof(onoff), &onoff, ROLE_NODE);
  esp_ble_mesh_model_publish(model != NULL ? model : &root_models[3], ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_STATUS, sizeof(lightness), (uint8_t *)&lightness, ROLE_NODE);
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
    apply_control_state_and_publish(&root_models[3]);
    break;
  case ESP_BLE_MESH_NODE_PROV_RESET_EVT:
    ESP_LOGW(TAG, "Provisioning reset requested");
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
      apply_control_state_and_publish(&root_models[3]);
      if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_SET) {
        send_onoff_status(param->model, &param->ctx);
      }
    }
    break;
  case ESP_BLE_MESH_GENERIC_SERVER_STATE_CHANGE_EVT:
    if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_SET ||
        param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_GEN_ONOFF_SET_UNACK) {
      mesh_state_apply_onoff(&mesh_control_state, param->value.state_change.onoff_set.onoff);
      apply_control_state_and_publish(&root_models[3]);
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
      mesh_state_apply_lightness(&mesh_control_state, param->value.set.lightness.lightness);
      apply_control_state_and_publish(param->model);
      if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_SET) {
        send_lightness_status(param->model, &param->ctx);
      }
    }
    break;
  case ESP_BLE_MESH_LIGHTING_SERVER_STATE_CHANGE_EVT:
    if (param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_SET ||
        param->ctx.recv_op == ESP_BLE_MESH_MODEL_OP_LIGHT_LIGHTNESS_SET_UNACK) {
      mesh_state_apply_lightness(&mesh_control_state, param->value.state_change.lightness_set.lightness);
      apply_control_state_and_publish(param->model);
    }
    break;
  default:
    break;
  }
}

static void health_server_cb(esp_ble_mesh_health_server_cb_event_t event, esp_ble_mesh_health_server_cb_param_t *param) {
  switch (event) {
  case ESP_BLE_MESH_HEALTH_SERVER_FAULT_CLEAR_EVT:
    memset(health_server.health_test.current_faults, 0, sizeof(health_server.health_test.current_faults));
    memset(health_server.health_test.registered_faults, 0, sizeof(health_server.health_test.registered_faults));
    ESP_LOGI(TAG, "Health faults cleared");
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_ble_mesh_health_server_fault_update(&elements[0]));
    break;
  case ESP_BLE_MESH_HEALTH_SERVER_FAULT_TEST_EVT:
    health_server.health_test.prev_test_id = param->fault_test.test_id;
    health_server.health_test.current_faults[0] = ESP_BLE_MESH_NO_FAULT;
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

/* ESP-IDF asks us to refresh the publication buffer; the Mesh stack sends it after this callback returns. */
static void model_publish_cb(esp_ble_mesh_model_cb_event_t event, esp_ble_mesh_model_cb_param_t *param) {
  esp_ble_mesh_model_t *model;

  if (event != ESP_BLE_MESH_MODEL_PUBLISH_UPDATE_EVT) {
    return;
  }
  model = param->model_publish_update.model;
  if (model == &root_models[1]) {
    return;
  }
  if (model->pub == NULL || model->pub->msg == NULL) {
    return;
  }
  if (model == &root_models[2]) {
    uint8_t onoff = onoff_server.state.onoff;
    net_buf_simple_reset(model->pub->msg);
    net_buf_simple_add_u8(model->pub->msg, 0x82);
    net_buf_simple_add_u8(model->pub->msg, 0x04);
    net_buf_simple_add_u8(model->pub->msg, onoff);
    return;
  }
  if (model == &root_models[3]) {
    uint16_t lightness = lightness_state.lightness_actual;
    net_buf_simple_reset(model->pub->msg);
    net_buf_simple_add_u8(model->pub->msg, 0x82);
    net_buf_simple_add_u8(model->pub->msg, 0x4e);
    net_buf_simple_add_le16(model->pub->msg, lightness);
  }
}

esp_err_t ble_mesh_node_init(void) {
  mesh_control_state = control_state_create();
  bool restored = false;
  ESP_RETURN_ON_ERROR(persistent_state_load(&mesh_control_state, &restored), TAG, "load persisted state");
  if (!restored) {
    control_state_apply_brightness(&mesh_control_state, 30);
  }
  update_bound_mesh_state();

  ble_mesh_platform_get_device_uuid(dev_uuid);

  ESP_ERROR_CHECK(esp_ble_mesh_register_prov_callback(provisioning_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_config_server_callback(config_server_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_generic_server_callback(generic_server_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_lighting_server_callback(lighting_server_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_health_server_callback(health_server_cb));
  ESP_ERROR_CHECK(esp_ble_mesh_register_custom_model_callback(model_publish_cb));

  esp_err_t err = esp_ble_mesh_init(&provision, &composition);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "Failed to initialize BLE Mesh, err=%d", err);
    return err;
  }

  err = esp_ble_mesh_set_unprovisioned_device_name(LED_CONTROL_UNPROV_NAME);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "Failed to set unprovisioned name, err=%d", err);
  }

  err = esp_ble_mesh_node_prov_enable((esp_ble_mesh_prov_bearer_t)(ESP_BLE_MESH_PROV_ADV | ESP_BLE_MESH_PROV_GATT));
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "Failed to enable provisioning, err=%d", err);
    return err;
  }

  esp_reset_reason_t reset_reason = esp_reset_reason();
  if (reset_reason == ESP_RST_PANIC || reset_reason == ESP_RST_TASK_WDT || reset_reason == ESP_RST_WDT) {
    health_server.health_test.current_faults[0] = 0x01;
    health_server.health_test.registered_faults[0] = 0x01;
    ESP_ERROR_CHECK_WITHOUT_ABORT(esp_ble_mesh_health_server_fault_update(&elements[0]));
  }

  ESP_LOGI(TAG, "BLE Mesh node initialized name=%s uuid=%02x%02x:%02x%02x%02x%02x%02x%02x",
           LED_CONTROL_UNPROV_NAME,
           dev_uuid[0],
           dev_uuid[1],
           dev_uuid[2],
           dev_uuid[3],
           dev_uuid[4],
           dev_uuid[5],
           dev_uuid[6],
           dev_uuid[7]);
  return ESP_OK;
}
