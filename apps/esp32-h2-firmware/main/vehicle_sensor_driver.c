#include "vehicle_sensor_driver.h"

#include <limits.h>
#include <stddef.h>

_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "vehicle sensor ISR counter must be lock-free");
_Static_assert(ATOMIC_BOOL_LOCK_FREE == 2, "vehicle sensor ISR flags must be lock-free");
_Static_assert(sizeof(vehicle_sensor_edge_t) <= 16, "vehicle sensor queue items must remain fixed and small");

void vehicle_sensor_state_init(vehicle_sensor_state_t *state) {
  if (state == NULL) {
    return;
  }
  state->has_level = false;
  state->level = false;
  atomic_init(&state->dropped_edges, 0);
}

bool vehicle_sensor_process_level(
    vehicle_sensor_state_t *state,
    bool level,
    uint64_t monotonic_us,
    vehicle_sensor_event_t *event) {
  if (state == NULL || event == NULL || (state->has_level && state->level == level)) {
    return false;
  }

  state->has_level = true;
  state->level = level;
  event->kind = level ? VEHICLE_SENSOR_DETECTED : VEHICLE_SENSOR_CLEARED;
  event->level = level;
  event->monotonic_us = monotonic_us;
  return true;
}

uint64_t vehicle_sensor_elapsed_us(uint64_t newer, uint64_t older) {
  return newer - older;
}

bool vehicle_sensor_gpio_is_safe(
    int gpio,
    int pwm_gpio,
    int factory_reset_gpio,
    int console_tx_gpio,
    int console_rx_gpio) {
  if (gpio == pwm_gpio || gpio == factory_reset_gpio ||
      gpio == console_tx_gpio || gpio == console_rx_gpio) {
    return false;
  }

  // Deny by default so new package variants and special-purpose pins cannot become sensor inputs implicitly.
  switch (gpio) {
  case 0:
  case 1:
  case 4:
  case 5:
  case 10:
  case 11:
  case 12:
  case 13:
  case 14:
  case 22:
  case 23:
  case 24:
    return true;
  default:
    return false;
  }
}

void vehicle_sensor_record_dropped_edge(vehicle_sensor_state_t *state) {
  if (state == NULL) {
    return;
  }

  uint32_t current = atomic_load_explicit(&state->dropped_edges, memory_order_relaxed);
  while (current != UINT32_MAX &&
         !atomic_compare_exchange_weak_explicit(
             &state->dropped_edges,
             &current,
             current + 1,
             memory_order_relaxed,
             memory_order_relaxed)) {
  }
}

uint32_t vehicle_sensor_dropped_edge_count(const vehicle_sensor_state_t *state) {
  return state == NULL ? 0 : atomic_load_explicit(&state->dropped_edges, memory_order_relaxed);
}

#ifdef ESP_PLATFORM

#include "driver/gpio.h"
#include "esp_attr.h"
#include "esp_intr_alloc.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "soc/soc_caps.h"

#define VEHICLE_SENSOR_GPIO ((gpio_num_t)CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO)
#define VEHICLE_SENSOR_QUEUE_LENGTH 32
#define VEHICLE_SENSOR_TASK_STACK_DEPTH 3072
#define VEHICLE_SENSOR_TASK_PRIORITY 6

#if defined(CONFIG_ESP_CONSOLE_UART_DEFAULT)
#define VEHICLE_SENSOR_CONSOLE_TX_GPIO 24
#define VEHICLE_SENSOR_CONSOLE_RX_GPIO 23
#elif defined(CONFIG_ESP_CONSOLE_UART_CUSTOM)
#if CONFIG_ESP_CONSOLE_UART_TX_GPIO >= 0
#define VEHICLE_SENSOR_CONSOLE_TX_GPIO CONFIG_ESP_CONSOLE_UART_TX_GPIO
#elif CONFIG_ESP_CONSOLE_UART_NUM == 0
#define VEHICLE_SENSOR_CONSOLE_TX_GPIO 24
#else
#define VEHICLE_SENSOR_CONSOLE_TX_GPIO -1
#endif
#if CONFIG_ESP_CONSOLE_UART_RX_GPIO >= 0
#define VEHICLE_SENSOR_CONSOLE_RX_GPIO CONFIG_ESP_CONSOLE_UART_RX_GPIO
#elif CONFIG_ESP_CONSOLE_UART_NUM == 0
#define VEHICLE_SENSOR_CONSOLE_RX_GPIO 23
#else
#define VEHICLE_SENSOR_CONSOLE_RX_GPIO -1
#endif
#else
#define VEHICLE_SENSOR_CONSOLE_TX_GPIO -1
#define VEHICLE_SENSOR_CONSOLE_RX_GPIO -1
#endif

