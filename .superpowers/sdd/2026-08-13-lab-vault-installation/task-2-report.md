# Task 2 보고서

## 상태

완료. Lab Root CA와 Gateway device, Gateway MQTT, API server intermediate의 자동 서명을 구현했다. `PKI_ENV=lab` 외 환경은 거부하며, Root private key는 `0600`, 공개 인증서와 chain은 `0644`로 생성한다. 기존 CSR fingerprint가 일치할 때만 산출물을 재사용하고, 다른 CSR은 충돌로 거부한다.

## Commit

`feat(pki): automate lab intermediate signing`

## Tests

- `node --test scripts/pki/sign-lab-intermediates.test.mjs scripts/pki/pki-scripts.test.mjs`
- `bash -n scripts/pki/sign-lab-intermediates.sh scripts/pki/bootstrap-lab-vault.sh`
- `git diff --check`

## Concerns

- 실제 Vault Docker와 CSR 생성부터 intermediate 설치까지의 통합 실행은 Task 4의 bootstrap 통합 시험에서 검증한다.
- Lab Root private key는 자동화 편의를 위한 Lab 전용 파일이며 운영 환경에서 사용하면 안 된다.
