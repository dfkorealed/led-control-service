#!/usr/bin/env bash
set -euo pipefail
FIRMWARE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
cc -std=c11 -Wall -Wextra -Werror -pedantic -pthread \
  -DCONFIG_LED_CONTROL_PWM_GPIO=8 \
  -I"$FIRMWARE_DIR/test/identify_fake/include" \
  -I"$FIRMWARE_DIR/test/host_fake/include" -I"$FIRMWARE_DIR/main" \
  "$FIRMWARE_DIR/test/identify_fake/test_identify_driver.c" \
  "$FIRMWARE_DIR/main/identify.c" "$FIRMWARE_DIR/main/led_driver.c" \
  "$FIRMWARE_DIR/main/led_output_state.c" \
  -o "$BUILD_DIR/identify-driver"
if [ "$#" -eq 0 ]; then
  set -- expiry latest idle-stop restart stale-restart stale-stop zero \
    expiry-latest output-retry stop-retry repeated init-retry
fi
for scenario in "$@"; do
  "$BUILD_DIR/identify-driver" "$scenario"
done
cc -std=c11 -Wall -Wextra -Werror -pedantic \
  "$FIRMWARE_DIR/test/led_output_state_test.c" \
  "$FIRMWARE_DIR/main/led_output_state.c" -o "$BUILD_DIR/led-output-state"
"$BUILD_DIR/led-output-state"