#if !SOC_GPIO_SUPPORT_PIN_HYS_FILTER
#error "ESP32-H2 hardware GPIO hysteresis is required"
#endif

#if !defined(CONFIG_GPIO_CTRL_FUNC_IN_IRAM) || !CONFIG_GPIO_CTRL_FUNC_IN_IRAM
#error "CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y is required for the vehicle sensor ISR"
#endif

#if CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO < 0 || CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO > 27 || \
    CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 2 || CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 3 || \
    CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 6 || CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 7 || \
    CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 8 || CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 9 || \
    (CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO >= 15 && CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO <= 21) || \
    CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 25 || CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 26 || \
    CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 27
#error "Vehicle sensor GPIO conflicts with ESP32-H2 strapping, flash, package, or USB-Serial-JTAG pins"
#endif

#if CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == CONFIG_LED_CONTROL_PWM_GPIO
#error "Vehicle sensor GPIO must not conflict with the PWM GPIO"
#endif

#if CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == CONFIG_LED_CONTROL_FACTORY_RESET_GPIO
#error "Vehicle sensor GPIO must not conflict with the factory reset GPIO"
#endif

#if defined(CONFIG_ESP_CONSOLE_UART_DEFAULT) && \
    (CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 23 || CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == 24)
#error "Vehicle sensor GPIO must not conflict with UART0 console GPIO23/GPIO24"
#endif

#if defined(CONFIG_ESP_CONSOLE_UART_CUSTOM) && \
    (CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == VEHICLE_SENSOR_CONSOLE_TX_GPIO || \
     CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO == VEHICLE_SENSOR_CONSOLE_RX_GPIO)
#error "Vehicle sensor GPIO must not conflict with configured console GPIO"
#endif

typedef struct {
  vehicle_sensor_state_t state;
  vehicle_sensor_event_handler_t handler;
  void *handler_context;
  QueueHandle_t queue;
  TaskHandle_t task;
  bool isr_service_owned;
  bool gpio_configured;
  bool handler_registered;
  _Atomic bool current_level_valid;
  _Atomic bool current_level;
  _Atomic bool resync_needed;
  _Atomic uint32_t isr_generation;
  bool task_gate_open;
} vehicle_sensor_driver_t;

static vehicle_sensor_driver_t driver;
static StaticQueue_t edge_queue_storage;
static uint8_t edge_queue_buffer[VEHICLE_SENSOR_QUEUE_LENGTH * sizeof(vehicle_sensor_edge_t)];
static StaticTask_t sensor_task_storage;
static StackType_t sensor_task_stack[VEHICLE_SENSOR_TASK_STACK_DEPTH];
static portMUX_TYPE startup_mux = portMUX_INITIALIZER_UNLOCKED;

void IRAM_ATTR vehicle_sensor_gpio_isr(void *argument) {
  vehicle_sensor_driver_t *sensor = argument;
  atomic_fetch_add_explicit(&sensor->isr_generation, 1, memory_order_release);
  vehicle_sensor_edge_t edge = {
      .level = gpio_get_level(VEHICLE_SENSOR_GPIO) != 0,
      .monotonic_us = (uint64_t)esp_timer_get_time(),
  };

  if (xQueueSendFromISR(sensor->queue, &edge, NULL) == pdTRUE) {
    atomic_store_explicit(&sensor->current_level, edge.level, memory_order_relaxed);
    atomic_store_explicit(&sensor->current_level_valid, true, memory_order_release);
  } else {
    uint32_t dropped = atomic_load_explicit(&sensor->state.dropped_edges, memory_order_relaxed);
    while (dropped != UINT32_MAX &&
           !atomic_compare_exchange_weak_explicit(
               &sensor->state.dropped_edges,
               &dropped,
               dropped + 1,
               memory_order_relaxed,
               memory_order_relaxed)) {
    }
    atomic_store_explicit(&sensor->resync_needed, true, memory_order_release);
  }
}

static void vehicle_sensor_publish_edge(
    vehicle_sensor_driver_t *sensor,
    const vehicle_sensor_edge_t *edge) {
  vehicle_sensor_event_t event;
  if (vehicle_sensor_process_level(&sensor->state, edge->level, edge->monotonic_us, &event)) {
    sensor->handler(&event, sensor->handler_context);
  }
}

