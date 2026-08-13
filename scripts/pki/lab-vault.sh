#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
LOCAL_DIR="$ROOT_DIR/.local"
LAB_VAULT_DIR="$LOCAL_DIR/lab-vault"
LAB_VAULT_DATA_DIR="$LAB_VAULT_DIR/data"
LAB_VAULT_CONFIG_PATH="$LAB_VAULT_DIR/config.hcl"
LAB_VAULT_CONTAINER="led-control-lab-vault"
LAB_VAULT_SCOPE_LABEL="led-control.scope=lab-vault"
PKI_ENV="${PKI_ENV:-}"
LAB_VAULT_IMAGE="${LAB_VAULT_IMAGE:-hashicorp/vault:1.17.6}"
LAB_VAULT_PORT="${LAB_VAULT_PORT:-18200}"
ROOT_TOKEN_PATH="$LAB_VAULT_DIR/root-token"
UNSEAL_KEY_PATH="$LAB_VAULT_DIR/unseal-key"

die() {
  printf '[lab-vault] %s\n' "$*" >&2
  exit 1
}

validate_lab_directory() {
  [[ ! -L "$LOCAL_DIR" ]] || die ".local symlink는 Lab Vault에서 허용하지 않습니다."
  [[ ! -L "$LAB_VAULT_DIR" ]] || die "Lab Vault 디렉터리 symlink는 허용하지 않습니다."
  [[ "$LAB_VAULT_DIR" == "$ROOT_DIR/.local/lab-vault" ]] || die "Lab Vault 삭제 경로가 올바르지 않습니다."
}

require_lab_environment() {
  [[ "$PKI_ENV" == "lab" ]] || die "이 명령은 PKI_ENV=lab에서만 실행할 수 있습니다."
  [[ "$LAB_VAULT_PORT" =~ ^[0-9]{1,5}$ ]] || die "LAB_VAULT_PORT는 1부터 65535 사이여야 합니다."
  (( 10#$LAB_VAULT_PORT >= 1 && 10#$LAB_VAULT_PORT <= 65535 )) || die "LAB_VAULT_PORT는 1부터 65535 사이여야 합니다."
  command -v docker >/dev/null 2>&1 || die "Docker 실행 파일을 찾을 수 없습니다."
  command -v node >/dev/null 2>&1 || die "Vault 초기화 결과를 검증할 Node.js를 찾을 수 없습니다."
  validate_lab_directory
}

container_id() {
  docker ps -aq --filter "name=^/${LAB_VAULT_CONTAINER}$"
}

container_label() {
  docker inspect -f '{{ index .Config.Labels "led-control.scope" }}' "$1"
}

assert_lab_container() {
  [[ "$(container_label "$1")" == "lab-vault" ]] || die "동일 이름의 container가 Lab Vault 소유 label을 가지지 않아 작업을 중단합니다."
}

container_is_running() {
  [[ "$(docker inspect -f '{{.State.Running}}' "$1")" == "true" || "$(docker inspect -f '{{.State.Running}}' "$1")" == "running" ]]
}

ensure_lab_layout() {
  [[ ! -L "$LOCAL_DIR" && ! -L "$LAB_VAULT_DIR" && ! -L "$LAB_VAULT_DATA_DIR" ]] || die "Lab Vault symlink는 허용하지 않습니다."
  mkdir -p "$LOCAL_DIR" "$LAB_VAULT_DIR" "$LAB_VAULT_DATA_DIR"
  chmod 0700 "$LOCAL_DIR" "$LAB_VAULT_DIR" "$LAB_VAULT_DATA_DIR"

  local temporary
  temporary="$(mktemp "$LAB_VAULT_DIR/.config.XXXXXX")"
  cat >"$temporary" <<EOF
storage "file" {
  path = "/vault/file"
}

listener "tcp" {
  address = "0.0.0.0:8200"
  tls_disable = 1
}

api_addr = "http://127.0.0.1:${LAB_VAULT_PORT}"
EOF
  chmod 0644 "$temporary"
  mv -f "$temporary" "$LAB_VAULT_CONFIG_PATH"
}

vault_state() {
  local status_file exit_code state
  status_file="$(mktemp "$LAB_VAULT_DIR/.status.XXXXXX")"
  if docker exec "$1" vault status -format=json >"$status_file" 2>/dev/null; then
    exit_code=0
  else
    exit_code=$?
  fi
  [[ "$exit_code" -eq 0 || "$exit_code" -eq 2 ]] || {
    rm -f "$status_file"
    die "Lab Vault 상태를 확인할 수 없습니다."
  }
  state="$(node - "$status_file" <<'NODE'
const fs = require("node:fs");
const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (typeof status.initialized !== "boolean" || typeof status.sealed !== "boolean") process.exit(1);
process.stdout.write(`${status.initialized ? "initialized" : "uninitialized"}:${status.sealed ? "sealed" : "unsealed"}`);
NODE
  )" || {
    rm -f "$status_file"
    die "Lab Vault 상태 응답 형식이 올바르지 않습니다."
  }
  rm -f "$status_file"
  printf '%s\n' "$state"
}

wait_for_vault() {
  local id="$1" attempt exit_code
  for attempt in {1..20}; do
    if docker exec "$id" vault status -format=json >/dev/null 2>&1; then
      return
    else
      exit_code=$?
    fi
    [[ "$exit_code" -eq 2 ]] && return
    sleep 1
  done
  die "Lab Vault server가 시작 시간 안에 응답하지 않았습니다."
}

