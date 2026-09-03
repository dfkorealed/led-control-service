#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
VAULT_BIN="${VAULT_BIN:-vault}"
PKI_ENV="${PKI_ENV:-lab}"
OUTPUT_ROOT="${PKI_SERVICE_CERT_DIR:-$ROOT_DIR/.local/lab-pki/services}"
GENERATIONS_DIR="$OUTPUT_ROOT/generations"
CURRENT_POINTER="$OUTPUT_ROOT/current"
LOCK_DIR="$OUTPUT_ROOT/.service-issue.lock"
LOCK_TIMEOUT_SECONDS="${LAB_SERVICE_LOCK_TIMEOUT_SECONDS:-30}"

DEVICE_MOUNT="gateway-device-pki"
API_MOUNT="api-server-pki"
MQTT_MOUNT="gateway-mqtt-pki"
API_MQTT_URI_SAN="spiffe://led-control/mqtt/api-service"
SERVICE_BUNDLE_FORMAT_VERSION="4"
ROOT_CRL_PATH="${PKI_ROOT_CRL_PATH:-$ROOT_DIR/.local/lab-pki/root/root.crl}"

STAGE=""
SCRATCH=""
LOCK_HELD=0

die() {
  printf '[lab-service-cert] %s\n' "$*" >&2
  exit 1
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

assert_no_symlink_ancestors() {
  local path="$1"
  while [[ "$path" != "/" ]]; do
    [[ ! -L "$path" ]] || die "symlink 경로는 허용하지 않습니다: $path"
    path="$(dirname "$path")"
  done
}

require_environment() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "$name is required"
}

validate_vault_environment() {
  require_environment VAULT_ADDR
  case "$PKI_ENV" in
    lab) ;;
    production)
      [[ "$VAULT_ADDR" == https://* ]] || die "production Vault requires HTTPS VAULT_ADDR"
      local storage_type
      storage_type="$("$VAULT_BIN" status -format=json | node -e 'let source = ""; process.stdin.on("data", chunk => source += chunk); process.stdin.on("end", () => process.stdout.write(String(JSON.parse(source).storage_type || "").toLowerCase()))')" || die "production Vault status is unavailable"
      case "$storage_type" in raft|consul) ;; *) die "production Vault rejects unapproved storage backend: ${storage_type:-missing}" ;; esac
      ;;
    *) die "PKI_ENV must be lab or production" ;;
  esac
}

