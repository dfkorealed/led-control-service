#pragma once

#include <stdint.h>

#include "esp_err.h"

esp_err_t ble_mesh_platform_bluetooth_init(void);
void ble_mesh_platform_get_device_uuid(uint8_t dev_uuid[16]);
