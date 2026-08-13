# Task 2 보고서

## 상태

완료. Fix Round1에서 고정된 `.local/lab-pki/{csrs,root,signed-intermediates}` 경로만 사용하도록 변경했다. 단일 signer lock 안에서 Root 생성, serial 소비, 세 intermediate의 상태 검사를 수행한다. Root key와 certificate 공개키 digest 일치를 확인하고, intermediate는 generation 디렉터리를 검증한 뒤 고정 chain pointer를 원자적으로 전환한다. 이전 실행의 자체 임시 generation은 안전하게 정리하지만 legacy 또는 외부 산출물은 거부한다.

## Commit

`feat(pki): automate lab intermediate signing`

Fix Round1: `fix(pki): harden lab intermediate signer`

## Tests

- `node --test scripts/pki/sign-lab-intermediates.test.mjs scripts/pki/pki-scripts.test.mjs`
- `bash -n scripts/pki/sign-lab-intermediates.sh scripts/pki/bootstrap-lab-vault.sh`
- `git diff --check`
- 동시 signer lock/serial uniqueness와 interruption recovery 회귀 테스트

## Concerns

- 실제 Vault Docker와 CSR 생성부터 intermediate 설치까지의 통합 실행은 Task 4의 bootstrap 통합 시험에서 검증한다.
- Lab Root private key는 자동화 편의를 위한 Lab 전용 파일이며 운영 환경에서 사용하면 안 된다.
- lock이 남아 있으면 자동 삭제하지 않는다. 실행 중인 signer가 없음을 확인한 뒤에만 `.local/lab-pki/.intermediate-sign.lock`을 수동 제거해야 한다.
