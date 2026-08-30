#pragma once

#include <stdbool.h>
#include <stdatomic.h>
#include <stdint.h>

typedef struct {
  bool level;
  uint64_t monotonic_us;
} vehicle_sensor_edge_t;

typedef enum {
  VEHICLE_SENSOR_CLEARED = 0,
  VEHICLE_SENSOR_DETECTED = 1,
} vehicle_sensor_event_kind_t;

typedef struct {
  vehicle_sensor_event_kind_t kind;
  bool level;
  uint64_t monotonic_us;
} vehicle_sensor_event_t;

typedef struct {
  bool has_level;
  bool level;
  _Atomic uint32_t dropped_edges;
} vehicle_sensor_state_t;

void vehicle_sensor_state_init(vehicle_sensor_state_t *state);
bool vehicle_sensor_process_level(
    vehicle_sensor_state_t *state,
    bool level,
    uint64_t monotonic_us,
    vehicle_sensor_event_t *event);
uint64_t vehicle_sensor_elapsed_us(uint64_t newer, uint64_t older);
bool vehicle_sensor_gpio_is_safe(int gpio, int pwm_gpio, int factory_reset_gpio);
void vehicle_sensor_record_dropped_edge(vehicle_sensor_state_t *state);
uint32_t vehicle_sensor_dropped_edge_count(const vehicle_sensor_state_t *state);

#ifdef ESP_PLATFORM
#include "esp_err.h"

typedef void (*vehicle_sensor_event_handler_t)(const vehicle_sensor_event_t *event, void *context);

esp_err_t vehicle_sensor_driver_start(vehicle_sensor_event_handler_t handler, void *context);
void vehicle_sensor_driver_stop(void);
bool vehicle_sensor_driver_get_current_level(bool *level);
uint32_t vehicle_sensor_driver_dropped_edge_count(void);
#endif
