#pragma once

#include "esp_err.h"

typedef int esp_reset_reason_t;

_Noreturn void esp_system_abort(const char *details);
esp_err_t esp_register_shutdown_handler(void (*handler)(void));
esp_reset_reason_t esp_reset_reason(void);
