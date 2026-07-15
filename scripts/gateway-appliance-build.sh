#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

command -v docker >/dev/null || { echo "docker가 필요합니다." >&2; exit 1; }
docker buildx version >/dev/null || { echo "Docker Buildx가 필요합니다." >&2; exit 1; }

if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY_BUILD:-0}" != "1" ]; then
  echo "재현 가능한 이미지 생성을 위해 먼저 변경 사항을 커밋하세요. 임시 검증은 ALLOW_DIRTY_BUILD=1을 사용합니다." >&2
  exit 1
fi

REVISION=$(git rev-parse --short=12 HEAD)
if [ "${ALLOW_DIRTY_BUILD:-0}" = "1" ] && [ -n "$(git status --porcelain)" ]; then
  REVISION="${REVISION}-dirty"
fi
REPOSITORY=${GATEWAY_IMAGE_REPOSITORY:-led-control-gateway}
TAG=${GATEWAY_IMAGE_TAG:-$REVISION}
OUTPUT_DIR=${GATEWAY_APPLIANCE_OUTPUT_DIR:-$ROOT_DIR/dist/gateway-appliance}
ARCHIVE="$OUTPUT_DIR/${REPOSITORY//\//-}-${TAG}-linux-arm64.tar"

mkdir -p "$OUTPUT_DIR"
docker buildx build --platform linux/arm64 --load \
  -f apps/gateway/docker/Dockerfile \
  -t "$REPOSITORY:$TAG" \
  --label "org.opencontainers.image.revision=$REVISION" \
  .
docker image save "$REPOSITORY:$TAG" --output "$ARCHIVE"

if command -v sha256sum >/dev/null; then
  (cd "$OUTPUT_DIR" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
else
  (cd "$OUTPUT_DIR" && shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
fi
printf 'GATEWAY_IMAGE_REPOSITORY=%s\nGATEWAY_IMAGE_TAG=%s\n' "$REPOSITORY" "$TAG" > "$ARCHIVE.env"
printf '%s\n' "$ARCHIVE"
