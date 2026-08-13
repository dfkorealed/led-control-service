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
  [[ "$STATION_NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "station 이름은 소문자 영문, 숫자, 하이픈만 사용할 수 있습니다."
  [[ "$LOCK_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die "LAB_MANUFACTURING_LOCK_TIMEOUT_SECONDS는 0 이상의 정수여야 합니다."
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
  cat >"$path" <<'EOF'
[ req ]
distinguished_name = subject
x509_extensions = manufacturing_ca
prompt = no

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

verify_generation() {
  local generation="$1" expected_station="$2"
  local ca_key="$generation/manufacturing-ca.key" ca="$generation/manufacturing-ca.crt"
  local station_key="$generation/station.key" station="$generation/station.crt" chain="$generation/station.chain.crt"
  [[ -d "$generation" && ! -L "$generation" ]] || die "manufacturing generation이 안전하지 않습니다."
  assert_regular_file "$ca_key" "Manufacturing CA private key"
  assert_regular_file "$ca" "Manufacturing CA certificate"
  assert_regular_file "$station_key" "station private key"
  assert_regular_file "$station" "station certificate"
  assert_regular_file "$chain" "station chain"
  [[ "$(file_mode "$ca_key")" == "600" && "$(file_mode "$station_key")" == "600" ]] || die "Manufacturing private key 권한은 0600이어야 합니다."
  [[ "$(file_mode "$ca")" == "644" && "$(file_mode "$station")" == "644" && "$(file_mode "$chain")" == "644" ]] || die "Manufacturing 공개 산출물 권한은 0644이어야 합니다."
  openssl verify -CAfile "$ca" "$ca" >/dev/null 2>&1 || die "Manufacturing CA 검증에 실패했습니다."
  openssl verify -CAfile "$ca" "$station" >/dev/null 2>&1 || die "station certificate chain 검증에 실패했습니다."
  [[ "$(key_public_key_digest "$ca_key")" == "$(certificate_public_key_digest "$ca")" ]] || die "Manufacturing CA private key와 certificate 공개키가 일치하지 않습니다."
  [[ "$(key_public_key_digest "$station_key")" == "$(certificate_public_key_digest "$station")" ]] || die "station private key와 certificate 공개키가 일치하지 않습니다."
  [[ "$(station_subject "$station")" == "CN=$expected_station" ]] || die "station identity mismatch: 기존 station 이름과 요청이 다릅니다."
  local ca_details station_details
  ca_details="$(openssl x509 -in "$ca" -noout -text)"
  station_details="$(openssl x509 -in "$station" -noout -text)"
  grep -Fq "CA:TRUE, pathlen:0" <<<"$ca_details" || die "Manufacturing CA basic constraints가 올바르지 않습니다."
  grep -Fq "Certificate Sign, CRL Sign" <<<"$ca_details" || die "Manufacturing CA key usage가 올바르지 않습니다."
  grep -Fq "TLS Web Client Authentication" <<<"$station_details" || die "station certificate에는 clientAuth가 필요합니다."
  ! grep -Fq "TLS Web Server Authentication" <<<"$station_details" || die "station certificate에 serverAuth는 허용되지 않습니다."
  cmp -s <(cat "$station" "$ca") "$chain" || die "station chain 파일이 올바르지 않습니다."
}

stable_path() {
  case "$1" in
    manufacturing-ca.key) printf '%s/manufacturing-ca.key\n' "$MANUFACTURING_DIR" ;;
    manufacturing-ca.crt) printf '%s/manufacturing-ca.crt\n' "$MANUFACTURING_DIR" ;;
    station.key) printf '%s/station.key\n' "$MANUFACTURING_DIR" ;;
    station.crt) printf '%s/station.crt\n' "$MANUFACTURING_DIR" ;;
    station.chain.crt) printf '%s/station.chain.crt\n' "$MANUFACTURING_DIR" ;;
    *) die "알 수 없는 stable output: $1" ;;
  esac
}

