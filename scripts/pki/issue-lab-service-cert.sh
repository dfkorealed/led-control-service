#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VAULT_BIN="${VAULT_BIN:-vault}"
PKI_ENV="${PKI_ENV:-lab}"
VAULT_STORAGE_MODE="${VAULT_STORAGE_MODE:-file}"
OUTPUT_DIR="${PKI_SERVICE_CERT_DIR:-$ROOT_DIR/.local/vault-pki/services}"

API_MOUNT="api-server-pki"
MQTT_MOUNT="gateway-mqtt-pki"
API_MQTT_URI_SAN="spiffe://led-control/mqtt/api-service"

die() {
  printf '%s\n' "$*" >&2
  exit 1
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
      case "$VAULT_STORAGE_MODE" in
        dev|inmem) die "production Vault rejects dev or inmem storage" ;;
      esac
      local storage_type
      storage_type="$("$VAULT_BIN" status -format=json | node -e 'let source = ""; process.stdin.on("data", (chunk) => { source += chunk; }); process.stdin.on("end", () => { const status = JSON.parse(source); process.stdout.write(String(status.storage_type || "").toLowerCase()); });')" || die "production Vault status is unavailable"
      case "$storage_type" in
        dev|inmem) die "production Vault rejects dev or inmem storage" ;;
      esac
      ;;
    *) die "PKI_ENV must be lab or production" ;;
  esac
}