validate_dns() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] &&
    [[ "$value" != *..* ]] && [[ ${#value} -le 253 ]] || die "DNS SAN is invalid"
}

validate_ipv4() {
  local value="$1" IFS=. octet
  local -a octets
  read -r -a octets <<<"$value"
  [[ ${#octets[@]} -eq 4 ]] || die "IP SAN is invalid"
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] && ((10#$octet <= 255)) || die "IP SAN is invalid"
  done
}

acquire_lock() {
  local elapsed=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    [[ -d "$LOCK_DIR" && ! -L "$LOCK_DIR" ]] || die "service bundle lock 경로가 안전하지 않습니다."
    (( elapsed >= LOCK_TIMEOUT_SECONDS )) && die "다른 service bundle 발급이 실행 중이거나 stale lock이 남아 있습니다."
    sleep 1
    elapsed=$((elapsed + 1))
  done
  chmod 0700 "$LOCK_DIR"
  LOCK_HELD=1
}

cleanup() {
  [[ -z "$STAGE" ]] || rm -rf "$STAGE"
  [[ -z "$SCRATCH" ]] || rm -rf "$SCRATCH"
  if (( LOCK_HELD )); then rmdir "$LOCK_DIR" 2>/dev/null || true; fi
}
trap cleanup EXIT

read_ca() {
  local mount="$1" destination="$2" response
  response="$("$VAULT_BIN" read -format=json "$mount/cert/ca_chain")" || die "Vault CA chain 조회에 실패했습니다."
  printf '%s' "$response" | node -e '
    let source = "";
    process.stdin.on("data", chunk => source += chunk);
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(source).data;
        const chainIsValid = typeof data?.ca_chain === "string"
          ? Boolean(data.ca_chain.trim())
          : Array.isArray(data?.ca_chain) && data.ca_chain.length > 0 &&
            data.ca_chain.every(item => typeof item === "string" && item.trim());
        if (typeof data?.certificate !== "string" || !data.certificate.trim() || !chainIsValid) process.exit(1);
        process.stdout.write(data.certificate);
      } catch {
        process.exit(1);
      }
    });
  ' >"$destination" || die "Vault returned an invalid CA chain"
  openssl x509 -in "$destination" -noout >/dev/null 2>&1 || die "Vault returned an invalid CA certificate"
  chmod 0644 "$destination"
}

read_crl() {
  local mount="$1" ca="$2" destination="$3" label="$4"
  "$VAULT_BIN" read -format=raw "$mount/crl/pem" >"$destination" || die "$label CRL 조회에 실패했습니다."
  openssl crl -in "$destination" -noout -verify -CAfile "$ca" >/dev/null 2>&1 || die "Vault returned an invalid $label CRL"
  chmod 0644 "$destination"
}

crl_from_bundle() {
  local bundle="$1" target="$2"
  awk -v target="$target" '
    /-----BEGIN X509 CRL-----/ { current++ }
    current == target { print }
    /-----END X509 CRL-----/ && current == target { exit }
  ' "$bundle"
}

verify_crl_bundle() {
  local bundle="$1" ca="$2" label="$3"
  [[ "$(grep -c 'BEGIN X509 CRL' "$bundle")" == "2" ]] || die "$label CRL bundle은 intermediate와 Root CRL을 모두 포함해야 합니다."
  openssl crl -in <(crl_from_bundle "$bundle" 1) -noout -verify -CAfile "$ca" >/dev/null 2>&1 || die "$label intermediate CRL 검증에 실패했습니다."
  openssl crl -in <(crl_from_bundle "$bundle" 2) -noout -verify -CAfile "$ca" >/dev/null 2>&1 || die "$label Root CRL 검증에 실패했습니다."
}

public_key_digest() {
  openssl dgst -sha256 | awk '{print $NF}'
}

verify_key_pair() {
  local key="$1" certificate="$2" label="$3" key_digest certificate_digest
  key_digest="$(openssl pkey -in "$key" -pubout 2>/dev/null | public_key_digest)" || die "$label private key가 올바르지 않습니다."
  certificate_digest="$(openssl x509 -in "$certificate" -pubkey -noout 2>/dev/null | public_key_digest)" || die "$label certificate가 올바르지 않습니다."
  [[ "$key_digest" == "$certificate_digest" ]] || die "$label key와 certificate가 일치하지 않습니다."
}

issue_leaf() {
  local directory="$1" name="$2" mount="$3" role="$4" common_name="$5" dns_name="$6" ip_address="$7" uri_san="${8:-}"
  local key="$directory/${name}.key" csr="$directory/${name}.csr" certificate="$directory/${name}.crt"
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$key"
  if [[ -n "$uri_san" ]]; then
    openssl req -new -key "$key" -out "$csr" -subj "/CN=$common_name" -addext "subjectAltName=URI:$uri_san"
    "$VAULT_BIN" write -field=certificate "$mount/sign/$role" "csr=@$csr" "common_name=$common_name" "uri_sans=$uri_san" >"$certificate"
  else
    openssl req -new -key "$key" -out "$csr" -subj "/CN=$common_name" -addext "subjectAltName=DNS:$dns_name,IP:$ip_address"
    "$VAULT_BIN" write -field=certificate "$mount/sign/$role" "csr=@$csr" "common_name=$common_name" "alt_names=$dns_name" "ip_sans=$ip_address" >"$certificate"
  fi
  chmod 0600 "$key" "$csr"
  chmod 0644 "$certificate"
  {
    cat "$certificate"
    printf '\n'
    cat "$directory/${mount}.ca"
  } >"$directory/${name}.chain.crt"
  chmod 0644 "$directory/${name}.chain.crt"
  verify_key_pair "$key" "$certificate" "$name"
}

input_hash() {
  {
    printf '%s\0' "$SERVICE_BUNDLE_FORMAT_VERSION" "$LAB_API_DNS" "$LAB_API_IP" "$LAB_MQTT_DNS" "$LAB_MQTT_IP" "$API_MQTT_URI_SAN"
    cat "$SCRATCH/api-ca.crt" "$SCRATCH/mqtt-ca.crt" "$SCRATCH/device-ca.crt"
  } | openssl dgst -sha256 | awk '{print $NF}'
}

current_generation() {
  [[ -e "$CURRENT_POINTER" || -L "$CURRENT_POINTER" ]] || return 1
  [[ -L "$CURRENT_POINTER" ]] || die "service current pointer가 symlink가 아닙니다."
  local target
  target="$(readlink "$CURRENT_POINTER")"
  [[ "$target" =~ ^generations/bundle-[0-9a-f]{64}$ ]] || die "service current pointer가 안전하지 않습니다."
  printf '%s\n' "$OUTPUT_ROOT/$target"
}

verify_generation() {
  local generation="$1" name
  [[ -d "$generation" && ! -L "$generation" ]] || die "service generation이 안전하지 않습니다."
  for name in api mqtt-server api-mqtt-client; do
    [[ -f "$generation/$name.key" && ! -L "$generation/$name.key" && "$(file_mode "$generation/$name.key")" == 600 ]] || die "$name key가 안전하지 않습니다."
    [[ -f "$generation/$name.csr" && ! -L "$generation/$name.csr" && "$(file_mode "$generation/$name.csr")" == 600 ]] || die "$name CSR이 안전하지 않습니다."
    [[ -f "$generation/$name.crt" && ! -L "$generation/$name.crt" && "$(file_mode "$generation/$name.crt")" == 644 ]] || die "$name certificate가 안전하지 않습니다."
    [[ -f "$generation/$name.chain.crt" && ! -L "$generation/$name.chain.crt" && "$(file_mode "$generation/$name.chain.crt")" == 644 ]] || die "$name chain이 안전하지 않습니다."
    verify_key_pair "$generation/$name.key" "$generation/$name.crt" "$name"
  done
  for name in api-ca.crt mqtt-ca.crt device-ca.crt mqtt-client.crl device.crl input-hash format-version; do
    [[ -f "$generation/$name" && ! -L "$generation/$name" && "$(file_mode "$generation/$name")" == 644 ]] || die "$name 파일이 안전하지 않습니다."
  done
  [[ "$(tr -d '[:space:]' <"$generation/format-version")" == "$SERVICE_BUNDLE_FORMAT_VERSION" ]] || die "service bundle format version이 올바르지 않습니다."
  verify_crl_bundle "$generation/mqtt-client.crl" "$generation/mqtt-ca.crt" MQTT
  verify_crl_bundle "$generation/device.crl" "$generation/device-ca.crt" device
}

publish_current() {
  local generation="$1" temporary="$OUTPUT_ROOT/.current.new-$$-$RANDOM"
  ln -s "generations/$(basename "$generation")" "$temporary"
  node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$temporary" "$CURRENT_POINTER"
}

for name in LAB_API_DNS LAB_API_IP LAB_MQTT_DNS LAB_MQTT_IP; do require_environment "$name"; done
validate_vault_environment
if [[ "$PKI_ENV" == "production" ]]; then require_environment PKI_ROOT_CRL_PATH; fi
validate_dns "$LAB_API_DNS"
validate_dns "$LAB_MQTT_DNS"
validate_ipv4 "$LAB_API_IP"
validate_ipv4 "$LAB_MQTT_IP"
[[ -x "$(command -v "$VAULT_BIN" 2>/dev/null || true)" || -f "$VAULT_BIN" ]] || die "Vault executable is not available"
[[ "$LOCK_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die "LAB_SERVICE_LOCK_TIMEOUT_SECONDS must be an integer"

assert_no_symlink_ancestors "$OUTPUT_ROOT"
mkdir -p "$GENERATIONS_DIR"
chmod 0700 "$OUTPUT_ROOT" "$GENERATIONS_DIR"
acquire_lock

SCRATCH="$(mktemp -d "$OUTPUT_ROOT/.service-material.XXXXXX")"
chmod 0700 "$SCRATCH"
read_ca "$API_MOUNT" "$SCRATCH/api-ca.crt"
read_ca "$MQTT_MOUNT" "$SCRATCH/mqtt-ca.crt"
read_ca "$DEVICE_MOUNT" "$SCRATCH/device-ca.crt"
[[ -f "$ROOT_CRL_PATH" && ! -L "$ROOT_CRL_PATH" ]] || die "Root CRL 파일이 없거나 안전하지 않습니다."
cp "$ROOT_CRL_PATH" "$SCRATCH/root.crl"
chmod 0644 "$SCRATCH/root.crl"
openssl crl -in "$SCRATCH/root.crl" -noout -verify -CAfile "$SCRATCH/device-ca.crt" >/dev/null 2>&1 || die "Root CRL 검증에 실패했습니다."
read_crl "$MQTT_MOUNT" "$SCRATCH/mqtt-ca.crt" "$SCRATCH/mqtt-intermediate.crl" MQTT
read_crl "$DEVICE_MOUNT" "$SCRATCH/device-ca.crt" "$SCRATCH/device-intermediate.crl" device
for purpose in mqtt-client device; do
  intermediate="$SCRATCH/${purpose%%-*}-intermediate.crl"
  if [[ "$purpose" == "device" ]]; then intermediate="$SCRATCH/device-intermediate.crl"; fi
  { cat "$intermediate"; printf '\n'; cat "$SCRATCH/root.crl"; } >"$SCRATCH/$purpose.crl"
  chmod 0644 "$SCRATCH/$purpose.crl"
done
verify_crl_bundle "$SCRATCH/mqtt-client.crl" "$SCRATCH/mqtt-ca.crt" MQTT
verify_crl_bundle "$SCRATCH/device.crl" "$SCRATCH/device-ca.crt" device

INPUT_HASH="$(input_hash)"
CURRENT="$(current_generation || true)"
if [[ -n "$CURRENT" ]] && { [[ ! -f "$CURRENT/format-version" ]] || [[ "$(tr -d '[:space:]' <"$CURRENT/format-version")" != "$SERVICE_BUNDLE_FORMAT_VERSION" ]]; }; then
  CURRENT=""
fi
if [[ -n "$CURRENT" ]]; then
  verify_generation "$CURRENT"
  if [[ "$(cat "$CURRENT/input-hash")" == "$INPUT_HASH" ]] &&
    cmp -s "$CURRENT/api-ca.crt" "$SCRATCH/api-ca.crt" && cmp -s "$CURRENT/mqtt-ca.crt" "$SCRATCH/mqtt-ca.crt" &&
    cmp -s "$CURRENT/device-ca.crt" "$SCRATCH/device-ca.crt" && cmp -s "$CURRENT/mqtt-client.crl" "$SCRATCH/mqtt-client.crl" &&
    cmp -s "$CURRENT/device.crl" "$SCRATCH/device.crl"; then
    printf 'Service certificate bundle is already current in %s\n' "$CURRENT_POINTER"
    exit 0
  fi
fi

STAGE="$(mktemp -d "$GENERATIONS_DIR/.bundle.XXXXXX")"
chmod 0700 "$STAGE"
cp "$SCRATCH/api-ca.crt" "$STAGE/api-ca.crt"
cp "$SCRATCH/mqtt-ca.crt" "$STAGE/mqtt-ca.crt"
cp "$SCRATCH/device-ca.crt" "$STAGE/device-ca.crt"
cp "$SCRATCH/mqtt-client.crl" "$STAGE/mqtt-client.crl"
cp "$SCRATCH/device.crl" "$STAGE/device.crl"
cp "$SCRATCH/api-ca.crt" "$STAGE/${API_MOUNT}.ca"
cp "$SCRATCH/mqtt-ca.crt" "$STAGE/${MQTT_MOUNT}.ca"
chmod 0644 "$STAGE"/*.crt "$STAGE"/*.crl "$STAGE"/*.ca
printf '%s\n' "$INPUT_HASH" >"$STAGE/input-hash"
printf '%s\n' "$SERVICE_BUNDLE_FORMAT_VERSION" >"$STAGE/format-version"
chmod 0644 "$STAGE/input-hash" "$STAGE/format-version"

if [[ -n "$CURRENT" && "$(cat "$CURRENT/input-hash")" == "$INPUT_HASH" ]]; then
  for name in api mqtt-server api-mqtt-client; do
    cp "$CURRENT/$name.key" "$CURRENT/$name.csr" "$CURRENT/$name.crt" "$CURRENT/$name.chain.crt" "$STAGE/"
  done
else
  issue_leaf "$STAGE" api "$API_MOUNT" api-server "$LAB_API_DNS" "$LAB_API_DNS" "$LAB_API_IP"
  issue_leaf "$STAGE" mqtt-server "$MQTT_MOUNT" mqtt-server "$LAB_MQTT_DNS" "$LAB_MQTT_DNS" "$LAB_MQTT_IP"
  issue_leaf "$STAGE" api-mqtt-client "$MQTT_MOUNT" api-mqtt-client api-service "" "" "$API_MQTT_URI_SAN"
fi
rm -f "$STAGE/${API_MOUNT}.ca" "$STAGE/${MQTT_MOUNT}.ca"
chmod 0600 "$STAGE"/*.key "$STAGE"/*.csr
chmod 0644 "$STAGE"/*.crt "$STAGE"/*.crl "$STAGE/input-hash" "$STAGE/format-version"
verify_generation "$STAGE"

BUNDLE_HASH="$(cat "$STAGE"/*.crt "$STAGE"/*.crl "$STAGE/input-hash" "$STAGE/format-version" | openssl dgst -sha256 | awk '{print $NF}')"
FINAL="$GENERATIONS_DIR/bundle-$BUNDLE_HASH"
if [[ -e "$FINAL" ]]; then
  verify_generation "$FINAL"
  rm -rf "$STAGE"
  STAGE=""
else
  mv "$STAGE" "$FINAL"
  STAGE=""
fi
publish_current "$FINAL"
printf 'Public service certificate bundle is ready in %s\n' "$CURRENT_POINTER"
