#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
IDF_ROOT="${IDF_PATH:-$HOME/esp/esp-idf}"
PATCH_GATE="$REPO_ROOT/scripts/esp32-h2-idf-patch.sh"
PINNED_COMMIT=fcae32885b0296b32044cb99ecbdc50d98dddb83
FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

NETWORKING_PATH=components/bt/esp_ble_mesh/api/core/esp_ble_mesh_networking_api.c
BTC_TASK_PATH=components/bt/common/btc/core/btc_task.c
PROV_PATH=components/bt/esp_ble_mesh/btc/btc_ble_mesh_prov.c
STAGED_ROOT="$FIXTURE_ROOT/build-workdir"

hash_file() {
  openssl dgst -sha256 "$1" | awk '{print $NF}'
}

"$PATCH_GATE" verify-source "$IDF_ROOT"
"$PATCH_GATE" stage "$IDF_ROOT" "$STAGED_ROOT"
"$PATCH_GATE" verify-staged "$STAGED_ROOT"

IDENTITY="$STAGED_ROOT/esp-idf-patch.identity"
test -f "$IDENTITY"
grep -q '^schema=led-control-esp-idf-patch-v1$' "$IDENTITY"
grep -q '^esp_idf_version=v5.5.1$' "$IDENTITY"
grep -q "^esp_idf_commit=$PINNED_COMMIT$" "$IDENTITY"
grep -Eq '^patch_sha256=[0-9a-f]{64}$' "$IDENTITY"
grep -Eq '^networking_api_patched_sha256=[0-9a-f]{64}$' "$IDENTITY"

FIRST_SOURCE_HASH="$(hash_file "$STAGED_ROOT/$NETWORKING_PATH")"
FIRST_IDENTITY_HASH="$(hash_file "$IDENTITY")"
"$PATCH_GATE" stage "$IDF_ROOT" "$STAGED_ROOT"
"$PATCH_GATE" apply-staged "$STAGED_ROOT"
test "$(hash_file "$STAGED_ROOT/$NETWORKING_PATH")" = "$FIRST_SOURCE_HASH"
test "$(hash_file "$IDENTITY")" = "$FIRST_IDENTITY_HASH"

cp "$IDF_ROOT/$NETWORKING_PATH" "$STAGED_ROOT/$NETWORKING_PATH"
UNPATCHED_HASH="$(hash_file "$STAGED_ROOT/$NETWORKING_PATH")"
if "$PATCH_GATE" verify-staged "$STAGED_ROOT" >"$FIXTURE_ROOT/unpatched.out" 2>&1; then
  echo "unpatched ESP-IDF overlay unexpectedly passed verification" >&2
  exit 1
fi
grep -q 'staged networking source is not patched' "$FIXTURE_ROOT/unpatched.out"
test "$(hash_file "$STAGED_ROOT/$NETWORKING_PATH")" = "$UNPATCHED_HASH"

"$PATCH_GATE" apply-staged "$STAGED_ROOT"
printf '\nlocal tamper\n' >>"$STAGED_ROOT/$NETWORKING_PATH"
TAMPERED_HASH="$(hash_file "$STAGED_ROOT/$NETWORKING_PATH")"
if "$PATCH_GATE" apply-staged "$STAGED_ROOT" >"$FIXTURE_ROOT/tampered.out" 2>&1; then
  echo "tampered ESP-IDF overlay unexpectedly passed patch application" >&2
  exit 1
fi
grep -q 'refusing to overwrite unexpected staged networking source' "$FIXTURE_ROOT/tampered.out"
test "$(hash_file "$STAGED_ROOT/$NETWORKING_PATH")" = "$TAMPERED_HASH"

