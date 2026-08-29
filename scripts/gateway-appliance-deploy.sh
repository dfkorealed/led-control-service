#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if (($# < 1 || $# > 2)); then
  echo "사용법: scripts/gateway-appliance-deploy.sh <user@raspberry-pi> [image.tar]" >&2
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
  "$ROOT_DIR/apps/gateway/docker/seccomp-bluez-mesh.json" \
  "$ROOT_DIR/apps/gateway/.env.appliance.example" \
  "$TARGET:/tmp/"

ssh "$TARGET" bash -s -- "$REMOTE_DIR" "$ARCHIVE_NAME" <<'REMOTE'
set -euo pipefail
REMOTE_DIR=$1
ARCHIVE_NAME=$2
mv "/tmp/$ARCHIVE_NAME" "/tmp/$ARCHIVE_NAME.sha256" "/tmp/$ARCHIVE_NAME.env" "$REMOTE_DIR/"
mv /tmp/compose.raspberry-pi.yml "$REMOTE_DIR/compose.yml"
mv /tmp/seccomp-bluez-mesh.json "$REMOTE_DIR/docker/seccomp-bluez-mesh.json"
mv /tmp/.env.appliance.example "$REMOTE_DIR/.env.appliance.example"
cd "$REMOTE_DIR"
sha256sum -c "$ARCHIVE_NAME.sha256"
docker image load --input "$ARCHIVE_NAME"

if [ ! -f .env.appliance ]; then
  echo "$REMOTE_DIR/.env.appliance를 .env.appliance.example 기준으로 작성한 뒤 다시 실행하세요." >&2
  exit 2
fi
for file in device.crt device.key api-ca.crt mqtt-ca.crt; do
  sudo test -s "data/identity/device/current/$file" || { echo "제조 identity 누락: $REMOTE_DIR/data/identity/device/current/$file" >&2; exit 2; }
done

set -a
. "./$ARCHIVE_NAME.env"
set +a
docker compose --env-file .env.appliance -f compose.yml up -d --remove-orphans

for _ in $(seq 1 60); do
  STATUS=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' led-control-gateway 2>/dev/null || true)
  [ "$STATUS" = healthy ] && { docker compose -f compose.yml ps; exit 0; }
  [ "$STATUS" = unhealthy ] && break
  sleep 2
done
docker compose -f compose.yml ps
docker compose -f compose.yml logs --tail=100 gateway-appliance
exit 1
REMOTE
