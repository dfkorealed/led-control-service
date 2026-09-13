#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

# BIO 동글은 USB serial descriptor가 없어 동일 VID:PID 여러 대를 안전하게
# 구분할 수 없다. 따라서 매 실행 시 sysfs를 다시 읽고 exact-one만 허용한다.
SYSFS_ROOT=${GATEWAY_BIO_USB_SYSFS_ROOT:-/sys/bus/usb/devices}
DEV_ROOT=${GATEWAY_BIO_USB_DEV_ROOT:-/dev/bus/usb}
EXPECTED_VENDOR=1a86
EXPECTED_PRODUCT=5523
matches=()

shopt -s nullglob
for candidate in "$SYSFS_ROOT"/*; do
  [ -f "$candidate/idVendor" ] && [ -f "$candidate/idProduct" ] || continue
  vendor=$(tr '[:upper:]' '[:lower:]' < "$candidate/idVendor")
  product=$(tr '[:upper:]' '[:lower:]' < "$candidate/idProduct")
  if [ "$vendor" = "$EXPECTED_VENDOR" ] && [ "$product" = "$EXPECTED_PRODUCT" ]; then
    matches+=("$candidate")
  fi
done

if [ "${#matches[@]}" -ne 1 ]; then
  echo "BIO USB preflight requires exactly one approved device" >&2
  exit 1
fi

sysfs_device=${matches[0]}
bus=$(<"$sysfs_device/busnum")
device=$(<"$sysfs_device/devnum")
sysfs_dev=$(<"$sysfs_device/dev")
[[ "$bus" =~ ^[0-9]+$ && "$device" =~ ^[0-9]+$ && "$sysfs_dev" =~ ^[0-9]+:[0-9]+$ ]] || {
  echo "BIO USB sysfs metadata is invalid" >&2
  exit 1
}

printf -v bus_padded '%03d' "$((10#$bus))"
printf -v device_padded '%03d' "$((10#$device))"
device_path="$DEV_ROOT/$bus_padded/$device_padded"
[ -e "$device_path" ] || {
  echo "BIO USB character device is unavailable" >&2
  exit 1
}

# GNU stat의 type/major/minor/GID를 한 번에 읽어 node 교체 경합과 일반 파일
# 대체를 함께 차단한다. sysfs의 dev 번호까지 같아야 descriptor와 node가 같다.
stat_value=$(stat -c '%F|%t|%T|%g' "$device_path")
IFS='|' read -r file_type major_hex minor_hex device_gid <<< "$stat_value"
[[ "$file_type" = "character special file" && "$major_hex" =~ ^[0-9a-fA-F]+$ && "$minor_hex" =~ ^[0-9a-fA-F]+$ ]] || {
  echo "BIO USB node is not a character device" >&2
  exit 1
}
[[ "$device_gid" =~ ^[0-9]+$ ]] || {
  echo "BIO USB device group is invalid" >&2
  exit 1
}

node_dev="$((16#$major_hex)):$((16#$minor_hex))"
[ "$node_dev" = "$sysfs_dev" ] || {
  echo "BIO USB sysfs and character device do not match" >&2
  exit 1
}

printf 'GATEWAY_BIO_USB_DEVICE=%s\n' "$device_path"
printf 'GATEWAY_BIO_USB_GID=%s\n' "$device_gid"