git clone --shared --no-checkout "$IDF_ROOT" "$FIXTURE_ROOT/wrong-idf" >/dev/null 2>&1
git -C "$FIXTURE_ROOT/wrong-idf" sparse-checkout init --no-cone
git -C "$FIXTURE_ROOT/wrong-idf" sparse-checkout set \
  /export.sh \
  /components/bt/CMakeLists.txt \
  "/$NETWORKING_PATH" \
  "/$BTC_TASK_PATH" \
  "/$PROV_PATH"
git -C "$FIXTURE_ROOT/wrong-idf" checkout --detach "$PINNED_COMMIT" >/dev/null 2>&1
printf '\nwrong source\n' >>"$FIXTURE_ROOT/wrong-idf/$BTC_TASK_PATH"
WRONG_SOURCE_HASH="$(hash_file "$FIXTURE_ROOT/wrong-idf/$BTC_TASK_PATH")"
if "$PATCH_GATE" verify-source "$FIXTURE_ROOT/wrong-idf" >"$FIXTURE_ROOT/wrong-source.out" 2>&1; then
  echo "wrong ESP-IDF source hash unexpectedly passed verification" >&2
  exit 1
fi
grep -q 'btc_task.c upstream SHA-256 mismatch' "$FIXTURE_ROOT/wrong-source.out"
test "$(hash_file "$FIXTURE_ROOT/wrong-idf/$BTC_TASK_PATH")" = "$WRONG_SOURCE_HASH"

git -C "$FIXTURE_ROOT/wrong-idf" checkout -- "$BTC_TASK_PATH"
printf '\nwrong component tree\n' >>"$FIXTURE_ROOT/wrong-idf/components/bt/CMakeLists.txt"
WRONG_COMPONENT_HASH="$(hash_file "$FIXTURE_ROOT/wrong-idf/components/bt/CMakeLists.txt")"
if "$PATCH_GATE" verify-source "$FIXTURE_ROOT/wrong-idf" >"$FIXTURE_ROOT/wrong-component.out" 2>&1; then
  echo "dirty ESP-IDF component tree unexpectedly passed verification" >&2
  exit 1
fi
grep -q 'components/bt tree does not match the pinned commit' "$FIXTURE_ROOT/wrong-component.out"
test "$(hash_file "$FIXTURE_ROOT/wrong-idf/components/bt/CMakeLists.txt")" = "$WRONG_COMPONENT_HASH"
git -C "$FIXTURE_ROOT/wrong-idf" checkout -- components/bt/CMakeLists.txt

printf 'untracked component source\n' >"$FIXTURE_ROOT/wrong-idf/components/bt/local-test-source.c"
if "$PATCH_GATE" verify-source "$FIXTURE_ROOT/wrong-idf" >"$FIXTURE_ROOT/untracked-component.out" 2>&1; then
  echo "untracked ESP-IDF component source unexpectedly passed verification" >&2
  exit 1
fi
grep -q 'components/bt tree contains untracked files' "$FIXTURE_ROOT/untracked-component.out"
test -f "$FIXTURE_ROOT/wrong-idf/components/bt/local-test-source.c"
rm "$FIXTURE_ROOT/wrong-idf/components/bt/local-test-source.c"

git -C "$FIXTURE_ROOT/wrong-idf" checkout --detach "$PINNED_COMMIT^" >/dev/null 2>&1
if "$PATCH_GATE" verify-source "$FIXTURE_ROOT/wrong-idf" >"$FIXTURE_ROOT/wrong-revision.out" 2>&1; then
  echo "wrong ESP-IDF revision unexpectedly passed verification" >&2
  exit 1
fi
grep -q 'ESP-IDF commit mismatch' "$FIXTURE_ROOT/wrong-revision.out"

FINAL_STAGED_ROOT="$FIXTURE_ROOT/final-build-workdir"
"$PATCH_GATE" stage "$IDF_ROOT" "$FINAL_STAGED_ROOT"
ESP32_H2_IDF_UNDER_TEST="$FINAL_STAGED_ROOT" \
  "$REPO_ROOT/apps/esp32-h2-firmware/test/native/test_esp_idf_server_send_boundary.sh"
