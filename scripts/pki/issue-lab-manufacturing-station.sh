#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
PKI_ENV="${PKI_ENV:-}"
LAB_PKI_DIR="$ROOT_DIR/.local/lab-pki"
MANUFACTURING_DIR="$LAB_PKI_DIR/manufacturing"
GENERATION_DIR="$MANUFACTURING_DIR/generations"
LOCK_DIR="$MANUFACTURING_DIR/.station-issue.lock"
LOCK_TIMEOUT_SECONDS="${LAB_MANUFACTURING_LOCK_TIMEOUT_SECONDS:-30}"
STATION_NAME="${LAB_MANUFACTURING_STATION_NAME:-lab-manufacturing-station}"
COMMAND="${1:-issue}"
CRL_FRESHNESS_SECONDS="${LAB_MANUFACTURING_CRL_FRESHNESS_SECONDS:-86400}"
CURRENT_POINTER="$MANUFACTURING_DIR/current"

die() {
  printf '[lab-manufacturing-station] %s\n' "$*" >&2
  exit 1
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

assert_component_path() {
  local path="$1" boundary="$ROOT_DIR"
  while :; do
    [[ ! -L "$path" ]] || die "symlink 경로는 허용하지 않습니다: $path"
    [[ "$path" == "$boundary" ]] && return
    [[ "$path" != "/" ]] || die "Lab PKI 경로가 repository 경계를 벗어났습니다."
    path="$(dirname "$path")"
  done
}

assert_regular_file() {
  local path="$1" label="$2"
  [[ ! -L "$path" && -f "$path" ]] || die "$label은 symlink가 아닌 일반 파일이어야 합니다."
}

require_lab_environment() {
  [[ "$PKI_ENV" == "lab" ]] || die "이 명령은 PKI_ENV=lab에서만 실행할 수 있습니다."
  [[ "$COMMAND" == "issue" || "$COMMAND" == "revoke" ]] || die "사용법: $0 [issue|revoke]"
  [[ "$STATION_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "station 이름은 소문자 영문, 숫자, 하이픈만 사용할 수 있습니다."
  [[ "$LOCK_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die "LAB_MANUFACTURING_LOCK_TIMEOUT_SECONDS는 0 이상의 정수여야 합니다."
  [[ "$CRL_FRESHNESS_SECONDS" =~ ^[0-9]+$ ]] || die "LAB_MANUFACTURING_CRL_FRESHNESS_SECONDS는 0 이상의 정수여야 합니다."
  command -v openssl >/dev/null 2>&1 || die "OpenSSL 실행 파일을 찾을 수 없습니다."
}

ensure_layout() {
  mkdir -p "$ROOT_DIR/.local" "$LAB_PKI_DIR" "$MANUFACTURING_DIR" "$GENERATION_DIR"
  assert_component_path "$ROOT_DIR/.local"
  assert_component_path "$LAB_PKI_DIR"
  assert_component_path "$MANUFACTURING_DIR"
  assert_component_path "$GENERATION_DIR"
  chmod 0700 "$ROOT_DIR/.local" "$LAB_PKI_DIR" "$MANUFACTURING_DIR" "$GENERATION_DIR"
}

acquire_lock() {
  local elapsed=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    [[ -d "$LOCK_DIR" && ! -L "$LOCK_DIR" ]] || die "Lab manufacturing lock 경로가 안전하지 않습니다."
    (( elapsed >= LOCK_TIMEOUT_SECONDS )) && die "다른 Lab manufacturing station 발급이 실행 중이거나 stale lock이 남아 있습니다: $LOCK_DIR"
    sleep 1
    elapsed=$((elapsed + 1))
  done
  chmod 0700 "$LOCK_DIR"
}

release_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

public_key_digest() {
  openssl dgst -sha256 | awk '{print $NF}'
}

certificate_public_key_digest() {
  openssl x509 -in "$1" -pubkey -noout | public_key_digest
}

key_public_key_digest() {
  openssl pkey -in "$1" -pubout | public_key_digest
}

station_subject() {
  openssl x509 -in "$1" -noout -subject -nameopt RFC2253 | sed 's/^subject=//'
}

write_config() {
  local path="$1"
  local generation="$2"
  cat >"$path" <<EOF
[ req ]
distinguished_name = subject
prompt = no

[ ca ]
default_ca = ca_default

[ ca_default ]
database = $generation/index.txt
new_certs_dir = $generation/newcerts
certificate = $generation/manufacturing-ca.crt
private_key = $generation/manufacturing-ca.key
serial = $generation/serial
crlnumber = $generation/crlnumber
default_md = sha256
default_days = 825
default_crl_days = 7
policy = station_policy
copy_extensions = none
unique_subject = no

[ station_policy ]
commonName = supplied

[ subject ]
CN = Lab Manufacturing CA

[ manufacturing_ca ]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always

[ station ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF
  chmod 0644 "$path"
}

assert_prime256v1_key() {
  local key="$1" label="$2"
  openssl ec -in "$key" -noout -text 2>/dev/null | grep -Eq 'ASN1 OID: prime256v1|NIST CURVE: P-256' || die "$label은 ECDSA prime256v1이어야 합니다."
}

assert_prime256v1_certificate() {
  local certificate="$1" label="$2"
  openssl x509 -in "$certificate" -pubkey -noout | openssl pkey -pubin -noout -text 2>/dev/null | grep -Eq 'ASN1 OID: prime256v1|NIST CURVE: P-256' || die "$label은 ECDSA prime256v1이어야 합니다."
}

extension_value() {
  local certificate="$1" extension="$2"
  openssl x509 -in "$certificate" -noout -ext "$extension" 2>/dev/null | tail -n +2 | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

verify_crl() {
  local crl="$1" ca="$2"
  assert_regular_file "$crl" "Manufacturing CRL"
  [[ "$(file_mode "$crl")" == "644" ]] || die "Manufacturing CRL 권한은 0644이어야 합니다."
  openssl crl -in "$crl" -noout >/dev/null 2>&1 || die "Manufacturing CRL 형식이 올바르지 않습니다."
  openssl crl -in "$crl" -noout -verify -CAfile "$ca" >/dev/null 2>&1 || die "Manufacturing CRL signature 검증에 실패했습니다."
  local issuer subject
  issuer="$(openssl crl -in "$crl" -noout -issuer -nameopt RFC2253 | sed 's/^issuer=//')"
  subject="$(station_subject "$ca")"
  [[ "$issuer" == "$subject" ]] || die "Manufacturing CRL issuer가 CA와 일치하지 않습니다."
  crl_has_minimum_freshness "$crl" || die "Manufacturing CRL 유효 기간이 최소 freshness window보다 짧습니다."
}

crl_has_minimum_freshness() {
  local crl="$1" next_update epoch now
  next_update="$(openssl crl -in "$crl" -noout -nextupdate 2>/dev/null | sed 's/^nextUpdate=//')" || return 1
  [[ -n "$next_update" ]] || return 1
  if epoch="$(date -j -u -f '%b %e %T %Y %Z' "$next_update" '+%s' 2>/dev/null)"; then :; else
    epoch="$(date -u -d "$next_update" '+%s' 2>/dev/null)" || return 1
  fi
  now="$(date -u '+%s')"
  (( epoch > now + CRL_FRESHNESS_SECONDS ))
}

crl_is_usable() {
  local crl="$1" ca="$2" issuer subject
  [[ ! -L "$crl" && -f "$crl" && "$(file_mode "$crl")" == "644" ]] || return 1
  openssl crl -in "$crl" -noout -verify -CAfile "$ca" >/dev/null 2>&1 || return 1
  issuer="$(openssl crl -in "$crl" -noout -issuer -nameopt RFC2253 2>/dev/null | sed 's/^issuer=//')" || return 1
  subject="$(station_subject "$ca")" || return 1
  [[ "$issuer" == "$subject" ]] && crl_has_minimum_freshness "$crl"
}

regenerate_crl() {
  local generation="$1"
  local config="$generation/openssl.cnf"
  local temporary="$generation/.manufacturing.crl.new-$$-$RANDOM"
  openssl ca -config "$config" -gencrl -out "$temporary" >/dev/null 2>&1 || die "Manufacturing CRL 생성에 실패했습니다."
  chmod 0644 "$temporary"
  mv -f "$temporary" "$generation/manufacturing.crl"
}

verify_generation() {
  local generation="$1" expected_station="$2"
  local ca_key="$generation/manufacturing-ca.key" ca="$generation/manufacturing-ca.crt"
  local station_key="$generation/station.key" station="$generation/station.crt" chain="$generation/station.chain.crt" crl="$generation/manufacturing.crl"
  [[ -d "$generation" && ! -L "$generation" ]] || die "manufacturing generation이 안전하지 않습니다."
  assert_regular_file "$ca_key" "Manufacturing CA private key"
  assert_regular_file "$ca" "Manufacturing CA certificate"
  assert_regular_file "$station_key" "station private key"
  assert_regular_file "$station" "station certificate"
  assert_regular_file "$chain" "station chain"
  assert_regular_file "$generation/openssl.cnf" "Manufacturing OpenSSL config"
  assert_regular_file "$generation/index.txt" "Manufacturing CA index"
  assert_regular_file "$generation/serial" "Manufacturing CA serial"
  assert_regular_file "$generation/crlnumber" "Manufacturing CA CRL number"
  [[ "$(file_mode "$ca_key")" == "600" && "$(file_mode "$station_key")" == "600" ]] || die "Manufacturing private key 권한은 0600이어야 합니다."
  [[ "$(file_mode "$ca")" == "644" && "$(file_mode "$station")" == "644" && "$(file_mode "$chain")" == "644" ]] || die "Manufacturing 공개 산출물 권한은 0644이어야 합니다."
  openssl verify -CAfile "$ca" "$ca" >/dev/null 2>&1 || die "Manufacturing CA 검증에 실패했습니다."
  openssl verify -CAfile "$ca" "$station" >/dev/null 2>&1 || die "station certificate chain 검증에 실패했습니다."
  [[ "$(key_public_key_digest "$ca_key")" == "$(certificate_public_key_digest "$ca")" ]] || die "Manufacturing CA private key와 certificate 공개키가 일치하지 않습니다."
  [[ "$(key_public_key_digest "$station_key")" == "$(certificate_public_key_digest "$station")" ]] || die "station private key와 certificate 공개키가 일치하지 않습니다."
  assert_prime256v1_key "$ca_key" "Manufacturing CA private key"
  assert_prime256v1_certificate "$ca" "Manufacturing CA certificate"
  assert_prime256v1_key "$station_key" "station private key"
  assert_prime256v1_certificate "$station" "station certificate"
  [[ "$(station_subject "$station")" == "CN=$expected_station" ]] || die "station identity mismatch: 기존 station 이름과 요청이 다릅니다."
  local ca_details station_details
  ca_details="$(openssl x509 -in "$ca" -noout -text)"
  station_details="$(openssl x509 -in "$station" -noout -text)"
  grep -Fq "CA:TRUE, pathlen:0" <<<"$ca_details" || die "Manufacturing CA basic constraints가 올바르지 않습니다."
  grep -Fq "Certificate Sign, CRL Sign" <<<"$ca_details" || die "Manufacturing CA key usage가 올바르지 않습니다."
  [[ "$(extension_value "$station" basicConstraints)" == "CA:FALSE" ]] && grep -Fq "Basic Constraints: critical" <<<"$station_details" || die "station basicConstraints는 critical CA:false여야 합니다."
  [[ "$(extension_value "$station" keyUsage)" == "Digital Signature" ]] && grep -Fq "Key Usage: critical" <<<"$station_details" || die "station keyUsage는 critical digitalSignature만 허용합니다."
  [[ "$(extension_value "$station" extendedKeyUsage)" == "TLS Web Client Authentication" ]] && grep -Fq "Extended Key Usage: critical" <<<"$station_details" || die "station EKU는 critical clientAuth 하나여야 합니다."
  cmp -s <(cat "$station" "$ca") "$chain" || die "station chain 파일이 올바르지 않습니다."
}

stable_path() {
  case "$1" in
    manufacturing-ca.key) printf '%s/manufacturing-ca.key\n' "$MANUFACTURING_DIR" ;;
    manufacturing-ca.crt) printf '%s/manufacturing-ca.crt\n' "$MANUFACTURING_DIR" ;;
    station.key) printf '%s/station.key\n' "$MANUFACTURING_DIR" ;;
    station.crt) printf '%s/station.crt\n' "$MANUFACTURING_DIR" ;;
    station.chain.crt) printf '%s/station.chain.crt\n' "$MANUFACTURING_DIR" ;;
    manufacturing.crl) printf '%s/manufacturing.crl\n' "$MANUFACTURING_DIR" ;;
    *) die "알 수 없는 stable output: $1" ;;
  esac
}