static void vehicle_sensor_task(void *argument) {
  vehicle_sensor_driver_t *sensor = argument;
  vehicle_sensor_edge_t edge;

  if (!sensor->task_gate_open) {
    if (ulTaskNotifyTake(pdTRUE, portMAX_DELAY) == 0) {
      return;
    }
    sensor->task_gate_open = true;
  }

  for (;;) {
    if (xQueueReceive(sensor->queue, &edge, portMAX_DELAY) != pdTRUE) {
      return;
    }

    vehicle_sensor_publish_edge(sensor, &edge);
    while (xQueueReceive(sensor->queue, &edge, 0) == pdTRUE) {
      vehicle_sensor_publish_edge(sensor, &edge);
    }

    while (atomic_exchange_explicit(&sensor->resync_needed, false, memory_order_acq_rel)) {
      const uint32_t generation_before =
          atomic_load_explicit(&sensor->isr_generation, memory_order_acquire);
      vehicle_sensor_edge_t sampled_edge = {
          .monotonic_us = (uint64_t)esp_timer_get_time(),
      };
      sampled_edge.level = gpio_get_level(VEHICLE_SENSOR_GPIO) != 0;

      bool generation_stable = false;
      portENTER_CRITICAL(&startup_mux);
      if (generation_before ==
          atomic_load_explicit(&sensor->isr_generation, memory_order_acquire)) {
        atomic_store_explicit(&sensor->current_level, sampled_edge.level, memory_order_relaxed);
        atomic_store_explicit(&sensor->current_level_valid, true, memory_order_release);
        generation_stable = true;
      }
      portEXIT_CRITICAL(&startup_mux);

      if (generation_stable) {
        vehicle_sensor_publish_edge(sensor, &sampled_edge);
      }
      // A changed generation rejects the stale sample; drain the newer ISR edge before retrying.
      while (xQueueReceive(sensor->queue, &edge, 0) == pdTRUE) {
        vehicle_sensor_publish_edge(sensor, &edge);
      }
    }
  }
}

static void vehicle_sensor_driver_cleanup(void) {
  if (driver.gpio_configured) {
    gpio_intr_disable(VEHICLE_SENSOR_GPIO);
  }
  if (driver.handler_registered) {
    gpio_isr_handler_remove(VEHICLE_SENSOR_GPIO);
    driver.handler_registered = false;
  }
  if (driver.task != NULL) {
    vTaskDelete(driver.task);
    driver.task = NULL;
  }
  if (driver.queue != NULL) {
    vQueueDelete(driver.queue);
    driver.queue = NULL;
  }
  if (driver.isr_service_owned) {
    gpio_uninstall_isr_service();
    driver.isr_service_owned = false;
  }
  if (driver.gpio_configured) {
    gpio_reset_pin(VEHICLE_SENSOR_GPIO);
    driver.gpio_configured = false;
  }
  driver.handler = NULL;
  driver.handler_context = NULL;
  atomic_store_explicit(&driver.current_level_valid, false, memory_order_release);
  atomic_store_explicit(&driver.resync_needed, false, memory_order_release);
  atomic_store_explicit(&driver.isr_generation, 0, memory_order_release);
  driver.task_gate_open = false;
}

