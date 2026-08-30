#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "vehicle_sensor_driver.h"

esp_err_t ble_mesh_node_init(void);
bool ble_mesh_node_submit_vehicle_sensor_event(const vehicle_sensor_event_t *event);
esp_err_t ble_mesh_node_shutdown(void);
