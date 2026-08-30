#pragma once

#include "freertos/FreeRTOS.h"

typedef void (*TaskFunction_t)(void *argument);
typedef struct {
  TaskFunction_t function;
  void *argument;
  int active;
  uint32_t notifications;
} StaticTask_t;
typedef StaticTask_t *TaskHandle_t;

TaskHandle_t xTaskCreateStatic(
    TaskFunction_t function,
    const char *name,
    uint32_t stack_depth,
    void *argument,
    UBaseType_t priority,
    StackType_t *stack,
    StaticTask_t *task_storage);
void vTaskDelete(TaskHandle_t task);
TaskHandle_t xTaskGetCurrentTaskHandle(void);
BaseType_t xTaskNotifyGive(TaskHandle_t task);
uint32_t ulTaskNotifyTake(BaseType_t clear_on_exit, TickType_t ticks_to_wait);
void vTaskDelay(TickType_t ticks);
