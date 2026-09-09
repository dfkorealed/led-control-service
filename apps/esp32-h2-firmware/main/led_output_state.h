#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Zero-initialize before use. The driver serializes all access, including reads
 * that expire attention, and supplies monotonic time after taking its mutex. */
typedef struct {
  uint8_t target_percent;
  bool attention_active;
  int64_t attention_started_us;
  int64_t attention_duration_us;
} led_output_state_t;

void led_output_state_set_target(led_output_state_t *state, uint8_t percent);
void led_output_state_set_attention(led_output_state_t *state, uint8_t seconds, int64_t now_us);
uint8_t led_output_state_brightness(led_output_state_t *state, int64_t now_us);