validate_existing_identity() {
  local station_certificate="$MANUFACTURING_DIR/station.crt"
  local output
  output="$(stable_path station.crt)"
  if [[ ! -e "$output" && ! -L "$output" ]]; then
    local name
    for name in manufacturing-ca.key manufacturing-ca.crt station.key station.chain.crt manufacturing.crl; do
      [[ ! -e "$(stable_path "$name")" && ! -L "$(stable_path "$name")" ]] || die "기존 Manufacturing 산출물이 불완전합니다. reset 후 다시 발급하세요."
    done
    return 10
  fi
  [[ -L "$CURRENT_POINTER" ]] || die "기존 Manufacturing current pointer가 안전하지 않습니다."
  local target
  target="$(readlink "$CURRENT_POINTER")"
  [[ "$target" =~ ^generations/station-[0-9a-f]{64}$ ]] || die "Manufacturing current pointer가 안전한 generation을 가리키지 않습니다."
  local generation="$MANUFACTURING_DIR/$target"
  local name
  for name in manufacturing-ca.key manufacturing-ca.crt station.key station.crt station.chain.crt manufacturing.crl; do
    local path expected
    path="$(stable_path "$name")"
    expected="current/$name"
    [[ -L "$path" && "$(readlink "$path")" == "$expected" ]] || die "Manufacturing stable pointer가 generation과 일치하지 않습니다."
  done
  verify_generation "$generation" "$STATION_NAME"
  printf '%s\n' "$generation"
  return 0
}

