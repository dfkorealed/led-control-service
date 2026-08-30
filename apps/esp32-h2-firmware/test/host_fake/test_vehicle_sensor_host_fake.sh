#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FAKE_ROOT="$REPO_ROOT/apps/esp32-h2-firmware/test/host_fake"
MAIN_ROOT="$REPO_ROOT/apps/esp32-h2-firmware/main"
COMMON_FLAGS=(
  -std=c11
  -Wall
  -Wextra
  -Werror
  -pedantic
  -I"$FAKE_ROOT/include"
  -I"$FAKE_ROOT"
  -I"$MAIN_ROOT"
  -DESP_PLATFORM
  -DCONFIG_GPIO_CTRL_FUNC_IN_IRAM=1
)

cc "${COMMON_FLAGS[@]}" \
  -DCONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO=4 \
  -DCONFIG_LED_CONTROL_PWM_GPIO=8 \
  -DCONFIG_LED_CONTROL_FACTORY_RESET_GPIO=9 \
  -DCONFIG_ESP_CONSOLE_UART_DEFAULT=1 \
  -DCONFIG_ESP_CONSOLE_UART_NUM=0 \
  "$FAKE_ROOT/test_vehicle_sensor_driver_integration.c" \
  "$FAKE_ROOT/fake_esp_idf.c" \
  "$MAIN_ROOT/vehicle_sensor_driver.c" \
  -o /tmp/test_vehicle_sensor_driver_integration
/tmp/test_vehicle_sensor_driver_integration

cc "${COMMON_FLAGS[@]}" \
  -DCONFIG_LED_CONTROL_TEST_BUILD=1 \
  "$FAKE_ROOT/test_test_build_fail_stop.c" \
  "$MAIN_ROOT/app_main.c" \
  -o /tmp/test_test_build_fail_stop
/tmp/test_test_build_fail_stop

if cc "${COMMON_FLAGS[@]}" \
  -DCONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO=23 \
  -DCONFIG_LED_CONTROL_PWM_GPIO=8 \
  -DCONFIG_LED_CONTROL_FACTORY_RESET_GPIO=9 \
  -DCONFIG_ESP_CONSOLE_UART_DEFAULT=1 \
  -DCONFIG_ESP_CONSOLE_UART_NUM=0 \
  -c "$MAIN_ROOT/vehicle_sensor_driver.c" \
  -o /tmp/test_vehicle_sensor_unsafe_uart.o \
  > /tmp/test_vehicle_sensor_unsafe_uart.log 2>&1; then
  echo "UART0 console GPIO23 unexpectedly passed the compile guard" >&2
  exit 1
fi
grep -q "must not conflict with UART0 console" /tmp/test_vehicle_sensor_unsafe_uart.log

if cc "${COMMON_FLAGS[@]}" \
  -DCONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO=22 \
  -DCONFIG_LED_CONTROL_PWM_GPIO=8 \
  -DCONFIG_LED_CONTROL_FACTORY_RESET_GPIO=9 \
  -DCONFIG_ESP_CONSOLE_UART_CUSTOM=1 \
  -DCONFIG_ESP_CONSOLE_UART_NUM=0 \
  -DCONFIG_ESP_CONSOLE_UART_TX_GPIO=22 \
  -DCONFIG_ESP_CONSOLE_UART_RX_GPIO=23 \
  -c "$MAIN_ROOT/vehicle_sensor_driver.c" \
  -o /tmp/test_vehicle_sensor_unsafe_custom_console.o \
  > /tmp/test_vehicle_sensor_unsafe_custom_console.log 2>&1; then
  echo "custom console GPIO22 unexpectedly passed the compile guard" >&2
  exit 1
fi
grep -q "must not conflict with configured console GPIO" /tmp/test_vehicle_sensor_unsafe_custom_console.log
