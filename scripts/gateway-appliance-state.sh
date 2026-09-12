#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 077

# Host contract: Bash, GNU coreutils/tar, util-linux flock, OpenSSL and Docker
# (Docker only for backup/restore). No archive, dotenv or journal is executable.
ROOT=/opt/led-control/gateway
TEST_ROOT=0 POLICY_SHA='' RECIPIENT='' KEY='' BACKUP='' SCRATCH='' OUTPUT_STAGE=''
DATA_DIR='' RESTORE_STAGE='' STATE_ACTIVE=0 RECOVERING=0 JOURNAL_ACTIVE=0
JOURNAL_SCRATCH=''
IMAGE_REPOSITORY='' IMAGE_TAG=''
COMPOSE_PROJECT=gateway EXPECTED_PROJECT='' OLD_CURRENT=none
METADATA_SECONDS=15 COMPOSE_SECONDS=120 KILL_SECONDS=5
COMMAND=${1:-}; [ "$#" -gt 0 ] && shift
usage() { echo 'usage: state.sh backup|verify|drill|restore DIRECTORY --recipient CERT [--key KEY] [--policy-sha256 SHA] [--test-root DIR]' >&2; exit 2; }
error() { echo "gateway state failed: $1" >&2; return 1; }
case "$COMMAND" in backup|verify|drill|restore) ;; *) usage ;; esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --recipient) [ "$#" -ge 2 ] && [ -z "$RECIPIENT" ] || usage; RECIPIENT=$2; shift 2 ;;
    --key) [ "$#" -ge 2 ] && [ -z "$KEY" ] || usage; KEY=$2; shift 2 ;;
    --policy-sha256) [ "$#" -ge 2 ] && [ -z "$POLICY_SHA" ] || usage; POLICY_SHA=$2; shift 2 ;;
    --test-root) [ "$#" -ge 2 ] && [ "$TEST_ROOT" = 0 ] || usage; ROOT=$2; TEST_ROOT=1; shift 2 ;;
    -*) usage ;;
    *) [ -z "$BACKUP" ] || usage; BACKUP=$1; shift ;;
  esac
done
[ -n "$BACKUP" ] && [ -n "$RECIPIENT" ] || usage
if [ "$COMMAND" = backup ]; then [ -z "$KEY" ] || usage; else [ -n "$KEY" ] || usage; fi
case "$COMMAND" in
  backup|restore) [[ "$POLICY_SHA" =~ ^[a-f0-9]{64}$ ]] || usage ;;
  *) [ -z "$POLICY_SHA" ] && [ "$TEST_ROOT" = 0 ] || usage ;;
esac
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gateway-appliance-common.sh"

