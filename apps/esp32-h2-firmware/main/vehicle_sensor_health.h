#pragma once

#include <stddef.h>
#include <stdint.h>

#define VEHICLE_SENSOR_FAULT_DROPPED (1U << 0)
#define VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED (1U << 1)
#define VEHICLE_SENSOR_FAULT_SEND_ERROR (1U << 2)
#define VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED (1U << 3)
#define VEHICLE_SENSOR_FAULT_SEQUENCE_EXHAUSTED (1U << 4)
#define VEHICLE_SENSOR_FAULT_PERMANENT_MASK VEHICLE_SENSOR_FAULT_SEQUENCE_EXHAUSTED

#define VEHICLE_SENSOR_HEALTH_CODE_DROPPED 0x80U
#define VEHICLE_SENSOR_HEALTH_CODE_RETRY_EXHAUSTED 0x81U
#define VEHICLE_SENSOR_HEALTH_CODE_SEND_ERROR 0x82U
#define VEHICLE_SENSOR_HEALTH_CODE_PUBLICATION_UNCONFIGURED 0x83U
#define VEHICLE_SENSOR_HEALTH_CODE_SEQUENCE_EXHAUSTED 0x84U

typedef struct {
  uint32_t active_mask;
  uint32_t history_mask;
} vehicle_sensor_health_t;

void vehicle_sensor_health_init(vehicle_sensor_health_t *health);
void vehicle_sensor_health_activate(vehicle_sensor_health_t *health, uint32_t mask);
void vehicle_sensor_health_recover_transient(vehicle_sensor_health_t *health, uint32_t mask);
void vehicle_sensor_health_clear_history(vehicle_sensor_health_t *health);
uint32_t vehicle_sensor_health_active_mask(const vehicle_sensor_health_t *health);
uint32_t vehicle_sensor_health_history_mask(const vehicle_sensor_health_t *health);
size_t vehicle_sensor_health_build_current(
    const vehicle_sensor_health_t *health,
    uint8_t *faults,
    size_t capacity);
size_t vehicle_sensor_health_build_registered(
    const vehicle_sensor_health_t *health,
    uint8_t *faults,
    size_t capacity);
