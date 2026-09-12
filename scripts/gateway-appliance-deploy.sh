#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if (($# < 1 || $# > 2)); then
  echo '사용법: scripts/gateway-appliance-deploy.sh <user@raspberry-pi> [bundle-dir]' >&2
  exit 2
fi
TARGET=$1
[[ "$TARGET" =~ ^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$ ]] || { echo '잘못된 SSH 대상입니다.' >&2; exit 2; }
BUNDLE=${2:-}
if [ -z "$BUNDLE" ]; then
  BUNDLE=$(find "$ROOT_DIR/dist/gateway-appliance" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print 2>/dev/null | sort | tail -n 1)
fi
[ -n "$BUNDLE" ] && [ -d "$BUNDLE" ] && [ ! -L "$BUNDLE" ] || { echo 'immutable release bundle directory가 필요합니다.' >&2; exit 1; }
BUNDLE_NAME=$(basename "$BUNDLE")
[[ "$BUNDLE_NAME" =~ ^[A-Za-z0-9_.+-]+$ ]] || { echo 'bundle directory 이름이 안전하지 않습니다.' >&2; exit 1; }
# Trusted manager and policy digest come from the checkout, never the bundle.
POLICY_SHA=$(sha256sum "$ROOT_DIR/apps/gateway/release-policy.json")
POLICY_SHA=${POLICY_SHA%% *}
MANAGER=$ROOT_DIR/scripts/gateway-appliance-release.sh
/bin/bash "$MANAGER" verify "$BUNDLE" --policy-sha256 "$POLICY_SHA"
REMOTE_STAGE=$(ssh "$TARGET" 'mktemp -d /tmp/led-control-gateway-upload.XXXXXX')
[[ "$REMOTE_STAGE" =~ ^/tmp/led-control-gateway-upload\.[A-Za-z0-9]+$ ]] || { echo '원격 staging 경로를 확인할 수 없습니다.' >&2; exit 1; }
# No identity, site env, private key or obsolete loose artifact is transmitted.
scp -r "$BUNDLE" "$MANAGER" "$TARGET:$REMOTE_STAGE/"
ssh "$TARGET" "sudo /bin/bash '$REMOTE_STAGE/gateway-appliance-release.sh' activate '$REMOTE_STAGE/$BUNDLE_NAME' --policy-sha256 '$POLICY_SHA'"
