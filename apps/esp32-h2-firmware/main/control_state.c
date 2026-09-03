#include "control_state.h"

/* 이 구조체는 명령을 처리하는 동안의 메모리 상태일 뿐 flash를 직접 건드리지 않는다.
 * 저장은 BLE 경로가 persistent_state에 명시적으로 예약해, 상태 계산과 flash 수명을 결합하지 않는다. */
control_state_t control_state_create(void) {
  control_state_t state = {
      .brightness_percent = 0,
      .previous_brightness_percent = 0,
      .power_on = false,
      .last_command_sequence = 0,
  };
  return state;
}

void control_state_apply_brightness(control_state_t *state, int brightness_percent) {
  if (brightness_percent < 0) {
    brightness_percent = 0;
  }
  if (brightness_percent > 100) {
    brightness_percent = 100;
  }

  state->brightness_percent = (uint8_t)brightness_percent;
  if (brightness_percent > 0) {
    state->previous_brightness_percent = (uint8_t)brightness_percent;
  }
  state->power_on = brightness_percent > 0;
}

bool command_sequence_accept(control_state_t *state, uint32_t sequence) {
  if (sequence <= state->last_command_sequence) {
    return false;
  }
  state->last_command_sequence = sequence;
  return true;
}
