#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH_DIR="$REPO_ROOT/apps/esp32-h2-firmware/patches"
PATCH_FILE="$PATCH_DIR/esp-idf-v5.5.1-server-send-ownership.patch"
METADATA_FILE="$PATCH_DIR/esp-idf-v5.5.1-server-send-ownership.conf"
NETWORKING_PATH=components/bt/esp_ble_mesh/api/core/esp_ble_mesh_networking_api.c
BTC_TASK_PATH=components/bt/common/btc/core/btc_task.c
PROV_PATH=components/bt/esp_ble_mesh/btc/btc_ble_mesh_prov.c
IDENTITY_NAME=esp-idf-patch.identity

usage() {
  echo "Usage: scripts/esp32-h2-idf-patch.sh verify-source IDF_PATH" >&2
  echo "   or: scripts/esp32-h2-idf-patch.sh stage IDF_PATH BUILD_WORKDIR" >&2
  echo "   or: scripts/esp32-h2-idf-patch.sh apply-staged|verify-staged BUILD_WORKDIR" >&2
  echo "   or: scripts/esp32-h2-idf-patch.sh write-identity IDENTITY_FILE" >&2
  echo "   or: scripts/esp32-h2-idf-patch.sh verify-identity IDENTITY_FILE" >&2
  echo "   or: scripts/esp32-h2-idf-patch.sh report BUILD_WORKDIR" >&2
  exit 2
}

hash_file() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

