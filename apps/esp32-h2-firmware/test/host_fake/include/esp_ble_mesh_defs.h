#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CONFIG_BLE_MESH_MODEL_KEY_COUNT 3
#define ESP_BLE_MESH_KEY_UNUSED 0xffffU
#define ESP_BLE_MESH_ADDR_UNASSIGNED 0x0000U
#define ROLE_NODE 0

struct net_buf_simple {
  uint8_t *data;
  size_t len;
  size_t size;
};

static inline void net_buf_simple_reset(struct net_buf_simple *buffer) {
  buffer->len = 0;
}

static inline void net_buf_simple_add_u8(struct net_buf_simple *buffer, uint8_t value) {
  buffer->data[buffer->len++] = value;
}

static inline void net_buf_simple_add_mem(
    struct net_buf_simple *buffer,
    const void *data,
    size_t length) {
  const uint8_t *bytes = data;
  for (size_t index = 0; index < length; index++) {
    net_buf_simple_add_u8(buffer, bytes[index]);
  }
}

typedef struct esp_ble_mesh_model esp_ble_mesh_model_t;

typedef struct {
  esp_ble_mesh_model_t *model;
  uint16_t publish_addr;
  uint16_t app_idx;
  uint8_t ttl;
  uint8_t period;
  struct net_buf_simple *msg;
} esp_ble_mesh_model_pub_t;

struct esp_ble_mesh_model {
  esp_ble_mesh_model_pub_t *pub;
  uint16_t keys[CONFIG_BLE_MESH_MODEL_KEY_COUNT];
};

typedef struct {
  uint16_t net_idx;
  uint16_t app_idx;
  uint16_t addr;
  uint16_t recv_dst;
  uint32_t recv_op;
  uint8_t send_ttl;
} esp_ble_mesh_msg_ctx_t;