store_initialization_credentials() {
  local init_file="$1"
  node - "$init_file" "$ROOT_TOKEN_PATH" "$UNSEAL_KEY_PATH" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [initPath, rootTokenPath, unsealKeyPath] = process.argv.slice(2);
const result = JSON.parse(fs.readFileSync(initPath, "utf8"));
if (typeof result.root_token !== "string" || result.root_token.length === 0 || !Array.isArray(result.keys_base64) || result.keys_base64.length !== 1 || typeof result.keys_base64[0] !== "string" || result.keys_base64[0].length === 0) {
  process.exit(1);
}
for (const target of [rootTokenPath, unsealKeyPath]) {
  if (fs.existsSync(target) || fs.lstatSync(path.dirname(target)).isSymbolicLink()) process.exit(1);
}
function writeAtomically(target, value) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Math.random().toString(16).slice(2)}`);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${value}\n`, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}
try {
  writeAtomically(rootTokenPath, result.root_token);
  writeAtomically(unsealKeyPath, result.keys_base64[0]);
} catch (error) {
  for (const target of [rootTokenPath, unsealKeyPath]) {
    if (fs.existsSync(target)) fs.rmSync(target);
  }
  throw error;
}
NODE
}

initialize_or_unseal() {
  local id="$1" state init_file
  state="$(vault_state "$id")"
  if [[ "$state" == "uninitialized:sealed" ]]; then
    init_file="$(mktemp "$LAB_VAULT_DIR/.init.XXXXXX")"
    chmod 0600 "$init_file"
    if ! docker exec "$id" vault operator init -key-shares=1 -key-threshold=1 -format=json >"$init_file"; then
      rm -f "$init_file"
      die "Lab Vault 초기화에 실패했습니다."
    fi
    if ! store_initialization_credentials "$init_file"; then
      rm -f "$init_file"
      die "Lab Vault 초기화 credential 저장에 실패했습니다. reset 후 다시 시작하세요."
    fi
    rm -f "$init_file"
    state="$(vault_state "$id")"
  fi

  [[ "$state" == "initialized:sealed" || "$state" == "initialized:unsealed" ]] || die "Lab Vault 초기화 상태가 올바르지 않습니다."
  [[ -r "$ROOT_TOKEN_PATH" && -r "$UNSEAL_KEY_PATH" && ! -L "$ROOT_TOKEN_PATH" && ! -L "$UNSEAL_KEY_PATH" ]] || die "Lab Vault credential 파일이 없습니다. reset 후 다시 시작하세요."
  if [[ "$state" == "initialized:sealed" ]]; then
    docker exec -i "$id" vault operator unseal >/dev/null <"$UNSEAL_KEY_PATH" || die "Lab Vault unseal에 실패했습니다."
  fi
  [[ "$(vault_state "$id")" == "initialized:unsealed" ]] || die "Lab Vault가 unseal 상태가 아닙니다."
}

remove_new_credentials_after_start_failure() {
  rm -f "$ROOT_TOKEN_PATH" "$UNSEAL_KEY_PATH"
}

start() {
  local id
  id="$(container_id)"
  if [[ -n "$id" ]]; then
    assert_lab_container "$id"
    if container_is_running "$id"; then
      wait_for_vault "$id"
      initialize_or_unseal "$id"
      printf 'Lab Vault is already running at http://127.0.0.1:%s\n' "$LAB_VAULT_PORT"
      return
    fi
    docker start "$id" >/dev/null
    wait_for_vault "$id"
    initialize_or_unseal "$id"
    printf 'Lab Vault started at http://127.0.0.1:%s\n' "$LAB_VAULT_PORT"
    return
  fi

  ensure_lab_layout
  if ! docker run -d \
    --name "$LAB_VAULT_CONTAINER" \
    --label "$LAB_VAULT_SCOPE_LABEL" \
    --cap-add IPC_LOCK \
    --publish "127.0.0.1:${LAB_VAULT_PORT}:8200" \
    --volume "${LAB_VAULT_DATA_DIR}:/vault/file" \
    --volume "${LAB_VAULT_CONFIG_PATH}:/vault/config/config.hcl:ro" \
    --entrypoint vault \
    "$LAB_VAULT_IMAGE" server -config=/vault/config/config.hcl \
    >/dev/null; then
    remove_new_credentials_after_start_failure
    die "Lab Vault container 시작에 실패했습니다."
  fi
  wait_for_vault "$LAB_VAULT_CONTAINER"
  initialize_or_unseal "$LAB_VAULT_CONTAINER"
  printf 'Lab Vault started at http://127.0.0.1:%s\n' "$LAB_VAULT_PORT"
}

status() {
  local id
  id="$(container_id)"
  [[ -n "$id" ]] || die "Lab Vault container가 실행 중이 아닙니다. start를 먼저 실행하세요."
  assert_lab_container "$id"
  container_is_running "$id" || die "Lab Vault container가 중지되어 있습니다. start를 실행하세요."
  docker exec "$id" vault status -address=http://127.0.0.1:8200
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
    docker stop "$id" >/dev/null
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
    docker rm -f "$id" >/dev/null
  fi
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