publish_stable_pointers() {
  local generation="$1"
  local relative_generation="${generation#"$MANUFACTURING_DIR/"}"
  local current_temporary="$CURRENT_POINTER.new-$$-$RANDOM"
  ln -s "$relative_generation" "$current_temporary"
  # macOS mv follows a destination symlink to a directory; Node rename replaces the symlink itself atomically.
  node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$current_temporary" "$CURRENT_POINTER"
  local name path temporary
  for name in manufacturing-ca.key manufacturing-ca.crt station.key station.crt station.chain.crt manufacturing.crl; do
    path="$(stable_path "$name")"
    if [[ -e "$path" || -L "$path" ]]; then
      [[ -L "$path" && "$(readlink "$path")" == "current/$name" ]] || die "Manufacturing stable output이 current pointer 형식이 아닙니다."
      continue
    fi
    temporary="$path.new-$$-$RANDOM"
    ln -s "current/$name" "$temporary"
    mv -f "$temporary" "$path"
  done
}

create_identity() {
  local source_generation="${1:-}"
  local temporary="$MANUFACTURING_DIR/.generation-tmp-$$-$RANDOM"
  mkdir "$temporary"
  chmod 0700 "$temporary"
  mkdir "$temporary/newcerts"
  if [[ -n "$source_generation" ]]; then
    cp "$source_generation/manufacturing-ca.key" "$temporary/manufacturing-ca.key"
    cp "$source_generation/manufacturing-ca.crt" "$temporary/manufacturing-ca.crt"
    cp "$source_generation/index.txt" "$temporary/index.txt"
    cp "$source_generation/serial" "$temporary/serial"
    cp "$source_generation/crlnumber" "$temporary/crlnumber"
    cp -R "$source_generation/newcerts/." "$temporary/newcerts/"
  else
    : >"$temporary/index.txt"
    printf '1000\n' >"$temporary/serial"
    printf '1000\n' >"$temporary/crlnumber"
  fi
  local config="$temporary/openssl.cnf"
  write_config "$config" "$temporary"
  if { [[ -n "$source_generation" ]] || openssl ecparam -name prime256v1 -genkey -noout -out "$temporary/manufacturing-ca.key"; } &&
    { [[ -n "$source_generation" ]] || openssl req -x509 -new -sha256 -days 1825 -key "$temporary/manufacturing-ca.key" -config "$config" -extensions manufacturing_ca -out "$temporary/manufacturing-ca.crt"; } &&
    openssl ecparam -name prime256v1 -genkey -noout -out "$temporary/station.key" &&
    openssl req -new -key "$temporary/station.key" -subj "/CN=$STATION_NAME" -out "$temporary/station.csr" &&
    openssl ca -batch -config "$config" -extensions station -in "$temporary/station.csr" -out "$temporary/station.crt" >/dev/null 2>&1; then :; else
    rm -rf "$temporary"
    die "Manufacturing CA 또는 station identity 발급에 실패했습니다."
  fi
  cat "$temporary/station.crt" "$temporary/manufacturing-ca.crt" >"$temporary/station.chain.crt"
  regenerate_crl "$temporary"
  rm -f "$temporary/station.csr"
  chmod 0600 "$temporary/manufacturing-ca.key" "$temporary/station.key"
  chmod 0644 "$temporary/manufacturing-ca.crt" "$temporary/station.crt" "$temporary/station.chain.crt" "$temporary/openssl.cnf" "$temporary/index.txt" "$temporary/serial" "$temporary/crlnumber"
  local fingerprint generation
  fingerprint="$(key_public_key_digest "$temporary/station.key")"
  generation="$GENERATION_DIR/station-$fingerprint"
  [[ ! -e "$generation" ]] || { rm -rf "$temporary"; die "동일 station 공개키 generation이 이미 존재하지만 stable pointer가 없습니다. reset 후 다시 발급하세요."; }
  mv -f "$temporary" "$generation"
  write_config "$generation/openssl.cnf" "$generation"
  verify_generation "$generation" "$STATION_NAME"
  publish_stable_pointers "$generation"
}

