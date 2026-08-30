#include "fake_esp_idf.h"
#include "vehicle_sensor_driver.h"

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>

typedef struct {
  vehicle_sensor_event_t events[96];
  bool current_levels[96];
  size_t count;
  bool stop_in_callback;
  esp_err_t self_stop_result;
} event_log_t;

static void record_event(const vehicle_sensor_event_t *event, void *context) {
  event_log_t *log = context;
  assert(log->count < sizeof(log->events) / sizeof(log->events[0]));
  bool current = false;
  assert(vehicle_sensor_driver_get_current_level(&current));
  log->events[log->count] = *event;
  log->current_levels[log->count] = current;
  log->count += 1;
  if (log->stop_in_callback) {
    log->stop_in_callback = false;
    log->self_stop_result = vehicle_sensor_driver_stop();
  }
}

static void assert_fully_stopped(void) {
  assert(!fake_esp_idf_interrupt_enabled());
  assert(!fake_esp_idf_gpio_configured());
  assert(!fake_esp_idf_isr_service_installed());
  assert(fake_esp_idf_queue_count() == 0);
}

static void test_boot_sample_precedes_deferred_isr_and_current_is_ready(void) {
  event_log_t log = {0};
  bool current = false;

  fake_esp_idf_reset(false);
  fake_esp_idf_transition_during_gpio_read(2, true);

  assert(vehicle_sensor_driver_start(record_event, &log) == ESP_OK);
  assert(vehicle_sensor_driver_get_current_level(&current));
  assert(current);

  fake_esp_idf_run_sensor_task();
  assert(log.count == 2);
  assert(!log.events[0].level);
  assert(log.events[1].level);
  assert(vehicle_sensor_driver_stop() == ESP_OK);
  assert_fully_stopped();
}

static void fill_queue_and_drop_terminal_high(void) {
  for (unsigned int index = 0; index < 32; index += 1) {
    fake_esp_idf_fire_edge(index % 2 == 0);
  }
  fake_esp_idf_fire_edge(true);
}

static void test_queue_overflow_resyncs_a_held_high_level(void) {
  event_log_t log = {0};
  bool current = false;

  fake_esp_idf_reset(false);
  assert(vehicle_sensor_driver_start(record_event, &log) == ESP_OK);
  fake_esp_idf_run_sensor_task();
  log.count = 0;

  fill_queue_and_drop_terminal_high();
  assert(vehicle_sensor_driver_dropped_edge_count() == 1);
  fake_esp_idf_run_sensor_task();

  assert(log.count == 33);
  assert(log.events[log.count - 1].level);
  assert(log.current_levels[log.count - 1]);
  for (size_t index = 1; index < log.count; index += 1) {
    assert(log.events[index - 1].monotonic_us <= log.events[index].monotonic_us);
  }
  assert(vehicle_sensor_driver_get_current_level(&current));
  assert(current);
  assert(vehicle_sensor_driver_stop() == ESP_OK);
}

static void test_newer_isr_edge_wins_a_resync_read_race(void) {
  event_log_t log = {0};
  bool current = false;

  fake_esp_idf_reset(false);
  assert(vehicle_sensor_driver_start(record_event, &log) == ESP_OK);
  fake_esp_idf_run_sensor_task();
  log.count = 0;

  fill_queue_and_drop_terminal_high();
  fake_esp_idf_transition_on_next_gpio_read(false);
  fake_esp_idf_run_sensor_task();

  assert(log.count == 32);
  for (size_t index = 1; index < log.count; index += 1) {
    assert(log.events[index - 1].monotonic_us <= log.events[index].monotonic_us);
  }
  assert(vehicle_sensor_driver_get_current_level(&current));
  assert(!current);
  assert(vehicle_sensor_driver_stop() == ESP_OK);
}

static void test_task_create_preemption_blocks_until_handle_is_published(void) {
  event_log_t log = {.stop_in_callback = true};

  fake_esp_idf_reset(true);
  fake_esp_idf_preempt_task_create_once();
  assert(vehicle_sensor_driver_start(record_event, &log) == ESP_OK);
  assert(log.count == 0);

  fake_esp_idf_run_sensor_task();
  assert(log.count == 1);
  assert(log.self_stop_result == ESP_ERR_INVALID_STATE);
  assert(vehicle_sensor_driver_stop() == ESP_OK);
  assert_fully_stopped();
}

static void test_callback_self_stop_is_rejected_and_external_stop_completes(void) {
  event_log_t log = {.stop_in_callback = true};

  fake_esp_idf_reset(true);
  assert(vehicle_sensor_driver_start(record_event, &log) == ESP_OK);
  fake_esp_idf_run_sensor_task();

  assert(log.self_stop_result == ESP_ERR_INVALID_STATE);
  assert(fake_esp_idf_interrupt_enabled());
  assert(vehicle_sensor_driver_stop() == ESP_OK);
  assert_fully_stopped();
}

static void test_repeated_start_stop_and_failed_start_cleanup(void) {
  event_log_t log = {0};

  fake_esp_idf_reset(false);
  fake_esp_idf_fail_next(FAKE_FAIL_ISR_HANDLER_ADD);
  assert(vehicle_sensor_driver_start(record_event, &log) == ESP_FAIL);
  assert_fully_stopped();

  assert(vehicle_sensor_driver_start(record_event, &log) == ESP_OK);
  assert(vehicle_sensor_driver_stop() == ESP_OK);
  assert_fully_stopped();
  assert(vehicle_sensor_driver_stop() == ESP_OK);

  assert(vehicle_sensor_driver_start(record_event, &log) == ESP_OK);
  assert(vehicle_sensor_driver_stop() == ESP_OK);
  assert_fully_stopped();

  fake_esp_idf_fail_next(FAKE_FAIL_TASK_CREATE);
  assert(vehicle_sensor_driver_start(record_event, &log) == ESP_ERR_NO_MEM);
  assert_fully_stopped();
}

int main(void) {
  test_boot_sample_precedes_deferred_isr_and_current_is_ready();
  test_queue_overflow_resyncs_a_held_high_level();
  test_newer_isr_edge_wins_a_resync_read_race();
  test_task_create_preemption_blocks_until_handle_is_published();
  test_callback_self_stop_is_rejected_and_external_stop_completes();
  test_repeated_start_stop_and_failed_start_cleanup();
  return 0;
}
