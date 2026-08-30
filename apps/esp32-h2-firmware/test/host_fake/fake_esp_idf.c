#include "fake_esp_idf.h"

#include <assert.h>
#include <setjmp.h>
#include <stdint.h>
#include <string.h>

#include "driver/gpio.h"
#include "esp_intr_alloc.h"
#include "esp_timer.h"
#include "freertos/queue.h"
#include "freertos/task.h"

static bool gpio_level;
static bool gpio_configured;
static bool interrupt_enabled;
static bool isr_service_installed;
static gpio_isr_t gpio_handler;
static void *gpio_handler_argument;
static unsigned int critical_depth;
static bool deferred_interrupt;
static int64_t monotonic_us;
static unsigned int gpio_read_count;
static unsigned int transition_read_number;
static bool transition_read_level;
static bool fire_edges_after_empty_receive;
static bool empty_receive_first_level;
static bool empty_receive_second_level;
static fake_failure_t next_failure;
static TaskHandle_t created_task;
static TaskHandle_t current_task;
static QueueHandle_t created_queue;
static bool preempt_task_create_once;
static bool preempting_task_create;
static jmp_buf task_create_scheduler;

static void dispatch_interrupt(void) {
  if (!interrupt_enabled || gpio_handler == NULL) {
    return;
  }
  if (critical_depth != 0) {
    deferred_interrupt = true;
    return;
  }
  gpio_handler(gpio_handler_argument);
}

void fake_esp_idf_reset(bool initial_level) {
  gpio_level = initial_level;
  gpio_configured = false;
  interrupt_enabled = false;
  isr_service_installed = false;
  gpio_handler = NULL;
  gpio_handler_argument = NULL;
  critical_depth = 0;
  deferred_interrupt = false;
  monotonic_us = 0;
  gpio_read_count = 0;
  transition_read_number = 0;
  transition_read_level = false;
  fire_edges_after_empty_receive = false;
  empty_receive_first_level = false;
  empty_receive_second_level = false;
  next_failure = FAKE_FAIL_NONE;
  created_task = NULL;
  current_task = NULL;
  created_queue = NULL;
  preempt_task_create_once = false;
  preempting_task_create = false;
}

void fake_esp_idf_fail_next(fake_failure_t failure) {
  next_failure = failure;
}

void fake_esp_idf_transition_during_gpio_read(unsigned int read_number, bool level) {
  transition_read_number = read_number;
  transition_read_level = level;
}

void fake_esp_idf_transition_on_next_gpio_read(bool level) {
  transition_read_number = gpio_read_count + 1;
  transition_read_level = level;
}

void fake_esp_idf_fire_edges_after_next_empty_receive(bool first_level, bool second_level) {
  fire_edges_after_empty_receive = true;
  empty_receive_first_level = first_level;
  empty_receive_second_level = second_level;
}

void fake_esp_idf_preempt_task_create_once(void) {
  preempt_task_create_once = true;
}

void fake_esp_idf_fire_edge(bool level) {
  gpio_level = level;
  dispatch_interrupt();
}

void fake_esp_idf_run_sensor_task(void) {
  assert(created_task != NULL && created_task->active);
  current_task = created_task;
  created_task->function(created_task->argument);
  current_task = NULL;
}

bool fake_esp_idf_interrupt_enabled(void) {
  return interrupt_enabled;
}

bool fake_esp_idf_gpio_configured(void) {
  return gpio_configured;
}

bool fake_esp_idf_isr_service_installed(void) {
  return isr_service_installed;
}

unsigned int fake_esp_idf_queue_count(void) {
  return created_queue == NULL ? 0 : created_queue->count;
}

void fake_port_enter_critical(portMUX_TYPE *mux) {
  mux->locked += 1;
  critical_depth += 1;
}

void fake_port_exit_critical(portMUX_TYPE *mux) {
  assert(mux->locked > 0 && critical_depth > 0);
  mux->locked -= 1;
  critical_depth -= 1;
  if (critical_depth == 0 && deferred_interrupt) {
    deferred_interrupt = false;
    dispatch_interrupt();
  }
}

int gpio_get_level(gpio_num_t gpio) {
  (void)gpio;
  gpio_read_count += 1;
  const bool sampled = gpio_level;
  if (transition_read_number == gpio_read_count) {
    transition_read_number = 0;
    fake_esp_idf_fire_edge(transition_read_level);
  }
  return sampled ? 1 : 0;
}

esp_err_t gpio_config(const gpio_config_t *config) {
  (void)config;
  if (next_failure == FAKE_FAIL_GPIO_CONFIG) {
    next_failure = FAKE_FAIL_NONE;
    return ESP_FAIL;
  }
  gpio_configured = true;
  return ESP_OK;
}

esp_err_t gpio_install_isr_service(int flags) {
  assert(flags == ESP_INTR_FLAG_IRAM);
  isr_service_installed = true;
  return ESP_OK;
}

void gpio_uninstall_isr_service(void) {
  isr_service_installed = false;
}

