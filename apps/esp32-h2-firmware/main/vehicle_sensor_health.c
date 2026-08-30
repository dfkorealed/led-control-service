#include "vehicle_sensor_health.h"

#include <string.h>

typedef struct {
  uint32_t mask;
  uint8_t code;
} vehicle_sensor_fault_code_t;

static const vehicle_sensor_fault_code_t fault_codes[] = {
    {VEHICLE_SENSOR_FAULT_DROPPED, VEHICLE_SENSOR_HEALTH_CODE_DROPPED},
    {VEHICLE_SENSOR_FAULT_RETRY_EXHAUSTED, VEHICLE_SENSOR_HEALTH_CODE_RETRY_EXHAUSTED},
    {VEHICLE_SENSOR_FAULT_SEND_ERROR, VEHICLE_SENSOR_HEALTH_CODE_SEND_ERROR},
    {VEHICLE_SENSOR_FAULT_PUBLICATION_UNCONFIGURED,
     VEHICLE_SENSOR_HEALTH_CODE_PUBLICATION_UNCONFIGURED},
    {VEHICLE_SENSOR_FAULT_SEQUENCE_EXHAUSTED,
     VEHICLE_SENSOR_HEALTH_CODE_SEQUENCE_EXHAUSTED},
};

static size_t build_faults(uint32_t mask, uint8_t *faults, size_t capacity) {
  if (faults == NULL || capacity == 0) {
    return 0;
  }
  memset(faults, 0, capacity);
  size_t count = 0;
  for (size_t index = 0; index < sizeof(fault_codes) / sizeof(fault_codes[0]); index++) {
    if ((mask & fault_codes[index].mask) != 0 && count < capacity) {
      faults[count++] = fault_codes[index].code;
    }
  }
  return count;
}

void vehicle_sensor_health_init(vehicle_sensor_health_t *health) {
  if (health != NULL) {
    memset(health, 0, sizeof(*health));
  }
}

void vehicle_sensor_health_activate(vehicle_sensor_health_t *health, uint32_t mask) {
  if (health != NULL) {
    health->active_mask |= mask;
    health->history_mask |= mask;
  }
}

void vehicle_sensor_health_recover_transient(vehicle_sensor_health_t *health, uint32_t mask) {
  if (health != NULL) {
    health->active_mask &= ~(mask & ~VEHICLE_SENSOR_FAULT_PERMANENT_MASK);
  }
}

void vehicle_sensor_health_clear_history(vehicle_sensor_health_t *health) {
  if (health != NULL) {
    health->history_mask = 0;
  }
}

uint32_t vehicle_sensor_health_active_mask(const vehicle_sensor_health_t *health) {
  return health == NULL ? 0 : health->active_mask;
}

uint32_t vehicle_sensor_health_history_mask(const vehicle_sensor_health_t *health) {
  return health == NULL ? 0 : health->history_mask;
}

size_t vehicle_sensor_health_build_current(
    const vehicle_sensor_health_t *health,
    uint8_t *faults,
    size_t capacity) {
  return build_faults(vehicle_sensor_health_active_mask(health), faults, capacity);
}

size_t vehicle_sensor_health_build_registered(
    const vehicle_sensor_health_t *health,
    uint8_t *faults,
    size_t capacity) {
  return build_faults(vehicle_sensor_health_history_mask(health), faults, capacity);
}
