# Task 4 보고서

## 상태

구현 완료. `bootstrap-device-lab.sh`가 Lab Vault 시작, intermediate prepare/sign/install, API·MQTT service identity와 device/MQTT CRL, 제조 station identity, `gateway-pki` 제한 token, 절대 경로 `lab.env`를 순서대로 생성한다. Vault root token은 setup 과정에서만 사용하며 `lab.env`에는 application token 파일 경로만 기록한다.

## 구현

- `PKI_ENV=lab`, LAN IP, Docker/OpenSSL/jq/Node/Vault CLI를 변경 전에 검사한다.
- 기존 `application-token`과 `lab.env`는 모든 선행 단계가 성공한 후에만 원자 교체한다.
- service bundle에 `device-ca.crt`, 서명 검증된 `device.crl`을 추가했다.
- `lab.env`에 API HTTPS, 제조 mTLS, MQTT mTLS, CRL, Vault mount/role과 제한 token 경로를 기록한다.
- 실제 HTTPS TLS server에서 정상 station 통과, 타 CA station 거부, 폐기 station 거부를 검증한다.
- `pnpm lab:pki:bootstrap`, `pnpm test:lab:pki`, `pnpm test:lab:pki:integration` 명령을 추가했다.

## 검증

- RED: orchestrator 부재와 device CA/CRL 부재로 예상 실패 확인
- `node --test scripts/pki/*.test.mjs scripts/pki/pki-scripts.test.mjs`: 30 pass, 1 opt-in skip
- `pnpm test:lan-tls`: 1 pass
- `bash -n scripts/pki/*.sh`: pass
- `git diff --check`: pass

## 남은 확인

실제 Docker Vault 전체 bootstrap은 `hashicorp/vault:1.17.6` image pull 지연으로 중단했다. container는 생성되지 않았다. Vault CLI는 Homebrew로 설치됐다. 사용자는 LAN IP를 지정해 다음 명령으로 opt-in 통합을 수행한다.

```bash
LAB_API_IP=<Mac-LAN-IP> LAB_MQTT_IP=<Mac-LAN-IP> pnpm test:lab:pki:integration
```

Task 5에서 이 명령과 산출물을 사용하는 한국어 최초 설치 runbook을 작성한다.
