# 양산 장비 2-노드 실험실 검증

기준일: 2026-07-12

## 목적과 완료 기준

이 절차는 Raspberry Pi gateway 1대와 ESP32-H2 조명 노드 2대로 claim부터 재시작 복구와 ACL 부정 시험까지 반복 검증한다. 자동 단위 테스트 통과만으로 양산 준비 완료로 판정하지 않는다. Raspberry Pi BlueZ Phase 0 통과와 아래 HIL 시나리오 3회 연속 성공 로그가 모두 필요하다.

## 장비와 사전 조건

- Raspberry Pi 4 또는 CM5, Raspberry Pi OS, 내장 Bluetooth
- ESP32-H2-MINI 개발 보드 2대와 데이터 USB 케이블
- 테스트용 절연 LED driver 또는 개발 LED 부하
- PostgreSQL, API, Web, TLS Mosquitto가 실행 중인 개발 서버
- 각 node에 같은 검증 대상 firmware가 flash된 상태
- gateway 제조 identity와 claim code, claim 후 발급된 MQTT 인증서
- `bluetooth-meshd`, API, gateway의 systemd/journald 로그 수집 권한

## 보안 주의

claim code, private key, session token을 명령 stdout JSON에 포함하지 않는다. runner는 secret 형태의 JSON key를 마스킹하지만 임의 문자열 내부의 secret까지 완전히 판별하지 못한다. 인증서와 key 파일은 소유자 권한으로 관리하고 결과 JSON에는 경로, commandId, fixtureId, status, 지연시간만 기록한다.

## 환경 변수

필수 장비 값은 다음과 같다.

```bash
export HIL_GATEWAY_SERIAL='GW-LAB-001'
export HIL_NODE1_PORT='/dev/cu.usbmodem1301'
export HIL_NODE2_PORT='/dev/cu.usbmodem1302'
export HIL_CA_PATH="$PWD/.local/pki/ca.crt"
export HIL_GATEWAY_CERT_PATH="$PWD/.local/pki/gateway-<gatewayId>.crt"
export HIL_GATEWAY_KEY_PATH="$PWD/.local/pki/gateway-<gatewayId>.key"
export HIL_STEP_TIMEOUT_MS=120000
```

각 단계 실행 명령은 shell 문자열이 아니라 JSON string array로 설정한다. runner는 shell을 거치지 않아 인자 주입 위험을 줄인다.

```bash
export HIL_CLAIM_COMMAND_JSON='["/opt/led-lab/bin/hil-step","claim"]'
export HIL_BOOTSTRAP_COMMAND_JSON='["/opt/led-lab/bin/hil-step","bootstrap"]'
export HIL_SECURE_MQTT_COMMAND_JSON='["/opt/led-lab/bin/hil-step","secure-mqtt"]'
export HIL_SCAN_COMMAND_JSON='["/opt/led-lab/bin/hil-step","scan"]'
export HIL_PROVISION_COMMAND_JSON='["/opt/led-lab/bin/hil-step","provision"]'
export HIL_BIND_COMMAND_JSON='["/opt/led-lab/bin/hil-step","bind"]'
export HIL_INDIVIDUAL_CONTROL_COMMAND_JSON='["/opt/led-lab/bin/hil-step","individual-control"]'
export HIL_GROUP_CONTROL_COMMAND_JSON='["/opt/led-lab/bin/hil-step","group-control"]'
export HIL_STALE_EVENT_COMMAND_JSON='["/opt/led-lab/bin/hil-step","stale-event"]'
export HIL_OFFLINE_COMMAND_JSON='["/opt/led-lab/bin/hil-step","offline"]'
export HIL_RESTART_RECOVERY_COMMAND_JSON='["/opt/led-lab/bin/hil-step","restart-recovery"]'
export HIL_ACL_NEGATIVE_COMMAND_JSON='["/opt/led-lab/bin/hil-step","acl-negative"]'
```

