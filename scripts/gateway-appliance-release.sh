#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 077

# Pi dependencies: Bash/coreutils (sync -f, mv -T), util-linux flock and Docker.
# This verifies checksum closure + exact env wire, not Node's JSON/SPDX/layers.
# Never source/eval bundle, site or journal contents.
ROOT=/opt/led-control/gateway
TEST_ROOT=0 POLICY_SHA="" BUNDLE="" STAGE="" JOURNAL_ACTIVE=0 RECOVERING=0
COMPOSE_PROJECT=gateway EXPECTED_PROJECT="" DATA_DIR=""
METADATA_SECONDS=15 COMPOSE_SECONDS=120 LOAD_SECONDS=300 KILL_SECONDS=5
COMMAND=${1:-}; [ "$#" -gt 0 ] && shift
usage() { echo 'usage: release.sh verify|activate BUNDLE --policy-sha256 SHA [--test-root DIR]; rollback --policy-sha256 SHA [--test-root DIR]' >&2; exit 2; }
error() { echo "gateway release failed: $1" >&2; return 1; }
case "$COMMAND" in verify|activate|rollback) ;; *) usage ;; esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    --policy-sha256) [ "$#" -ge 2 ] && [ -z "$POLICY_SHA" ] || usage; POLICY_SHA=$2; shift 2 ;;
    --test-root) [ "$#" -ge 2 ] && [ "$TEST_ROOT" = 0 ] || usage; ROOT=$2; TEST_ROOT=1; shift 2 ;;
    -*) usage ;;
    *) [ -z "$BUNDLE" ] && [ "$COMMAND" != rollback ] || usage; BUNDLE=$1; shift ;;
  esac
