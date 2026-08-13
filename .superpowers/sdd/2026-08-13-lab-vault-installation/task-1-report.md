# Task 1 구현 보고서: Docker Lab Vault 수명주기

## 상태

DONE

## 구현 내용

- `scripts/pki/lab-vault.sh`에 `start`, `status`, `stop`, `reset --confirm-lab-destroy` 명령을 추가했다.
- `PKI_ENV=lab`이 아닌 실행을 Docker 호출 전에 거부한다.
- Vault는 `127.0.0.1:18200`에만 노출되는 persistent file-storage server mode로 실행하며, 최초 `operator init` 결과에서 root token과 unseal key를 분리 저장한다.
- token과 Lab 디렉터리는 각각 `0600`, `0700` 권한으로 생성한다.
- `start`는 실행 중 container를 재생성하지 않고, `stop`은 container와 Lab identity를 보존한다.
- `reset`은 정확한 `--confirm-lab-destroy` 인자가 있을 때만 Lab container와 Lab Vault 디렉터리를 제거한다.
- 루트 `package.json`에 `lab:vault`, `test:lab:vault` 명령을 추가했다.

## TDD 및 검증

1. 스크립트가 없는 상태에서 `node --test scripts/pki/lab-vault.test.mjs`를 실행해 실패를 확인했다.
2. fake Docker 기반 테스트로 production 거부, 권한, secret 비출력, start 멱등성, status/stop, reset 확인 인자를 검증했다.
3. 최종 검증 명령: `pnpm test:lab:vault && git diff --check && bash -n scripts/pki/lab-vault.sh`
4. 결과: 5개 테스트 통과, diff whitespace 오류 없음, Bash 문법 검사 통과.

## 다음 Task 입력

- Task 2는 이 스크립트가 실행한 Lab Vault에 `bootstrap-lab-vault.sh prepare`를 연결하고, Lab Root와 세 intermediate CSR 자동 서명을 구현한다.
- 실제 Docker/Vault 이미지 실행 검증은 Task 4 통합 bootstrap에서 수행한다. Task 1은 Docker 명령 계약을 fake Docker로 격리 검증했다.

## Fix Round1

- 제품 실행에서 container 이름은 `led-control-lab-vault`, 삭제 경로는 저장소의 `.local/lab-vault`로 고정했다. `LAB_VAULT_CONTAINER`, `LAB_VAULT_DIR`, `DOCKER_BIN` 재정의는 거부한다.
- fake Docker는 `LAB_VAULT_TEST_MODE=1` 및 `NODE_TEST_CONTEXT=lab-vault-contract`가 함께 있는 계약 테스트에서만 주입할 수 있다. 제품 실행에서 이 주입 경계를 사용하면 Docker 호출 전에 실패한다.
- `reset`과 기존 container의 start/status/stop은 `led-control.scope=lab-vault` label을 inspect해 Lab 소유가 확인될 때만 동작한다. Lab Vault 디렉터리와 `.local` symlink는 제거하지 않는다.
- Vault 실행 argv에서 token을 제거했다. `VAULT_DEV_ROOT_TOKEN_ID`와 `VAULT_DEV_LISTEN_ADDRESS`는 Docker 환경으로 전달하고, container 명령은 `server -dev`만 사용한다.
- 포트는 1부터 65535까지만 허용하며, 새 token 생성 직후 `docker run`이 실패하면 해당 token 파일을 제거한다.
- Fix Round1 검증: `pnpm test:lab:vault` 9개 통과, `bash -n scripts/pki/lab-vault.sh`, `git diff --check` 통과.

## Fix Round2

- 제품 스크립트에서 `LAB_VAULT_TEST_*`, `NODE_TEST_CONTEXT`, `DOCKER_BIN`과 모든 테스트 전용 경로 주입을 제거했다. container 이름은 `led-control-lab-vault`, 삭제 경로는 스크립트가 위치한 저장소의 `.local/lab-vault`로 항상 고정된다.
- 계약 테스트는 제품 스크립트를 임시 fake repository의 `scripts/pki`에 복사하고, `PATH` 앞의 fake `docker` 실행 파일로 동작을 검증한다. 따라서 test 실행의 삭제 경로도 임시 repository 안으로 자연스럽게 한정된다.
- root token 파일은 read-only mount로만 container에 전달한다. 고정된 `sh -ec` entrypoint가 container 내부에서 파일을 읽어 `VAULT_DEV_ROOT_TOKEN_ID`를 export한 뒤 `vault server -dev`를 exec한다.
- Docker `Config.Env` 입력인 `--env VAULT_DEV_ROOT_TOKEN_ID`와 Vault argv의 `-dev-root-token-id=<token>`을 제거했다. fake Docker 계약 테스트는 Docker run 인자와 config 입력 어디에도 실제 token 문자열이 없음을 확인한다.
- 기존 label 소유 확인, symlink 거부, 포트 범위 검증, Docker run 실패 시 신규 token 정리 동작을 유지했다.
- Fix Round2 검증: `pnpm test:lab:vault` 6개 통과, `bash -n scripts/pki/lab-vault.sh`, `git diff --check` 통과.

## Fix Round3

- Vault dev mode를 제거하고 `.local/lab-vault/data`를 `/vault/file`에 mount하는 persistent file-storage server mode로 전환했다. `config.hcl`은 `0.0.0.0:8200` listener, `tls_disable = 1`, loopback `api_addr`를 사용한다.
- container 실행 명령, Docker 환경과 Docker config 입력에는 root token 또는 unseal key가 없다. 최초 초기화는 `docker exec vault operator init -key-shares=1 -key-threshold=1 -format=json` stdout을 `0600` 임시 파일로 수집하고 Node로 검증해 `root-token`, `unseal-key`를 `0600` 원자 파일로 저장한다.
- unseal key는 `docker exec -i ... vault operator unseal`의 stdin으로만 전달한다. stop 후 재시작은 persistent data와 저장된 unseal key로 unseal하며 init을 반복하지 않는다.
- 계약 테스트는 persistent config, data mount, init 출력의 콘솔 비노출, Docker run/config/log의 secret 비노출, file mode, 재시작 unseal, reset label/confirm, symlink/포트/실패 정리를 검증한다.
- Fix Round3 검증: `pnpm test:lab:vault` 5개 통과, `bash -n scripts/pki/lab-vault.sh`, `git diff --check` 통과.