file_size() { stat -c '%s' -- "$1" 2>/dev/null || stat -f '%z' "$1"; }
owner_ids() { stat -c '%u|%g' -- "$1" 2>/dev/null || stat -f '%u|%g' "$1"; }
relative_name() {
  local part rest=$1
  [[ "$rest" =~ ^[A-Za-z0-9_+./-]+$ ]] && [ "${#rest}" -le 100 ] || return 1
  while :; do
    part=${rest%%/*}; [ -n "$part" ] && [ "$part" != . ] && [ "$part" != .. ] || return 1
    [ "$rest" != "$part" ] || break; rest=${rest#*/}
  done
}
state_name() {
  relative_name "$1" || return 1
  # USTAR adds '/' to directory names. No prefix field is supported by this
  # profile, so producer and parser reserve that byte for every directory.
  [ "${2:-}" != d ] || [ "${#1}" -le 99 ] || return 1
  case "$1" in gateway|gateway/*|mesh|mesh/*|identity|identity/*|factory-trust|factory-trust/*) ;; *) return 1 ;; esac
}
state_paths() {
  local base=$1 root entry relative kind
  for root in factory-trust gateway identity mesh; do
    safe_directory "$base/$root" || return 1
    while IFS= read -r -d '' entry; do
      relative=${entry#"$base/"}; kind=f
      if [ -d "$entry" ] && [ ! -L "$entry" ]; then kind=d; fi
      state_name "$relative" "$kind" || return 1
    done < <(find "$base/$root" -print0)
  done
}
owned_directory_path() {
  local directory=$1 parent=$2 prefix=$3 name nonce
  # Prefix matching alone accepts parent/nested/.prefix.NONCE. Only a direct
  # physical child of the caller's validated parent is one of our mktemp paths.
  [ "${directory%/*}" = "$parent" ] && safe_path "$directory" && [ -d "$parent" ] || return 1
  [ "$(cd "$parent" && pwd -P)" = "$parent" ] || return 1
  name=${directory##*/}; [[ "$name" = "$prefix"* ]] || return 1
  nonce=${name#"$prefix"}; [[ "$nonce" =~ ^[A-Za-z0-9]{6}$ ]]
}
trusted_temp_base() {
  local physical mode ids
  # TMPDIR is deliberately not consulted: verify/drill cannot resolve arbitrary
  # live roots yet must never create plaintext inside one selected by the caller.
  physical=$(cd /tmp && pwd -P) || return 1
  [ "$TEMP_BASE" = "$physical" ] && safe_path "$physical" && [ -d "$physical" ] || return 1
  ids=$(owner_ids "$physical") && [ "${ids%%|*}" = 0 ] || return 1
  # BSD %Lp omits sticky/set-id bits; use the full mode for this host check.
  mode=$(stat -c '%a' -- "$physical" 2>/dev/null || stat -f '%p' "$physical") || return 1
  (( (8#$mode & 07777) == 01777 ))
}
temp_isolated() {
  local boundary
  trusted_temp_base || return 1
  # A site/artifact may be below the system temp base (test fixtures often are),
  # but may not contain the base itself. mktemp's fresh direct child is then a
  # sibling of those existing paths, never inside them.
  for boundary in "$ROOT" "${DATA_DIR:-/opt/led-control/data}" "$BACKUP"; do
    case "$TEMP_BASE/" in "$boundary/"*) return 1 ;; esac
  done
}
remove_owned_directory() {
  # Only our validated mktemp directories are eligible. rm never follows links;
  # never turn a journal-controlled arbitrary path into a recursive deletion.
  local directory=$1 prefix=$2
  case "${prefix##*/}" in
    .gateway-state.) [ "${prefix%/*}" = "$TEMP_BASE" ] && temp_isolated || return 1 ;;
    .state-restore.) [ "${prefix%/*}" = "$DATA_DIR" ] && safe_directory "$DATA_DIR" || return 1 ;;
    .state-output.) [ "${prefix%/*}" = "${BACKUP%/*}" ] && safe_directory "${BACKUP%/*}" || return 1 ;;
    *) return 1 ;;
  esac
  owned_directory_path "$directory" "${prefix%/*}" "${prefix##*/}" && safe_directory "$directory" && [ "$(file_mode "$directory")" = 700 ] || return 1
  find "$directory" -type d -exec chmod u+rwx {} + || return 1
  owned_directory_path "$directory" "${prefix%/*}" "${prefix##*/}" && safe_directory "$directory" && [ "$(file_mode "$directory")" = 700 ] || return 1
  rm -rf -- "$directory"
}
state_identity() {
  local base=$1 entry relative kind target generation file
  for kind in gateway mesh identity factory-trust; do safe_directory "$base/$kind" || return 1; done
  while IFS= read -r -d '' entry; do
    relative=${entry#"$base/"}
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then [ "$(file_mode "$entry")" = 750 ] || return 1; fi
    case "$relative" in *.key) regular "$entry" && [ -s "$entry" ] && [ "$(file_mode "$entry")" = 600 ] || return 1 ;; esac
  done < <(find "$base/identity" -print0)
  for kind in device mqtt; do
    safe_directory "$base/identity/$kind/generations" && [ -L "$base/identity/$kind/current" ] || return 1
    target=$(readlink "$base/identity/$kind/current") || return 1
    [[ "$target" =~ ^generations/[A-Za-z0-9_-]+$ ]] || return 1
    generation=$base/identity/$kind/$target; safe_directory "$generation" || return 1
    if [ "$kind" = device ]; then
      for file in device.crt device.key api-ca.crt mqtt-ca.crt; do regular "$generation/$file" && [ -s "$generation/$file" ] || return 1; done
    else
      for file in gateway.crt gateway.key mqtt-ca.crt; do regular "$generation/$file" && [ -s "$generation/$file" ] || return 1; done
    fi
  done
  regular "$base/factory-trust/api-ca.crt" && [ -s "$base/factory-trust/api-ca.crt" ]
}
render_manifest() {
  local base=$1 output=$2 list=$3 entry relative mode type size digest target ids previous=''
  state_paths "$base" || return 1
  : > "$list" || return 1
  for relative in factory-trust gateway identity mesh; do
    safe_directory "$base/$relative" || return 1
    while IFS= read -r -d '' entry; do
      relative=${entry#"$base/"}; state_name "$relative" || return 1
      printf '%s\n' "$relative" >> "$list" || return 1
    done < <(find "$base/$relative" -print0)
  done
  sort -o "$list" "$list" || return 1
  printf 'led-control-gateway-state/v1|%s|%s\n' "$SOURCE_RELEASE" "$CREATED_AT" > "$output" || return 1
  while IFS= read -r relative; do
    [[ "$previous" < "$relative" ]] || return 1; previous=$relative; entry=$base/$relative
    mode=$(file_mode "$entry") && ids=$(owner_ids "$entry") || return 1
    target=-; size=0; digest=-
    if [ -L "$entry" ]; then
      type=l; target=$(readlink "$entry") || return 1; relative_name "$target" || return 1
      # Only generation selectors are links. State/outbox files cannot alias
      # another file, and selectors cannot cross device/MQTT identities.
      case "$relative" in identity/device/current|identity/mqtt/current) ;; *) return 1 ;; esac
      [[ "$target" =~ ^generations/[A-Za-z0-9_-]+$ ]] && safe_directory "${entry%/*}/$target" || return 1
    else
      (( (8#$mode & 07022) == 0 )) || return 1
      if [ -d "$entry" ]; then type=d; (( (8#$mode & 0700) == 0700 )) || return 1
      elif regular "$entry"; then type=f; size=$(file_size "$entry") && digest=$(hash_file "$entry") || return 1
      else return 1; fi
    fi
    printf '%s|%s|%04o|%s|%s|%s|%s\n' "$relative" "$type" "$((8#$mode))" "$ids" "$size" "$digest" "$target" >> "$output" || return 1
  done < "$list"
  state_identity "$base"
}

certificate_fingerprint() {
  regular "$RECIPIENT" && [ -s "$RECIPIENT" ] || return 1
  openssl x509 -in "$RECIPIENT" -pubkey -noout 2>/dev/null | openssl rsa -pubin -noout >/dev/null 2>&1 || return 1
  openssl x509 -in "$RECIPIENT" -outform DER 2>/dev/null | sha256sum | cut -d ' ' -f 1
}
outer_verify() {
  local directory=$1 entry name line key value previous='' count=0 checksum
  safe_directory "$directory" || return 1
  while IFS= read -r -d '' entry; do
    name=${entry#"$directory/"}; case "$name" in backup.env|checksums.sha256|state.cms) ;; *) return 1 ;; esac
    regular "$entry" && [ -s "$entry" ] || return 1; count=$((count+1))
  done < <(find "$directory" -mindepth 1 -print0)
  [ "$count" = 3 ] && terminated_text "$directory/backup.env" && terminated_text "$directory/checksums.sha256" || return 1
  count=0
  while IFS= read -r line; do
    [[ "$line" =~ ^([A-Z_0-9]+)=([A-Za-z0-9_./:+-]+)$ ]] || return 1
    key=${BASH_REMATCH[1]}; value=${BASH_REMATCH[2]}; [[ "$previous" < "$key" ]] || return 1; previous=$key; count=$((count+1))
    case "$key" in
      CIPHERTEXT) [ "$value" = state.cms ] || return 1 ;;
      CIPHERTEXT_SHA256) CIPHER_SHA=$value ;;
      CIPHERTEXT_SIZE) CIPHER_SIZE=$value ;;
      CREATED_AT) CREATED_AT=$value ;;
      ENCRYPTION) [ "$value" = openssl-cms-aes-256-cbc-rsa/v1 ] || return 1 ;;
      RECIPIENT_SHA256) [ "$value" = "$RECIPIENT_SHA" ] || return 1 ;;
      RELEASE_ID) SOURCE_RELEASE=$value ;;
      SCHEMA) [ "$value" = led-control-gateway-backup/v1 ] || return 1 ;;
      *) return 1 ;;
    esac
  done < "$directory/backup.env"
  [ "$count" = 8 ] && valid_release_id "$SOURCE_RELEASE" && [[ "$CREATED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || return 1
  [[ "$CIPHER_SHA" =~ ^[a-f0-9]{64}$ && "$CIPHER_SIZE" =~ ^[1-9][0-9]*$ ]] || return 1
  [ "$(file_size "$directory/state.cms")" = "$CIPHER_SIZE" ] && [ "$(hash_file "$directory/state.cms")" = "$CIPHER_SHA" ] || return 1
  checksum=$(printf '%s  backup.env\n%s  state.cms\n' "$(hash_file "$directory/backup.env")" "$CIPHER_SHA")
  [ "$(cat "$directory/checksums.sha256")" = "$checksum" ] && [ "$(wc -l < "$directory/checksums.sha256" | tr -d ' ')" = 2 ]
}
write_outer() {
  local directory=$1
  CIPHER_SHA=$(hash_file "$directory/state.cms"); CIPHER_SIZE=$(file_size "$directory/state.cms")
  printf 'CIPHERTEXT=state.cms\nCIPHERTEXT_SHA256=%s\nCIPHERTEXT_SIZE=%s\nCREATED_AT=%s\nENCRYPTION=openssl-cms-aes-256-cbc-rsa/v1\nRECIPIENT_SHA256=%s\nRELEASE_ID=%s\nSCHEMA=led-control-gateway-backup/v1\n' "$CIPHER_SHA" "$CIPHER_SIZE" "$CREATED_AT" "$RECIPIENT_SHA" "$SOURCE_RELEASE" > "$directory/backup.env" || return 1
  printf '%s  backup.env\n%s  state.cms\n' "$(hash_file "$directory/backup.env")" "$CIPHER_SHA" > "$directory/checksums.sha256"
}

# Strict USTAR decoding is done before each filesystem operation. GNU tar is
# used only to produce archives, never to interpret untrusted paths/types. The
# hex header avoids Bash's NUL truncation and verbose-tar parsing ambiguities.
header_text() {
  local start=$1 length=$2 index byte ended=0 char
  FIELD=''
  for ((index=start; index<start+length; index++)); do
    byte=${HEADER:index*2:2}
    if [ "$byte" = 00 ]; then ended=1; continue; fi
    [ "$ended" = 0 ] && (( 16#$byte >= 32 && 16#$byte <= 126 )) || return 1
    printf -v char '%b' "\\x$byte"; FIELD=$FIELD$char
  done
}
header_octal() {
  local start=$1 length=$2 index byte value='' ended=0
  for ((index=start; index<start+length; index++)); do
    byte=${HEADER:index*2:2}
    case "$byte" in
      00|20) [ -z "$value" ] || ended=1 ;;
      3[0-7]) [ "$ended" = 0 ] || return 1; value=$value${byte#3} ;;
      *) return 1 ;;
    esac
  done
  [ -n "$value" ] && [ "${#value}" -le 11 ] || return 1
  NUMBER=$((8#$value))
}
read_header() {
  HEADER=$(dd bs=512 count=1 iflag=fullblock status=none | od -An -v -tx1 | tr -d ' \n') || return 1
  [ "${#HEADER}" = 1024 ]
}
extract_stream() {
  local destination=$1 index checksum expected name mode uid gid size kind target previous='' first=1 entry padding zero
  zero=$(printf '%01024d' 0)
  while :; do
    read_header || return 1
    if [ "$HEADER" = "$zero" ]; then
      [ "$first" = 0 ] && read_header && [ "$HEADER" = "$zero" ] || return 1
      [ -z "$(od -An -v -tx1 | tr -d '0 \n')" ] || return 1
      break
    fi
    checksum=0
    for ((index=0;index<512;index++)); do
      if ((index>=148 && index<156)); then checksum=$((checksum+32)); else checksum=$((checksum+16#${HEADER:index*2:2})); fi
    done
    header_octal 148 8 && [ "$NUMBER" = "$checksum" ] || return 1
    [ "${HEADER:514:16}" = 7573746172003030 ] || return 1
    header_text 345 155 && [ -z "$FIELD" ] || return 1
    header_text 0 100 || return 1; name=${FIELD%/}; relative_name "$name" || return 1
    header_octal 100 8 || return 1; mode=$NUMBER; ((mode<=0777)) || return 1
    header_octal 108 8 || return 1; uid=$NUMBER
    header_octal 116 8 || return 1; gid=$NUMBER
    header_octal 124 12 || return 1; size=$NUMBER
    kind=${HEADER:312:2}; header_text 157 100 || return 1; target=$FIELD
    if [ "$first" = 1 ]; then
      [ "$name" = manifest.state ] && [ "$kind" = 30 ] && [ "$mode" = 384 ] && ((size>0 && size<=16777216)) || return 1
      first=0
    else
      if [ "$kind" = 35 ]; then state_name "$name" d || return 1; else state_name "$name" || return 1; fi
      [[ "$previous" < "$name" ]] || return 1; previous=$name
    fi
    entry=$destination/$name
    safe_path "${entry%/*}" && [ -d "${entry%/*}" ] && [ ! -e "$entry" ] && [ ! -L "$entry" ] || return 1
    case "$kind" in
      30|00)
        [ -z "$target" ] && (( (mode & 0022) == 0 )) || return 1
        dd bs=65536 count="$size" iflag=count_bytes,fullblock status=none of="$entry" || return 1
        [ "$(file_size "$entry")" = "$size" ] || return 1
        padding=$(((512-size%512)%512))
        if [ "$padding" != 0 ]; then
          expected=$(dd bs=1 count="$padding" iflag=fullblock status=none | od -An -v -tx1 | tr -d ' \n') || return 1
          [ "${#expected}" = "$((padding*2))" ] && [ -z "${expected//00/}" ] || return 1
        fi ;;
      35) [ "$size" = 0 ] && [ -z "$target" ] && (( (mode & 0022) == 0 && (mode & 0700) == 0700 )) && mkdir -m 700 "$entry" || return 1 ;;
      32)
        [ "$size" = 0 ] && [ "$mode" = 511 ] && relative_name "$target" || return 1
        case "$name" in identity/device/current|identity/mqtt/current) ;; *) return 1 ;; esac
        [[ "$target" =~ ^generations/[A-Za-z0-9_-]+$ ]] && ln -s "$target" "$entry" || return 1 ;;
      *) return 1 ;;
    esac
    if [ "$(owner_ids "$entry")" != "$uid|$gid" ]; then chown -h "$uid:$gid" "$entry" || return 1; fi
    [ "$kind" = 32 ] || chmod "$(printf '%o' "$mode")" "$entry" || return 1
  done
  render_manifest "$destination" "$destination/actual.manifest" "$destination/actual.list" && cmp -s "$destination/manifest.state" "$destination/actual.manifest"
}
decrypt_to() {
  mkdir -m 700 "$1" || return 1
  # Deliberately suppress OpenSSL/parser diagnostics: neither may disclose a
  # private archive pathname or payload when rejecting untrusted input.
  (openssl cms -decrypt -binary -inform DER -in "$SCRATCH/artifact/state.cms" -recip "$RECIPIENT" -inkey "$KEY" 2>/dev/null | extract_stream "$1") 2>/dev/null
}
validate_artifact() {
  regular "$KEY" && [ -s "$KEY" ] && outer_verify "$BACKUP" || return 1
  mkdir -m 700 "$SCRATCH/artifact" || return 1
  cp -- "$BACKUP/backup.env" "$BACKUP/checksums.sha256" "$BACKUP/state.cms" "$SCRATCH/artifact/" && outer_verify "$SCRATCH/artifact" || return 1
  decrypt_to "$SCRATCH/first" || return 1
  if [ "$COMMAND" = drill ] || [ "$COMMAND" = restore ]; then
    decrypt_to "$SCRATCH/second" && cmp -s "$SCRATCH/first/actual.manifest" "$SCRATCH/second/actual.manifest" || return 1
  fi
}

