# Task 1 구현 보고서: Docker Lab Vault 수명주기

## 상태

DONE

## 구현 내용

- `scripts/pki/lab-vault.sh`에 `start`, `status`, `stop`, `reset --confirm-lab-destroy` 명령을 추가했다.
- `PKI_ENV=lab`이 아닌 실행을 Docker 호출 전에 거부한다.
- Vault dev container는 `127.0.0.1:18200`에만 노출하며 root token은 `.local/lab-vault/root-token`에서 읽어 `VAULT_DEV_ROOT_TOKEN_ID` 환경으로 전달한다.
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
