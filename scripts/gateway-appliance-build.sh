#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

# Even disposable builds use a clean source commit. A test-only platform is an
# explicit manifest property, not permission to label dirty source as a commit.
if [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  echo "재현 가능한 release bundle은 clean Git checkout이 필요합니다. 먼저 변경 사항을 커밋하세요." >&2
  exit 1
fi
command -v node >/dev/null || { echo "bundle build/CI에는 Node.js 22 이상이 필요합니다(Pi host 요구사항 아님)." >&2; exit 1; }
command -v docker >/dev/null || { echo "docker가 필요합니다." >&2; exit 1; }
docker buildx version >/dev/null || { echo "Docker Buildx가 필요합니다." >&2; exit 1; }

REVISION=$(git rev-parse HEAD)
COMMIT_SECONDS=$(git show -s --format=%ct HEAD)
VERSION=$(node -p 'require("./apps/gateway/package.json").version')
REPOSITORY=${GATEWAY_IMAGE_REPOSITORY:-led-control-gateway}
TAG=${GATEWAY_IMAGE_TAG:-$VERSION-$REVISION}
PLATFORM=${GATEWAY_RELEASE_PLATFORM:-linux/arm64}
TEST_MODE=${GATEWAY_RELEASE_TEST_MODE:-0}
case "$TEST_MODE" in 0|1) ;; *) echo "GATEWAY_RELEASE_TEST_MODE는 0 또는 1이어야 합니다." >&2; exit 1 ;; esac
case "$PLATFORM" in linux/arm64|linux/amd64) ;; *) echo "지원하지 않는 release platform입니다." >&2; exit 1 ;; esac
if [ "$PLATFORM" != linux/arm64 ] && [ "$TEST_MODE" != 1 ]; then
  echo "platform override는 GATEWAY_RELEASE_TEST_MODE=1인 disposable CI 전용입니다." >&2
  exit 1
fi
# Keep this array nonempty for macOS Bash 3.2 with nounset enabled.
CREATE_ARGS=(--platform "$PLATFORM")
TEST_SUFFIX=""
if [ "$TEST_MODE" = 1 ]; then
  CREATE_ARGS+=(--test-mode)
  TEST_SUFFIX="-test"
  TAG="${TAG}-test"
fi

# A single serializer owns the OCI version/revision/source/firmware labels.
# Each complete key=value is one argv item, never shell-evaluated metadata.
# org.opencontainers.image.version / org.opencontainers.image.revision
# com.led-control.firmware-compatibility
LABELS=$(node --input-type=module - "$REVISION" "$COMMIT_SECONDS" "$TEST_MODE" <<'NODE'
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { imageLabels } from "./scripts/gateway-release-bundle.mjs";
const [gitCommit, seconds, testMode] = process.argv.slice(2);
const policy = JSON.parse(readFileSync("apps/gateway/release-policy.json", "utf8"));
const metadata = {
  gitCommit, gitCommitTimestamp: new Date(Number(seconds) * 1000).toISOString(), testMode: testMode === "1",
  gatewayVersion: JSON.parse(readFileSync("apps/gateway/package.json", "utf8")).version,
  lockSha256: createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex"),
};
for (const [key, value] of Object.entries(imageLabels(metadata, policy))) process.stdout.write(`${key}=${value}\n`);
NODE
)
LABEL_ARGS=()
while IFS= read -r label; do LABEL_ARGS+=(--label "$label"); done <<< "$LABELS"

OUTPUT_DIR=${GATEWAY_APPLIANCE_OUTPUT_DIR:-$ROOT_DIR/dist/gateway-appliance}
mkdir -p "$OUTPUT_DIR"
BUILD_TEMP=$(mktemp -d "$OUTPUT_DIR/.gateway-build.XXXXXX")
trap 'rm -rf -- "$BUILD_TEMP"' EXIT
docker buildx build --platform "$PLATFORM" --load \
  -f apps/gateway/docker/Dockerfile \
  -t "$REPOSITORY:$TAG" \
  "${LABEL_ARGS[@]}" \
  .
docker image save "$REPOSITORY:$TAG" --output "$BUILD_TEMP/image.tar"
docker image inspect "$REPOSITORY:$TAG" > "$BUILD_TEMP/image-inspect.json"
# Bypass the hardware entrypoint. Inventory was collected in the final image
# layer from actual dpkg/Node files, without network, HCI or site identity.
docker run --rm --network none --read-only --entrypoint cat "$REPOSITORY:$TAG" \
  /usr/local/share/gateway-release-inventory.json > "$BUILD_TEMP/inventory.json"
CONFIG_PREFIX=$(node --input-type=module -e 'import { imageArchiveConfigDigest } from "./scripts/gateway-release-bundle.mjs"; process.stdout.write((await imageArchiveConfigDigest(process.argv[1])).slice(7,23));' "$BUILD_TEMP/image.tar")
BUNDLE_DIR="$OUTPUT_DIR/$VERSION-$REVISION-$CONFIG_PREFIX$TEST_SUFFIX"
node scripts/gateway-release-bundle.mjs create \
  --source "$ROOT_DIR" "${CREATE_ARGS[@]}" \
  --image-archive "$BUILD_TEMP/image.tar" \
  --image-inspect "$BUILD_TEMP/image-inspect.json" \
  --inventory "$BUILD_TEMP/inventory.json" --output "$BUNDLE_DIR"
printf '%s\n' "$BUNDLE_DIR"