state_runtime() {
  local images loaded
  pointer_id current && [ "$POINTER" != none ] || return 1; OLD_CURRENT=$POINTER
  verify_bundle "$ROOT/releases/$OLD_CURRENT" && resolve_site "$ROOT/.env.appliance" && temp_isolated && ownership_preflight || return 1
  sed "s|seccomp=./docker/seccomp-bluez-mesh.json|seccomp=$ROOT/releases/$OLD_CURRENT/docker/seccomp-bluez-mesh.json|g" "$ROOT/releases/$OLD_CURRENT/compose.yml" > "$SCRATCH/compose.yml" || return 1
  COMPOSE_FILE=$SCRATCH/compose.yml
  docker_cmd "$METADATA_SECONDS" version >/dev/null 2>&1 && docker_cmd "$METADATA_SECONDS" compose version >/dev/null 2>&1 && compose config --quiet || return 1
  images=$(compose_output config --images 2>/dev/null) && [ "$images" = "$IMAGE_REPOSITORY:$IMAGE_TAG" ] || return 1
  loaded=$(docker_cmd "$METADATA_SECONDS" image inspect --format '{{.Id}}' "$IMAGE_REPOSITORY:$IMAGE_TAG" 2>/dev/null) && [ "$loaded" = "$IMAGE_DIGEST" ]
}
write_state_journal() {
  local temporary
  temporary=$(mktemp "$ROOT/.state-write.XXXXXX") || return 1
  JOURNAL_SCRATCH=${JOURNAL_SCRATCH:-$SCRATCH}
  printf 'COMPOSE_PROJECT=%s\nDATA_DIR=%s\nENV_SHA256=%s\nOPERATION=%s\nPHASE=%s\nRELEASE_ID=%s\nSCHEMA=gateway-state-operation/v1\nSTAGE=%s\nWORKSPACE=%s\n' "$COMPOSE_PROJECT" "$DATA_DIR" "$ENV_SHA" "$OPERATION" "$1" "$OLD_CURRENT" "${RESTORE_STAGE:-none}" "$JOURNAL_SCRATCH" > "$temporary" || return 1
  chmod 600 "$temporary" && durable "$temporary" && mv -Tf -- "$temporary" "$ROOT/.state.journal" && durable "$ROOT"
}
read_state_journal() {
  local line key value previous='' count=0 journal_data journal_release journal_schema
  regular "$ROOT/.state.journal" && [ "$(file_mode "$ROOT/.state.journal")" = 600 ] && terminated_text "$ROOT/.state.journal" || return 1
  while IFS= read -r line; do
    [[ "$line" =~ ^([A-Z_0-9]+)=([A-Za-z0-9_./+-]+)$ ]] || return 1
    key=${BASH_REMATCH[1]}; value=${BASH_REMATCH[2]}; [[ "$previous" < "$key" ]] || return 1; previous=$key; count=$((count+1))
    case "$key" in
      COMPOSE_PROJECT) EXPECTED_PROJECT=$value ;; DATA_DIR) journal_data=$value ;; ENV_SHA256) ENV_SHA=$value ;;
      OPERATION) OPERATION=$value ;; PHASE) PHASE=$value ;; RELEASE_ID) journal_release=$value ;;
      SCHEMA) journal_schema=$value ;; STAGE) RESTORE_STAGE=$value ;; WORKSPACE) JOURNAL_SCRATCH=$value ;; *) return 1 ;;
    esac
  done < "$ROOT/.state.journal"
  [ "$count" = 9 ] && [ "$journal_schema" = gateway-state-operation/v1 ] && valid_release_id "$journal_release" || return 1
  [[ "$ENV_SHA" =~ ^[a-f0-9]{64}$ ]] && regular "$ROOT/.env.appliance" && [ "$(hash_file "$ROOT/.env.appliance")" = "$ENV_SHA" ] || return 1
  case "$EXPECTED_PROJECT" in gateway|led-control-gateway) ;; *) return 1 ;; esac
  temp_isolated && owned_directory_path "$JOURNAL_SCRATCH" "$TEMP_BASE" .gateway-state. || return 1
  if [ -e "$JOURNAL_SCRATCH" ]; then safe_directory "$JOURNAL_SCRATCH" && [ "$(file_mode "$JOURNAL_SCRATCH")" = 700 ] || return 1; fi
  pointer_id current && [ "$POINTER" = "$journal_release" ] && verify_bundle "$ROOT/releases/$POINTER" && resolve_site "$ROOT/.env.appliance" && [ "$DATA_DIR" = "$journal_data" ] && temp_isolated || return 1
  case "$OPERATION:$PHASE" in backup:prepared|backup:committed) [ "$RESTORE_STAGE" = none ] || return 1 ;;
    restore:prepared|restore:stopped|restore:old_gateway|restore:new_gateway|restore:old_mesh|restore:new_mesh|restore:old_identity|restore:new_identity|restore:old_factory-trust|restore:new_factory-trust|restore:rolled_back|restore:committed)
      owned_directory_path "$RESTORE_STAGE" "$DATA_DIR" .state-restore. && safe_directory "$RESTORE_STAGE" && [ "$(file_mode "$RESTORE_STAGE")" = 700 ] || return 1
      safe_directory "$RESTORE_STAGE/new" && safe_directory "$RESTORE_STAGE/old" && safe_directory "$RESTORE_STAGE/discard" || return 1 ;;
    *) return 1 ;;
  esac
}
clear_state_journal() {
  rm -- "$ROOT/.state.journal" && durable "$ROOT" || return 1; STATE_ACTIVE=0
}
cleanup_restore() {
  if [ "$RESTORE_STAGE" != none ] && [ -n "$RESTORE_STAGE" ]; then
    remove_owned_directory "$RESTORE_STAGE" "$DATA_DIR/.state-restore." && durable "$DATA_DIR" || return 1
  fi
  RESTORE_STAGE=''
}
recover_state() {
  local root live old new discard
  read_state_journal && state_runtime || return 1
  if [ "$OPERATION" = restore ] && [ "$PHASE" != committed ] && [ "$PHASE" != rolled_back ]; then
    # Presence is checked as well as durable phase: a crash may occur between a
    # rename and its following journal write, or partway through this rollback.
    # prepared is durable before stop, and no rename can happen until stopped
    # is durable. A failed stop must not prevent restarting the untouched roots.
    if [ "$PHASE" != prepared ]; then compose stop gateway-appliance || return 1; fi
    for root in gateway mesh identity factory-trust; do
      live=$DATA_DIR/$root; old=$RESTORE_STAGE/old/$root; new=$RESTORE_STAGE/new/$root; discard=$RESTORE_STAGE/discard/$root
      if [ -e "$old" ] || [ -L "$old" ]; then
        safe_directory "$old" || return 1
        if [ -e "$live" ] || [ -L "$live" ]; then
          safe_directory "$live" && [ ! -e "$discard" ] && [ ! -L "$discard" ] && mv -T -- "$live" "$discard" && durable "$DATA_DIR" || return 1
        fi
        mv -T -- "$old" "$live" && durable "$DATA_DIR" || return 1
      else
        safe_directory "$live" || return 1
        # Untouched roots still have new/<root>; already-rolled-back roots have
        # discard/<root>. Anything else is an ambiguous/incomplete transaction.
        safe_directory "$new" || safe_directory "$discard" || return 1
      fi
    done
    write_state_journal rolled_back || return 1
  fi
  state_identity "$DATA_DIR" && compose up -d --remove-orphans && healthy || return 1
  # Journal deletion is last. A committed/rolled-back journal tolerates partial
  # deletion of rollback copies, so a power loss during cleanup is recoverable.
  if [ "$OPERATION" = restore ]; then
    for root in old new discard; do
      owned_directory_path "$RESTORE_STAGE" "$DATA_DIR" .state-restore. && safe_directory "$RESTORE_STAGE" && [ "$(file_mode "$RESTORE_STAGE")" = 700 ] && safe_directory "$RESTORE_STAGE/$root" || return 1
      find "$RESTORE_STAGE/$root" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + || return 1
    done
    durable "$RESTORE_STAGE" || return 1
  fi
  # SIGKILL/power loss cannot run a trap. A validated transaction remembers its
  # original private extraction workspace so the next recovery can clean it.
  if [ "$JOURNAL_SCRATCH" != "$SCRATCH" ] && [ -d "$JOURNAL_SCRATCH" ]; then
    remove_owned_directory "$JOURNAL_SCRATCH" "$TEMP_BASE/.gateway-state." && durable "$TEMP_BASE" || return 1
  fi
  clear_state_journal && cleanup_restore
}
state_finish() {
  local status=$1; trap - EXIT INT TERM
  if [ "$status" != 0 ] && [ "$STATE_ACTIVE" = 1 ] && [ "$RECOVERING" = 0 ]; then
    RECOVERING=1
    if recover_state; then echo 'gateway state operation failed; original state recovered' >&2
    else echo 'gateway state recovery failed; durable journal retained' >&2; status=3; fi
  fi
  if [ -n "$OUTPUT_STAGE" ]; then remove_owned_directory "$OUTPUT_STAGE" "${BACKUP%/*}/.state-output." || status=3; fi
  if [ "$STATE_ACTIVE" = 0 ] && [ -n "$RESTORE_STAGE" ]; then cleanup_restore || status=3; fi
  if [ -n "$SCRATCH" ]; then remove_owned_directory "$SCRATCH" "$TEMP_BASE/.gateway-state." || status=3; fi
  exit "$status"
}
trap 'state_finish $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TEMP_BASE=$(cd /tmp && pwd -P) || error 'system temporary parent unavailable'
safe_path "$BACKUP" || error 'unsafe backup path'
case "$COMMAND" in
  backup|restore)
    safe_directory "$ROOT" || error 'unsafe appliance root'
    if [ "$TEST_ROOT" = 1 ]; then
      regular "$ROOT/.gateway-release-disposable-root" && [ "$(cat "$ROOT/.gateway-release-disposable-root")" = gateway-release-test/v1 ] || error 'disposable root sentinel required'
    fi
    resolve_site "$ROOT/.env.appliance" || error 'site data path rejected before staging' ;;
