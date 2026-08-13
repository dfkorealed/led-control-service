#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
LOCAL_DIR="$ROOT_DIR/.local"
REQUESTED_LAB_VAULT_DIR="${LAB_VAULT_DIR:-}"
REQUESTED_LAB_VAULT_CONTAINER="${LAB_VAULT_CONTAINER:-}"
REQUESTED_DOCKER_BIN="${DOCKER_BIN:-}"
LAB_VAULT_DIR="$LOCAL_DIR/lab-vault"
LAB_VAULT_CONTAINER="led-control-lab-vault"
LAB_VAULT_SCOPE_LABEL="led-control.scope=lab-vault"
PKI_ENV="${PKI_ENV:-}"
LAB_VAULT_IMAGE="${LAB_VAULT_IMAGE:-hashicorp/vault:1.17.6}"
LAB_VAULT_PORT="${LAB_VAULT_PORT:-18200}"
DOCKER_BIN="docker"
ROOT_TOKEN_PATH="$LAB_VAULT_DIR/root-token"
TOKEN_CREATED=0

die() {
  printf '[lab-vault] %s\n' "$*" >&2
  exit 1
}

configure_test_boundary() {
  local has_test_override=0
  [[ -n "${LAB_VAULT_TEST_MODE:-}" || -n "${LAB_VAULT_TEST_DIR:-}" || -n "${LAB_VAULT_TEST_DOCKER_BIN:-}" ]] && has_test_override=1

  if [[ "$has_test_override" -eq 0 ]]; then
    return
  fi

  [[ "${LAB_VAULT_TEST_MODE:-}" == "1" && "${NODE_TEST_CONTEXT:-}" == "lab-vault-contract" ]] || die "LAB_VAULT_TEST_* 값은 Node 계약 테스트에서만 사용할 수 있습니다."
  [[ -n "${LAB_VAULT_TEST_DIR:-}" && -n "${LAB_VAULT_TEST_DOCKER_BIN:-}" ]] || die "Lab Vault 계약 테스트에는 디렉터리와 Docker fixture가 모두 필요합니다."
  [[ "$LAB_VAULT_TEST_DIR" == */lab-vault ]] || die "테스트 Lab Vault 디렉터리는 lab-vault로 끝나야 합니다."
  LAB_VAULT_DIR="$LAB_VAULT_TEST_DIR"
  ROOT_TOKEN_PATH="$LAB_VAULT_DIR/root-token"
  DOCKER_BIN="$LAB_VAULT_TEST_DOCKER_BIN"
}

validate_lab_directory() {
  [[ ! -L "$LOCAL_DIR" ]] || die ".local symlink는 Lab Vault에서 허용하지 않습니다."
  [[ ! -L "$LAB_VAULT_DIR" ]] || die "Lab Vault 디렉터리 symlink는 허용하지 않습니다."

  if [[ "${LAB_VAULT_TEST_MODE:-}" == "1" ]]; then
    return
  fi

  [[ "$LAB_VAULT_DIR" == "$ROOT_DIR/.local/lab-vault" ]] || die "Lab Vault 삭제 경로가 올바르지 않습니다."
}