esp_err_t gpio_isr_handler_add(gpio_num_t gpio, gpio_isr_t handler, void *argument) {
  (void)gpio;
  if (next_failure == FAKE_FAIL_ISR_HANDLER_ADD) {
    next_failure = FAKE_FAIL_NONE;
    return ESP_FAIL;
  }
  gpio_handler = handler;
  gpio_handler_argument = argument;
  return ESP_OK;
}

esp_err_t gpio_isr_handler_remove(gpio_num_t gpio) {
  (void)gpio;
  gpio_handler = NULL;
  gpio_handler_argument = NULL;
  return ESP_OK;
}

esp_err_t gpio_set_intr_type(gpio_num_t gpio, int type) {
  (void)gpio;
  assert(type == GPIO_INTR_ANYEDGE);
  return ESP_OK;
}

esp_err_t gpio_intr_enable(gpio_num_t gpio) {
  (void)gpio;
  interrupt_enabled = true;
  return ESP_OK;
}

esp_err_t gpio_intr_disable(gpio_num_t gpio) {
  (void)gpio;
  interrupt_enabled = false;
  deferred_interrupt = false;
  return ESP_OK;
}

esp_err_t gpio_reset_pin(gpio_num_t gpio) {
  (void)gpio;
  gpio_configured = false;
  return ESP_OK;
}

int64_t esp_timer_get_time(void) {
  monotonic_us += 1;
  return monotonic_us;
}

QueueHandle_t xQueueCreateStatic(
    UBaseType_t length,
    UBaseType_t item_size,
    uint8_t *storage,
    StaticQueue_t *queue_storage) {
  queue_storage->storage = storage;
  queue_storage->length = length;
  queue_storage->item_size = item_size;
  queue_storage->head = 0;
  queue_storage->tail = 0;
  queue_storage->count = 0;
  queue_storage->active = true;
  created_queue = queue_storage;
  return queue_storage;
}

BaseType_t xQueueSend(QueueHandle_t queue, const void *item, TickType_t ticks_to_wait) {
  (void)ticks_to_wait;
  if (queue == NULL || !queue->active || queue->count == queue->length) {
    return pdFALSE;
  }
  memcpy(queue->storage + queue->tail * queue->item_size, item, queue->item_size);
  queue->tail = (queue->tail + 1) % queue->length;
  queue->count += 1;
  return pdTRUE;
}

BaseType_t xQueueSendFromISR(QueueHandle_t queue, const void *item, BaseType_t *higher_priority_woken) {
  (void)higher_priority_woken;
  return xQueueSend(queue, item, 0);
}

BaseType_t xQueueReceive(QueueHandle_t queue, void *item, TickType_t ticks_to_wait) {
  (void)ticks_to_wait;
  if (queue == NULL || !queue->active || queue->count == 0) {
    if (queue != NULL && queue->active && fire_edges_after_empty_receive) {
      fire_edges_after_empty_receive = false;
      fake_esp_idf_fire_edge(empty_receive_first_level);
      fake_esp_idf_fire_edge(empty_receive_second_level);
    }
    return pdFALSE;
  }
  memcpy(item, queue->storage + queue->head * queue->item_size, queue->item_size);
  queue->head = (queue->head + 1) % queue->length;
  queue->count -= 1;
  return pdTRUE;
}

void vQueueDelete(QueueHandle_t queue) {
  if (queue != NULL) {
    queue->active = false;
  }
  created_queue = NULL;
}

TaskHandle_t xTaskCreateStatic(
    TaskFunction_t function,
    const char *name,
    uint32_t stack_depth,
    void *argument,
    UBaseType_t priority,
    StackType_t *stack,
    StaticTask_t *task_storage) {
  (void)name;
  (void)stack_depth;
  (void)priority;
  (void)stack;
  if (next_failure == FAKE_FAIL_TASK_CREATE) {
    next_failure = FAKE_FAIL_NONE;
    return NULL;
  }
  task_storage->function = function;
  task_storage->argument = argument;
  task_storage->active = true;
  task_storage->notifications = 0;
  created_task = task_storage;
  if (preempt_task_create_once) {
    preempt_task_create_once = false;
    preempting_task_create = true;
    current_task = task_storage;
    if (setjmp(task_create_scheduler) == 0) {
      task_storage->function(task_storage->argument);
    }
    current_task = NULL;
    preempting_task_create = false;
  }
  return task_storage;
}

void vTaskDelete(TaskHandle_t task) {
  assert(task != NULL);
  task->active = false;
  if (created_task == task) {
    created_task = NULL;
  }
}

TaskHandle_t xTaskGetCurrentTaskHandle(void) {
  return current_task;
}

BaseType_t xTaskNotifyGive(TaskHandle_t task) {
  assert(task != NULL && task->active);
  task->notifications += 1;
  return pdTRUE;
}

uint32_t ulTaskNotifyTake(BaseType_t clear_on_exit, TickType_t ticks_to_wait) {
  assert(current_task != NULL && current_task->active);
  if (current_task->notifications > 0) {
    const uint32_t notifications = current_task->notifications;
    if (clear_on_exit == pdTRUE) {
      current_task->notifications = 0;
    } else {
      current_task->notifications -= 1;
    }
    return notifications;
  }
  if (preempting_task_create && ticks_to_wait == portMAX_DELAY) {
    longjmp(task_create_scheduler, 1);
  }
  return 0;
}
