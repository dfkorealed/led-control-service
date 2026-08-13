#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PKI_ENV="${PKI_ENV:-}"
LAB_API_DNS="${LAB_API_DNS:-api.led.lan}"
LAB_MQTT_DNS="${LAB_MQTT_DNS:-mqtt.led.lan}"
LAB_VAULT_PORT="${LAB_VAULT_PORT:-18200}"
VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:${LAB_VAULT_PORT}}"
VAULT_BIN="${VAULT_BIN:-vault}"
LAB_PKI_DIR="$ROOT_DIR/.local/lab-pki"
SERVICE_ROOT="$LAB_PKI_DIR/services"
SERVICE_DIR="$SERVICE_ROOT/current"
MANUFACTURING_DIR="$LAB_PKI_DIR/manufacturing"
ROOT_TOKEN_FILE="$ROOT_DIR/.local/lab-vault/root-token"
APPLICATION_TOKEN_FILE="$LAB_PKI_DIR/application-token"
APPLICATION_TOKEN_ACCESSOR_FILE="$LAB_PKI_DIR/application-token.accessor"
LAB_ENV_FILE="$LAB_PKI_DIR/lab.env"

LAB_VAULT_SCRIPT="${LAB_VAULT_SCRIPT:-$ROOT_DIR/scripts/pki/lab-vault.sh}"
VAULT_BOOTSTRAP_SCRIPT="${VAULT_BOOTSTRAP_SCRIPT:-$ROOT_DIR/scripts/pki/bootstrap-lab-vault.sh}"
INTERMEDIATE_SIGN_SCRIPT="${INTERMEDIATE_SIGN_SCRIPT:-$ROOT_DIR/scripts/pki/sign-lab-intermediates.sh}"
SERVICE_CERT_SCRIPT="${SERVICE_CERT_SCRIPT:-$ROOT_DIR/scripts/pki/issue-lab-service-cert.sh}"
MANUFACTURING_STATION_SCRIPT="${MANUFACTURING_STATION_SCRIPT:-$ROOT_DIR/scripts/pki/issue-lab-manufacturing-station.sh}"