esac
temp_isolated || error 'system temporary parent is unsafe or overlaps the site/artifact'
SCRATCH=$(mktemp -d "$TEMP_BASE/.gateway-state.XXXXXX") || error 'temporary staging unavailable'
RECIPIENT_SHA=$(certificate_fingerprint) || error 'recipient certificate rejected'
if [ "$COMMAND" = verify ] || [ "$COMMAND" = drill ]; then
  validate_artifact || error 'encrypted state verification rejected'
  echo "state $COMMAND verified"; exit 0
fi
if [ "$TEST_ROOT" = 1 ]; then
  METADATA_SECONDS=1; COMPOSE_SECONDS=1; KILL_SECONDS=1
fi
for executable in flock sync docker sha256sum timeout tar openssl dd; do command -v "$executable" >/dev/null || error 'host dependency missing'; done
# Normal restore input validation precedes every Docker/live-data boundary.
# An existing journal takes priority: recovery is the only permitted mutation.
if [ "$COMMAND" = restore ] && [ ! -e "$ROOT/.state.journal" ] && [ ! -L "$ROOT/.state.journal" ]; then validate_artifact || error 'encrypted state verification rejected'; fi
operation_lock || exit "$?"
if [ -e "$ROOT/.activation.journal" ] || [ -L "$ROOT/.activation.journal" ]; then error 'release recovery required before state operation'; fi
if [ -e "$ROOT/.state.journal" ] || [ -L "$ROOT/.state.journal" ]; then
  STATE_ACTIVE=1; RECOVERING=1
  if ! recover_state; then echo 'interrupted state recovery failed; durable journal retained' >&2; exit 3; fi
  RECOVERING=0; EXPECTED_PROJECT=''; JOURNAL_SCRATCH=''
