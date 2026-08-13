# Task 3 보고서

## 상태

완료. `scripts/pki/issue-lab-manufacturing-station.sh`가 Lab 전용 ECDSA P-256 Manufacturing CA와 단일 station client identity를 발급한다. 산출물은 고정 경로 `.local/lab-pki/manufacturing`에 generation pointer로 공개되며, CA와 station private key는 `0600`, 공개 인증서와 chain은 `0644`으로 제한한다.

기존 station은 subject, CA issuer chain, CA/station key 공개키 일치, `clientAuth` 전용 확장을 모두 다시 검증한 경우에만 재사용한다. 요청 station 이름이 다르거나 공개키가 불일치하면 기존 identity를 덮어쓰지 않고 실패한다. `PKI_ENV=lab` 이외 환경과 유효하지 않은 station 이름도 material 생성 전에 거부한다.

## Commit

`feat(pki): issue lab manufacturing station identity`

Fix Round1: `fix(pki): harden lab manufacturing station revocation`

Fix Round2: `fix(pki): rotate revoked lab station identities`

## Tests

- RED 확인: `node --test scripts/pki/issue-lab-manufacturing-station.test.mjs`는 구현 전 issuer 부재로 4개 실패
- `node --test scripts/pki/issue-lab-manufacturing-station.test.mjs scripts/pki/sign-lab-intermediates.test.mjs scripts/pki/pki-scripts.test.mjs` 16개 통과
- `bash -n scripts/pki/issue-lab-manufacturing-station.sh`
- `git diff --check`

### Fix Round1

- 기존 station 재사용 전 `basicConstraints`(critical `CA:false`), `keyUsage`(critical `digitalSignature` 하나), `extendedKeyUsage`(critical `clientAuth` 하나)를 엄격히 검증한다.
- Manufacturing CA와 station의 private/public key가 모두 ECDSA `prime256v1`인지 확인한다.
- OpenSSL CA database(`index.txt`, `serial`, `crlnumber`, config)를 generation에 유지하고 초기 `manufacturing.crl`을 발급한다. `revoke` subcommand는 station serial을 폐기한 뒤 CRL을 원자적으로 갱신한다.
- API HTTPS는 `API_MANUFACTURING_CRL_PATH`를 여섯 번째 필수 TLS 경로로 받고 device/manufacturing CRL 배열을 TLS context에 전달하며 둘 중 하나의 변경도 reload한다.
- Task 4는 station mTLS 통과, 다른 CA 거부, 폐기 station CRL 거부를 실제 API endpoint 계약으로 검증한다.

### Fix Round2

- current station serial이 Manufacturing CA index에서 `R`이면 기본 `issue`가 재사용하지 않고, 같은 CA database와 CRL 이력을 복사한 새 EC P-256 key/certificate generation을 발급한다. stable `current` pointer는 원자적으로 새 generation으로 전환하며 기존 revoked serial은 CRL에 남는다.
- 재사용 전에 CRL signature를 `openssl crl -verify -CAfile`로 확인하고, next update가 24시간 freshness window를 넘는지 검사한다. missing, signature 불일치, 만료 임박 CRL은 lock 안에서 원자 재생성한다.
- macOS의 `mv`가 directory symlink를 따라 들어가는 동작을 피하기 위해 current pointer 교체에는 Node `renameSync`를 사용한다.

## Concerns

- station identity는 Lab Root 및 API server/Gateway device issuing CA와 분리되어 있다. 이 CA는 Lab 전용이며 운영 제조 인증서로 사용하면 안 된다.
- Task 4 통합 bootstrap이 이 station CA trust bundle과 manufacturing CRL을 API 제조 enrollment 경로에 연결하고 실제 Docker Vault 기반 전체 흐름을 검증해야 한다.
- 발급 중 프로세스가 중단되어 lock이 남았을 때는 실행 중인 프로세스가 없음을 확인한 뒤에만 `.local/lab-pki/manufacturing/.station-issue.lock`을 수동 제거해야 한다.
- CRL freshness 기본값은 24시간이며 `LAB_MANUFACTURING_CRL_FRESHNESS_SECONDS`로 Lab에서만 조정할 수 있다. Task 4는 API reload 이후 폐기 station의 실제 mTLS 거부를 검증해야 한다.
