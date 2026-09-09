#include "led_output_state.h"

#define ATTENTION_PERIOD_US INT64_C(1000000)
#define ATTENTION_PULSE_US INT64_C(150000)
#define ATTENTION_MIN_PERCENT 10

void led_output_state_set_target(led_output_state_t *state, uint8_t percent) {
  state->target_percent = percent > 100 ? 100 : percent;
}

void led_output_state_set_attention(led_output_state_t *state, uint8_t seconds, int64_t now_us) {
  state->attention_active = seconds != 0;
  state->attention_started_us = now_us;
  state->attention_duration_us = (int64_t)seconds * INT64_C(1000000);
}

uint8_t led_output_state_brightness(led_output_state_t *state, int64_t now_us) {
  if (!state->attention_active) {
    return state->target_percent;
  }

  int64_t elapsed_us = now_us - state->attention_started_us;
  if (elapsed_us >= state->attention_duration_us) {
    state->attention_active = false;
    return state->target_percent;
  }

  /* Attention is visual only: keep even an OFF fixture visible until stop,
   * never write the pulse/floor back into the normal target or Mesh state.
   * Bright fixtures briefly dim by 30%; dim fixtures briefly rise by 30 points. */
  uint8_t base = state->target_percent < ATTENTION_MIN_PERCENT
                     ? ATTENTION_MIN_PERCENT : state->target_percent;
  if (elapsed_us % ATTENTION_PERIOD_US < ATTENTION_PULSE_US) {
    return base >= 50 ? (uint8_t)(base * 70 / 100) : (uint8_t)(base + 30);
  }
  return base;
}
