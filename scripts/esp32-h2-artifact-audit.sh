#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: scripts/esp32-h2-artifact-audit.sh create|verify BUILD_WORKDIR MODE COMPANY_ID [APPROVAL_MANIFEST]" >&2
  exit 2
}

[ "$#" -ge 4 ] && [ "$#" -le 5 ] || usage

ACTION="$1"
BUILD_WORKDIR="$2"
MODE="$3"
COMPANY_ID="$4"
APPROVAL_MANIFEST="${5:-}"
BUILD_DIR="$BUILD_WORKDIR/build"
SDKCONFIG="$BUILD_WORKDIR/sdkconfig"
PARTITIONS="$BUILD_WORKDIR/partitions.csv"
BINARY="$BUILD_DIR/led_control_node.bin"
MAP="$BUILD_DIR/led_control_node.map"
FLASH_ARGS="$BUILD_DIR/flash_args"
ARTIFACT_MANIFEST="$BUILD_DIR/led-control-artifact.manifest"
MIN_RELEASE_FREE_BYTES=$((256 * 1024))

hash_file() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

manifest_value() {
  local key="$1"
  local file="$2"
  local values
  values="$(sed -n "s/^${key}=//p" "$file")"
  if [ "$(printf '%s\n' "$values" | sed '/^$/d' | wc -l | tr -d ' ')" -ne 1 ]; then
    echo "artifact manifest has invalid $key" >&2
    exit 1
  fi
  printf '%s\n' "$values"
}

require_file() {
  if [ ! -f "$1" ]; then
    echo "artifact audit missing required file: $1" >&2
    exit 1
  fi
}

for file in "$SDKCONFIG" "$PARTITIONS" "$BINARY" "$MAP" "$FLASH_ARGS"; do
  require_file "$file"
done

if ! grep -q '^CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y$' "$SDKCONFIG"; then
  echo "artifact audit requires CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y" >&2
  exit 1
fi

symbol_address() {
  local symbol="$1"
  awk -v symbol="$symbol" '$1 ~ /^0x[0-9A-Fa-f]+$/ && $2 == symbol { print $1; exit }' "$MAP"
}

for symbol in vehicle_sensor_gpio_isr gpio_get_level esp_timer_get_time xQueueGenericSendFromISR; do
  address="$(symbol_address "$symbol")"
  if [ -z "$address" ]; then
    echo "artifact audit could not resolve $symbol in the linker map" >&2
    exit 1
  fi
  numeric_address=$((address))
  if ! {
    { [ "$numeric_address" -ge $((0x40000000)) ] && [ "$numeric_address" -lt $((0x40020000)) ]; } ||
      { [ "$numeric_address" -ge $((0x40800000)) ] && [ "$numeric_address" -lt $((0x40850000)) ]; }
  }; then
    echo "$symbol is not linked to IRAM/ROM: $address" >&2
    exit 1
  fi
done

IFS=',' read -r _ _ _ APP_OFFSET APP_SIZE _ < <(
  awk -F',' '{ name=$1; gsub(/[[:space:]]/, "", name); if (name == "ota_0") { print; exit } }' "$PARTITIONS"
)
APP_OFFSET="${APP_OFFSET//[[:space:]]/}"
APP_SIZE="${APP_SIZE//[[:space:]]/}"
if ! [[ "$APP_OFFSET" =~ ^0x[0-9A-Fa-f]+$ ]] || ! [[ "$APP_SIZE" =~ ^0x[0-9A-Fa-f]+$ ]]; then
  echo "artifact audit requires an explicit ota_0 offset and size" >&2
  exit 1
fi

FLASH_APP_OFFSET="$(awk '$2 == "led_control_node.bin" { print $1; exit }' "$FLASH_ARGS")"
if [ "$FLASH_APP_OFFSET" != "$APP_OFFSET" ]; then
  echo "generated flash_args app offset does not match ota_0" >&2
  exit 1
fi

BINARY_SIZE="$(wc -c <"$BINARY" | tr -d ' ')"
APP_PARTITION_SIZE=$((APP_SIZE))
APP_PARTITION_FREE=$((APP_PARTITION_SIZE - BINARY_SIZE))
REQUIRED_PERCENT_FREE=$(((APP_PARTITION_SIZE * 20 + 99) / 100))
RELEASE_REQUIRED_FREE="$REQUIRED_PERCENT_FREE"
if [ "$RELEASE_REQUIRED_FREE" -lt "$MIN_RELEASE_FREE_BYTES" ]; then
  RELEASE_REQUIRED_FREE="$MIN_RELEASE_FREE_BYTES"
