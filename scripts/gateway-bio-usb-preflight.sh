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

read_sysfs_value() {
  local value
  IFS= read -r value < "$1" || return 1
  printf '%s' "$value"
}

shopt -s nullglob
for candidate in "$SYSFS_ROOT"/*; do
  [ -f "$candidate/idVendor" ] && [ -f "$candidate/idProduct" ] || continue
  if ! vendor=$(read_sysfs_value "$candidate/idVendor" 2>/dev/null); then
    echo "BIO_USB_PREFLIGHT_SYSFS_READ_FAILED" >&2
    exit 1
  fi
  if ! product=$(read_sysfs_value "$candidate/idProduct" 2>/dev/null); then
    echo "BIO_USB_PREFLIGHT_SYSFS_READ_FAILED" >&2
    exit 1
  fi
  vendor=$(printf '%s' "$vendor" | tr '[:upper:]' '[:lower:]')
  product=$(printf '%s' "$product" | tr '[:upper:]' '[:lower:]')
  if [ "$vendor" = "$EXPECTED_VENDOR" ] && [ "$product" = "$EXPECTED_PRODUCT" ]; then
    matches+=("$candidate")
  fi
done

if [ "${#matches[@]}" -ne 1 ]; then
  echo "BIO USB preflight requires exactly one approved device" >&2
  exit 1
fi

sysfs_device=${matches[0]}
# sysfs VID:PID만 같아도 다른 interface/endpoint라면 장비를 열지 않는다.
# 커널이 제공한 binary descriptor를 read-only로 검증한다. host에는 Node/libusb를
# 요구하지 않으며 실제 open/claim 뒤 재검증은 BioDirectUsbConnection이 다시 한다.
# descriptor 길이를 먼저 검사하여 잘린 자료·0-length·다중 interface를 거부한다.
if ! od -An -v -tu1 "$sysfs_device/descriptors" 2>/dev/null | awk '
  { for (i=1;i<=NF;i++) b[++n]=$i }
  END {
    if (n<18 || b[1]!=18 || b[2]!=1 || b[9]!=134 || b[10]!=26 || b[11]!=35 || b[12]!=85 || b[18]!=1) exit 1;
    for (p=19;p<=n;p+=len) {
      len=b[p]; type=b[p+1]; if (len<2 || p+len-1>n) exit 1;
      if (type==2) { if(len!=9 || b[p+4]!=1) exit 1; configs++; }
      if (type==4) { if(len!=9 || b[p+2]!=0 || b[p+3]!=0 || b[p+4]!=3) exit 1; interfaces++; }
      if (type==5) {
        if(len!=7 || interfaces!=1) exit 1;
        if(b[p+2]==130 && b[p+3]==2 && b[p+4]==32 && b[p+5]==0) input++;
        else if(b[p+2]==2 && b[p+3]==2 && b[p+4]==32 && b[p+5]==0) output++;
        else if(b[p+2]==129 && b[p+3]==3 && b[p+4]==8 && b[p+5]==0) interrupt++;
        else exit 1;
      }
    }
    if(configs!=1 || interfaces!=1 || input!=1 || output!=1 || interrupt!=1) exit 1;
  }'; then
  echo "BIO_USB_PREFLIGHT_DESCRIPTOR_INVALID" >&2
  exit 1
fi
# Redirection 오류에는 sysfs basename이 포함될 수 있으므로 하위 stderr를 버리고
# 외부에는 고정 code만 보낸다. TOCTOU로 파일이 사라져도 raw topology는 숨긴다.
if ! bus=$(read_sysfs_value "$sysfs_device/busnum" 2>/dev/null) ||
   ! device=$(read_sysfs_value "$sysfs_device/devnum" 2>/dev/null) ||
   ! sysfs_dev=$(read_sysfs_value "$sysfs_device/dev" 2>/dev/null); then
  echo "BIO_USB_PREFLIGHT_SYSFS_READ_FAILED" >&2
  exit 1
fi
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
if ! stat_value=$(stat -c '%F|%t|%T|%g' "$device_path" 2>/dev/null); then
  echo "BIO_USB_PREFLIGHT_STAT_FAILED" >&2
  exit 1
fi
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
