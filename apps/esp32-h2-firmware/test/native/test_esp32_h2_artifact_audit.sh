#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

mkdir -p "$FIXTURE_ROOT/build"
cat >"$FIXTURE_ROOT/sdkconfig" <<'EOF'
CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y
CONFIG_LED_CONTROL_TEST_BUILD=y
CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=65535
EOF
printf 'fixture binary\n' >"$FIXTURE_ROOT/build/led_control_node.bin"
cat >"$FIXTURE_ROOT/build/flash_args" <<'EOF'
--flash_mode dio --flash_freq 48m --flash_size 4MB
0x10000 led_control_node.bin
EOF
cat >"$FIXTURE_ROOT/partitions.csv" <<'EOF'
# Name, Type, SubType, Offset, Size, Flags
nvs,data,nvs,0x9000,0x4000,
otadata,data,ota,0xd000,0x2000,
phy_init,data,phy,0xf000,0x1000,
ota_0,app,ota_0,0x10000,0x1f0000,
ota_1,app,ota_1,0x200000,0x1f0000,
EOF

write_map() {
  local gpio_address="$1"
  cat >"$FIXTURE_ROOT/build/led_control_node.map" <<EOF
                0x40801000                vehicle_sensor_gpio_isr
                $gpio_address                gpio_get_level
                0x40803000                esp_timer_get_time
                0x40804000                xQueueGenericSendFromISR
EOF
}

write_map 0x42002000
if "$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" create "$FIXTURE_ROOT" test 65535 >"$FIXTURE_ROOT/flash-symbol.out" 2>&1; then
  echo "audit unexpectedly accepted flash-resident gpio_get_level" >&2
  exit 1
fi
grep -q "gpio_get_level is not linked to IRAM/ROM" "$FIXTURE_ROOT/flash-symbol.out"

write_map 0x40402000
if "$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" create "$FIXTURE_ROOT" test 65535 >"$FIXTURE_ROOT/non-executable-symbol.out" 2>&1; then
  echo "audit unexpectedly accepted an address outside ESP32-H2 ROM/IRAM" >&2
  exit 1
fi
grep -q "gpio_get_level is not linked to IRAM/ROM" "$FIXTURE_ROOT/non-executable-symbol.out"

write_map 0x40802000
"$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" create "$FIXTURE_ROOT" test 65535
grep -q '^binary_size=15$' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -q '^app_partition_size=2031616$' "$FIXTURE_ROOT/build/led-control-artifact.manifest"
grep -q '^release_required_free=406324$' "$FIXTURE_ROOT/build/led-control-artifact.manifest"

dd if=/dev/zero of="$FIXTURE_ROOT/build/led_control_node.bin" bs=1 count=1700000 2>/dev/null
if "$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" create "$FIXTURE_ROOT" production 4660 >"$FIXTURE_ROOT/margin.out" 2>&1; then
  echo "audit unexpectedly accepted insufficient production OTA margin" >&2
  exit 1
fi
grep -q "production OTA free margin" "$FIXTURE_ROOT/margin.out"

sed -i.bak '/CONFIG_GPIO_CTRL_FUNC_IN_IRAM/d' "$FIXTURE_ROOT/sdkconfig"
printf 'fixture binary\n' >"$FIXTURE_ROOT/build/led_control_node.bin"
if "$REPO_ROOT/scripts/esp32-h2-artifact-audit.sh" create "$FIXTURE_ROOT" test 65535 >"$FIXTURE_ROOT/config.out" 2>&1; then
  echo "audit unexpectedly accepted missing GPIO IRAM config" >&2
  exit 1
fi
grep -q "CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y" "$FIXTURE_ROOT/config.out"