main() {
  require_lab_environment
  ensure_layout
  acquire_lock
  trap release_lock EXIT
  local generation validation_status
  if generation="$(validate_existing_identity)"; then
    :
  else
    validation_status=$?
    [[ "$validation_status" == "10" ]] || exit "$validation_status"
    [[ "$COMMAND" == "issue" ]] || die "station identity가 없으므로 revoke할 수 없습니다."
    create_identity
    printf 'Lab Manufacturing CA와 station client identity를 발급했습니다.\n'
    return
  fi
  local ca="$generation/manufacturing-ca.crt" crl="$generation/manufacturing.crl" serial
  serial="$(openssl x509 -in "$generation/station.crt" -noout -serial | sed 's/^serial=//')"
  if awk -F '\t' -v serial="$serial" '$1 == "R" && toupper($4) == toupper(serial) { found = 1 } END { exit !found }' "$generation/index.txt"; then
    [[ "$COMMAND" == "issue" ]] || die "station certificate는 이미 폐기되어 revoke할 수 없습니다."
    create_identity "$generation"
    printf '폐기된 Lab Manufacturing station identity를 새 generation으로 교체했습니다.\n'
    return
  fi
  if ! crl_is_usable "$crl" "$ca"; then
    regenerate_crl "$generation"
  fi
  verify_crl "$crl" "$ca"
  if [[ "$COMMAND" == "revoke" ]]; then
    openssl ca -config "$generation/openssl.cnf" -revoke "$generation/station.crt" >/dev/null 2>&1 || die "station certificate 폐기에 실패했습니다. 이미 폐기된 certificate인지 확인하세요."
    regenerate_crl "$generation"
    verify_generation "$generation" "$STATION_NAME"
    printf 'Lab Manufacturing station certificate를 폐기하고 CRL을 갱신했습니다.\n'
  else
    printf '기존 Lab Manufacturing station identity를 검증하고 재사용합니다.\n'
  fi
}

main "$@"