fi
if [ "$COMMAND" = restore ] && [ ! -d "$SCRATCH/first" ]; then validate_artifact || error 'encrypted state verification rejected'; fi
if [ "$COMMAND" = backup ]; then
  safe_path "$BACKUP" && safe_directory "${BACKUP%/*}" && [ ! -e "$BACKUP" ] && [ ! -L "$BACKUP" ] || error 'backup output must be a new safe directory'
else
  outer_verify "$BACKUP" && cmp -s "$BACKUP/checksums.sha256" "$SCRATCH/artifact/checksums.sha256" || error 'backup changed before restore'
fi
state_runtime && state_identity "$DATA_DIR" && healthy || error 'current release/state preflight rejected'
ENV_SHA=$(hash_file "$ROOT/.env.appliance"); OPERATION=$COMMAND
if [ "$COMMAND" = backup ]; then
  case "$BACKUP/" in "$DATA_DIR/"*|"$ROOT/"*) error 'backup output cannot be inside the appliance' ;; esac
  SOURCE_RELEASE=$OLD_CURRENT; CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  state_paths "$DATA_DIR" || error 'state archive paths rejected before quiesce'
  STATE_ACTIVE=1; write_state_journal prepared
  compose stop gateway-appliance || error 'gateway quiesce failed'
  render_manifest "$DATA_DIR" "$SCRATCH/manifest.state" "$SCRATCH/list" || error 'state snapshot rejected'
  OUTPUT_STAGE=$(mktemp -d "${BACKUP%/*}/.state-output.XXXXXX")
  # -T's trusted -C directive gives both GNU tar and the macOS behavior harness
  # one ordered input list. State names cannot start with an option or contain LF.
  { printf 'manifest.state\n-C\n%s\n' "$DATA_DIR"; cat "$SCRATCH/list"; } > "$SCRATCH/archive.list"
  (tar --format=ustar --no-recursion -cf - -C "$SCRATCH" -T "$SCRATCH/archive.list" | openssl cms -encrypt -binary -aes-256-cbc -outform DER -stream -out "$OUTPUT_STAGE/state.cms" "$RECIPIENT") 2>/dev/null || error 'state encryption failed'
  write_outer "$OUTPUT_STAGE" && outer_verify "$OUTPUT_STAGE" || error 'encrypted output rejected'
  compose up -d --remove-orphans && healthy || error 'gateway restart failed'
  write_state_journal committed
  for name in backup.env checksums.sha256 state.cms; do chmod 440 "$OUTPUT_STAGE/$name"; durable "$OUTPUT_STAGE/$name"; done
  durable "$OUTPUT_STAGE"
  [ ! -e "$BACKUP" ] && [ ! -L "$BACKUP" ] || error 'backup output appeared during operation'
  mv -T -- "$OUTPUT_STAGE" "$BACKUP"; OUTPUT_STAGE=''; chmod 550 "$BACKUP"; durable "${BACKUP%/*}"
  clear_state_journal
