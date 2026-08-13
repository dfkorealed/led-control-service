# Task 3 보고서

## 상태

완료. `scripts/pki/issue-lab-manufacturing-station.sh`가 Lab 전용 ECDSA P-256 Manufacturing CA와 단일 station client identity를 발급한다. 산출물은 고정 경로 `.local/lab-pki/manufacturing`에 generation pointer로 공개되며, CA와 station private key는 `0600`, 공개 인증서와 chain은 `0644`으로 제한한다.

기존 station은 subject, CA issuer chain, CA/station key 공개키 일치, `clientAuth` 전용 확장을 모두 다시 검증한 경우에만 재사용한다. 요청 station 이름이 다르거나 공개키가 불일치하면 기존 identity를 덮어쓰지 않고 실패한다. `PKI_ENV=lab` 이외 환경과 유효하지 않은 station 이름도 material 생성 전에 거부한다.

## Commit

`feat(pki): issue lab manufacturing station identity`

## Tests

- RED 확인: `node --test scripts/pki/issue-lab-manufacturing-station.test.mjs`는 구현 전 issuer 부재로 4개 실패
- `node --test scripts/pki/issue-lab-manufacturing-station.test.mjs scripts/pki/sign-lab-intermediates.test.mjs scripts/pki/pki-scripts.test.mjs` 16개 통과
- `bash -n scripts/pki/issue-lab-manufacturing-station.sh`
- `git diff --check`

## Concerns

- station identity는 Lab Root 및 API server/Gateway device issuing CA와 분리되어 있다. 이 CA는 Lab 전용이며 운영 제조 인증서로 사용하면 안 된다.
- Task 4 통합 bootstrap이 이 station CA trust bundle을 API 제조 enrollment 경로에 연결하고 실제 Docker Vault 기반 전체 흐름을 검증해야 한다.
- 발급 중 프로세스가 중단되어 lock이 남았을 때는 실행 중인 프로세스가 없음을 확인한 뒤에만 `.local/lab-pki/manufacturing/.station-issue.lock`을 수동 제거해야 한다.
