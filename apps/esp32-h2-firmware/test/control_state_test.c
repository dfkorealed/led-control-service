#include <assert.h>

#include "../main/control_state.h"
#include "../main/mesh_state.h"

int main(void) {
  control_state_t state = control_state_create();
  assert(state.brightness_percent == 0);
  assert(state.power_on == false);

  control_state_apply_brightness(&state, 45);
  assert(state.brightness_percent == 45);
  assert(state.power_on == true);
  assert(state.previous_brightness_percent == 45);

  control_state_apply_brightness(&state, 0);
  assert(state.brightness_percent == 0);
  assert(state.power_on == false);

  control_state_apply_brightness(&state, 140);
  assert(state.brightness_percent == 100);
  assert(state.power_on == true);

  control_state_apply_brightness(&state, -10);
  assert(state.brightness_percent == 0);
  assert(state.power_on == false);

  assert(mesh_state_percent_to_lightness(0) == 0);
  assert(mesh_state_percent_to_lightness(50) == 32768);
  assert(mesh_state_percent_to_lightness(100) == 65535);
  assert(mesh_state_percent_to_lightness(140) == 65535);

  assert(mesh_state_lightness_to_percent(0) == 0);
  assert(mesh_state_lightness_to_percent(32768) == 50);
  assert(mesh_state_lightness_to_percent(65535) == 100);

  mesh_state_apply_lightness(&state, 49151);
  assert(state.brightness_percent == 75);
  assert(state.power_on == true);

  control_state_apply_brightness(&state, 30);
  assert(mesh_state_apply_onoff(&state, 0) == 0);
  assert(state.brightness_percent == 0);
  assert(state.power_on == false);
  assert(state.previous_brightness_percent == 30);

  assert(mesh_state_apply_onoff(&state, 1) == 30);
  assert(state.brightness_percent == 30);
  assert(state.power_on == true);

  assert(command_sequence_accept(&state, 10));
  assert(state.last_command_sequence == 10);
  assert(!command_sequence_accept(&state, 9));
  assert(!command_sequence_accept(&state, 10));
  assert(command_sequence_accept(&state, 11));

  return 0;
}