validate_dns() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] &&
    [[ "$value" != *..* ]] &&
    [[ ${#value} -le 253 ]] || die "DNS SAN is invalid"
}

validate_ipv4() {
  local value="$1"
  local IFS=.
  local -a octets
  read -r -a octets <<<"$value"
  [[ ${#octets[@]} -eq 4 ]] || die "IP SAN is invalid"
  local octet
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || die "IP SAN is invalid"
    ((10#$octet <= 255)) || die "IP SAN is invalid"
  done
}

publish_public() {
  local name="$1"
  local extension="$2"
  local source="$3"
  local version=1
  local destination
  while :; do
    destination="$OUTPUT_DIR/${name}.v${version}.${extension}"
    if [[ ! -e "$destination" ]]; then
      local temporary
      temporary="$(mktemp "$OUTPUT_DIR/.${name}.v${version}.XXXXXX")"
      cp "$source" "$temporary"
      chmod 0644 "$temporary"
      mv -f "$temporary" "$destination"
      break
    fi
    cmp -s "$source" "$destination" && break
    version=$((version + 1))
  done

  local current="$OUTPUT_DIR/${name}.${extension}"
  local pointer="$OUTPUT_DIR/.${name}.current.XXXXXX"
  rm -f "$pointer"
  ln -s "$(basename "$destination")" "$pointer"
  mv -f "$pointer" "$current"
}

read_ca() {
  local mount="$1"
  local temporary="$2"
  "$VAULT_BIN" read -field=certificate "$mount/cert/ca" >"$temporary"
  grep -Fq -- "-----BEGIN CERTIFICATE-----" "$temporary" || die "Vault returned an invalid CA certificate"
}

issue_leaf() {
  local name="$1"
  local mount="$2"
  local role="$3"
  local common_name="$4"
  local dns_name="$5"
  local ip_address="$6"
  local uri_san="${7:-}"

  local key="$OUTPUT_DIR/${name}.key"
  local csr="$OUTPUT_DIR/${name}.csr"
  local certificate="$OUTPUT_DIR/${name}.crt"
  local chain="$OUTPUT_DIR/${name}.chain.crt"
  local key_temporary csr_temporary certificate_temporary chain_temporary
  key_temporary="$(mktemp "$OUTPUT_DIR/.${name}.key.XXXXXX")"
  csr_temporary="$(mktemp "$OUTPUT_DIR/.${name}.csr.XXXXXX")"
  certificate_temporary="$(mktemp "$OUTPUT_DIR/.${name}.crt.XXXXXX")"
  chain_temporary="$(mktemp "$OUTPUT_DIR/.${name}.chain.XXXXXX")"

  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$key_temporary"
  if [[ -n "$uri_san" ]]; then
    openssl req -new -key "$key_temporary" -out "$csr_temporary" -subj "/CN=$common_name" \
      -addext "subjectAltName=URI:$uri_san"
    "$VAULT_BIN" write -field=certificate "$mount/sign/$role" \
      "csr=@$csr_temporary" \
      "common_name=$common_name" \
      "uri_sans=$uri_san" >"$certificate_temporary"
  else
    openssl req -new -key "$key_temporary" -out "$csr_temporary" -subj "/CN=$common_name" \
      -addext "subjectAltName=DNS:$dns_name,IP:$ip_address"
    "$VAULT_BIN" write -field=certificate "$mount/sign/$role" \
      "csr=@$csr_temporary" \
      "common_name=$common_name" \
      "alt_names=$dns_name" \
      "ip_sans=$ip_address" >"$certificate_temporary"
  fi
  grep -Fq -- "-----BEGIN CERTIFICATE-----" "$certificate_temporary" || die "Vault returned an invalid service certificate"
  cat "$certificate_temporary" "$OUTPUT_DIR/${mount}.ca.tmp" >"$chain_temporary"

  chmod 0600 "$key_temporary" "$csr_temporary"
  chmod 0644 "$certificate_temporary" "$chain_temporary"
  mv -f "$key_temporary" "$key"
  mv -f "$csr_temporary" "$csr"
  mv -f "$certificate_temporary" "$certificate"
  mv -f "$chain_temporary" "$chain"
}

require_environment LAB_API_DNS
require_environment LAB_API_IP
require_environment LAB_MQTT_DNS
require_environment LAB_MQTT_IP
validate_vault_environment
validate_dns "$LAB_API_DNS"
validate_dns "$LAB_MQTT_DNS"
validate_ipv4 "$LAB_API_IP"
validate_ipv4 "$LAB_MQTT_IP"
[[ -x "$(command -v "$VAULT_BIN")" || -f "$VAULT_BIN" ]] || die "Vault executable is not available"

mkdir -p "$OUTPUT_DIR"
chmod 0700 "$OUTPUT_DIR"

api_ca="$(mktemp "$OUTPUT_DIR/.api-ca.XXXXXX")"
mqtt_ca="$(mktemp "$OUTPUT_DIR/.mqtt-ca.XXXXXX")"
crl="$(mktemp "$OUTPUT_DIR/.mqtt-client.crl.XXXXXX")"
trap 'rm -f "$api_ca" "$mqtt_ca" "$crl" "$OUTPUT_DIR"/*.ca.tmp' EXIT
read_ca "$API_MOUNT" "$api_ca"
read_ca "$MQTT_MOUNT" "$mqtt_ca"
cp "$api_ca" "$OUTPUT_DIR/${API_MOUNT}.ca.tmp"
cp "$mqtt_ca" "$OUTPUT_DIR/${MQTT_MOUNT}.ca.tmp"
publish_public api-ca crt "$api_ca"
publish_public mqtt-ca crt "$mqtt_ca"

issue_leaf api "$API_MOUNT" api-server "$LAB_API_DNS" "$LAB_API_DNS" "$LAB_API_IP"
issue_leaf mqtt-server "$MQTT_MOUNT" mqtt-server "$LAB_MQTT_DNS" "$LAB_MQTT_DNS" "$LAB_MQTT_IP"
issue_leaf api-mqtt-client "$MQTT_MOUNT" api-mqtt-client api-service "" "" "$API_MQTT_URI_SAN"

"$VAULT_BIN" read -format=raw "$MQTT_MOUNT/crl/pem" >"$crl"
openssl crl -in "$crl" -noout >/dev/null 2>&1 || die "Vault returned an invalid MQTT client CRL"
publish_public mqtt-client crl "$crl"

printf 'Public service certificate bundle is ready in %s\n' "$OUTPUT_DIR"