done
[[ "$POLICY_SHA" =~ ^[a-f0-9]{64}$ ]] || usage
[ "$COMMAND" = rollback ] || [ -n "$BUNDLE" ] || usage
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gateway-appliance-common.sh"
write_journal() {
  local temporary; temporary=$(mktemp "$ROOT/.journal-write.XXXXXX") || return 1
  printf 'CANDIDATE=%s\nCOMPOSE_PROJECT=%s\nENV_MODE=%s\nENV_SHA256=%s\nOLD_CURRENT=%s\nOLD_PREVIOUS=%s\nPHASE=%s\nSCHEMA=gateway-activation/v1\n' "$CANDIDATE" "$COMPOSE_PROJECT" "$ENV_MODE" "$ENV_SHA" "$OLD_CURRENT" "$OLD_PREVIOUS" "$1" > "$temporary" || return 1
  chmod 600 "$temporary" && durable "$temporary" && mv -Tf -- "$temporary" "$ROOT/.activation.journal" && durable "$ROOT"
}
read_journal() {
  local line key value previous="" count=0
  regular "$ROOT/.activation.journal" && [ "$(file_mode "$ROOT/.activation.journal")" = 600 ] && terminated_text "$ROOT/.activation.journal" || return 1
  while IFS= read -r line; do
    [[ "$line" =~ ^([A-Z_0-9]+)=([A-Za-z0-9_./+-]+)$ ]] || return 1
    key=${BASH_REMATCH[1]}; value=${BASH_REMATCH[2]}
    [[ "$previous" < "$key" ]] || return 1; previous=$key; count=$((count+1))
    case "$key" in
      CANDIDATE) CANDIDATE=$value ;; COMPOSE_PROJECT) COMPOSE_PROJECT=$value ;; ENV_MODE) ENV_MODE=$value ;; ENV_SHA256) ENV_SHA=$value ;;
      OLD_CURRENT) OLD_CURRENT=$value ;; OLD_PREVIOUS) OLD_PREVIOUS=$value ;; PHASE) PHASE=$value ;; SCHEMA) JOURNAL_SCHEMA=$value ;; *) return 1 ;;
    esac
  done < "$ROOT/.activation.journal"
  [ "$count" = 8 ] && [ "$JOURNAL_SCHEMA" = gateway-activation/v1 ] && valid_release_id "$CANDIDATE" || return 1
  case "$COMPOSE_PROJECT" in gateway|led-control-gateway) ;; *) return 1 ;; esac
  [[ "$ENV_MODE" =~ ^[0-7]{3,4}$ && "$ENV_SHA" =~ ^[a-f0-9]{64}$ ]] || return 1
  [ "$OLD_CURRENT" = none ] || valid_release_id "$OLD_CURRENT" || return 1
  [ "$OLD_PREVIOUS" = none ] || valid_release_id "$OLD_PREVIOUS" || return 1
  case "$PHASE" in prepared|env_switched|service_started|healthy|previous_switched|current_switched) ;; *) return 1 ;; esac
  regular "$ROOT/.activation-env.snapshot" && [ "$(file_mode "$ROOT/.activation-env.snapshot")" = 600 ] && [ "$(hash_file "$ROOT/.activation-env.snapshot")" = "$ENV_SHA" ]
}
clear_journal() {
  rm -- "$ROOT/.activation.journal" && durable "$ROOT" || return 1; JOURNAL_ACTIVE=0
  # Keep the 0600 snapshot until the next transaction: removing it before the
  # journal is unrecoverable; removing it afterwards violates journal-last commit.
}
recover() {
  local actual_current actual_previous
  read_journal || return 1
  pointer_id current || return 1; actual_current=$POINTER
  pointer_id previous || return 1; actual_previous=$POINTER
  [ "$actual_current" = "$OLD_CURRENT" ] || [ "$actual_current" = "$CANDIDATE" ] || return 1
  [ "$actual_previous" = "$OLD_PREVIOUS" ] || [ "$actual_previous" = "$OLD_CURRENT" ] || return 1
  verify_bundle "$ROOT/releases/$CANDIDATE" || return 1
  if [ "$OLD_PREVIOUS" != none ]; then verify_bundle "$ROOT/releases/$OLD_PREVIOUS" || return 1; fi
  if [ "$OLD_CURRENT" != none ]; then verify_bundle "$ROOT/releases/$OLD_CURRENT" || return 1; fi
  EXPECTED_PROJECT=$COMPOSE_PROJECT
  resolve_site "$ROOT/.activation-env.snapshot" && ownership_preflight || return 1
  atomic_copy "$ROOT/.activation-env.snapshot" "$ROOT/.env.appliance" "$ENV_MODE" || return 1
  switch_pointer previous "$OLD_PREVIOUS" && switch_pointer current "$OLD_CURRENT" || return 1
  if [ "$OLD_CURRENT" != none ]; then
    verify_bundle "$ROOT/releases/$OLD_CURRENT" && preflight "$ROOT/releases/$OLD_CURRENT" && compose up -d --remove-orphans && healthy || return 1
  else
    verify_bundle "$ROOT/releases/$CANDIDATE" && identity_preflight && runtime_compose "$ROOT/releases/$CANDIDATE" && compose down || return 1
  fi
  clear_journal
}
finish() {
  local status=$1; trap - EXIT INT TERM
  if [ "$status" != 0 ] && [ "$JOURNAL_ACTIVE" = 1 ] && [ "$RECOVERING" = 0 ]; then
    if recover; then echo 'gateway release failed; previous state recovered' >&2
    else echo 'gateway release recovery failed; journal retained' >&2; status=3; fi
  fi
  if [ -n "$STAGE" ] && [[ "$STAGE" = "$ROOT/releases/.staging."* ]] && [ -d "$STAGE" ] && [ ! -L "$STAGE" ]; then chmod -R u+w "$STAGE"; rm -rf -- "$STAGE"; fi
  exit "$status"
}
trap 'finish $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$COMMAND" = verify ]; then verify_bundle "$BUNDLE" || error 'bundle verification rejected'; echo "verified host checksum/env contract: $RELEASE_ID"; exit 0; fi
safe_directory "$ROOT" || error 'unsafe appliance root'
if [ "$TEST_ROOT" = 1 ]; then regular "$ROOT/.gateway-release-disposable-root" && [ "$(cat "$ROOT/.gateway-release-disposable-root")" = gateway-release-test/v1 ] || error 'disposable root sentinel required'; fi
for executable in flock sync docker sha256sum timeout; do command -v "$executable" >/dev/null || error 'host dependency missing'; done
timeout --signal=TERM --kill-after=1s 1s true || error 'timeout deadline support required'
if [ "$TEST_ROOT" = 1 ]; then METADATA_SECONDS=1; COMPOSE_SECONDS=1; LOAD_SECONDS=1; KILL_SECONDS=1; fi
# Shared operation lock for release and state tools. Never unlink its inode.
operation_lock || exit "$?"
if [ -e "$ROOT/.state.journal" ] || [ -L "$ROOT/.state.journal" ]; then error 'state recovery required before release activation'; fi
for name in releases runtime; do
  if [ ! -e "$ROOT/$name" ] && [ ! -L "$ROOT/$name" ]; then mkdir -m 750 "$ROOT/$name"; fi
  safe_directory "$ROOT/$name" || error 'unsafe release/runtime directory'
done
durable "$ROOT"
if [ -e "$ROOT/.activation.journal" ] || [ -L "$ROOT/.activation.journal" ]; then
  JOURNAL_ACTIVE=1; RECOVERING=1
  if ! recover; then echo 'interrupted activation recovery failed; journal retained' >&2; exit 3; fi
  RECOVERING=0; EXPECTED_PROJECT=""