fi
if [ "$APP_PARTITION_FREE" -lt 0 ]; then
  echo "firmware binary exceeds ota_0 partition" >&2
  exit 1
fi
if [ "$MODE" = "production" ] && [ "$APP_PARTITION_FREE" -lt "$RELEASE_REQUIRED_FREE" ]; then
  echo "production OTA free margin is $APP_PARTITION_FREE bytes; require at least $RELEASE_REQUIRED_FREE" >&2
  exit 1
fi

case "$MODE" in
  test)
    grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=y$' "$SDKCONFIG" || {
      echo "test artifact mode does not match sdkconfig" >&2
      exit 1
    }
    APPROVAL_SHA256=none
    ;;
  production)
    if grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=y$' "$SDKCONFIG"; then
      echo "production artifact mode does not match sdkconfig" >&2
      exit 1
    fi
    require_file "$APPROVAL_MANIFEST"
    APPROVAL_SHA256="$(hash_file "$APPROVAL_MANIFEST")"
    ;;
  *) usage ;;
esac

CONFIG_COMPANY_ID="$(sed -n 's/^CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=//p' "$SDKCONFIG")"
if [ "$CONFIG_COMPANY_ID" != "$COMPANY_ID" ]; then
  echo "artifact Company ID mismatch: sdkconfig=$CONFIG_COMPANY_ID requested=$COMPANY_ID" >&2
  exit 1
fi

if [ "$ACTION" = "create" ]; then
  TEMP_MANIFEST="$ARTIFACT_MANIFEST.tmp"
  {
    echo "schema=led-control-artifact-v1"
    echo "mode=$MODE"
    echo "company_id=$COMPANY_ID"
    echo "binary_sha256=$(hash_file "$BINARY")"
    echo "sdkconfig_sha256=$(hash_file "$SDKCONFIG")"
    echo "linker_map_sha256=$(hash_file "$MAP")"
    echo "flash_args_sha256=$(hash_file "$FLASH_ARGS")"
    echo "partitions_sha256=$(hash_file "$PARTITIONS")"
    echo "approval_manifest_sha256=$APPROVAL_SHA256"
    echo "binary_size=$BINARY_SIZE"
    echo "app_partition_size=$APP_PARTITION_SIZE"
    echo "app_partition_free=$APP_PARTITION_FREE"
    echo "release_required_free=$RELEASE_REQUIRED_FREE"
  } >"$TEMP_MANIFEST"
  mv "$TEMP_MANIFEST" "$ARTIFACT_MANIFEST"
  echo "Artifact manifest: $ARTIFACT_MANIFEST"
  echo "Firmware binary: $BINARY_SIZE bytes; OTA slot free: $APP_PARTITION_FREE bytes; production minimum: $RELEASE_REQUIRED_FREE bytes"
  exit 0
fi

[ "$ACTION" = "verify" ] || usage
require_file "$ARTIFACT_MANIFEST"

[ "$(manifest_value schema "$ARTIFACT_MANIFEST")" = "led-control-artifact-v1" ] || {
  echo "artifact manifest schema mismatch" >&2
  exit 1
}
[ "$(manifest_value mode "$ARTIFACT_MANIFEST")" = "$MODE" ] || {
  echo "artifact mode mismatch" >&2
  exit 1
}
[ "$(manifest_value company_id "$ARTIFACT_MANIFEST")" = "$COMPANY_ID" ] || {
  echo "artifact Company ID mismatch" >&2
  exit 1
}

verify_hash() {
  local key="$1"
  local file="$2"
  local label="$3"
  if [ "$(manifest_value "$key" "$ARTIFACT_MANIFEST")" != "$(hash_file "$file")" ]; then
    echo "artifact $label hash mismatch" >&2
    exit 1
  fi
}

verify_hash binary_sha256 "$BINARY" binary
verify_hash sdkconfig_sha256 "$SDKCONFIG" sdkconfig
verify_hash linker_map_sha256 "$MAP" linker-map
verify_hash flash_args_sha256 "$FLASH_ARGS" flash-args
verify_hash partitions_sha256 "$PARTITIONS" partitions
if [ "$(manifest_value approval_manifest_sha256 "$ARTIFACT_MANIFEST")" != "$APPROVAL_SHA256" ]; then
  echo "artifact manufacturing approval hash mismatch" >&2
  exit 1
fi
