#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCTION_POLICY="$REPO_ROOT/apps/esp32-h2-firmware/manufacturing/production-trust-policy.conf"
MIN_RELEASE_FREE_BYTES=$((256 * 1024))

usage() {
  echo "Usage: scripts/esp32-h2-artifact-audit.sh create|verify BUILD_WORKDIR test COMPANY_ID [SOURCE_COMMIT]" >&2
  echo "   or: scripts/esp32-h2-artifact-audit.sh create-production-attestation|verify-production-attestation BUILD_WORKDIR COMPANY_ID SOURCE_COMMIT APPROVAL SIGNATURE" >&2
  echo "   or: scripts/esp32-h2-artifact-audit.sh create-test-only-attestation|verify-test-only-attestation POLICY BUILD_WORKDIR COMPANY_ID SOURCE_COMMIT APPROVAL SIGNATURE" >&2
  exit 2
}

hash_file() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

single_value() {
  local key="$1"
  local file="$2"
  local label="$3"
  local values
  values="$(sed -n "s/^${key}=//p" "$file")"
  if [ "$(printf '%s\n' "$values" | sed '/^$/d' | wc -l | tr -d ' ')" -ne 1 ]; then
    echo "$label has invalid $key" >&2
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

load_policy() {
  local policy="$1"
  local required_state="$2"
  require_file "$policy"
  [ "$(single_value schema "$policy" "trust policy")" = "led-control-trust-policy-v1" ] || {
    echo "trust policy schema mismatch" >&2
    exit 1
  }
  local state
  state="$(single_value state "$policy" "trust policy")"
  if [ "$state" = "unprovisioned" ]; then
    echo "production trust root is not provisioned" >&2
    exit 1
  fi
  [ "$state" = "$required_state" ] || {
    echo "trust policy state must be $required_state" >&2
    exit 1
  }

  ATTESTATION_PUBLIC_KEY="$(single_value attestation_public_key "$policy" "trust policy")"
  ATTESTATION_PUBLIC_KEY_SHA256="$(single_value attestation_public_key_sha256 "$policy" "trust policy")"
  ATTESTATION_PRIVATE_KEY="$(single_value attestation_private_key "$policy" "trust policy")"
  require_file "$ATTESTATION_PUBLIC_KEY"
  if ! [[ "$ATTESTATION_PUBLIC_KEY_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "trust policy contains an invalid attestation public-key SHA-256" >&2
    exit 1
  fi
  local actual_key_sha256
  actual_key_sha256="$(openssl pkey -pubin -in "$ATTESTATION_PUBLIC_KEY" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
  [ "$actual_key_sha256" = "$ATTESTATION_PUBLIC_KEY_SHA256" ] || {
    echo "attestation public key does not match fixed trust policy fingerprint" >&2
    exit 1
  }
}

load_build() {
  BUILD_WORKDIR="$1"
  BUILD_DIR="$BUILD_WORKDIR/build"
  SDKCONFIG="$BUILD_WORKDIR/sdkconfig"
  PARTITIONS="$BUILD_WORKDIR/partitions.csv"
  BINARY="$BUILD_DIR/led_control_node.bin"
  BOOTLOADER="$BUILD_DIR/bootloader/bootloader.bin"
  PARTITION_TABLE="$BUILD_DIR/partition_table/partition-table.bin"
  OTA_DATA="$BUILD_DIR/ota_data_initial.bin"
  MAP="$BUILD_DIR/led_control_node.map"
  FLASH_ARGS="$BUILD_DIR/flash_args"
  TEST_MANIFEST="$BUILD_DIR/led-control-artifact.manifest"
  ATTESTATION="$BUILD_DIR/led-control-artifact.attestation"
  ATTESTATION_SIGNATURE="$BUILD_DIR/led-control-artifact.attestation.sig"

  for file in "$SDKCONFIG" "$PARTITIONS" "$BINARY" "$BOOTLOADER" "$PARTITION_TABLE" "$OTA_DATA" "$MAP" "$FLASH_ARGS"; do
    require_file "$file"
  done
}

audit_layout() {
  if ! grep -q '^CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y$' "$SDKCONFIG"; then
    echo "artifact audit requires CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y" >&2
    exit 1
  fi

  symbol_address() {
    local symbol="$1"
    awk -v symbol="$symbol" '$1 ~ /^0x[0-9A-Fa-f]+$/ && $2 == symbol { print $1; exit }' "$MAP"
  }

  for symbol in vehicle_sensor_gpio_isr gpio_get_level esp_timer_get_time xQueueGenericSendFromISR; do
    local address
    local numeric_address
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

  verify_flash_offset 0x0 bootloader/bootloader.bin bootloader
  verify_flash_offset 0x8000 partition_table/partition-table.bin "partition table"
  verify_flash_offset 0xd000 ota_data_initial.bin "OTA data"
  verify_flash_offset "$APP_OFFSET" led_control_node.bin application

  BINARY_SIZE="$(wc -c <"$BINARY" | tr -d ' ')"
  APP_PARTITION_SIZE=$((APP_SIZE))
  APP_PARTITION_FREE=$((APP_PARTITION_SIZE - BINARY_SIZE))
  local required_percent_free
  required_percent_free=$(((APP_PARTITION_SIZE * 20 + 99) / 100))
  RELEASE_REQUIRED_FREE="$required_percent_free"
  if [ "$RELEASE_REQUIRED_FREE" -lt "$MIN_RELEASE_FREE_BYTES" ]; then
    RELEASE_REQUIRED_FREE="$MIN_RELEASE_FREE_BYTES"
  fi
  if [ "$APP_PARTITION_FREE" -lt 0 ]; then
    echo "firmware binary exceeds ota_0 partition" >&2
    exit 1
  fi
}

verify_flash_offset() {
  local expected_offset="$1"
  local path="$2"
  local label="$3"
  local actual_offset
  actual_offset="$(awk -v path="$path" '$2 == path { print $1; exit }' "$FLASH_ARGS")"
  if [ "$actual_offset" != "$expected_offset" ]; then
    echo "generated flash_args $label offset mismatch" >&2
    exit 1
  fi
}

write_payload() {
  local output="$1"
  local schema="$2"
  local mode="$3"
  local company_id="$4"
  local source_commit="$5"
  local approval_manifest_sha256="$6"
  local approval_signature_sha256="$7"
  local approval_signer_sha256="$8"

  printf '%s\n' \
    "schema=$schema" \
    "mode=$mode" \
    "company_id=$company_id" \
    "source_commit=$source_commit" \
    "approval_manifest_sha256=$approval_manifest_sha256" \
    "approval_signature_sha256=$approval_signature_sha256" \
    "approval_signer_sha256=$approval_signer_sha256" \
    "binary_sha256=$(hash_file "$BINARY")" \
    "bootloader_sha256=$(hash_file "$BOOTLOADER")" \
    "partition_table_sha256=$(hash_file "$PARTITION_TABLE")" \
    "ota_data_sha256=$(hash_file "$OTA_DATA")" \
    "sdkconfig_sha256=$(hash_file "$SDKCONFIG")" \
    "linker_map_sha256=$(hash_file "$MAP")" \
    "flash_args_sha256=$(hash_file "$FLASH_ARGS")" \
    "partitions_sha256=$(hash_file "$PARTITIONS")" \
    "binary_size=$BINARY_SIZE" \
    "app_partition_size=$APP_PARTITION_SIZE" \
    "app_partition_free=$APP_PARTITION_FREE" \
    "release_required_free=$RELEASE_REQUIRED_FREE" \
    >"$output"
}

verify_recorded_hash() {
  local key="$1"
  local file="$2"
  local label="$3"
  if [ "$(single_value "$key" "$ATTESTATION" "artifact attestation")" != "$(hash_file "$file")" ]; then
    echo "artifact $label hash mismatch" >&2
    exit 1
  fi
}

ACTION="${1:-}"
case "$ACTION" in
  create|verify)
    [ "$#" -ge 4 ] && [ "$#" -le 5 ] || usage
    [ "$3" = "test" ] || {
      echo "legacy unsigned production artifact mode is prohibited" >&2
      exit 1
    }
    load_build "$2"
    audit_layout
    grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=y$' "$SDKCONFIG" || {
      echo "test artifact mode does not match sdkconfig" >&2
      exit 1
    }
    [ "$(single_value CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID "$SDKCONFIG" "sdkconfig")" = "$4" ] || {
      echo "artifact Company ID mismatch" >&2
      exit 1
    }
    SOURCE_COMMIT="${5:-test-build-uncommitted}"
    if [ "$ACTION" = "create" ]; then
      write_payload "$TEST_MANIFEST.tmp" led-control-test-artifact-v2 test "$4" "$SOURCE_COMMIT" none none none
      mv "$TEST_MANIFEST.tmp" "$TEST_MANIFEST"
      rm -f "$ATTESTATION" "$ATTESTATION_SIGNATURE"
      echo "Artifact manifest: $TEST_MANIFEST"
      echo "Firmware binary: $BINARY_SIZE bytes; OTA slot free: $APP_PARTITION_FREE bytes; production minimum: $RELEASE_REQUIRED_FREE bytes"
    else
      require_file "$TEST_MANIFEST"
      expected="$(mktemp)"
      write_payload "$expected" led-control-test-artifact-v2 test "$4" "$SOURCE_COMMIT" none none none
      cmp -s "$expected" "$TEST_MANIFEST" || {
        rm -f "$expected"
        echo "test artifact manifest mismatch" >&2
        exit 1
      }
      rm -f "$expected"
    fi
    ;;
  create-production-attestation|verify-production-attestation)
    [ "$#" -eq 6 ] || usage
    POLICY="$PRODUCTION_POLICY"
    REQUIRED_STATE=provisioned
    BUILD_WORKDIR_ARG="$2"
    COMPANY_ID="$3"
    SOURCE_COMMIT="$4"
    APPROVAL="$5"
    APPROVAL_SIGNATURE="$6"
    APPROVAL_ACTION=verify-production
    ;;
  create-test-only-attestation|verify-test-only-attestation)
    [ "$#" -eq 7 ] || usage
    POLICY="$2"
    REQUIRED_STATE=test-only
    BUILD_WORKDIR_ARG="$3"
    COMPANY_ID="$4"
    SOURCE_COMMIT="$5"
    APPROVAL="$6"
    APPROVAL_SIGNATURE="$7"
    APPROVAL_ACTION=verify-test-only
    ;;
  *) usage ;;