require_lab_environment() {
  [[ "$PKI_ENV" == "lab" ]] || die "이 명령은 PKI_ENV=lab에서만 실행할 수 있습니다."
  [[ -z "$REQUESTED_LAB_VAULT_DIR" && -z "$REQUESTED_LAB_VAULT_CONTAINER" && -z "$REQUESTED_DOCKER_BIN" ]] || die "Lab Vault 경계는 재정의할 수 없습니다."
  [[ "$LAB_VAULT_PORT" =~ ^[0-9]{1,5}$ ]] || die "LAB_VAULT_PORT는 1부터 65535 사이여야 합니다."
  (( 10#$LAB_VAULT_PORT >= 1 && 10#$LAB_VAULT_PORT <= 65535 )) || die "LAB_VAULT_PORT는 1부터 65535 사이여야 합니다."
  [[ -x "$(command -v "$DOCKER_BIN")" || -f "$DOCKER_BIN" ]] || die "Docker 실행 파일을 찾을 수 없습니다."
  validate_lab_directory
}

container_id() {
  "$DOCKER_BIN" ps -aq --filter "name=^/${LAB_VAULT_CONTAINER}$"
}

container_label() {
  local id="$1"
  "$DOCKER_BIN" inspect -f '{{ index .Config.Labels "led-control.scope" }}' "$id"
}

assert_lab_container() {
  local id="$1"
  [[ "$(container_label "$id")" == "lab-vault" ]] || die "동일 이름의 container가 Lab Vault 소유 label을 가지지 않아 작업을 중단합니다."
}

container_is_running() {
  local id="$1"
  [[ "$("$DOCKER_BIN" inspect -f '{{.State.Running}}' "$id")" == "true" || "$("$DOCKER_BIN" inspect -f '{{.State.Running}}' "$id")" == "running" ]]
}

ensure_lab_directory() {
  [[ ! -L "$LOCAL_DIR" && ! -L "$LAB_VAULT_DIR" ]] || die "Lab Vault symlink는 허용하지 않습니다."
  mkdir -p "$LOCAL_DIR" "$LAB_VAULT_DIR"
  chmod 0700 "$LOCAL_DIR" "$LAB_VAULT_DIR"
}

ensure_root_token() {
  if [[ -e "$ROOT_TOKEN_PATH" ]]; then
    [[ -s "$ROOT_TOKEN_PATH" && ! -L "$ROOT_TOKEN_PATH" ]] || die "Lab Vault root token 파일이 올바르지 않습니다. reset 후 다시 시작하세요."
    chmod 0600 "$ROOT_TOKEN_PATH"
    return
  fi

  ensure_lab_directory
  local temporary
  temporary="$(mktemp "$LAB_VAULT_DIR/.root-token.XXXXXX")"
  openssl rand -hex 32 >"$temporary" || {
    rm -f "$temporary"
    die "Lab Vault root token 생성에 실패했습니다."
  }
  chmod 0600 "$temporary"
  mv -f "$temporary" "$ROOT_TOKEN_PATH"
  TOKEN_CREATED=1
}

remove_new_token_after_start_failure() {
  [[ "$TOKEN_CREATED" -eq 1 ]] || return
  rm -f "$ROOT_TOKEN_PATH"
}

start() {
  local id
  id="$(container_id)"
  if [[ -n "$id" ]]; then
    assert_lab_container "$id"
    [[ -r "$ROOT_TOKEN_PATH" ]] || die "기존 Lab Vault container의 root token 파일이 없습니다. reset 후 다시 시작하세요."
    if container_is_running "$id"; then
      printf 'Lab Vault is already running at http://127.0.0.1:%s\n' "$LAB_VAULT_PORT"
      return
    fi
    "$DOCKER_BIN" start "$id" >/dev/null
    printf 'Lab Vault started at http://127.0.0.1:%s\n' "$LAB_VAULT_PORT"
    return
  fi

  ensure_root_token
  if ! VAULT_DEV_ROOT_TOKEN_ID="$(<"$ROOT_TOKEN_PATH")" \
    VAULT_DEV_LISTEN_ADDRESS="0.0.0.0:8200" \
    "$DOCKER_BIN" run -d \
      --name "$LAB_VAULT_CONTAINER" \
      --label "$LAB_VAULT_SCOPE_LABEL" \
      --cap-add IPC_LOCK \
      --publish "127.0.0.1:${LAB_VAULT_PORT}:8200" \
      --env VAULT_DEV_ROOT_TOKEN_ID \
      --env VAULT_DEV_LISTEN_ADDRESS \
      "$LAB_VAULT_IMAGE" server -dev \
      >/dev/null; then
    remove_new_token_after_start_failure
    die "Lab Vault container 시작에 실패했습니다."
  fi
  printf 'Lab Vault started at http://127.0.0.1:%s\n' "$LAB_VAULT_PORT"
}

status() {
  local id
  id="$(container_id)"
  [[ -n "$id" ]] || die "Lab Vault container가 실행 중이 아닙니다. start를 먼저 실행하세요."
  assert_lab_container "$id"
  container_is_running "$id" || die "Lab Vault container가 중지되어 있습니다. start를 실행하세요."
  "$DOCKER_BIN" exec "$id" vault status -address=http://127.0.0.1:8200
}

stop() {
  local id
  id="$(container_id)"
  if [[ -z "$id" ]]; then
    printf 'Lab Vault container is not present.\n'
    return
  fi
  assert_lab_container "$id"
  if container_is_running "$id"; then
    "$DOCKER_BIN" stop "$id" >/dev/null
    printf 'Lab Vault stopped.\n'
    return
  fi
  printf 'Lab Vault is already stopped.\n'
}

reset() {
  [[ "${2:-}" == "--confirm-lab-destroy" && "$#" -eq 2 ]] || die "reset에는 --confirm-lab-destroy 확인 인자가 필요합니다."
  [[ ! -L "$LAB_VAULT_DIR" ]] || die "Lab Vault 디렉터리 symlink는 제거하지 않습니다."
  local id
  id="$(container_id)"
  if [[ -n "$id" ]]; then
    assert_lab_container "$id"
    "$DOCKER_BIN" rm -f "$id" >/dev/null
  fi
  rm -rf "$LAB_VAULT_DIR"
  printf 'Lab Vault container and Lab-only files were removed.\n'
}

configure_test_boundary
require_lab_environment

case "${1:-}" in
  start) [[ "$#" -eq 1 ]] || die "usage: $0 start|status|stop|reset --confirm-lab-destroy"; start ;;
  status) [[ "$#" -eq 1 ]] || die "usage: $0 start|status|stop|reset --confirm-lab-destroy"; status ;;
  stop) [[ "$#" -eq 1 ]] || die "usage: $0 start|status|stop|reset --confirm-lab-destroy"; stop ;;
  reset) reset "$@" ;;
  *) die "usage: $0 start|status|stop|reset --confirm-lab-destroy" ;;
esac
