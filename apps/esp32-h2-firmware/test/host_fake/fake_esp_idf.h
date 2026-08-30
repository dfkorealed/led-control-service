#pragma once

#include <stdbool.h>

typedef enum {
  FAKE_FAIL_NONE = 0,
  FAKE_FAIL_GPIO_CONFIG,
  FAKE_FAIL_ISR_HANDLER_ADD,
  FAKE_FAIL_TASK_CREATE,
} fake_failure_t;

void fake_esp_idf_reset(bool initial_level);
void fake_esp_idf_fail_next(fake_failure_t failure);
void fake_esp_idf_transition_during_gpio_read(unsigned int read_number, bool level);
void fake_esp_idf_transition_on_next_gpio_read(bool level);
void fake_esp_idf_fire_edge(bool level);
void fake_esp_idf_run_sensor_task(void);
bool fake_esp_idf_interrupt_enabled(void);
bool fake_esp_idf_gpio_configured(void);
bool fake_esp_idf_isr_service_installed(void);
unsigned int fake_esp_idf_queue_count(void);