else
  RESTORE_STAGE=$(mktemp -d "$DATA_DIR/.state-restore.XXXXXX")
  mkdir -m 700 "$RESTORE_STAGE/new" "$RESTORE_STAGE/old" "$RESTORE_STAGE/discard"
  for name in gateway mesh identity factory-trust; do cp -a -- "$SCRATCH/first/$name" "$RESTORE_STAGE/new/$name"; done
  render_manifest "$RESTORE_STAGE/new" "$SCRATCH/staged.manifest" "$SCRATCH/staged.list" && cmp -s "$SCRATCH/staged.manifest" "$SCRATCH/first/actual.manifest" || error 'same-filesystem stage changed'
  durable "$RESTORE_STAGE"
  STATE_ACTIVE=1; write_state_journal prepared
  compose stop gateway-appliance || error 'gateway quiesce failed'; write_state_journal stopped
  for name in gateway mesh identity factory-trust; do
    mv -T -- "$DATA_DIR/$name" "$RESTORE_STAGE/old/$name"; durable "$DATA_DIR"; write_state_journal "old_$name"
    mv -T -- "$RESTORE_STAGE/new/$name" "$DATA_DIR/$name"; durable "$DATA_DIR"; write_state_journal "new_$name"
  done
  compose up -d --remove-orphans && healthy || error 'restored state is not healthy'
  write_state_journal committed
  RECOVERING=1
  recover_state || { echo 'committed state cleanup failed; journal retained' >&2; exit 3; }
  RECOVERING=0
fi
echo "state $COMMAND completed"
