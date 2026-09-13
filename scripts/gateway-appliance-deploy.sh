#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ADAPTER=bluez
if [[ ${1:-} = --adapter ]]; then
  (($# >= 2)) || { echo "--adapter 값이 필요합니다." >&2; exit 2; }
  ADAPTER=$2
  shift 2
fi
if [[ "$ADAPTER" != bluez && "$ADAPTER" != bio-usb ]]; then
  echo "--adapter는 bluez 또는 bio-usb만 허용합니다." >&2
  exit 2
fi
if (($# < 1 || $# > 2)); then
  echo "사용법: scripts/gateway-appliance-deploy.sh [--adapter bio-usb] <user@raspberry-pi> [image.tar]" >&2
  exit 2
fi
TARGET=$1
ARCHIVE=${2:-$(find "$ROOT_DIR/dist/gateway-appliance" -name '*-linux-arm64.tar' -type f -print 2>/dev/null | sort | tail -n 1)}
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || { echo "배포할 ARM64 image archive가 없습니다." >&2; exit 1; }
[ -f "$ARCHIVE.sha256" ] || { echo "$ARCHIVE.sha256 파일이 없습니다." >&2; exit 1; }
[ -f "$ARCHIVE.env" ] || { echo "$ARCHIVE.env 파일이 없습니다." >&2; exit 1; }

ARCHIVE_DIR=$(dirname "$ARCHIVE")
ARCHIVE_NAME=$(basename "$ARCHIVE")
if command -v sha256sum >/dev/null; then
  (cd "$ARCHIVE_DIR" && sha256sum -c "$ARCHIVE_NAME.sha256")
else
  (cd "$ARCHIVE_DIR" && shasum -a 256 -c "$ARCHIVE_NAME.sha256")
fi

REMOTE_DIR=/opt/led-control/gateway
# Existing identity keys are owned by the container's gateway user. Only prepare
# directory entries here; recursive chown would make 0600 device keys unreadable.
ssh "$TARGET" "sudo install -d -m 0750 -o \"\$USER\" -g \"\$(id -gn)\" $REMOTE_DIR $REMOTE_DIR/docker $REMOTE_DIR/data $REMOTE_DIR/data/gateway $REMOTE_DIR/data/mesh $REMOTE_DIR/data/identity $REMOTE_DIR/data/factory-trust"
scp \
  "$ARCHIVE" "$ARCHIVE.sha256" "$ARCHIVE.env" \
  "$ROOT_DIR/apps/gateway/compose.raspberry-pi.yml" \
  "$ROOT_DIR/apps/gateway/compose.bio-usb.yml" \
  "$ROOT_DIR/apps/gateway/docker/seccomp-bluez-mesh.json" \
  "$ROOT_DIR/apps/gateway/.env.appliance.example" \
  "$ROOT_DIR/scripts/gateway-bio-usb-preflight.sh" \
  "$ROOT_DIR/scripts/gateway-appliance-deploy-lib.sh" \
  "$TARGET:/tmp/"

ssh "$TARGET" bash -s -- "$REMOTE_DIR" "$ARCHIVE_NAME" "$ADAPTER" <<'REMOTE'
set -euo pipefail
REMOTE_DIR=$1
ARCHIVE_NAME=$2
ADAPTER=$3
source /tmp/gateway-appliance-deploy-lib.sh
cd "$REMOTE_DIR"

capture_rollback() {
  [ -f .env.appliance ] && [ -f compose.yml ] || {
    echo "GATEWAY_ROLLBACK_COMPOSE_INPUT_MISSING" >&2
    return 1
  }
  if ! current_adapter=$(read_compose_dotenv_value .env.appliance GATEWAY_ADAPTER 2>/dev/null); then
    echo "GATEWAY_ROLLBACK_ADAPTER_INVALID" >&2
    return 1
  fi
  case "$current_adapter" in
    bluez) ;;
    bio-usb)
      [ -f compose.bio-usb.yml ] || {
        echo "GATEWAY_ROLLBACK_COMPOSE_INPUT_MISSING" >&2
        return 1
      }
      ;;
    *) echo "GATEWAY_ROLLBACK_ADAPTER_INVALID" >&2; return 1 ;;
  esac

  # 기존 배포의 adapter와 file set으로 Compose를 실제 렌더링한다. dotenv 값이나
  # 기본 경로를 추정하지 않으며, source가 하나로 확정되지 않으면 어떤 배포
  # mutation도 시작하지 않는다.
  if ! rollback_data_dir=$(resolve_current_gateway_snapshot_root \
      "$current_adapter" .env.appliance compose.yml compose.bio-usb.yml); then
    return 1
  fi

  rollback_dir="$REMOTE_DIR/rollback/$(date -u +%Y%m%dT%H%M%SZ)-$$"
  install -d -m 0700 "$REMOTE_DIR/rollback" "$rollback_dir"
  if ! capture_gateway_data_snapshot "$rollback_data_dir" \
      "$rollback_dir/gateway-data.tgz" 2>/dev/null; then
    echo "GATEWAY_ROLLBACK_SNAPSHOT_FAILED" >&2
    return 1
  fi
  if docker inspect led-control-gateway >/dev/null 2>&1; then
    # 전체 inspect에는 환경/경로가 포함될 수 있으므로 복구에 필요한 image와
    # lifecycle metadata만 0600 파일에 남긴다.
    docker inspect --format 'image_ref={{.Config.Image}}\nimage_id={{.Image}}\nstarted_at={{.State.StartedAt}}\nrestart_count={{.RestartCount}}' \
      led-control-gateway > "$rollback_dir/container-runtime.txt"
  fi
  [ ! -f compose.yml ] || cp -p compose.yml "$rollback_dir/compose.yml"
  [ ! -f compose.bio-usb.yml ] || cp -p compose.bio-usb.yml "$rollback_dir/compose.bio-usb.yml"
  [ ! -f .env.appliance ] || cp -p .env.appliance "$rollback_dir/.env.appliance"

  chmod -R go-rwx "$rollback_dir"
  printf 'Rollback capture: %s\n' "$rollback_dir"
}

# 실행 중 container나 현장 설정을 바꾸기 전에 항상 복구 좌표를 먼저 남긴다.
capture_rollback

BIO_DEVICE=""
BIO_GID=""
if [ "$ADAPTER" = bio-usb ]; then
  chmod 0755 /tmp/gateway-bio-usb-preflight.sh
  BIO_PREFLIGHT=$(env -u GATEWAY_BIO_USB_SYSFS_ROOT -u GATEWAY_BIO_USB_DEV_ROOT /tmp/gateway-bio-usb-preflight.sh)
  BIO_DEVICE=$(printf '%s\n' "$BIO_PREFLIGHT" | sed -n 's/^GATEWAY_BIO_USB_DEVICE=//p')
  BIO_GID=$(printf '%s\n' "$BIO_PREFLIGHT" | sed -n 's/^GATEWAY_BIO_USB_GID=//p')
  [[ "$BIO_DEVICE" =~ ^/dev/bus/usb/[0-9]{3}/[0-9]{3}$ && "$BIO_GID" =~ ^[0-9]+$ ]] || {
    echo "BIO USB preflight returned invalid deployment metadata" >&2
    exit 1
  }
fi

mv "/tmp/$ARCHIVE_NAME" "/tmp/$ARCHIVE_NAME.sha256" "/tmp/$ARCHIVE_NAME.env" "$REMOTE_DIR/"
mv /tmp/compose.raspberry-pi.yml "$REMOTE_DIR/compose.yml"
mv /tmp/compose.bio-usb.yml "$REMOTE_DIR/compose.bio-usb.yml"
mv /tmp/seccomp-bluez-mesh.json "$REMOTE_DIR/docker/seccomp-bluez-mesh.json"
mv /tmp/.env.appliance.example "$REMOTE_DIR/.env.appliance.example"
mv /tmp/gateway-bio-usb-preflight.sh "$REMOTE_DIR/gateway-bio-usb-preflight.sh"
mv /tmp/gateway-appliance-deploy-lib.sh "$REMOTE_DIR/gateway-appliance-deploy-lib.sh"
sha256sum -c "$ARCHIVE_NAME.sha256"
docker image load --input "$ARCHIVE_NAME"

if [ ! -f .env.appliance ]; then
  echo "$REMOTE_DIR/.env.appliance를 .env.appliance.example 기준으로 작성한 뒤 다시 실행하세요." >&2
  exit 2
fi
for file in device.crt device.key api-ca.crt mqtt-ca.crt; do
  sudo test -s "data/identity/device/current/$file" || { echo "제조 identity 누락: $REMOTE_DIR/data/identity/device/current/$file" >&2; exit 2; }
done

if ! GATEWAY_IMAGE_REPOSITORY=$(read_compose_dotenv_value "./$ARCHIVE_NAME.env" GATEWAY_IMAGE_REPOSITORY) ||
   ! GATEWAY_IMAGE_TAG=$(read_compose_dotenv_value "./$ARCHIVE_NAME.env" GATEWAY_IMAGE_TAG); then
  echo "Image archive metadata is missing or malformed" >&2
  exit 2
fi
[[ "$GATEWAY_IMAGE_REPOSITORY" =~ ^[A-Za-z0-9][A-Za-z0-9./:_-]*$ &&
   "$GATEWAY_IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || {
  echo "Image archive metadata is invalid" >&2
  exit 2
}

upsert_env_value() {
  key=$1
  value=$2
  temporary=$(mktemp ".env.appliance.tmp.XXXXXX")
  awk -v key="$key" 'substr($0, 1, length(key) + 1) != key "=" { print }' .env.appliance > "$temporary"
  printf '%s=%s\n' "$key" "$value" >> "$temporary"
  chmod --reference=.env.appliance "$temporary"
  mv "$temporary" .env.appliance
}

# Compose가 다음 재시작에서도 방금 검증·load한 immutable image를 선택하도록
# archive metadata를 장비 설정에 남긴다. 기존 site/identity 설정은 그대로 보존한다.
upsert_env_value GATEWAY_IMAGE_REPOSITORY "$GATEWAY_IMAGE_REPOSITORY"
upsert_env_value GATEWAY_IMAGE_TAG "$GATEWAY_IMAGE_TAG"
upsert_env_value GATEWAY_ADAPTER "$ADAPTER"

COMPOSE_ARGS=(--env-file .env.appliance -f compose.yml)
if [ "$ADAPTER" = bio-usb ]; then
  upsert_env_value GATEWAY_BIO_USB_DEVICE "$BIO_DEVICE"
  upsert_env_value GATEWAY_BIO_USB_GID "$BIO_GID"
  COMPOSE_ARGS+=(-f compose.bio-usb.yml)
  # USB bus/device 번호는 재연결마다 바뀔 수 있어 preflight 직후 Gateway
  # service 하나만 recreate한다. 다른 appliance state나 service는 건드리지 않는다.
fi

run_compose() {
  if [ "$ADAPTER" = bio-usb ]; then
    run_with_current_bio_device "$BIO_DEVICE" "$BIO_GID" docker compose "${COMPOSE_ARGS[@]}" "$@"
  else
    run_without_compose_shell_overrides docker compose "${COMPOSE_ARGS[@]}" "$@"
  fi
}

if [ "$ADAPTER" = bio-usb ]; then
  run_compose up -d --no-deps --force-recreate gateway-appliance
else
  run_compose up -d --remove-orphans
fi

for _ in $(seq 1 60); do
  STATUS=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' led-control-gateway 2>/dev/null || true)
  [ "$STATUS" = healthy ] && { run_compose ps; exit 0; }
  [ "$STATUS" = unhealthy ] && break
  sleep 2
done
run_compose ps
run_compose logs --tail=100 gateway-appliance
exit 1
REMOTE
