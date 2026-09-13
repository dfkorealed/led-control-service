#!/usr/bin/env bash
set -euo pipefail
umask 077

# Pi host에서 승인 후 사용하는 독립 BIO launcher다. 임의 Compose 파일/overlay,
# env_file 또는 예전 data 기본값을 받지 않는다. image transfer/load는 기존 build
# archive checksum 절차로 별도 수행한다. 이 script는 제조·claim·발급을 하지 않는다.
fail_input() { echo BIO_RUNTIME_INPUT_INVALID >&2; exit 2; }
fail_gate() { echo BIO_RUNTIME_PREFLIGHT_FAILED >&2; exit 1; }
[[ $# = 1 && ( $1 = check || $1 = start ) ]] || fail_input
[[ -z ${COMPOSE_FILE:-} && -z ${COMPOSE_PROFILES:-} && -z ${COMPOSE_PROJECT_NAME:-} && -z ${GATEWAY_DATA_DIR:-} ]] || fail_input
[[ ${GATEWAY_BIO_DATA_ROOT:-} =~ ^/opt/led-control/gateway/data-[a-z0-9][a-z0-9-]*$ ]] || fail_input
[[ ${GATEWAY_BIO_IMAGE:-} =~ ^[a-zA-Z0-9./:_-]+$ && ${GATEWAY_BIO_IMAGE_ID:-} =~ ^sha256:[a-f0-9]{64}$ ]] || fail_input
[[ ${GATEWAY_BIO_OLD_CONTAINER_ID:-} =~ ^[a-f0-9]{64}$ ]] || fail_input
[[ ${GATEWAY_SERIAL:-} =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail_input
for value in "${GATEWAY_EXPECTED_SITE_ID:-}" "${GATEWAY_EXPECTED_GATEWAY_ID:-}"; do
  [[ $value =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$ ]] || fail_input
done
[[ ${GATEWAY_BOOTSTRAP_URL:-} =~ ^https://[a-zA-Z0-9.-]+:[0-9]+/gateway-bootstrap$ ]] || fail_input
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_PATH="$ROOT_DIR/apps/gateway/compose.bio-runtime.yml"
[[ -f $COMPOSE_PATH ]] || fail_gate

# clean environment는 Docker context/DOCKER_HOST, NODE_OPTIONS, COMPOSE_* 및
# shell의 오래된 USB 좌표가 렌더링/실행에 끼어드는 것을 막는다. /var/run Docker
# socket을 쓰는 Pi host 전용이며 원격 Docker daemon은 지원하지 않는다.
docker_local() { env -i PATH="$PATH" docker "$@"; }

# canonical root 및 각 직접 자식만 준비한다. symlink/그룹 쓰기 가능한 parent를
# 따라 chown하지 않으며 recursive chown, old data copy, identity overwrite는 금지다.
for directory in /opt /opt/led-control /opt/led-control/gateway "$GATEWAY_BIO_DATA_ROOT"; do
  [[ $(sudo -n realpath -e "$directory" 2>/dev/null) = "$directory" ]] || fail_gate
  metadata=$(sudo -n stat -c '%F|%a|%u' "$directory" 2>/dev/null) || fail_gate
  IFS='|' read -r kind mode owner <<< "$metadata"
  [[ $kind = directory && ( $owner = 0 || $owner = 999 ) && $mode =~ ^[0-7]{3,4}$ ]] || fail_gate
  (( (8#$mode & 0022) == 0 )) || fail_gate
done

# 이 Pi의 고정 container-name/USB 소유권은 data-root가 달라도 공유된다. 따라서
# root별 lock이 아니라 하나의 host deployment lock을 원자적 mkdir로 잡는다.
# 기존 directory는 살아 있는 실행인지 stale인지 추측하지 않고 모두 거부한다.
# SIGKILL/전원 손실 뒤 남은 lock도 운영자가 exact container/evidence를 검토한 후
# 해제해야 한다. PID 재사용/시간 경과를 근거로 다른 실행의 lock을 지우지 않는다.
lock_path=/opt/led-control/gateway/.bio-runtime-deploy.lock
lock_owned=0
lock_identity=""
candidate_id=""
create_attempted=0
deployment_succeeded=0
evidence=""
deployment_id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
[[ $deployment_id =~ ^[a-f0-9]{32}$ ]] || fail_gate

capture_candidate() {
  local ids ownership
  ids=$(docker_local container ls -aq --no-trunc --filter "label=io.led-control.bio.deployment=$deployment_id" 2>/dev/null) || return 1
  [[ -n $ids ]] || return 0
  [[ $ids =~ ^[a-f0-9]{64}$ ]] || return 1
  ownership=$(docker_local inspect "$ids" --format '{{.Id}} {{index .Config.Labels "io.led-control.bio.deployment"}} {{.Image}}' 2>/dev/null) || return 1
  [[ $ownership = "$ids $deployment_id $GATEWAY_BIO_IMAGE_ID" ]] || return 1
  # 한 번 결속한 ID는 이름/label 조회 결과가 바뀌어도 새 ID로 교체하지 않는다.
  [[ -z $candidate_id || $candidate_id = "$ids" ]] || return 1
  candidate_id=$ids
}

cleanup_candidate() {
  local ids state
  if [[ -z $candidate_id && $create_attempted = 1 ]]; then capture_candidate || return 1; fi
  [[ -n $candidate_id ]] || return 0
  ids=$(docker_local container ls -aq --no-trunc --filter "id=$candidate_id" 2>/dev/null) || return 1
  [[ -n $ids ]] || return 0 # daemon이 exact ID 부재를 확인한 경우만 이미 제거됨으로 판단한다.
  [[ $ids = "$candidate_id" ]] || return 1
  docker_local stop --time 20 "$candidate_id" > "$evidence/candidate-stop.log" 2>&1 || return 1
  state=$(docker_local inspect "$candidate_id" --format '{{.State.Running}} {{.RestartCount}}' 2>/dev/null) || return 1
  [[ $state = 'false 0' ]] || return 1
}

finish_deployment() {
  local exit_code=$? cleanup_failed=0 current_lock
  trap - EXIT
  # 정리 중 두 번째 SIGINT/TERM이 들어와도 stop 확인과 lock 보존 판단을 끝낸다.
  # SIGKILL은 처리할 수 없으므로 stale lock의 수동 복구 관문을 유지한다.
  trap '' INT TERM HUP
  if [[ $deployment_succeeded != 1 && $create_attempted = 1 ]]; then
    cleanup_candidate || cleanup_failed=1
  fi
  if [[ $cleanup_failed = 1 ]]; then
    echo "BIO_RUNTIME_CLEANUP_FAILED evidence=$evidence" >&2
    # 장비 소유권이 미확정이면 lock을 남겨 다음 실행도 차단한다.
    exit 1
  fi
  if [[ $lock_owned = 1 ]]; then
    current_lock=$(sudo -n stat -c '%d:%i' "$lock_path" 2>/dev/null) || current_lock=""
    if [[ -z $lock_identity || $current_lock != "$lock_identity" ]] || ! sudo -n rmdir "$lock_path" 2>/dev/null; then
      if [[ $deployment_succeeded = 1 && $create_attempted = 1 ]]; then
        cleanup_candidate || echo "BIO_RUNTIME_CLEANUP_FAILED evidence=$evidence" >&2
      fi
      echo BIO_RUNTIME_LOCK_RELEASE_FAILED >&2; exit 1
    fi
  fi
  if [[ $deployment_succeeded = 1 && $exit_code = 0 ]]; then
    echo "BIO_RUNTIME_STARTED evidence=$evidence"
  fi
  exit "$exit_code"
}
trap finish_deployment EXIT
# Bash는 진행 중 foreground Docker 요청의 완료를 기다린 뒤 trap을 처리한다.
# client만 먼저 죽여 daemon에 늦게 생성되는 orphan을 남기지 않고, 완료된 요청의
# invocation label로 후보를 회수한 뒤 exact ID 하나만 정지한다.
trap 'deployment_succeeded=0; exit 130' INT
trap 'deployment_succeeded=0; exit 143' TERM
trap 'deployment_succeeded=0; exit 129' HUP
if [[ $1 = start ]]; then
  if ! sudo -n mkdir -m 0700 "$lock_path" 2>/dev/null; then echo BIO_RUNTIME_LOCKED >&2; exit 1; fi
  lock_owned=1
  lock_identity=$(sudo -n stat -c '%d:%i' "$lock_path" 2>/dev/null) || fail_gate
fi

image_state=$(docker_local image inspect "$GATEWAY_BIO_IMAGE" --format '{{.Id}} {{.Os}}/{{.Architecture}}' 2>/dev/null) || fail_gate
[[ $image_state = "$GATEWAY_BIO_IMAGE_ID linux/arm64" ]] || fail_gate
export GATEWAY_BIO_IMAGE="$GATEWAY_BIO_IMAGE_ID"
old_id=$(docker_local inspect led-control-gateway --format '{{.Id}}' 2>/dev/null) || fail_gate
[[ $old_id = "$GATEWAY_BIO_OLD_CONTAINER_ID" ]] || fail_gate
candidate_name_absent() {
  local ids
  ids=$(docker_local container ls -aq --no-trunc --filter 'name=^/led-control-gateway-bio$' 2>/dev/null) || return 1
  [[ -z $ids ]]
}
candidate_name_absent || fail_gate
for leaf in identity gateway mesh; do
  directory="$GATEWAY_BIO_DATA_ROOT/$leaf"
  if sudo -n test -e "$directory" || sudo -n test -L "$directory"; then
    [[ $(sudo -n realpath -e "$directory" 2>/dev/null) = "$directory" ]] || fail_gate
    metadata=$(sudo -n stat -c '%F|%a|%u' "$directory" 2>/dev/null) || fail_gate
    IFS='|' read -r kind mode owner <<< "$metadata"
    [[ $kind = directory && ( $owner = 0 || $owner = 999 ) ]] || fail_gate
    (( (8#$mode & 0022) == 0 )) || fail_gate
  elif [[ $leaf != mesh ]]; then fail_gate; fi
done

usb_state=$(env -u GATEWAY_BIO_USB_SYSFS_ROOT -u GATEWAY_BIO_USB_DEV_ROOT bash "$ROOT_DIR/scripts/gateway-bio-usb-preflight.sh") || fail_gate
export GATEWAY_BIO_USB_DEVICE=$(printf '%s\n' "$usb_state" | sed -n 's/^GATEWAY_BIO_USB_DEVICE=//p')
export GATEWAY_BIO_USB_GID=$(printf '%s\n' "$usb_state" | sed -n 's/^GATEWAY_BIO_USB_GID=//p')
[[ $GATEWAY_BIO_USB_DEVICE =~ ^/dev/bus/usb/[0-9]{3}/[0-9]{3}$ && $GATEWAY_BIO_USB_GID =~ ^[0-9]+$ ]] || fail_gate
if [[ $1 = check ]]; then echo BIO_RUNTIME_HOST_VALID; exit 0; fi

sudo -n install -d -o 999 -g 999 -m 0750 "$GATEWAY_BIO_DATA_ROOT/identity" || fail_gate
sudo -n install -d -o 999 -g 999 -m 0700 "$GATEWAY_BIO_DATA_ROOT/gateway" "$GATEWAY_BIO_DATA_ROOT/mesh" || fail_gate
evidence=$(mktemp -d /tmp/gateway-bio-deploy.XXXXXX)
# 현 image/env/mount/lifecycle은 rollback 판단용 protected evidence다. private key
# 파일은 복사하지 않는다. old container는 정확한 ID 하나만 stop하고 삭제하지 않는다.
docker_local inspect "$old_id" > "$evidence/old-container.json"
docker_local run --rm --network none --read-only --user 999:999 --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=bind,source=$GATEWAY_BIO_DATA_ROOT/identity,target=/data/identity,readonly" \
  --mount "type=bind,source=$GATEWAY_BIO_DATA_ROOT/gateway,target=/data/gateway,readonly" \
  -e "GATEWAY_SERIAL=$GATEWAY_SERIAL" -e "GATEWAY_EXPECTED_SITE_ID=$GATEWAY_EXPECTED_SITE_ID" -e "GATEWAY_EXPECTED_GATEWAY_ID=$GATEWAY_EXPECTED_GATEWAY_ID" \
  --entrypoint node "$GATEWAY_BIO_IMAGE" /opt/led-control/bio-runtime-preflight.mjs > "$evidence/identity-check.log" 2>&1 || fail_gate
# USB 좌표는 directory/identity 검증 시간 동안 바뀔 수 있다. 기존 주소를 재사용하지
# 않고 직전 preflight와 동일함을 확인한다. adapter도 open 직전 descriptor를 재검증한다.
[[ $(env -u GATEWAY_BIO_USB_SYSFS_ROOT -u GATEWAY_BIO_USB_DEV_ROOT bash "$ROOT_DIR/scripts/gateway-bio-usb-preflight.sh") = "$usb_state" ]] || fail_gate
compose() {
  env -i PATH="$PATH" GATEWAY_BIO_IMAGE="$GATEWAY_BIO_IMAGE" GATEWAY_BIO_DATA_ROOT="$GATEWAY_BIO_DATA_ROOT" \
    GATEWAY_BIO_DEPLOYMENT_ID="$deployment_id" \
    GATEWAY_BIO_USB_DEVICE="$GATEWAY_BIO_USB_DEVICE" GATEWAY_BIO_USB_GID="$GATEWAY_BIO_USB_GID" \
    GATEWAY_SERIAL="$GATEWAY_SERIAL" GATEWAY_BOOTSTRAP_URL="$GATEWAY_BOOTSTRAP_URL" \
    docker compose --env-file /dev/null -p "led-control-bio-$deployment_id" -f "$COMPOSE_PATH" "$@"
}
compose config --format json > "$evidence/compose.json" 2> "$evidence/compose-error.log" || fail_gate
candidate_name_absent || fail_gate
docker_local stop "$old_id" > "$evidence/old-stop.log" 2>&1 || fail_gate
# up가 API 오류/중단 전에 이미 장비를 시작하는 모호한 창을 없앤다. 먼저 create만
# 수행하고 invocation label+image로 ID를 소유한 뒤 exact-ID start를 한 번 호출한다.
# create가 실패해도 EXIT trap은 그 label만 찾아 부분 생성된 후보를 정지한다.
create_attempted=1
compose create --no-recreate --no-build --pull never gateway-bio > "$evidence/create.log" 2>&1 || { echo BIO_RUNTIME_CREATE_FAILED >&2; exit 1; }
capture_candidate || fail_gate
[[ -n $candidate_id ]] || fail_gate
printf '%s\n' "$candidate_id" > "$evidence/candidate-id"
docker_local start "$candidate_id" > "$evidence/start.log" 2>&1 || { echo BIO_RUNTIME_START_FAILED >&2; exit 1; }
# start 성공 직후 실제 Node process의 UID/GID999, Cap*0, NoNewPrivs1을 검증한다.
# invariant가 어긋나면 새 BIO container만 stop한다. image 내부 helper가 없거나
# process가 이미 종료된 경우도 성공으로 추정하지 않으며 재시작하지 않는다.
if ! docker_local exec "$candidate_id" node /usr/local/lib/gateway-bio-process-check.cjs > "$evidence/process-check.log" 2>&1; then
  echo "BIO_RUNTIME_PROCESS_UNSAFE evidence=$evidence" >&2; exit 1
fi
[[ $(docker_local inspect "$candidate_id" --format '{{.State.Running}} {{.RestartCount}}' 2>/dev/null) = 'true 0' ]] || fail_gate
deployment_succeeded=1
# 자동 restart/recreate가 handshake를 반복하지 않게 restart=no로 유지한다.
# healthy 3회/DB heartbeat는 운영자가 별도로 관측한다. 실패 후 old identity를
# 자동 재시작하지 않는다(이미 revoke된 identity일 수 있으므로 승인이 필요하다).
