#!/usr/bin/env bash

# Compose dotenv는 shell script가 아니다. 특히 현장 이름의 공백과 따옴표를
# 허용하면서도 $(), backtick 같은 문자열을 절대 실행하지 않도록 필요한 key만
# awk의 문자 파서로 읽는다. 동일 key가 여러 번 나오면 Compose처럼 마지막 값을 쓴다.
read_compose_dotenv_value() {
  local env_file=$1
  local requested_key=$2

  [[ "$requested_key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 2
  [ -f "$env_file" ] || return 1

  awk -v requested_key="$requested_key" '
    function ltrim(value) { sub(/^[[:space:]]+/, "", value); return value }
    function rtrim(value) { sub(/[[:space:]]+$/, "", value); return value }
    function invalid() { parse_error = 1 }
    {
      line = $0
      sub(/\r$/, "", line)
      line = ltrim(line)
      if (line == "" || substr(line, 1, 1) == "#") next
      if (substr(line, 1, 7) == "export ") line = ltrim(substr(line, 8))

      separator = index(line, "=")
      if (!separator) next
      key = rtrim(substr(line, 1, separator - 1))
      if (key != requested_key) next
      value = ltrim(substr(line, separator + 1))

      quote = substr(value, 1, 1)
      if (quote == "\"" || quote == "\047") {
        parsed = ""
        escaped = 0
        closed = 0
        for (i = 2; i <= length(value); i++) {
          character = substr(value, i, 1)
          if (quote == "\"" && escaped) {
            if (character == "n") parsed = parsed "\n"
            else if (character == "r") parsed = parsed "\r"
            else if (character == "t") parsed = parsed "\t"
            else parsed = parsed character
            escaped = 0
          } else if (quote == "\"" && character == "\\") {
            escaped = 1
          } else if (character == quote) {
            remainder = ltrim(substr(value, i + 1))
            if (remainder != "" && substr(remainder, 1, 1) != "#") invalid()
            closed = 1
            break
          } else {
            parsed = parsed character
          }
        }
        if (!closed || escaped) invalid()
      } else {
        parsed = value
        # Compose의 unquoted inline comment는 공백 뒤 #에서만 시작한다.
        if (match(parsed, /[[:space:]]+#/)) parsed = substr(parsed, 1, RSTART - 1)
        parsed = rtrim(parsed)
      }

      found = 1
      result = parsed
    }
    END {
      if (parse_error) exit 2
      if (!found) exit 1
      print result
    }
  ' "$env_file"
}

capture_gateway_data_snapshot() {
  local data_dir=$1
  local archive=$2
  local temporary="${archive}.tmp.$$"
  local owner
  owner="$(id -u):$(id -g)"

  # 운영 state는 gateway:gateway 0700이므로 SSH 계정의 tar는 정상 구성에서도
  # 실패한다. 데이터 읽기와 임시 archive 소유권 회수에만 sudo를 좁혀 사용한다.
  if ! sudo tar -C "$data_dir" -czf "$temporary" gateway mesh; then
    sudo rm -f "$temporary" >/dev/null 2>&1 || true
    return 1
  fi
  if ! sudo chown "$owner" "$temporary"; then
    sudo rm -f "$temporary" >/dev/null 2>&1 || true
    return 1
  fi
  chmod 0600 "$temporary"
  mv "$temporary" "$archive"
}

run_without_compose_shell_overrides() {
  (($# > 0)) || return 2

  # Compose interpolation에서 호출자의 exported 값이 --env-file보다 우선한다.
  # Raspberry Pi의 local Docker daemon에 필요한 PATH/HOME만 보존해, rollback
  # config와 실제 up이 동일한 dotenv 입력만 해석하도록 process 환경을 고정한다.
  env -i PATH="$PATH" HOME="$HOME" "$@"
}

extract_gateway_snapshot_sources() {
  local sources

  # `docker compose config --format json gateway-appliance`의 normalized volume
  # object만 읽는다. JSON escape가 필요한 특수 경로는 shell 재해석 위험 없이
  # 정확히 decode할 도구가 없으므로 허용하지 않고 배포를 중단한다.
  if ! sources=$(awk '
    function value_after_colon(line, value) {
      value = line
      sub(/^[[:space:]]*"[^"]+"[[:space:]]*:[[:space:]]*"/, "", value)
      sub(/"[,]?[[:space:]]*$/, "", value)
      return value
    }
    /^[[:space:]]*"volumes"[[:space:]]*:[[:space:]]*\[/ { in_volumes = 1; next }
    in_volumes && /^[[:space:]]*\][,]?[[:space:]]*$/ { in_volumes = 0; next }
    in_volumes && /^[[:space:]]*"type"[[:space:]]*:/ {
      type = value_after_colon($0)
      next
    }
    in_volumes && /^[[:space:]]*"source"[[:space:]]*:/ {
      source = value_after_colon($0)
      if (index(source, "\\") != 0) invalid = 1
      next
    }
    in_volumes && /^[[:space:]]*"target"[[:space:]]*:/ {
      target = value_after_colon($0)
      if (target == "/var/lib/led-control") {
        gateway_count++
        if (type != "bind" || source == "") invalid = 1
        gateway_source = source
      } else if (target == "/var/lib/bluetooth/mesh") {
        mesh_count++
        if (type != "bind" || source == "") invalid = 1
        mesh_source = source
      }
      type = ""
      source = ""
      next
    }
    END {
      if (invalid || gateway_count != 1 || mesh_count != 1) exit 2
      print gateway_source
      print mesh_source
    }
  '); then
    echo "GATEWAY_ROLLBACK_MOUNT_INVALID" >&2
    return 1
  fi
  printf '%s\n' "$sources"
}

canonical_gateway_snapshot_root() {
  local gateway_source=$1
  local mesh_source=$2
  local canonical_gateway
  local canonical_mesh
  local snapshot_root

  if [[ "$gateway_source" != /* || "$mesh_source" != /* ]] ||
     ! canonical_gateway=$(realpath "$gateway_source" 2>/dev/null) ||
     ! canonical_mesh=$(realpath "$mesh_source" 2>/dev/null) ||
     [ ! -d "$canonical_gateway" ] || [ ! -d "$canonical_mesh" ]; then
    echo "GATEWAY_ROLLBACK_SOURCE_INVALID" >&2
    return 1
  fi

  snapshot_root=${canonical_gateway%/gateway}
  # tar의 -C 범위를 root나 임의 공통 조상으로 넓히지 않는다. 두 expected bind가
  # 같은 non-root parent의 exact gateway/mesh sibling일 때만 snapshot한다.
  if [ -z "$snapshot_root" ] || [ "$snapshot_root" = / ] ||
     [ "$canonical_gateway" != "$snapshot_root/gateway" ] ||
     [ "$canonical_mesh" != "$snapshot_root/mesh" ]; then
    echo "GATEWAY_ROLLBACK_SOURCE_INVALID" >&2
    return 1
  fi
  printf '%s\n' "$snapshot_root"
}

resolve_current_gateway_snapshot_root() {
  local adapter=$1
  local env_file=$2
  local base_compose=$3
  local bio_compose=$4
  local rendered
  local sources
  local gateway_source
  local mesh_source
  local -a compose_args

  compose_args=(--env-file "$env_file" -f "$base_compose")
  case "$adapter" in
    bluez) ;;
    bio-usb) compose_args+=(-f "$bio_compose") ;;
    *) echo "GATEWAY_ROLLBACK_ADAPTER_INVALID" >&2; return 1 ;;
  esac

  if ! rendered=$(run_without_compose_shell_overrides \
      docker compose "${compose_args[@]}" config --format json gateway-appliance 2>/dev/null); then
    echo "GATEWAY_ROLLBACK_COMPOSE_CONFIG_FAILED" >&2
    return 1
  fi
  if ! sources=$(printf '%s\n' "$rendered" | extract_gateway_snapshot_sources); then
    return 1
  fi
  gateway_source=${sources%%$'\n'*}
  mesh_source=${sources#*$'\n'}
  [ "$gateway_source" != "$sources" ] || {
    echo "GATEWAY_ROLLBACK_MOUNT_INVALID" >&2
    return 1
  }
  canonical_gateway_snapshot_root "$gateway_source" "$mesh_source"
}

run_with_current_bio_device() {
  local device=$1
  local gid=$2
  shift 2

  [[ "$device" =~ ^/dev/bus/usb/[0-9]{3}/[0-9]{3}$ ]] || return 2
  [[ "$gid" =~ ^[0-9]+$ ]] || return 2
  (($# > 0)) || return 2

  # shell export와 --env-file보다 process environment가 우선한다. preflight 직후
  # 검증한 두 값만 해당 Compose 호출에 주입해 재연결 전 stale node를 배제한다.
  env -i PATH="$PATH" HOME="$HOME" \
    GATEWAY_BIO_USB_DEVICE="$device" GATEWAY_BIO_USB_GID="$gid" "$@"
}
