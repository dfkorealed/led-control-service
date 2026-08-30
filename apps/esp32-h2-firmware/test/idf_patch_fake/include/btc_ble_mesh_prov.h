#ifndef TEST_IDF_PATCH_FAKE_BTC_BLE_MESH_PROV_H
#define TEST_IDF_PATCH_FAKE_BTC_BLE_MESH_PROV_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_ble_mesh_networking_api.h"

#define BTC_SIG_API_CALL 0
#define BTC_PID_MODEL 1
#define BTC_PID_PROV 2

typedef enum {
    BT_STATUS_SUCCESS = 0,
    BT_STATUS_FAIL,
    BT_STATUS_NOMEM,
    BT_STATUS_BUSY,
    BT_STATUS_PARM_INVALID,
} bt_status_t;

typedef enum {
    BTC_BLE_MESH_ACT_MODEL_PUBLISH = 1,
    BTC_BLE_MESH_ACT_SERVER_MODEL_SEND,
    BTC_BLE_MESH_ACT_CLIENT_MODEL_SEND,
    BTC_BLE_MESH_ACT_SERVER_MODEL_UPDATE_STATE,
    BTC_BLE_MESH_ACT_NODE_RESET,
} btc_ble_mesh_model_act_t;

typedef struct btc_msg {
    uint8_t sig;
    uint8_t aid;
    uint8_t pid;
    uint8_t act;
    _Alignas(max_align_t)
    uint8_t arg[];
} btc_msg_t;

typedef union {
    struct {
        esp_ble_mesh_model_t *model;
        uint8_t device_role;
    } model_publish;
    struct {
        esp_ble_mesh_model_t *model;
        esp_ble_mesh_msg_ctx_t *ctx;
        uint32_t opcode;
        bool need_rsp;
        uint16_t length;
        uint8_t *data;
        uint8_t device_role;
        int32_t msg_timeout;
    } model_send;
} btc_ble_mesh_model_args_t;

typedef void (*btc_arg_deep_copy_t)(btc_msg_t *msg, void *dst, void *src);
typedef void (*btc_arg_deep_free_t)(btc_msg_t *msg);

bt_status_t btc_transfer_context(btc_msg_t *msg, void *arg, int arg_len,
                                 btc_arg_deep_copy_t copy_func,
                                 btc_arg_deep_free_t free_func);
void btc_ble_mesh_model_arg_deep_copy(btc_msg_t *msg, void *dst, void *src);
void btc_ble_mesh_model_arg_deep_free(btc_msg_t *msg);
int btc_profile_cb_set(uint8_t pid, void *callback);
esp_err_t btc_ble_mesh_client_model_init(esp_ble_mesh_model_t *model);

#endif
