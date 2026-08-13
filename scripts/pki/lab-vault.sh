#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKI_ENV="${PKI_ENV:-}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
LAB_VAULT_DIR="${LAB_VAULT_DIR:-$ROOT_DIR/.local/lab-vault}"
LAB_VAULT_CONTAINER="${LAB_VAULT_CONTAINER:-led-control-lab-vault}"
LAB_VAULT_IMAGE="${LAB_VAULT_IMAGE:-hashicorp/vault:1.17.6}"
LAB_VAULT_PORT="${LAB_VAULT_PORT:-18200}"
ROOT_TOKEN_PATH="$LAB_VAULT_DIR/root-token"

die() {
  printf '[lab-vault] %s\n' "$*" >&2
  exit 1
}

require_lab_environment() {
  [[ "$PKI_ENV" == "lab" ]] || die "이 명령은 PKI_ENV=lab에서만 실행할 수 있습니다."
  case "$LAB_VAULT_DIR" in
    "$ROOT_DIR/.local/lab-vault"|*/lab-vault) ;;
    *) die "LAB_VAULT_DIR은 Lab 전용 lab-vault 디렉터리여야 합니다." ;;
  esac
  [[ "$LAB_VAULT_PORT" =~ ^[0-9]+$ ]] || die "LAB_VAULT_PORT는 숫자 포트여야 합니다."
  [[ -x "$(command -v "$DOCKER_BIN")" || -f "$DOCKER_BIN" ]] || die "Docker 실행 파일을 찾을 수 없습니다."
}

container_id() {
  "$DOCKER_BIN" ps -aq --filter "name=^/${LAB_VAULT_CONTAINER}$"
}

container_is_running() {
  local id
  id="$(container_id)"
  [[ -n "$id" ]] || return 1
  [[ "$("$DOCKER_BIN" inspect -f '{{.State.Running}}' "$id")" == "true" || "$("$DOCKER_BIN" inspect -f '{{.State.Running}}' "$id")" == "running" ]]
}

ensure_root_token() {
  if [[ -e "$ROOT_TOKEN_PATH" ]]; then
    [[ -s "$ROOT_TOKEN_PATH" ]] || die "Lab Vault root token 파일이 비어 있습니다. reset 후 다시 시작하세요."
    chmod 0600 "$ROOT_TOKEN_PATH"
    return
  fi

  mkdir -p "$LAB_VAULT_DIR"
  chmod 0700 "$LAB_VAULT_DIR"
  local temporary
  temporary="$(mktemp "$LAB_VAULT_DIR/.root-token.XXXXXX")"
  openssl rand -hex 32 >"$temporary" || {
    rm -f "$temporary"
    die "Lab Vault root token 생성에 실패했습니다."
  }
  chmod 0600 "$temporary"
  mv -f "$temporary" "$ROOT_TOKEN_PATH"
}

start() {
  local id
  id="$(container_id)"
  if [[ -n "$id" ]]; then
    [[ -r "$ROOT_TOKEN_PATH" ]] || die "기존 Lab Vault container의 root token 파일이 없습니다. reset 후 다시 시작하세요."
    if container_is_running; then
      printf 'Lab Vault is already running at http://127.0.0.1:%s\n' "$LAB_VAULT_PORT"
      return
    fi
    "$DOCKER_BIN" start "$id" >/dev/null
    printf 'Lab Vault started at http://127.0.0.1:%s\n' "$LAB_VAULT_PORT"
    return
  fi

  ensure_root_token
  "$DOCKER_BIN" run -d \
    --name "$LAB_VAULT_CONTAINER" \
    --cap-add IPC_LOCK \
    --publish "127.0.0.1:${LAB_VAULT_PORT}:8200" \
    --volume "${ROOT_TOKEN_PATH}:/run/secrets/lab-vault-root-token:ro" \
    --entrypoint sh \
    "$LAB_VAULT_IMAGE" \
    -ec 'exec vault server -dev -dev-listen-address=0.0.0.0:8200 -dev-root-token-id="$(cat /run/secrets/lab-vault-root-token)"' \
    >/dev/null
  printf 'Lab Vault started at http://127.0.0.1:%s\n' "$LAB_VAULT_PORT"
}

status() {
  local id
  id="$(container_id)"
  [[ -n "$id" ]] || die "Lab Vault container가 실행 중이 아닙니다. start를 먼저 실행하세요."
  container_is_running || die "Lab Vault container가 중지되어 있습니다. start를 실행하세요."
  "$DOCKER_BIN" exec "$id" vault status -address=http://127.0.0.1:8200
}

stop() {
  local id
  id="$(container_id)"
  if [[ -z "$id" ]]; then
    printf 'Lab Vault container is not present.\n'
    return
  fi
  if container_is_running; then
    "$DOCKER_BIN" stop "$id" >/dev/null
    printf 'Lab Vault stopped.\n'
    return
  fi
  printf 'Lab Vault is already stopped.\n'
}

reset() {
  [[ "${2:-}" == "--confirm-lab-destroy" && "$#" -eq 2 ]] || die "reset에는 --confirm-lab-destroy 확인 인자가 필요합니다."
  local id
  id="$(container_id)"
  [[ -z "$id" ]] || "$DOCKER_BIN" rm -f "$id" >/dev/null
  rm -rf "$LAB_VAULT_DIR"
  printf 'Lab Vault container and Lab-only files were removed.\n'
}

require_lab_environment

case "${1:-}" in
  start) [[ "$#" -eq 1 ]] || die "usage: $0 start|status|stop|reset --confirm-lab-destroy"; start ;;
  status) [[ "$#" -eq 1 ]] || die "usage: $0 start|status|stop|reset --confirm-lab-destroy"; status ;;
  stop) [[ "$#" -eq 1 ]] || die "usage: $0 start|status|stop|reset --confirm-lab-destroy"; stop ;;
  reset) reset "$@" ;;
  *) die "usage: $0 start|status|stop|reset --confirm-lab-destroy" ;;
esac
