#pragma once

#include <stddef.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"

typedef struct {
  uint8_t *storage;
  UBaseType_t length;
  UBaseType_t item_size;
  UBaseType_t head;
  UBaseType_t tail;
  UBaseType_t count;
  int active;
} StaticQueue_t;
typedef StaticQueue_t *QueueHandle_t;

QueueHandle_t xQueueCreateStatic(
    UBaseType_t length,
    UBaseType_t item_size,
    uint8_t *storage,
    StaticQueue_t *queue_storage);
BaseType_t xQueueSend(QueueHandle_t queue, const void *item, TickType_t ticks_to_wait);
BaseType_t xQueueSendToFront(QueueHandle_t queue, const void *item, TickType_t ticks_to_wait);
BaseType_t xQueueSendFromISR(QueueHandle_t queue, const void *item, BaseType_t *higher_priority_woken);
BaseType_t xQueueReceive(QueueHandle_t queue, void *item, TickType_t ticks_to_wait);
void vQueueDelete(QueueHandle_t queue);
BaseType_t xQueueReset(QueueHandle_t queue);
UBaseType_t uxQueueMessagesWaiting(QueueHandle_t queue);
