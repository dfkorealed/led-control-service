#pragma once

#include <stdint.h>

#include "esp_err.h"

esp_err_t identify_init(void);
/* Task-context calls; repeated start replaces the deadline, zero means stop.
 * Stop always restores the latest normal driver target, never a snapshot. */
esp_err_t identify_start(uint8_t seconds);
esp_err_t identify_stop(void);
