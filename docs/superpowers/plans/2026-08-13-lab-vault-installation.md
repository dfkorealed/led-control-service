# Lab Vault 기반 실장비 설치 시험 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 개발자가 MacBook과 Raspberry Pi에서 양산과 같은 제조 등록·claim·bootstrap·MQTT 인증 흐름을 반복 실행할 수 있는 Lab PKI 자동화와 한국어 runbook을 제공한다.

**Architecture:** 기존 Vault PKI API와 발급 스크립트를 그대로 조합하고 Lab 전용 Vault 수명주기, Root 서명, 제조 station 발급만 추가한다. 모든 secret은 `.local` 아래 권한 제한 파일로 관리하며 제품 API/Gateway에 Lab 우회 경로를 만들지 않는다.

**Tech Stack:** Bash, Docker, HashiCorp Vault, OpenSSL, Node.js test runner, existing NestJS/Gateway appliance scripts

## 전역 제약

- 모든 신규 PKI 명령은 `PKI_ENV=lab`만 허용한다.
- `.local/lab-vault`, `.local/lab-pki` 밖의 인증서와 데이터를 변경하지 않는다.
- private key와 token은 `0600`, secret 상위 디렉터리는 `0700`을 유지한다.
- stdout과 문서에 token, claim code 또는 private key 원문을 출력하지 않는다.
- 기존 제품 API, MQTT 계약과 Gateway bootstrap endpoint를 우회하지 않는다.
- 문서와 사용자 출력은 한국어로 작성한다.

---

### Task 1: Docker Lab Vault 수명주기

**Files:**
- Create: `scripts/pki/lab-vault.sh`
- Create: `scripts/pki/lab-vault.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `scripts/pki/lab-vault.sh start|status|stop|reset --confirm-lab-destroy`
- Produces: `.local/lab-vault/root-token`, loopback `VAULT_ADDR`

- [x] **Step 1: 실패 테스트 작성**

fake Docker 실행 파일로 `PKI_ENV=production` 거부, root token `0600`, start 멱등성, reset 확인 인자와 secret 비출력을 검증한다.

- [x] **Step 2: 실패 확인**

Run: `node --test scripts/pki/lab-vault.test.mjs`
Expected: `lab-vault.sh`가 없어 실패

- [x] **Step 3: 최소 구현**

Vault image를 loopback 포트의 persistent file-storage server mode로 실행한다. 최초 시작은 `operator init` 결과를 root token과 unseal key 파일로 저장하고, 재시작은 stdin unseal을 수행한다. `status`는 `vault status`, `stop`은 container와 data를 보존하며 `reset`만 Lab container와 Lab Vault 디렉터리를 제거한다.

- [x] **Step 4: 검증과 커밋**

Run: `node --test scripts/pki/lab-vault.test.mjs && git diff --check`

Commit: `feat(pki): add isolated lab vault lifecycle`

### Task 2: Lab Root와 intermediate 자동 서명

**Files:**
- Create: `scripts/pki/sign-lab-intermediates.sh`
- Create: `scripts/pki/sign-lab-intermediates.test.mjs`
- Modify: `scripts/pki/bootstrap-lab-vault.sh`

**Interfaces:**
- Consumes: `PKI_CSR_DIR`의 세 목적별 CSR
- Produces: `LAB_ROOT_DIR/root.crt`, `LAB_SIGNED_INTERMEDIATE_DIR/{gateway-device,gateway-mqtt,api-server}-intermediate.chain.crt`

- [ ] **Step 1: 실패 테스트 작성**

실제 OpenSSL CSR로 EC P-256 Root, pathlen 0 intermediate, chain 검증, `0600/0644` 권한, 같은 CSR 멱등성과 다른 CSR 충돌 거부를 검사한다.

- [ ] **Step 2: 실패 확인**

Run: `node --test scripts/pki/sign-lab-intermediates.test.mjs`
Expected: signer가 없어 실패

- [ ] **Step 3: 서명 구현**

Lab 전용 OpenSSL config와 serial을 생성하고 임시 파일 후 atomic rename으로 세 CSR을 서명한다. CSR fingerprint metadata가 기존 산출물과 다르면 실패한다.

- [ ] **Step 4: 검증과 커밋**

Run: `node --test scripts/pki/sign-lab-intermediates.test.mjs scripts/pki/pki-scripts.test.mjs`

Commit: `feat(pki): automate lab intermediate signing`

### Task 3: 제조 station CA와 인증서

**Files:**
- Create: `scripts/pki/issue-lab-manufacturing-station.sh`
- Create: `scripts/pki/issue-lab-manufacturing-station.test.mjs`

**Interfaces:**
- Produces: `manufacturing-ca.crt`, `station.crt`, `station.key`, `station.chain.crt`

- [ ] **Step 1: 실패 테스트 작성**

station certificate가 별도 CA로 서명되고 `clientAuth`만 가지며 key `0600`, CA `0644`, 동일 station 멱등성, 잘못된 이름과 production 실행 거부를 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `node --test scripts/pki/issue-lab-manufacturing-station.test.mjs`
Expected: issuer가 없어 실패

- [ ] **Step 3: 발급 구현**

ECDSA P-256 Manufacturing CA와 station key/CSR을 생성하고 clientAuth extension으로 서명한다. 기존 인증서의 subject/issuer/key 일치가 확인된 경우만 재사용한다.

- [ ] **Step 4: 검증과 커밋**

Run: `node --test scripts/pki/issue-lab-manufacturing-station.test.mjs && git diff --check`

Commit: `feat(pki): issue lab manufacturing station identity`

### Task 4: 통합 bootstrap과 API 실행 bundle

**Files:**
- Create: `scripts/pki/bootstrap-device-lab.sh`
- Create: `scripts/pki/bootstrap-device-lab.test.mjs`
- Modify: `scripts/pki/issue-lab-service-cert.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: `LAB_API_IP`, `LAB_MQTT_IP`, 선택적 `LAB_API_DNS`, `LAB_MQTT_DNS`
- Produces: `.local/lab-pki/lab.env`, API/MQTT service bundle, device CRL, policy-scoped Vault token file

