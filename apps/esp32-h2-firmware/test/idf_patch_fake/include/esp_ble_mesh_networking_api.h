#ifndef TEST_IDF_PATCH_FAKE_NETWORKING_API_H
#define TEST_IDF_PATCH_FAKE_NETWORKING_API_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define CONFIG_BLE_MESH_ADV_BUF_COUNT 20
#define CONFIG_BLE_MESH_DEINIT 0
#define CONFIG_BLE_MESH_FAST_PROV 0
#define CONFIG_BLE_MESH_PROVISIONER 0
#define CONFIG_BLE_MESH_SERVER_MODEL 0

#define ESP_BLE_HOST_STATUS_ENABLED 1
#define ESP_BLE_HOST_STATUS_CHECK(status) do { (void)(status); } while (0)
#define ESP_BLE_MESH_ADDR_UNASSIGNED 0x0000
#define ESP_BLE_MESH_KEY_UNUSED 0xffff
#define ESP_BLE_MESH_MIC_LONG 8
#define ESP_BLE_MESH_MIC_SHORT 4
#define ESP_BLE_MESH_SDU_MAX_LEN 384
#define ESP_BLE_MESH_TAG_SEND_SEGMENTED 0x01
#define MIN(a, b) ((a) < (b) ? (a) : (b))

#define BT_ERR(...) do { } while (0)

struct net_buf_simple {
    uint8_t *data;
    uint16_t len;
    uint16_t size;
};

typedef struct esp_ble_mesh_model esp_ble_mesh_model_t;

typedef struct {
    uint16_t publish_addr;
    uint16_t app_idx;
    uint8_t cred;
    uint8_t send_rel;
    uint8_t send_szmic;
    uint8_t ttl;
    struct net_buf_simple *msg;
} esp_ble_mesh_model_pub_t;

struct esp_ble_mesh_model {
    esp_ble_mesh_model_pub_t *pub;
};

typedef struct {
    uint16_t net_idx;
    uint16_t app_idx;
    uint16_t addr;
    uint16_t recv_dst;
    int8_t recv_rssi;
    uint32_t recv_op;
    uint8_t recv_ttl;
    uint8_t recv_cred;
    uint8_t recv_tag;
    uint8_t send_rel;
    uint8_t send_szmic;
    uint8_t send_ttl;
    uint8_t send_cred;
    uint8_t send_tag;
    esp_ble_mesh_model_t *model;
    bool srv_send;
} esp_ble_mesh_msg_ctx_t;

typedef enum {
    ROLE_NODE = 0,
    ROLE_PROVISIONER = 1,
} esp_ble_mesh_dev_role_t;

typedef void (*esp_ble_mesh_model_cb_t)(void);

static inline uint16_t sys_cpu_to_be16(uint16_t value)
{
    return (uint16_t)((value << 8U) | (value >> 8U));
}

static inline uint16_t sys_cpu_to_le16(uint16_t value)
{
    return value;
}

void *bt_mesh_malloc(size_t size);
void bt_mesh_free(void *ptr);
void bt_mesh_model_msg_init(struct net_buf_simple *buf, uint32_t opcode);
void net_buf_simple_add_mem(struct net_buf_simple *buf, const void *data, size_t length);
esp_err_t esp_ble_mesh_model_msg_opcode_init(uint8_t *data, uint32_t opcode);

esp_err_t esp_ble_mesh_server_model_send_msg(esp_ble_mesh_model_t *model,
                                             esp_ble_mesh_msg_ctx_t *ctx,
                                             uint32_t opcode,
                                             uint16_t length, uint8_t *data);
esp_err_t esp_ble_mesh_client_model_send_msg(esp_ble_mesh_model_t *model,
                                             esp_ble_mesh_msg_ctx_t *ctx,
                                             uint32_t opcode,
                                             uint16_t length, uint8_t *data,
                                             int32_t msg_timeout, bool need_rsp,
                                             esp_ble_mesh_dev_role_t device_role);

#endif
