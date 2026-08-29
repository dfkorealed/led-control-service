#!/usr/bin/env bash
set -euo pipefail
umask 077

SERIAL_PATTERN='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
TARGET_PATTERN='^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$'
PATH_PATTERN='^/[A-Za-z0-9._/-]+$'
URL_PATTERN='^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~:/?@!%+,;=&()-]*)?$'
TARGET= SERIAL= LABEL_OUTPUT=
usage() { printf '%s\n' "$1" >&2; exit 2; }
while (($#)); do
  case "$1" in
    --target) (($# >= 2)) || usage '--target requires a value'; TARGET=$2; shift 2;;
    --serial) (($# >= 2)) || usage '--serial requires a value'; SERIAL=$2; shift 2;;
    --label-output) (($# >= 2)) || usage '--label-output requires a value'; LABEL_OUTPUT=$2; shift 2;;
    *) usage 'invalid arguments';;
  esac
done
[[ -n "$TARGET" ]] || usage '--target is required'
[[ -n "$SERIAL" ]] || usage '--serial is required'
[[ -n "$LABEL_OUTPUT" ]] || usage '--label-output is required'
: "${MANUFACTURING_API_URL:?MANUFACTURING_API_URL is required}"
: "${STATION_CERT:?STATION_CERT is required}"
: "${STATION_KEY:?STATION_KEY is required}"
: "${STATION_CA:?STATION_CA is required}"
: "${GATEWAY_IMAGE:?GATEWAY_IMAGE is required}"
GATEWAY_IDENTITY_HOST_ROOT=${GATEWAY_IDENTITY_HOST_ROOT:-/opt/led-control/gateway/data/identity}
GATEWAY_FACTORY_TRUST_HOST_ROOT=${GATEWAY_FACTORY_TRUST_HOST_ROOT:-/opt/led-control/gateway/data/factory-trust}
[[ "$SERIAL" =~ $SERIAL_PATTERN && "$TARGET" =~ $TARGET_PATTERN && "$LABEL_OUTPUT" =~ $PATH_PATTERN && "$MANUFACTURING_API_URL" =~ $URL_PATTERN ]] || { printf '%s\n' 'invalid enrollment input' >&2; exit 2; }
[[ "$GATEWAY_IDENTITY_HOST_ROOT" =~ $PATH_PATTERN && "$GATEWAY_FACTORY_TRUST_HOST_ROOT" =~ $PATH_PATTERN ]] || { printf '%s\n' 'invalid enrollment path' >&2; exit 2; }
[[ "$GATEWAY_IMAGE" =~ ^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$ ]] || { printf '%s\n' 'invalid gateway image' >&2; exit 2; }
for variable in STATION_CERT STATION_KEY STATION_CA; do
  file=${!variable}
  resolved=$(realpath "$file" 2>/dev/null || true)
  [[ -n "$resolved" && -f "$resolved" && ! -L "$resolved" ]] || { printf '%s\n' 'invalid station credential path' >&2; exit 2; }
  printf -v "$variable" '%s' "$resolved"
done
KEY_MODE=$(stat -f '%Lp' "$STATION_KEY" 2>/dev/null || stat -c '%a' "$STATION_KEY")
[[ "$KEY_MODE" == 600 ]] || { printf '%s\n' 'invalid station key permissions' >&2; exit 2; }

if [[ -e "$LABEL_OUTPUT" ]]; then
  [[ -f "$LABEL_OUTPUT" && ! -L "$LABEL_OUTPUT" ]] || { printf '%s\n' 'invalid label path' >&2; exit 2; }
  MODE=$(stat -f '%Lp' "$LABEL_OUTPUT" 2>/dev/null || stat -c '%a' "$LABEL_OUTPUT")
  [[ "$MODE" == 600 ]] || { printf '%s\n' 'invalid label permissions' >&2; exit 2; }
  jq -e --arg serial "$SERIAL" '.serialNumber == $serial and (.claimCode|type)=="string" and (.fingerprint|type)=="string"' "$LABEL_OUTPUT" >/dev/null && exit 0
  printf '%s\n' 'existing label does not match the gateway' >&2
  exit 2
fi

TMP_LABEL=$(mktemp "${LABEL_OUTPUT}.tmp.XXXXXX")
trap 'rm -f "$TMP_LABEL"' EXIT
# The token is emitted only into ssh stdin; it is never a shell argument, file, or log.
curl --fail-with-body --silent --show-error --max-time 30 \
  --cert "$STATION_CERT" --key "$STATION_KEY" --cacert "$STATION_CA" \
  --header 'content-type: application/json' --data "{\"serialNumber\":\"$SERIAL\"}" \
  "$MANUFACTURING_API_URL/manufacturing/gateway-enrollments" \
  | jq -er '.enrollmentToken' \
  | ssh -o BatchMode=yes "$TARGET" -- docker run --rm -i --network host \
      --entrypoint node \
      --volume "$GATEWAY_IDENTITY_HOST_ROOT:/var/lib/led-control/identity" \
      --volume "$GATEWAY_FACTORY_TRUST_HOST_ROOT:/etc/led-control/factory-trust:ro" \
      "$GATEWAY_IMAGE" /usr/local/bin/manufacturing-enroll.mjs \
      "$SERIAL" "$MANUFACTURING_API_URL/gateway-manufacturing/enroll" \
      /var/lib/led-control/identity/device /etc/led-control/factory-trust/api-ca.crt \
  > "$TMP_LABEL"
jq -e --arg serial "$SERIAL" '.serialNumber == $serial and (.claimCode|type)=="string" and (.claimCode|length)>20 and (.fingerprint|test("^[0-9A-F]{64}$"))' "$TMP_LABEL" >/dev/null
chmod 0600 "$TMP_LABEL"
mv "$TMP_LABEL" "$LABEL_OUTPUT"
trap - EXIT
