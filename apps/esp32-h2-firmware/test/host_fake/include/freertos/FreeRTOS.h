#pragma once

#include <stdint.h>

typedef int BaseType_t;
typedef unsigned int UBaseType_t;
typedef uint32_t TickType_t;
typedef uint32_t StackType_t;
typedef struct {
  int locked;
} portMUX_TYPE;

#define portMUX_INITIALIZER_UNLOCKED {0}
#define pdTRUE 1
#define pdFALSE 0
#define portMAX_DELAY UINT32_MAX

void fake_port_enter_critical(portMUX_TYPE *mux);
void fake_port_exit_critical(portMUX_TYPE *mux);

#define portENTER_CRITICAL(mux) fake_port_enter_critical(mux)
#define portEXIT_CRITICAL(mux) fake_port_exit_critical(mux)
