#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VAULT_BIN="${VAULT_BIN:-vault}"
PKI_ENV="${PKI_ENV:-lab}"
PKI_LAN_DOMAIN="${PKI_LAN_DOMAIN:-lan}"
PKI_CSR_DIR="${PKI_CSR_DIR:-$ROOT_DIR/.local/lab-pki/csrs}"
PKI_INTERMEDIATE_DIR="${PKI_INTERMEDIATE_DIR:-$ROOT_DIR/.local/lab-pki/signed-intermediates}"
LAB_SIGNED_INTERMEDIATE_DIR="${LAB_SIGNED_INTERMEDIATE_DIR:-$ROOT_DIR/.local/lab-pki/signed-intermediates}"
POLICY_PATH="$ROOT_DIR/infra/vault/policies/gateway-pki.hcl"

DEVICE_MOUNT="gateway-device-pki"
MQTT_MOUNT="gateway-mqtt-pki"
API_MOUNT="api-server-pki"
GATEWAY_UUID_CN_GLOB="????????-????-????-????-????????????"

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
      local storage_type
      storage_type="$("$VAULT_BIN" status -format=json | node -e 'let source = ""; process.stdin.on("data", (chunk) => { source += chunk; }); process.stdin.on("end", () => { const status = JSON.parse(source); process.stdout.write(String(status.storage_type || "").toLowerCase()); });')" || die "production Vault status is unavailable"
      case "$storage_type" in
        raft|consul) ;;
        *) die "production Vault rejects unapproved storage backend: ${storage_type:-missing}" ;;
      esac
      ;;
    *) die "PKI_ENV must be lab or production" ;;
  esac
}

ensure_mount() {
  local mount="$1"
  if "$VAULT_BIN" secrets list -format=json 2>/dev/null | grep -Fq "\"${mount}/\""; then
    return
  fi
  "$VAULT_BIN" secrets enable "-path=$mount" pki >/dev/null
}

write_csr_if_missing() {
  local mount="$1"
  local common_name="$2"
  local artifact_name="${mount%-pki}"
  local destination="$PKI_CSR_DIR/${artifact_name}-intermediate.csr"
  [[ -s "$destination" ]] && return

  local temporary
  temporary="$(mktemp "$PKI_CSR_DIR/.${mount}.csr.XXXXXX")"
  if ! "$VAULT_BIN" write -field=csr "$mount/intermediate/generate/internal" \
    "common_name=$common_name" \
    key_type=ec \
    key_bits=256 \
    max_path_length=0 >"$temporary"; then
    rm -f "$temporary"
    die "Vault could not create the $mount intermediate CSR"
  fi
  grep -Fq -- "-----BEGIN CERTIFICATE REQUEST-----" "$temporary" || {
    rm -f "$temporary"
    die "Vault returned an invalid intermediate CSR for $mount"
  }
  chmod 0644 "$temporary"
  mv -f "$temporary" "$destination"
}

single_issuer_id() {
  local mount="$1"
  "$VAULT_BIN" list -format=json "$mount/issuers" |
    node -e '
      let source = "";
      process.stdin.on("data", (chunk) => { source += chunk; });
      process.stdin.on("end", () => {
        const issuers = JSON.parse(source);
        if (!Array.isArray(issuers) || issuers.length !== 1 || typeof issuers[0] !== "string") process.exit(1);
        process.stdout.write(issuers[0]);
      });
    ' || die "$mount must contain exactly one issuer"
}

publish_certificate() {
  local label="$1"
  local source="$2"
  local version=1
  local destination
  mkdir -p "$PKI_INTERMEDIATE_DIR"
  chmod 0700 "$PKI_INTERMEDIATE_DIR"

  while :; do
    destination="$PKI_INTERMEDIATE_DIR/${label}.v${version}.crt"
    if [[ ! -e "$destination" ]]; then
      local temporary
      temporary="$(mktemp "$PKI_INTERMEDIATE_DIR/.${label}.v${version}.XXXXXX")"
      cp "$source" "$temporary"
      chmod 0644 "$temporary"
      mv -f "$temporary" "$destination"
      break
    fi
    cmp -s "$source" "$destination" && break
    version=$((version + 1))
  done

  local pointer="$PKI_INTERMEDIATE_DIR/${label}.crt"
  local temporary_pointer="$PKI_INTERMEDIATE_DIR/.${label}.current.XXXXXX"
  rm -f "$temporary_pointer"
  ln -s "$(basename "$destination")" "$temporary_pointer"
  mv -f "$temporary_pointer" "$pointer"
}