die() {
  printf '[device-lab-bootstrap] %s\n' "$*" >&2
  exit 1
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

assert_no_symlink_path() {
  local path="$1"
  while [[ "$path" != "$ROOT_DIR" ]]; do
    [[ "$path" != "/" ]] || die "Lab PKI 경계가 repository 밖에 있습니다."
    [[ ! -L "$path" ]] || die "symlink 경로는 허용하지 않습니다: $path"
    path="$(dirname "$path")"
  done
}

validate_output_boundaries() {
  local path
  for path in "$ROOT_DIR/.local" "$LAB_PKI_DIR" "$SERVICE_ROOT" "$LAB_PKI_DIR/manufacturing"; do
    assert_no_symlink_path "$path"
  done
}

require_preconditions() {
  [[ "$PKI_ENV" == "lab" ]] || die "이 명령은 PKI_ENV=lab에서만 실행할 수 있습니다."
  [[ -n "${LAB_API_IP:-}" ]] || die "LAB_API_IP가 필요합니다."
  [[ -n "${LAB_MQTT_IP:-}" ]] || die "LAB_MQTT_IP가 필요합니다."
  [[ "$LAB_VAULT_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$LAB_VAULT_PORT >= 1 && 10#$LAB_VAULT_PORT <= 65535 )) || die "LAB_VAULT_PORT가 올바르지 않습니다."
  [[ "$VAULT_ADDR" == "http://127.0.0.1:${LAB_VAULT_PORT}" ]] || die "Lab Vault는 고정된 loopback VAULT_ADDR만 허용합니다."
  local tool
  for tool in docker openssl jq node; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool 실행 파일을 찾을 수 없습니다."
  done
  if [[ "$VAULT_BIN" == */* ]]; then
    [[ -x "$VAULT_BIN" && ! -d "$VAULT_BIN" ]] || die "Vault 실행 파일을 찾을 수 없습니다: $VAULT_BIN"
  else
    command -v "$VAULT_BIN" >/dev/null 2>&1 || die "Vault 실행 파일을 찾을 수 없습니다: $VAULT_BIN"
  fi
  for tool in "$LAB_VAULT_SCRIPT" "$VAULT_BOOTSTRAP_SCRIPT" "$INTERMEDIATE_SIGN_SCRIPT" "$SERVICE_CERT_SCRIPT" "$MANUFACTURING_STATION_SCRIPT"; do
    [[ -x "$tool" && ! -L "$tool" ]] || die "필수 PKI 스크립트를 실행할 수 없습니다: $tool"
  done
}

assert_secret_file() {
  local path="$1" label="$2" boundary resolved
  boundary="${3:-$(dirname "$path")}"
  [[ -f "$path" ]] || die "$label 파일이 없거나 안전하지 않습니다: $path"
  resolved="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$path")" || die "$label 실제 경로를 확인할 수 없습니다."
  [[ "$resolved" == "$boundary/"* || "$resolved" == "$boundary" ]] || die "${label}이 Lab PKI 경계를 벗어났습니다."
  [[ "$(file_mode "$path")" == "600" ]] || die "$label 권한은 0600이어야 합니다."
}

assert_public_file() {
  local path="$1" label="$2" boundary resolved
  boundary="${3:-$(dirname "$path")}"
  [[ -f "$path" ]] || die "$label 파일이 없거나 안전하지 않습니다: $path"
  resolved="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$path")" || die "$label 실제 경로를 확인할 수 없습니다."
  [[ "$resolved" == "$boundary/"* || "$resolved" == "$boundary" ]] || die "${label}이 Lab PKI 경계를 벗어났습니다."
}

write_env_line() {
  local key="$1" value="$2"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "$key 값에 줄바꿈을 사용할 수 없습니다."
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  value="${value//\`/\\\`}"
  printf '%s="%s"\n' "$key" "$value"
}

validate_outputs() {
  local name
  for name in api.crt api.chain.crt mqtt-server.crt mqtt-ca.crt api-ca.crt device-ca.crt api-mqtt-client.crt device.crl mqtt-client.crl; do
    assert_public_file "$SERVICE_DIR/$name" "$name" "$SERVICE_ROOT"
  done
  for name in api.key mqtt-server.key api-mqtt-client.key; do
    assert_secret_file "$SERVICE_DIR/$name" "$name" "$SERVICE_ROOT"
  done
  for name in manufacturing-ca.crt station.crt manufacturing.crl; do
    assert_public_file "$MANUFACTURING_DIR/$name" "$name" "$MANUFACTURING_DIR"
  done
  assert_secret_file "$MANUFACTURING_DIR/station.key" "station.key" "$MANUFACTURING_DIR"
}

issue_application_token() {
  local response token_temporary accessor_temporary
  response="$(mktemp "$LAB_PKI_DIR/.application-token-response.XXXXXX")"
  token_temporary="$(mktemp "$LAB_PKI_DIR/.application-token.XXXXXX")"
  accessor_temporary="$(mktemp "$LAB_PKI_DIR/.application-token-accessor.XXXXXX")"
  chmod 0600 "$response" "$token_temporary" "$accessor_temporary"
  if ! "$VAULT_BIN" token create -policy=gateway-pki -orphan -no-default-policy -ttl=0 -format=json >"$response"; then
    rm -f "$response" "$token_temporary" "$accessor_temporary"
    die "gateway-pki application token 발급에 실패했습니다."
  fi
  if ! node - "$response" "$token_temporary" "$accessor_temporary" <<'NODE'
const fs = require("node:fs");
const [source, tokenTarget, accessorTarget] = process.argv.slice(2);
const auth = JSON.parse(fs.readFileSync(source, "utf8"))?.auth;
const policies = Array.isArray(auth?.policies) ? [...auth.policies].sort() : [];
if (typeof auth?.client_token !== "string" || auth.client_token.length < 8 || /[\r\n]/.test(auth.client_token)) process.exit(1);
if (typeof auth?.accessor !== "string" || auth.accessor.length < 8 || /[\r\n]/.test(auth.accessor)) process.exit(1);
if (auth.lease_duration !== 0 || auth.renewable !== false || policies.join(",") !== "gateway-pki") process.exit(1);
fs.writeFileSync(tokenTarget, `${auth.client_token}\n`, { mode: 0o600 });
fs.writeFileSync(accessorTarget, `${auth.accessor}\n`, { mode: 0o600 });
fs.chmodSync(tokenTarget, 0o600);
fs.chmodSync(accessorTarget, 0o600);
NODE
  then
    rm -f "$response" "$token_temporary" "$accessor_temporary"
    die "Vault application token 응답이 올바르지 않습니다."
  fi
  rm -f "$response"
  printf '%s|%s\n' "$token_temporary" "$accessor_temporary"
}

write_lab_env() {
  local token_file="$1" destination="$2"
  {
    write_env_line PKI_ENV lab
    write_env_line PKI_PROVIDER vault
    write_env_line VAULT_ADDR "$VAULT_ADDR"
    write_env_line VAULT_TOKEN_FILE "$APPLICATION_TOKEN_FILE"
    write_env_line VAULT_PKI_DEVICE_MOUNT gateway-device-pki
    write_env_line VAULT_PKI_DEVICE_ROLE gateway-device
    write_env_line VAULT_PKI_MQTT_MOUNT gateway-mqtt-pki
    write_env_line VAULT_PKI_MQTT_ROLE gateway-mqtt
    write_env_line PKI_LAB_CURRENT_DIR "$SERVICE_DIR"
    write_env_line MQTT_URL "mqtts://${LAB_MQTT_DNS}:8883"
    write_env_line MQTT_PUBLIC_URL "mqtts://${LAB_MQTT_DNS}:8883"
    write_env_line MQTT_CA_PATH "$SERVICE_DIR/mqtt-ca.crt"
    write_env_line MQTT_CLIENT_CERT_PATH "$SERVICE_DIR/api-mqtt-client.crt"
    write_env_line MQTT_CLIENT_KEY_PATH "$SERVICE_DIR/api-mqtt-client.key"
    write_env_line MQTT_SERVER_CLIENT_CA_PATH "$SERVICE_DIR/mqtt-ca.crt"
    write_env_line MQTT_SERVER_CERT_PATH "$SERVICE_DIR/mqtt-server.crt"
    write_env_line MQTT_SERVER_KEY_PATH "$SERVICE_DIR/mqtt-server.key"
    write_env_line MQTT_CLIENT_CRL_PATH "$SERVICE_DIR/mqtt-client.crl"
    write_env_line API_TLS_CERT_PATH "$SERVICE_DIR/api.chain.crt"
    write_env_line API_TLS_KEY_PATH "$SERVICE_DIR/api.key"
    write_env_line API_DEVICE_CLIENT_CA_PATH "$SERVICE_DIR/device-ca.crt"
    write_env_line API_MANUFACTURING_CLIENT_CA_PATH "$MANUFACTURING_DIR/manufacturing-ca.crt"
    write_env_line API_DEVICE_CRL_PATH "$SERVICE_DIR/device.crl"
    write_env_line API_MANUFACTURING_CRL_PATH "$MANUFACTURING_DIR/manufacturing.crl"
    write_env_line PKI_API_CA_BUNDLE_PATH "$SERVICE_DIR/api-ca.crt"
    write_env_line PKI_MQTT_CA_BUNDLE_PATH "$SERVICE_DIR/mqtt-ca.crt"
    write_env_line VITE_API_PROXY_TARGET "https://${LAB_API_DNS}:4000"
    write_env_line NODE_EXTRA_CA_CERTS "$SERVICE_DIR/api-ca.crt"
    write_env_line LAB_API_DNS "$LAB_API_DNS"
    write_env_line LAB_API_IP "$LAB_API_IP"
    write_env_line LAB_MQTT_DNS "$LAB_MQTT_DNS"
    write_env_line LAB_MQTT_IP "$LAB_MQTT_IP"
    write_env_line MANUFACTURING_API_URL "https://${LAB_API_DNS}:4000"
    write_env_line STATION_CERT "$MANUFACTURING_DIR/station.crt"
    write_env_line STATION_KEY "$MANUFACTURING_DIR/station.key"
    write_env_line STATION_CA "$SERVICE_DIR/api-ca.crt"
  } >"$destination"
  chmod 0600 "$destination"
  assert_secret_file "$token_file" "application token 임시" "$LAB_PKI_DIR"
}

main() {
  require_preconditions
  validate_output_boundaries
  "$LAB_VAULT_SCRIPT" start
  assert_secret_file "$ROOT_TOKEN_FILE" "Lab Vault root token"
  export VAULT_ADDR VAULT_BIN PKI_ENV LAB_API_DNS LAB_API_IP LAB_MQTT_DNS LAB_MQTT_IP PKI_SERVICE_CERT_DIR="$SERVICE_ROOT" LAB_MANUFACTURING_DIR="$MANUFACTURING_DIR"
  export VAULT_TOKEN
  VAULT_TOKEN="$(tr -d '\r\n' <"$ROOT_TOKEN_FILE")"
  [[ -n "$VAULT_TOKEN" ]] || die "Lab Vault root token이 비어 있습니다."

  "$VAULT_BOOTSTRAP_SCRIPT" prepare
  "$INTERMEDIATE_SIGN_SCRIPT"
  "$VAULT_BOOTSTRAP_SCRIPT" install
  "$SERVICE_CERT_SCRIPT"
  unset VAULT_TOKEN
  "$MANUFACTURING_STATION_SCRIPT" issue
  validate_outputs

  mkdir -p "$LAB_PKI_DIR"
  chmod 0700 "$LAB_PKI_DIR" "$SERVICE_ROOT" "$MANUFACTURING_DIR"
  local token_result token_temporary accessor_temporary env_temporary old_accessor=""
  VAULT_TOKEN="$(tr -d '\r\n' <"$ROOT_TOKEN_FILE")"
  export VAULT_TOKEN
  token_result="$(issue_application_token)"
  token_temporary="${token_result%%|*}"
  accessor_temporary="${token_result#*|}"
  unset VAULT_TOKEN
  env_temporary="$(mktemp "$LAB_PKI_DIR/.lab.env.XXXXXX")"
  write_lab_env "$token_temporary" "$env_temporary"
  if [[ -f "$APPLICATION_TOKEN_ACCESSOR_FILE" && ! -L "$APPLICATION_TOKEN_ACCESSOR_FILE" ]]; then
    old_accessor="$(tr -d '\r\n' <"$APPLICATION_TOKEN_ACCESSOR_FILE")"
  fi
  mv -f "$token_temporary" "$APPLICATION_TOKEN_FILE"
  if [[ -n "$old_accessor" ]]; then
    VAULT_TOKEN="$(tr -d '\r\n' <"$ROOT_TOKEN_FILE")" "$VAULT_BIN" token revoke -accessor "$old_accessor" >/dev/null || die "이전 application token 폐기에 실패했습니다."
  fi
  mv -f "$accessor_temporary" "$APPLICATION_TOKEN_ACCESSOR_FILE"
  mv -f "$env_temporary" "$LAB_ENV_FILE"
  chmod 0600 "$APPLICATION_TOKEN_FILE" "$APPLICATION_TOKEN_ACCESSOR_FILE" "$LAB_ENV_FILE"
  printf 'Lab device trust environment가 준비되었습니다: %s\n' "$LAB_ENV_FILE"
}

main "$@"
