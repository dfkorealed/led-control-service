#include <assert.h>
#include <stdio.h>
#include "../main/led_output_state.h"

int main(void) {
  led_output_state_t state = {0};
  led_output_state_set_target(&state, 80);
  led_output_state_set_attention(&state, 1, 100);
  assert(led_output_state_brightness(&state, 100) == 56);
  assert(led_output_state_brightness(&state, 150099) == 56);
  assert(led_output_state_brightness(&state, 150100) == 80);
  assert(led_output_state_brightness(&state, 1000099) == 80);
  assert(state.attention_active);
  assert(led_output_state_brightness(&state, 1000100) == 80);
  assert(!state.attention_active);

  led_output_state_set_attention(&state, 1, 2000000);
  led_output_state_set_attention(&state, 2, 2900000);
  assert(led_output_state_brightness(&state, 3000000) == 56);
  assert(state.attention_active);
  led_output_state_set_target(&state, 35);
  assert(led_output_state_brightness(&state, 3900000) == 65);
  assert(state.target_percent == 35);
  led_output_state_set_attention(&state, 0, 3950000);
  assert(led_output_state_brightness(&state, 3950000) == 35);
  led_output_state_set_attention(&state, 0, 4000000);
  assert(led_output_state_brightness(&state, 4000000) == 35);

  /* Cover every normal target, including OFF, without allowing a blackout pulse. */
  for (unsigned target = 0; target <= 100; target++) {
    led_output_state_set_target(&state, (uint8_t)target);
    led_output_state_set_attention(&state, 255, 5000000);
    uint8_t pulse = led_output_state_brightness(&state, 5000000);
    uint8_t base = led_output_state_brightness(&state, 5150000);
    assert(pulse > 0 && pulse <= 100 && base > 0 && base <= 100);
    assert(pulse != base);
    assert(state.target_percent == target);
    led_output_state_set_target(&state, 0);
    assert(led_output_state_brightness(&state, 260000000) == 0);
    assert(!state.attention_active);
  }
  led_output_state_set_target(&state, 255);
  assert(led_output_state_brightness(&state, 300000000) == 100);
  puts("led output state: expiry, restart, latest target, pulse boundaries passed");
  return 0;
}
