#pragma once

#include "esp_ble_mesh_defs.h"
#include "esp_err.h"

esp_err_t esp_ble_mesh_model_publish(
    esp_ble_mesh_model_t *model,
    uint32_t opcode,
    uint16_t length,
    uint8_t *data,
    int role);