- [ ] **Step 1: 실패 테스트 작성**

필수 도구 선검사, 실행 순서, production 거부, device/MQTT CRL, application token file 권한, 절대 경로 env, root token 미사용과 부분 실패 보존을 fake command로 검사한다.

- [ ] **Step 2: 실패 확인**

Run: `node --test scripts/pki/bootstrap-device-lab.test.mjs`
Expected: orchestrator가 없어 실패

- [ ] **Step 3: 통합 구현**

Vault start→prepare→sign→install→service/station issue→CRL→policy token→env 순서로 실행한다. `lab.env`에는 인증서 경로, MQTT/API URL, Vault mount/role과 token file 경로만 기록한다.

- [ ] **Step 4: 검증과 커밋**

Run: `node --test scripts/pki/*.test.mjs && pnpm test:lan-tls && git diff --check`

Commit: `feat(pki): bootstrap device lab trust environment`

### Task 5: 한국어 수동 설치 runbook과 전체 검증

**Files:**
- Create: `docs/runbooks/device-lab-first-install.md`
- Modify: `README.md`
- Modify: `infra/vault/README.md`
- Modify: `docs/lesson_leared.md`
- Modify: `docs/superpowers/plans/2026-08-13-lab-vault-installation.md`

**Interfaces:**
- Consumes: Task 1~4 명령과 산출물
- Produces: MacBook 서버 준비부터 Pi 제조 등록, 웹 claim, ESP32 검색·등록·제어까지의 단일 수동 절차

- [ ] **Step 1: runbook 작성**

각 단계에 목적, 명령, 정상 결과, 실패 진단과 reset 경계를 작성한다. 제조 enrollment 전 station identity, claim 후 Gateway ID, bootstrap 후 heartbeat, unprovisioned ESP32와 첫 status 판정 기준을 포함한다.

- [ ] **Step 2: 문서 계약 테스트와 shell syntax 검증**

Run: `bash -n scripts/pki/*.sh && node --test scripts/pki/*.test.mjs scripts/pki/pki-scripts.test.mjs`

- [ ] **Step 3: 저장소 전체 관련 검증**

Run: `pnpm test:lan-tls && pnpm --filter @led-control/api test -- --runInBand src/pki src/gateway-onboarding && pnpm --filter @led-control/api typecheck`

- [ ] **Step 4: secret 및 diff 검사**

Run: `git grep -nE 'BEGIN (EC |RSA |)PRIVATE KEY|VAULT_TOKEN=' -- ':!*.test.*' ':!docs/superpowers/specs/*' || true; git diff --check`

- [ ] **Step 5: 계획 상태 갱신과 커밋**

완료한 체크박스와 실제 검증 수치를 기록한다.

Commit: `docs(pki): document first device lab installation`
