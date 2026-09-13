#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# BIO 동글은 BlueZ appliance와 USB 권한·컨테이너 capability·상태 경로가 전혀
# 다르다. 예전의 `--adapter bio-usb` overlay 배포를 다시 허용하면 BlueZ 권한이
# BIO 컨테이너에 섞일 수 있으므로, 원격 접속이나 파일 전송 전에 전용 launcher로
# 안내하고 종료한다. `--adapter bluez`는 구형 운영 명령과의 호환만 유지한다.
if [[ ${1:-} = --adapter ]]; then
  (($# >= 2)) || { echo "--adapter 값이 필요합니다." >&2; exit 2; }
  case "$2" in
    bluez) shift 2 ;;
    bio-usb)
      echo "GATEWAY_BIO_STANDALONE_REQUIRED: use scripts/gateway-bio-runtime.sh" >&2
      exit 2
      ;;
    *)
      echo "--adapter는 bluez 또는 bio-usb만 허용합니다." >&2
      exit 2
      ;;
  esac
fi

if (($# < 1 || $# > 2)); then
  echo '사용법: scripts/gateway-appliance-deploy.sh [--adapter bluez] <user@raspberry-pi> [bundle-dir]' >&2
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
scp -r "$BUNDLE" "$MANAGER" "$ROOT_DIR/scripts/gateway-appliance-common.sh" "$TARGET:$REMOTE_STAGE/"
ssh "$TARGET" "sudo /bin/bash '$REMOTE_STAGE/gateway-appliance-release.sh' activate '$REMOTE_STAGE/$BUNDLE_NAME' --policy-sha256 '$POLICY_SHA'"