단계 실행 파일은 성공 시 exit code `0`과 JSON 문서 하나를 stdout으로 출력해야 한다. 실패 시 0이 아닌 exit code를 반환한다.

## 단계별 판정

1. `claim`: 일회성 code로 한 번만 binding되고 재사용이 거부된다.
2. `bootstrap`: 제조 인증서가 일치할 때 assignment를 받고 다른 인증서는 거부된다.
3. `secure-mqtt`: client certificate로 TLS 연결되고 평문/무인증 연결은 실패한다.
4. `scan`: unprovisioned node 두 대만 발견된다.
5. `provision`: 두 node에 중복 없는 unicast address가 할당된다.
6. `bind`: AppKey, OnOff/Lightness/Health model bind, group subscription, publication이 성공한다.
7. `individual-control`: 각 node가 Lightness Status를 반환하고 중복 command가 재제어되지 않는다.
8. `group-control`: 두 node 결과가 fixture별로 기록되며 한 node timeout은 부분 실패로 나타난다.
9. `stale-event`: 중복 event와 낮은 sequence가 DB snapshot을 되돌리지 않는다.
10. `offline`: MQTT 단절 시 90초 gateway offline, 120초 fixture stale 정책이 적용된다.
11. `restart-recovery`: gateway, `bluetooth-meshd`, 두 node 재부팅 후 재provision 없이 상태가 복구된다.
12. `acl-negative`: 무인증 연결과 다른 gateway topic publish가 거부된다.

## 실행과 증거

```bash
pnpm gateway:hil:2node -- --repeat 3 > .local/hil-2node-result.json
jq '.passed, [.runs[].passed]' .local/hil-2node-result.json
sudo journalctl -u bluetooth-meshd -u led-control-gateway --since '30 minutes ago' > .local/hil-journald.log
```

세 run이 모두 `true`이고 수동 DB 수정이나 run 사이 reprovisioning이 없어야 한다. 실패한 단계는 결과 JSON의 단계명과 error, API/Mosquitto/journald 로그의 같은 시각을 기준으로 분석한다.

## 72시간 soak

HIL 3회 연속 성공 후 같은 장비와 인증서로 health command를 5분마다 실행한다. health command는 gateway heartbeat age, 두 node의 마지막 상태 age, RSSI/hop, 최근 명령 왕복 결과를 JSON 하나로 출력하고 하나라도 기준을 벗어나면 non-zero로 종료해야 한다.

```bash
export SOAK_HEALTH_COMMAND_JSON='["/opt/led-lab/bin/hil-step","soak-health"]'
export SOAK_DURATION_HOURS=72
export SOAK_INTERVAL_SECONDS=300
export SOAK_SAMPLE_TIMEOUT_MS=120000
export SOAK_OUTPUT_PATH="$PWD/.local/soak-72h.jsonl"
pnpm gateway:soak
```

runner는 첫 실패에서 즉시 non-zero로 종료하고 증거 파일을 `0600`으로 유지한다. 72시간 완료 결과의 `passed=true`, `failures=0`, JSONL 전체 sample과 같은 기간 journald를 함께 보관한다.

## 현재 상태

- HIL runner와 deterministic 순서, secret redaction, timeout, JSON 결과 형식은 구현 및 자동 테스트 완료다.
- 72시간 soak runner의 주기 실행, 첫 실패 종료, `0600` JSONL 증거는 구현 및 자동 테스트 완료다.
- Light Lightness/Generic OnOff SIG opcode codec과 status decode는 구현 및 자동 테스트 완료다.
- `/opt/led-lab/bin/hil-step` 단계별 실제 장비 실행 파일은 Raspberry Pi Phase 0 결과와 함께 구현해야 한다.
- 2-node 3회 연속 실기 결과는 아직 없다. 따라서 현재 프로젝트 상태를 양산 준비 완료로 판정하지 않는다.
- 2026-07-12 macOS probe 결과는 여섯 항목 모두 `hardware_required`, exit code 2였다.