import_intermediate() {
  local mount="$1"
  local label="$2"
  local certificate="$3"
  [[ -s "$certificate" ]] || die "$label intermediate certificate is required"
  "$VAULT_BIN" write "$mount/intermediate/set-signed" "certificate=@$certificate" >/dev/null
  local issuer
  issuer="$(single_issuer_id "$mount")"
  "$VAULT_BIN" write "$mount/config/issuers" "default=$issuer" >/dev/null
  publish_certificate "$label-ca" "$certificate"
}

configure_roles_and_policy() {
  "$VAULT_BIN" write "$DEVICE_MOUNT/roles/gateway-device" \
    allow_any_name=true \
    allowed_uri_sans="urn:dfkorea:gateway:*" \
    client_flag=true \
    server_flag=false \
    max_ttl=8760h \
    >/dev/null
  "$VAULT_BIN" write "$MQTT_MOUNT/roles/gateway-mqtt" \
    "allowed_domains=$GATEWAY_UUID_CN_GLOB" \
    allow_bare_domains=true \
    allow_subdomains=false \
    allow_glob_domains=true \
    allow_wildcard_certificates=false \
    allow_any_name=false \
    allow_localhost=false \
    allowed_uri_sans="urn:dfkorea:gateway:*" \
    client_flag=true \
    server_flag=false \
    max_ttl=2160h \
    >/dev/null
  "$VAULT_BIN" write "$MQTT_MOUNT/roles/mqtt-server" \
    "allowed_domains=$PKI_LAN_DOMAIN" \
    allow_bare_domains=false \
    allow_subdomains=true \
    allow_glob_domains=false \
    allow_any_name=false \
    allow_ip_sans=true \
    client_flag=false \
    server_flag=true \
    max_ttl=2160h \
    >/dev/null
  "$VAULT_BIN" write "$MQTT_MOUNT/roles/api-mqtt-client" \
    allowed_domains=api-service \
    allow_bare_domains=true \
    allow_subdomains=false \
    allow_glob_domains=false \
    allow_any_name=false \
    allowed_uri_sans="spiffe://led-control/mqtt/api-service" \
    client_flag=true \
    server_flag=false \
    max_ttl=2160h \
    >/dev/null
  "$VAULT_BIN" write "$API_MOUNT/roles/api-server" \
    "allowed_domains=$PKI_LAN_DOMAIN" \
    allow_bare_domains=false \
    allow_subdomains=true \
    allow_glob_domains=false \
    allow_any_name=false \
    allow_ip_sans=true \
    client_flag=false \
    server_flag=true \
    max_ttl=2160h \
    >/dev/null
  "$VAULT_BIN" policy write gateway-pki "$POLICY_PATH" >/dev/null
}

prepare() {
  mkdir -p "$PKI_CSR_DIR"
  chmod 0700 "$PKI_CSR_DIR"
  ensure_mount "$DEVICE_MOUNT"
  ensure_mount "$MQTT_MOUNT"
  ensure_mount "$API_MOUNT"
  write_csr_if_missing "$DEVICE_MOUNT" "LED Control Gateway Device Intermediate"
  write_csr_if_missing "$MQTT_MOUNT" "LED Control Gateway MQTT Intermediate"
  write_csr_if_missing "$API_MOUNT" "LED Control API Server Intermediate"
  printf 'Purpose-specific intermediate CSRs are ready in %s\n' "$PKI_CSR_DIR"
}

install() {
  local device_certificate="${GATEWAY_DEVICE_INTERMEDIATE_CERT:-$LAB_SIGNED_INTERMEDIATE_DIR/gateway-device-intermediate.chain.crt}"
  local mqtt_certificate="${GATEWAY_MQTT_INTERMEDIATE_CERT:-$LAB_SIGNED_INTERMEDIATE_DIR/gateway-mqtt-intermediate.chain.crt}"
  local api_certificate="${API_SERVER_INTERMEDIATE_CERT:-$LAB_SIGNED_INTERMEDIATE_DIR/api-server-intermediate.chain.crt}"
  import_intermediate "$DEVICE_MOUNT" gateway-device "$device_certificate"
  import_intermediate "$MQTT_MOUNT" gateway-mqtt "$mqtt_certificate"
  import_intermediate "$API_MOUNT" api-server "$api_certificate"
  configure_roles_and_policy
  printf 'Intermediate certificates, roles, and policy are installed.\n'
}

[[ -x "$(command -v "$VAULT_BIN")" || -f "$VAULT_BIN" ]] || die "Vault executable is not available"
[[ -r "$POLICY_PATH" ]] || die "Vault policy file is not readable"
validate_vault_environment

case "${1:-}" in
  prepare) prepare ;;
  install) install ;;
  *) die "usage: $0 prepare|install" ;;
esac