esac

if [[ "$ACTION" == *attestation ]]; then
  load_build "$BUILD_WORKDIR_ARG"
  audit_layout
  if [ "$APP_PARTITION_FREE" -lt "$RELEASE_REQUIRED_FREE" ]; then
    echo "production OTA free margin is $APP_PARTITION_FREE bytes; require at least $RELEASE_REQUIRED_FREE" >&2
    exit 1
  fi
  grep -q '^CONFIG_LED_CONTROL_TEST_BUILD=n$' "$SDKCONFIG" || {
    echo "production attestation does not match sdkconfig" >&2
    exit 1
  }
  [ "$(single_value CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID "$SDKCONFIG" "sdkconfig")" = "$COMPANY_ID" ] || {
    echo "artifact Company ID mismatch" >&2
    exit 1
  }

  if [ "$APPROVAL_ACTION" = "verify-production" ]; then
    approval_identity="$("$REPO_ROOT/scripts/esp32-h2-manufacturing-approval.sh" verify-production "$COMPANY_ID" "$SOURCE_COMMIT" "$SDKCONFIG" "$PARTITIONS" "$APPROVAL" "$APPROVAL_SIGNATURE")"
  else
    approval_identity="$("$REPO_ROOT/scripts/esp32-h2-manufacturing-approval.sh" verify-test-only "$POLICY" "$COMPANY_ID" "$SOURCE_COMMIT" "$SDKCONFIG" "$PARTITIONS" "$APPROVAL" "$APPROVAL_SIGNATURE")"
  fi
  load_policy "$POLICY" "$REQUIRED_STATE"
  approval_manifest_sha256="$(printf '%s\n' "$approval_identity" | sed -n 's/^approval_manifest_sha256=//p')"
  approval_signature_sha256="$(printf '%s\n' "$approval_identity" | sed -n 's/^approval_signature_sha256=//p')"
  approval_signer_sha256="$(printf '%s\n' "$approval_identity" | sed -n 's/^approval_signer_sha256=//p')"

  if [[ "$ACTION" == create-* ]]; then
    require_file "$ATTESTATION_PRIVATE_KEY"
    private_key_sha256="$(openssl pkey -in "$ATTESTATION_PRIVATE_KEY" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
    [ "$private_key_sha256" = "$ATTESTATION_PUBLIC_KEY_SHA256" ] || {
      echo "attestation private key does not match fixed trust policy" >&2
      exit 1
    }
    write_payload "$ATTESTATION.tmp" led-control-artifact-attestation-v1 production "$COMPANY_ID" "$SOURCE_COMMIT" "$approval_manifest_sha256" "$approval_signature_sha256" "$approval_signer_sha256"
    openssl dgst -sha256 -sign "$ATTESTATION_PRIVATE_KEY" -out "$ATTESTATION_SIGNATURE.tmp" "$ATTESTATION.tmp"
    mv "$ATTESTATION.tmp" "$ATTESTATION"
    mv "$ATTESTATION_SIGNATURE.tmp" "$ATTESTATION_SIGNATURE"
    rm -f "$TEST_MANIFEST"
    echo "Artifact attestation: $ATTESTATION"
    echo "Firmware binary: $BINARY_SIZE bytes; OTA slot free: $APP_PARTITION_FREE bytes; production minimum: $RELEASE_REQUIRED_FREE bytes"
    exit 0
  fi

  require_file "$ATTESTATION"
  require_file "$ATTESTATION_SIGNATURE"
  if ! openssl dgst -sha256 -verify "$ATTESTATION_PUBLIC_KEY" -signature "$ATTESTATION_SIGNATURE" "$ATTESTATION" >/dev/null 2>&1; then
    echo "artifact attestation signature verification failed" >&2
    exit 1
  fi
  verify_recorded_hash binary_sha256 "$BINARY" binary
  verify_recorded_hash bootloader_sha256 "$BOOTLOADER" bootloader
  verify_recorded_hash partition_table_sha256 "$PARTITION_TABLE" "partition table"
  verify_recorded_hash ota_data_sha256 "$OTA_DATA" "OTA data"
  expected="$(mktemp)"
  write_payload "$expected" led-control-artifact-attestation-v1 production "$COMPANY_ID" "$SOURCE_COMMIT" "$approval_manifest_sha256" "$approval_signature_sha256" "$approval_signer_sha256"
  cmp -s "$expected" "$ATTESTATION" || {
    rm -f "$expected"
    echo "artifact attestation does not exactly match build and approval inputs" >&2
    exit 1
  }
  rm -f "$expected"
fi