validate_existing_identity() {
  local station_certificate="$MANUFACTURING_DIR/station.crt"
  local output
  output="$(stable_path station.crt)"
  if [[ ! -e "$output" && ! -L "$output" ]]; then
    local name
    for name in manufacturing-ca.key manufacturing-ca.crt station.key station.chain.crt; do
      [[ ! -e "$(stable_path "$name")" && ! -L "$(stable_path "$name")" ]] || die "기존 Manufacturing 산출물이 불완전합니다. reset 후 다시 발급하세요."
    done
    return 1
  fi
  [[ -L "$station_certificate" ]] || die "기존 Manufacturing 산출물은 검증된 generation pointer 형식이어야 합니다."
  local target
  target="$(readlink "$station_certificate")"
  [[ "$target" =~ ^generations/station-[0-9a-f]{64}/station\.crt$ ]] || die "station stable pointer가 안전한 generation을 가리키지 않습니다."
  local generation="$MANUFACTURING_DIR/${target%/station.crt}"
  local name
  for name in manufacturing-ca.key manufacturing-ca.crt station.key station.crt station.chain.crt; do
    local path expected
    path="$(stable_path "$name")"
    expected="${target%/station.crt}/$name"
    [[ -L "$path" && "$(readlink "$path")" == "$expected" ]] || die "Manufacturing stable pointer가 generation과 일치하지 않습니다."
  done
  verify_generation "$generation" "$STATION_NAME"
  return 0
}

publish_stable_pointers() {
  local generation="$1" relative_generation="${generation#"$MANUFACTURING_DIR/"}"
  local name path temporary
  for name in manufacturing-ca.key manufacturing-ca.crt station.key station.crt station.chain.crt; do
    path="$(stable_path "$name")"
    [[ ! -e "$path" && ! -L "$path" ]] || die "Manufacturing stable output이 이미 존재합니다."
    temporary="$path.new-$$-$RANDOM"
    ln -s "$relative_generation/$name" "$temporary"
    mv -f "$temporary" "$path"
  done
}

create_identity() {
  local temporary="$MANUFACTURING_DIR/.generation-tmp-$$-$RANDOM"
  mkdir "$temporary"
  chmod 0700 "$temporary"
  local config="$temporary/openssl.cnf"
  write_config "$config"
  if ! openssl ecparam -name prime256v1 -genkey -noout -out "$temporary/manufacturing-ca.key" ||
    ! openssl req -x509 -new -sha256 -days 1825 -key "$temporary/manufacturing-ca.key" -config "$config" -extensions manufacturing_ca -out "$temporary/manufacturing-ca.crt" ||
    ! openssl ecparam -name prime256v1 -genkey -noout -out "$temporary/station.key" ||
    ! openssl req -new -key "$temporary/station.key" -subj "/CN=$STATION_NAME" -out "$temporary/station.csr" ||
    ! openssl x509 -req -in "$temporary/station.csr" -CA "$temporary/manufacturing-ca.crt" -CAkey "$temporary/manufacturing-ca.key" -CAcreateserial -out "$temporary/station.crt" -days 825 -sha256 -extfile "$config" -extensions station; then
    rm -rf "$temporary"
    die "Manufacturing CA 또는 station identity 발급에 실패했습니다."
  fi
  cat "$temporary/station.crt" "$temporary/manufacturing-ca.crt" >"$temporary/station.chain.crt"
  rm -f "$temporary/station.csr" "$temporary/manufacturing-ca.srl" "$config"
  chmod 0600 "$temporary/manufacturing-ca.key" "$temporary/station.key"
  chmod 0644 "$temporary/manufacturing-ca.crt" "$temporary/station.crt" "$temporary/station.chain.crt"
  local fingerprint generation
  fingerprint="$(key_public_key_digest "$temporary/station.key")"
  generation="$GENERATION_DIR/station-$fingerprint"
  [[ ! -e "$generation" ]] || { rm -rf "$temporary"; die "동일 station 공개키 generation이 이미 존재하지만 stable pointer가 없습니다. reset 후 다시 발급하세요."; }
  mv -f "$temporary" "$generation"
  verify_generation "$generation" "$STATION_NAME"
  publish_stable_pointers "$generation"
}

main() {
  require_lab_environment
  ensure_layout
  acquire_lock
  trap release_lock EXIT
  if validate_existing_identity; then
    printf '기존 Lab Manufacturing station identity를 검증하고 재사용합니다.\n'
  else
    create_identity
    printf 'Lab Manufacturing CA와 station client identity를 발급했습니다.\n'
  fi
}

main "$@"
