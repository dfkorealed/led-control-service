#include "vehicle_sensor_health.h"

#include <assert.h>
#include <string.h>

static void test_active_faults_recover_but_history_is_retained(void) {
  vehicle_sensor_health_t health;
  uint8_t current[8];
  uint8_t registered[8];

  vehicle_sensor_health_init(&health);
  vehicle_sensor_health_activate(
      &health,
      VEHICLE_SENSOR_FAULT_DROPPED | VEHICLE_SENSOR_FAULT_SEND_ERROR);
  assert(vehicle_sensor_health_active_mask(&health) ==
         (VEHICLE_SENSOR_FAULT_DROPPED | VEHICLE_SENSOR_FAULT_SEND_ERROR));
  assert(vehicle_sensor_health_history_mask(&health) ==
         (VEHICLE_SENSOR_FAULT_DROPPED | VEHICLE_SENSOR_FAULT_SEND_ERROR));

  memset(current, 0x7f, sizeof(current));
  memset(registered, 0x7f, sizeof(registered));
  assert(vehicle_sensor_health_build_current(&health, current, sizeof(current)) == 2);
  assert(vehicle_sensor_health_build_registered(&health, registered, sizeof(registered)) == 2);
  assert(current[0] == VEHICLE_SENSOR_HEALTH_CODE_DROPPED);
  assert(current[1] == VEHICLE_SENSOR_HEALTH_CODE_SEND_ERROR);
  assert(current[2] == 0);

  vehicle_sensor_health_recover_transient(&health, VEHICLE_SENSOR_FAULT_DROPPED);
  assert(vehicle_sensor_health_build_current(&health, current, sizeof(current)) == 1);
  assert(current[0] == VEHICLE_SENSOR_HEALTH_CODE_SEND_ERROR);
  assert(current[1] == 0);
  assert(vehicle_sensor_health_build_registered(&health, registered, sizeof(registered)) == 2);
}

static void test_clear_only_history_and_sequence_remains_active(void) {
  vehicle_sensor_health_t health;
  uint8_t current[8];
  uint8_t registered[8];

  vehicle_sensor_health_init(&health);
  vehicle_sensor_health_activate(
      &health,
      VEHICLE_SENSOR_FAULT_SEND_ERROR | VEHICLE_SENSOR_FAULT_SEQUENCE_EXHAUSTED);
  vehicle_sensor_health_recover_transient(
      &health,
      VEHICLE_SENSOR_FAULT_SEND_ERROR | VEHICLE_SENSOR_FAULT_SEQUENCE_EXHAUSTED);
  assert(vehicle_sensor_health_active_mask(&health) == VEHICLE_SENSOR_FAULT_SEQUENCE_EXHAUSTED);

  vehicle_sensor_health_clear_history(&health);
  assert(vehicle_sensor_health_history_mask(&health) == 0);
  assert(vehicle_sensor_health_build_registered(&health, registered, sizeof(registered)) == 0);
  assert(registered[0] == 0);
  assert(vehicle_sensor_health_build_current(&health, current, sizeof(current)) == 1);
  assert(current[0] == VEHICLE_SENSOR_HEALTH_CODE_SEQUENCE_EXHAUSTED);
  assert(current[1] == 0);
}

int main(void) {
  test_active_faults_recover_but_history_is_retained();
  test_clear_only_history_and_sequence_remains_active();
  return 0;
}