require_file() {
  local file="$1"
  local label="$2"
  if [ ! -f "$file" ]; then
    echo "$label not found at $file" >&2
    exit 1
  fi
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

require_sha256() {
  local value="$1"
  local label="$2"
  if ! [[ "$value" =~ ^[0-9a-f]{64}$ ]]; then
    echo "$label is not a lowercase SHA-256" >&2
    exit 1
  fi
}

require_git_commit() {
  local value="$1"
  if ! [[ "$value" =~ ^[0-9a-f]{40}$ ]]; then
    echo "ESP-IDF commit is not a lowercase Git SHA-1" >&2
    exit 1
  fi
}

load_metadata() {
  require_file "$PATCH_FILE" "ESP-IDF patch"
  require_file "$METADATA_FILE" "ESP-IDF patch metadata"
  [ "$(single_value schema "$METADATA_FILE" "ESP-IDF patch metadata")" = \
      "led-control-esp-idf-patch-metadata-v1" ] || {
    echo "ESP-IDF patch metadata schema mismatch" >&2
    exit 1
  }

  IDF_VERSION="$(single_value esp_idf_version "$METADATA_FILE" "ESP-IDF patch metadata")"
  IDF_COMMIT="$(single_value esp_idf_commit "$METADATA_FILE" "ESP-IDF patch metadata")"
  PATCH_SHA256="$(single_value patch_sha256 "$METADATA_FILE" "ESP-IDF patch metadata")"
  BTC_TASK_SHA256="$(single_value btc_task_upstream_sha256 "$METADATA_FILE" "ESP-IDF patch metadata")"
  NETWORKING_UPSTREAM_SHA256="$(single_value networking_api_upstream_sha256 "$METADATA_FILE" "ESP-IDF patch metadata")"
  NETWORKING_PATCHED_SHA256="$(single_value networking_api_patched_sha256 "$METADATA_FILE" "ESP-IDF patch metadata")"
  PROV_SHA256="$(single_value btc_ble_mesh_prov_upstream_sha256 "$METADATA_FILE" "ESP-IDF patch metadata")"

  require_git_commit "$IDF_COMMIT"
  require_sha256 "$PATCH_SHA256" "ESP-IDF patch digest"
  require_sha256 "$BTC_TASK_SHA256" "btc_task.c upstream digest"
  require_sha256 "$NETWORKING_UPSTREAM_SHA256" "networking_api.c upstream digest"
  require_sha256 "$NETWORKING_PATCHED_SHA256" "networking_api.c patched digest"
  require_sha256 "$PROV_SHA256" "btc_ble_mesh_prov.c upstream digest"
  if [ "$(hash_file "$PATCH_FILE")" != "$PATCH_SHA256" ]; then
    echo "ESP-IDF patch SHA-256 does not match repository metadata" >&2
    exit 1
  fi
}

verify_hash() {
  local file="$1"
  local expected="$2"
  local label="$3"
  require_file "$file" "$label"
  if [ "$(hash_file "$file")" != "$expected" ]; then
    echo "$label SHA-256 mismatch" >&2
    exit 1
  fi
}

verify_source() {
  local idf_root="$1"
  require_file "$idf_root/export.sh" "ESP-IDF export.sh"
  local actual_commit
  actual_commit="$(git -C "$idf_root" rev-parse HEAD 2>/dev/null || true)"
  if [ "$actual_commit" != "$IDF_COMMIT" ]; then
    echo "ESP-IDF commit mismatch: expected $IDF_COMMIT, got ${actual_commit:-unknown}" >&2
    exit 1
  fi
  local actual_version
  actual_version="$(git -C "$idf_root" describe --tags --exact-match HEAD 2>/dev/null || true)"
  if [ "$actual_version" != "$IDF_VERSION" ]; then
    echo "ESP-IDF version mismatch: expected $IDF_VERSION, got ${actual_version:-unknown}" >&2
    exit 1
  fi
  verify_hash "$idf_root/$BTC_TASK_PATH" "$BTC_TASK_SHA256" "btc_task.c upstream"
  verify_hash "$idf_root/$NETWORKING_PATH" "$NETWORKING_UPSTREAM_SHA256" "networking_api.c upstream"
  verify_hash "$idf_root/$PROV_PATH" "$PROV_SHA256" "btc_ble_mesh_prov.c upstream"
  if ! git -C "$idf_root" diff --quiet --ignore-submodules=none \
      "$IDF_COMMIT" -- components/bt; then
    echo "ESP-IDF components/bt tree does not match the pinned commit" >&2
    exit 1
  fi
  local untracked_sources
  if ! untracked_sources="$(git -C "$idf_root" ls-files --others --exclude-standard -- components/bt)"; then
    echo "could not inspect ESP-IDF components/bt untracked files" >&2
    exit 1
  fi
  if [ -n "$untracked_sources" ]; then
    echo "ESP-IDF components/bt tree contains untracked files" >&2
    exit 1
  fi
}

write_identity() {
  local identity="$1"
  mkdir -p "$(dirname "$identity")"
  printf '%s\n' \
    "schema=led-control-esp-idf-patch-v1" \
    "esp_idf_version=$IDF_VERSION" \
    "esp_idf_commit=$IDF_COMMIT" \
    "patch_sha256=$PATCH_SHA256" \
    "btc_task_upstream_sha256=$BTC_TASK_SHA256" \
    "networking_api_upstream_sha256=$NETWORKING_UPSTREAM_SHA256" \
    "networking_api_patched_sha256=$NETWORKING_PATCHED_SHA256" \
    "btc_ble_mesh_prov_upstream_sha256=$PROV_SHA256" \
    >"$identity.tmp"
  mv "$identity.tmp" "$identity"
}

verify_identity() {
  local identity="$1"
  require_file "$identity" "ESP-IDF patch identity"
  [ "$(wc -l <"$identity" | tr -d ' ')" -eq 8 ] || {
    echo "ESP-IDF patch identity has unexpected fields" >&2
    exit 1
  }
  [ "$(single_value schema "$identity" "ESP-IDF patch identity")" = "led-control-esp-idf-patch-v1" ] || {
    echo "ESP-IDF patch identity schema mismatch" >&2
    exit 1
  }
  local checks=(
    "esp_idf_version:$IDF_VERSION"
    "esp_idf_commit:$IDF_COMMIT"
    "patch_sha256:$PATCH_SHA256"
    "btc_task_upstream_sha256:$BTC_TASK_SHA256"
    "networking_api_upstream_sha256:$NETWORKING_UPSTREAM_SHA256"
    "networking_api_patched_sha256:$NETWORKING_PATCHED_SHA256"
    "btc_ble_mesh_prov_upstream_sha256:$PROV_SHA256"
  )
  for check in "${checks[@]}"; do
    local key="${check%%:*}"
    local expected="${check#*:}"
    if [ "$(single_value "$key" "$identity" "ESP-IDF patch identity")" != "$expected" ]; then
      echo "ESP-IDF patch identity $key mismatch" >&2
      exit 1
    fi
  done
}

verify_staged_sources() {
  local build_workdir="$1"
  verify_hash "$build_workdir/$BTC_TASK_PATH" "$BTC_TASK_SHA256" "staged btc_task.c"
  verify_hash "$build_workdir/$PROV_PATH" "$PROV_SHA256" "staged btc_ble_mesh_prov.c"
  require_file "$build_workdir/$NETWORKING_PATH" "staged networking_api.c"
}

apply_staged() {
  local build_workdir="$1"
  verify_staged_sources "$build_workdir"
  local current_hash
  current_hash="$(hash_file "$build_workdir/$NETWORKING_PATH")"
  if [ "$current_hash" = "$NETWORKING_PATCHED_SHA256" ]; then
    write_identity "$build_workdir/$IDENTITY_NAME"
    return
  fi
  if [ "$current_hash" != "$NETWORKING_UPSTREAM_SHA256" ]; then
    echo "refusing to overwrite unexpected staged networking source" >&2
    exit 1
  fi

  (
    cd "$build_workdir"
    git apply --unidiff-zero --check "$PATCH_FILE"
    git apply --unidiff-zero "$PATCH_FILE"
  )
  verify_hash "$build_workdir/$NETWORKING_PATH" "$NETWORKING_PATCHED_SHA256" \
    "staged patched networking_api.c"
  write_identity "$build_workdir/$IDENTITY_NAME"
}

verify_staged() {
  local build_workdir="$1"
  verify_staged_sources "$build_workdir"
  if [ "$(hash_file "$build_workdir/$NETWORKING_PATH")" != "$NETWORKING_PATCHED_SHA256" ]; then
    echo "staged networking source is not patched" >&2
    exit 1
  fi
  verify_identity "$build_workdir/$IDENTITY_NAME"
}

stage_overlay() {
  local idf_root="$1"
  local build_workdir="$2"
  verify_source "$idf_root"
  if [ -f "$build_workdir/$NETWORKING_PATH" ]; then
    local existing_hash
    existing_hash="$(hash_file "$build_workdir/$NETWORKING_PATH")"
    if [ "$existing_hash" != "$NETWORKING_UPSTREAM_SHA256" ] &&
       [ "$existing_hash" != "$NETWORKING_PATCHED_SHA256" ]; then
      echo "refusing to overwrite unexpected staged networking source" >&2
      exit 1
    fi
  fi
  mkdir -p "$build_workdir/components/bt"
  rsync -a --delete --checksum "$idf_root/components/bt/" "$build_workdir/components/bt/"
  apply_staged "$build_workdir"
  verify_staged "$build_workdir"
}

load_metadata
ACTION="${1:-}"
case "$ACTION" in
  verify-source)
    [ "$#" -eq 2 ] || usage
    verify_source "$2"
    ;;
  stage)
    [ "$#" -eq 3 ] || usage
    stage_overlay "$2" "$3"
    ;;
  apply-staged)
    [ "$#" -eq 2 ] || usage
    apply_staged "$2"
    verify_staged "$2"
    ;;
  verify-staged)
    [ "$#" -eq 2 ] || usage
    verify_staged "$2"
    ;;
  write-identity)
    [ "$#" -eq 2 ] || usage
    write_identity "$2"
    ;;
  verify-identity)
    [ "$#" -eq 2 ] || usage
    verify_identity "$2"
    ;;
  report)
    [ "$#" -eq 2 ] || usage
    verify_staged "$2"
    printf 'ESP-IDF %s (%s), server-send ownership patch %s\n' \
      "$IDF_VERSION" "$IDF_COMMIT" "$PATCH_SHA256"
    ;;
  *)
    usage
    ;;
esac
