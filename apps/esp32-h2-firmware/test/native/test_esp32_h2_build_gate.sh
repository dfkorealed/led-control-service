#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

mkdir -p "$FIXTURE_ROOT/idf"
cat >"$FIXTURE_ROOT/idf/export.sh" <<'EOF'
idf.py() {
  printf '%s\n' "$*" >>"$ESP32_H2_BUILD_GATE_CALLS"
}
EOF

run_build() {
  env \
    IDF_PATH="$FIXTURE_ROOT/idf" \
    ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build" \
    ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
    "$REPO_ROOT/scripts/esp32-h2-build.sh" "$@"
}

run_flash() {
  env \
    IDF_PATH="$FIXTURE_ROOT/idf" \
    ESP32_H2_BUILD_WORKDIR="$FIXTURE_ROOT/build" \
    ESP32_H2_BUILD_GATE_CALLS="$FIXTURE_ROOT/idf-calls" \
    "$REPO_ROOT/scripts/esp32-h2-flash.sh" /dev/null
}

if run_build >"$FIXTURE_ROOT/production-missing.out" 2>&1; then
  echo "production build unexpectedly accepted a missing Company ID" >&2
  exit 1
fi
grep -q "production build requires CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID" "$FIXTURE_ROOT/production-missing.out"
test ! -e "$FIXTURE_ROOT/idf-calls"

run_build --test-build >"$FIXTURE_ROOT/test-build.out" 2>&1
grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=y$' "$FIXTURE_ROOT/build/sdkconfig.build-gate"
grep -q '^CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=65535$' "$FIXTURE_ROOT/build/sdkconfig.build-gate"
grep -q "must not be flashed for HIL or production" "$FIXTURE_ROOT/test-build.out"

rm -f "$FIXTURE_ROOT/idf-calls"
CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=4660 run_build >"$FIXTURE_ROOT/production.out" 2>&1
grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=n$' "$FIXTURE_ROOT/build/sdkconfig.build-gate"
grep -q '^CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=4660$' "$FIXTURE_ROOT/build/sdkconfig.build-gate"

for invalid in 0 741 65535 invalid; do
  if CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID="$invalid" run_build >"$FIXTURE_ROOT/invalid.out" 2>&1; then
    echo "production build unexpectedly accepted Company ID $invalid" >&2
    exit 1
  fi
done

rm -f "$FIXTURE_ROOT/build/sdkconfig" "$FIXTURE_ROOT/idf-calls"
if run_flash >"$FIXTURE_ROOT/flash-missing.out" 2>&1; then
  echo "flash unexpectedly accepted a missing sdkconfig" >&2
  exit 1
fi
grep -q "flash requires a verified production sdkconfig" "$FIXTURE_ROOT/flash-missing.out"

printf 'CONFIG_LED_CONTROL_TEST_BUILD=y\nCONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=65535\n' >"$FIXTURE_ROOT/build/sdkconfig"
if run_flash >"$FIXTURE_ROOT/flash-test.out" 2>&1; then
  echo "flash unexpectedly accepted a test build" >&2
  exit 1
fi
grep -q "Refusing to flash a test-build binary" "$FIXTURE_ROOT/flash-test.out"

printf '# CONFIG_LED_CONTROL_TEST_BUILD is not set\nCONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=741\n' >"$FIXTURE_ROOT/build/sdkconfig"
if run_flash >"$FIXTURE_ROOT/flash-invalid.out" 2>&1; then
  echo "flash unexpectedly accepted an invalid production Company ID" >&2
  exit 1
fi
grep -q "flash requires the owner's Bluetooth SIG Company ID" "$FIXTURE_ROOT/flash-invalid.out"

printf '# CONFIG_LED_CONTROL_TEST_BUILD is not set\nCONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=4660\n' >"$FIXTURE_ROOT/build/sdkconfig"
run_flash >"$FIXTURE_ROOT/flash-production.out" 2>&1
grep -q -- '-p /dev/null flash monitor' "$FIXTURE_ROOT/idf-calls"