esp_err_t vehicle_sensor_driver_start(vehicle_sensor_event_handler_t handler, void *context) {
  if (handler == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  if (driver.queue != NULL) {
    return ESP_ERR_INVALID_STATE;
  }
  if (!vehicle_sensor_gpio_is_safe(
          CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO,
          CONFIG_LED_CONTROL_PWM_GPIO,
          CONFIG_LED_CONTROL_FACTORY_RESET_GPIO,
          VEHICLE_SENSOR_CONSOLE_TX_GPIO,
          VEHICLE_SENSOR_CONSOLE_RX_GPIO)) {
    return ESP_ERR_INVALID_ARG;
  }

  vehicle_sensor_state_init(&driver.state);
  driver.handler = handler;
  driver.handler_context = context;
  atomic_init(&driver.current_level_valid, false);
  atomic_init(&driver.current_level, false);
  atomic_init(&driver.resync_needed, false);
  atomic_init(&driver.isr_generation, 0);
  driver.task_gate_open = false;
  driver.queue = xQueueCreateStatic(
      VEHICLE_SENSOR_QUEUE_LENGTH,
      sizeof(vehicle_sensor_edge_t),
      edge_queue_buffer,
      &edge_queue_storage);
  if (driver.queue == NULL) {
    return ESP_ERR_NO_MEM;
  }

  const gpio_config_t config = {
      .pin_bit_mask = 1ULL << VEHICLE_SENSOR_GPIO,
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_ENABLE,
      .intr_type = GPIO_INTR_DISABLE,
      .hys_ctrl_mode = GPIO_HYS_SOFT_ENABLE,
  };
  esp_err_t error = gpio_config(&config);
  if (error != ESP_OK) {
    vehicle_sensor_driver_cleanup();
    return error;
  }
  driver.gpio_configured = true;

  error = gpio_install_isr_service(ESP_INTR_FLAG_IRAM);
  if (error == ESP_OK) {
    driver.isr_service_owned = true;
  } else if (error != ESP_ERR_INVALID_STATE) {
    vehicle_sensor_driver_cleanup();
    return error;
  }

  error = gpio_isr_handler_add(VEHICLE_SENSOR_GPIO, vehicle_sensor_gpio_isr, &driver);
  if (error != ESP_OK) {
    vehicle_sensor_driver_cleanup();
    return error;
  }
  driver.handler_registered = true;

  error = gpio_set_intr_type(VEHICLE_SENSOR_GPIO, GPIO_INTR_ANYEDGE);
  if (error != ESP_OK) {
    goto fail;
  }

  vehicle_sensor_edge_t boot_edge = {
      .level = gpio_get_level(VEHICLE_SENSOR_GPIO) != 0,
      .monotonic_us = (uint64_t)esp_timer_get_time(),
  };
  if (xQueueSend(driver.queue, &boot_edge, 0) != pdTRUE) {
    vehicle_sensor_driver_cleanup();
    return ESP_ERR_NO_MEM;
  }
  atomic_store_explicit(&driver.current_level, boot_edge.level, memory_order_relaxed);
  atomic_store_explicit(&driver.current_level_valid, true, memory_order_release);

  portENTER_CRITICAL(&startup_mux);
  error = gpio_intr_enable(VEHICLE_SENSOR_GPIO);
  if (error == ESP_OK) {
    const vehicle_sensor_edge_t reconciled_edge = {
        .level = gpio_get_level(VEHICLE_SENSOR_GPIO) != 0,
        .monotonic_us = (uint64_t)esp_timer_get_time(),
    };
    if (xQueueSend(driver.queue, &reconciled_edge, 0) != pdTRUE) {
      error = ESP_ERR_NO_MEM;
    } else {
      atomic_store_explicit(&driver.current_level, reconciled_edge.level, memory_order_relaxed);
      atomic_store_explicit(&driver.current_level_valid, true, memory_order_release);
    }
  }
  portEXIT_CRITICAL(&startup_mux);
  if (error != ESP_OK) {
    goto fail;
  }

  TaskHandle_t created_task = xTaskCreateStatic(
      vehicle_sensor_task,
      "vehicle_sensor",
      VEHICLE_SENSOR_TASK_STACK_DEPTH,
      &driver,
      VEHICLE_SENSOR_TASK_PRIORITY,
      sensor_task_stack,
      &sensor_task_storage);
  if (created_task == NULL) {
    error = ESP_ERR_NO_MEM;
    goto fail;
  }
  driver.task = created_task;
  xTaskNotifyGive(driver.task);
  return ESP_OK;

fail:
  vehicle_sensor_driver_cleanup();
  return error;
}

esp_err_t vehicle_sensor_driver_stop(void) {
  if (driver.queue == NULL) {
    return ESP_OK;
  }
  if (driver.task != NULL && xTaskGetCurrentTaskHandle() == driver.task) {
    return ESP_ERR_INVALID_STATE;
  }
  vehicle_sensor_driver_cleanup();
  return ESP_OK;
}

bool vehicle_sensor_driver_get_current_level(bool *level) {
  if (level == NULL || !atomic_load_explicit(&driver.current_level_valid, memory_order_acquire)) {
    return false;
  }
  *level = atomic_load_explicit(&driver.current_level, memory_order_relaxed);
  return true;
}

uint32_t vehicle_sensor_driver_dropped_edge_count(void) {
  return vehicle_sensor_dropped_edge_count(&driver.state);
}

#endif