fi
pointer_id current || error 'unsafe current pointer'; OLD_CURRENT=$POINTER
pointer_id previous || error 'unsafe previous pointer'; OLD_PREVIOUS=$POINTER
if [ "$OLD_CURRENT" != none ]; then verify_bundle "$ROOT/releases/$OLD_CURRENT" || error 'current release verification rejected'; fi
if [ "$OLD_PREVIOUS" != none ]; then verify_bundle "$ROOT/releases/$OLD_PREVIOUS" || error 'previous release verification rejected'; fi
if [ "$COMMAND" = rollback ]; then [ "$OLD_PREVIOUS" != none ] || error 'no previous release'; BUNDLE=$ROOT/releases/$OLD_PREVIOUS; fi
verify_bundle "$BUNDLE" || error 'bundle verification rejected'
CANDIDATE=$RELEASE_ID
[ "$OLD_CURRENT" != none ] || ownership_preflight || error 'legacy ownership preflight rejected'
if [ "$CANDIDATE" = "$OLD_CURRENT" ]; then preflight "$ROOT/releases/$CANDIDATE" && healthy || error 'current release is not healthy'; echo "already healthy: $CANDIDATE"; exit 0; fi
AVAILABLE_KB=$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')
BUNDLE_KB=$(du -sk "$BUNDLE" | awk '{print $1}')
[[ "$AVAILABLE_KB" =~ ^[0-9]+$ && "$BUNDLE_KB" =~ ^[0-9]+$ ]] && [ "$AVAILABLE_KB" -gt "$((BUNDLE_KB*2+1024))" ] || error 'insufficient staging disk space'
STAGE=$(mktemp -d "$ROOT/releases/.staging.XXXXXX"); mkdir "$STAGE/docker"
for name in appliance.env checksums.sha256 compose.yml docker/seccomp-bluez-mesh.json gateway-image-linux-arm64.tar release-manifest.json sbom.spdx.json; do cp -- "$BUNDLE/$name" "$STAGE/$name"; durable "$STAGE/$name"; done
durable "$STAGE/docker"; durable "$STAGE"
verify_bundle "$STAGE" && preflight "$STAGE" || error 'candidate preflight rejected'
FINAL=$ROOT/releases/$CANDIDATE
if [ -e "$FINAL" ] || [ -L "$FINAL" ]; then
  safe_directory "$FINAL" && verify_bundle "$FINAL" && cmp -s "$FINAL/checksums.sha256" "$STAGE/checksums.sha256" || error 'immutable release conflict'
else
  find "$STAGE" -type f -exec chmod 440 {} +; chmod 550 "$STAGE/docker" "$STAGE"
  mv -T -- "$STAGE" "$FINAL"; STAGE=""; durable "$ROOT/releases"
fi
verify_bundle "$FINAL" && runtime_compose "$FINAL" && resolve_loaded_image || error 'final release verification rejected'
resolve_site "$ROOT/.env.appliance" || error 'site dotenv rejected before mutation'
ENV_MODE=$(file_mode "$ROOT/.env.appliance"); ENV_SHA=$(hash_file "$ROOT/.env.appliance")
atomic_copy "$ROOT/.env.appliance" "$ROOT/.activation-env.snapshot" 600
JOURNAL_ACTIVE=1; write_journal prepared
TEMP_ENV=$(mktemp "$ROOT/.env-write.XXXXXX")
site_dotenv rewrite "$ROOT/.env.appliance" > "$TEMP_ENV"
chmod "$ENV_MODE" "$TEMP_ENV"; durable "$TEMP_ENV"; mv -Tf -- "$TEMP_ENV" "$ROOT/.env.appliance"; durable "$ROOT"
write_journal env_switched
resolve_site "$ROOT/.env.appliance" && [ "$SITE_IMAGE_REPOSITORY:$SITE_IMAGE_TAG" = "$IMAGE_REPOSITORY:$IMAGE_TAG" ] || error 'site image coordinates disagree'
RESOLVED_IMAGES=$(compose_output config --images 2>/dev/null) || error 'compose candidate resolution failed'
[ "$RESOLVED_IMAGES" = "$IMAGE_REPOSITORY:$IMAGE_TAG" ] || error 'compose candidate image disagrees'
compose up -d --remove-orphans || error 'candidate start failed'; write_journal service_started
healthy || error 'candidate is not healthy'; write_journal healthy
switch_pointer previous "$OLD_CURRENT"; write_journal previous_switched
switch_pointer current "$CANDIDATE"; write_journal current_switched
clear_journal
echo "activated healthy release: $CANDIDATE"
