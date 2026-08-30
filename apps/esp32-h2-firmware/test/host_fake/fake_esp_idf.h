#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef enum {
  FAKE_FAIL_NONE = 0,
  FAKE_FAIL_GPIO_CONFIG,
  FAKE_FAIL_ISR_HANDLER_ADD,
  FAKE_FAIL_TASK_CREATE,
} fake_failure_t;

void fake_esp_idf_reset(bool initial_level);
void fake_esp_idf_reset_preserving_rtos(bool initial_level);
void fake_esp_idf_fail_next(fake_failure_t failure);
void fake_esp_idf_transition_during_gpio_read(unsigned int read_number, bool level);
void fake_esp_idf_transition_on_next_gpio_read(bool level);
void fake_esp_idf_fire_edges_after_next_empty_receive(bool first_level, bool second_level);
void fake_esp_idf_preempt_task_create_once(void);
void fake_esp_idf_fire_edge(bool level);
void fake_esp_idf_run_sensor_task(void);
void fake_esp_idf_run_task_on_next_delay(void);
void fake_esp_idf_set_created_task_as_current(bool current);
void fake_esp_idf_set_time_us(int64_t value);
unsigned int fake_esp_idf_queue_delete_count(void);
unsigned int fake_esp_idf_task_create_count(void);
unsigned int fake_esp_idf_task_delete_count(void);
bool fake_esp_idf_interrupt_enabled(void);
bool fake_esp_idf_gpio_configured(void);
bool fake_esp_idf_isr_service_installed(void);
unsigned int fake_esp_idf_queue_count(void);
