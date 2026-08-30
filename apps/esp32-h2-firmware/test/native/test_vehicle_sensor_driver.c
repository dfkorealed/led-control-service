#include "vehicle_sensor_driver.h"

#include <assert.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>

static void test_boot_level_and_duplicate_filtering(void) {
  vehicle_sensor_state_t state;
  vehicle_sensor_event_t event;

  vehicle_sensor_state_init(&state);

  assert(vehicle_sensor_process_level(&state, true, 1000, &event));
  assert(event.kind == VEHICLE_SENSOR_DETECTED);
  assert(event.level);
  assert(event.monotonic_us == 1000);
  assert(!vehicle_sensor_process_level(&state, true, 2000, &event));
  assert(vehicle_sensor_process_level(&state, false, 3000, &event));
  assert(event.kind == VEHICLE_SENSOR_CLEARED);
  assert(!event.level);
  assert(event.monotonic_us == 3000);
}

static void test_boot_low_is_emitted_once(void) {
  vehicle_sensor_state_t state;
  vehicle_sensor_event_t event;

  vehicle_sensor_state_init(&state);

  assert(vehicle_sensor_process_level(&state, false, 42, &event));
  assert(event.kind == VEHICLE_SENSOR_CLEARED);
  assert(!vehicle_sensor_process_level(&state, false, 43, &event));
}

static void test_does_not_apply_a_timing_filter(void) {
  vehicle_sensor_state_t state;
  vehicle_sensor_event_t event;

  vehicle_sensor_state_init(&state);

  assert(vehicle_sensor_process_level(&state, true, 500, &event));
  assert(vehicle_sensor_process_level(&state, false, 500, &event));
  assert(vehicle_sensor_process_level(&state, true, 501, &event));
  assert(event.kind == VEHICLE_SENSOR_DETECTED);
  assert(event.monotonic_us == 501);
}

static void test_timestamp_elapsed_is_wrap_safe(void) {
  assert(vehicle_sensor_elapsed_us(3, UINT64_MAX - 4) == 8);
}

static void test_dropped_counter_is_atomic_and_monotonic(void) {
  vehicle_sensor_state_t state;

  vehicle_sensor_state_init(&state);
  vehicle_sensor_record_dropped_edge(&state);
  vehicle_sensor_record_dropped_edge(&state);

  assert(vehicle_sensor_dropped_edge_count(&state) == 2);
  vehicle_sensor_record_dropped_edge(&state);
  assert(vehicle_sensor_dropped_edge_count(&state) == 3);

  atomic_store(&state.dropped_edges, UINT32_MAX);
  vehicle_sensor_record_dropped_edge(&state);
  assert(vehicle_sensor_dropped_edge_count(&state) == UINT32_MAX);
}

static void test_gpio_allowlist_and_owned_pin_conflicts(void) {
  static const bool expected_safe[28] = {
      true, true, false, false, true, true, false, false,
      false, false, true, true, true, true, true, false,
      false, false, false, false, false, false, true, true,
      true, false, false, false,
  };

  for (int gpio = 0; gpio < 28; gpio += 1) {
    assert(vehicle_sensor_gpio_is_safe(gpio, 8, 9) == expected_safe[gpio]);
  }

  assert(!vehicle_sensor_gpio_is_safe(-1, 8, 9));
  assert(!vehicle_sensor_gpio_is_safe(28, 8, 9));
  assert(!vehicle_sensor_gpio_is_safe(4, 4, 9));
  assert(!vehicle_sensor_gpio_is_safe(4, 8, 4));
}

int main(void) {
  test_boot_level_and_duplicate_filtering();
  test_boot_low_is_emitted_once();
  test_does_not_apply_a_timing_filter();
  test_timestamp_elapsed_is_wrap_safe();
  test_dropped_counter_is_atomic_and_monotonic();
  test_gpio_allowlist_and_owned_pin_conflicts();
  return 0;
}
