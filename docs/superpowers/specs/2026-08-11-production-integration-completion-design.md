# 양산 통합 기능 완성 설계

작성일: 2026-08-11

## 1. 목적

현재 구현된 인증, 현장 생성, Gateway claim, 조명 등록, 모니터링, 수동 제어와 도면 편집 흐름에서 부분 구현으로 남은 구간을 실제 Raspberry Pi와 ESP32-H2를 연결할 수 있는 수준으로 완성한다.

이번 작업은 기존에 미구현으로 분류한 OTA, 스케줄·이벤트 제어, RF/AI, 모바일 제품화와 새 설정 CRUD를 구현하지 않는다. 완료된 기능을 과거 상태로 설명하는 문서만 현재 코드에 맞게 정정하고 미구현 목록과 후속 범위는 유지한다.

## 2. 범위

### 포함

1. 완료 기능에 관한 상위 설계 문서와 체크리스트 정합성
2. MQTT QoS 1 명령의 Gateway offline·broker 재시작 내구성
3. Gateway reconnect timer, 비동기 오류 경계와 runtime 인증서 교체
4. BLE Mesh OnOff, Lightness와 Health 상태의 주기 publication 및 MQTT 동기화
5. 층·Gateway를 명시적으로 선택하는 조명 등록과 실제 상태 기반 초기 상태
6. provisioning 전 식별 한계가 반영된 안전한 identify 절차와 실패 상태
7. 모니터링 화면의 `FloorMapObject` 읽기 전용 렌더링
8. 대규모 그룹 제어를 위한 BLE Mesh group address와 결과 확인 방식
9. Gateway healthcheck의 실제 D-Bus, mapping, HCI, MQTT 상태 검증
10. 실제 장비 HIL 단계 실행기와 재현 가능한 증거 수집
11. 기본 현장 선택 정합성과 로그인 화면 테스트 기본값 제거

### 제외

- React Native Android/iOS 제품화
- OTA package, 배포, rollback
- 스케줄, 센서, 이벤트와 장면 제어
- RF heatmap, Hamina 연동과 AI 도면 해석
- 현장·층 CRUD/archive, 사용자·MFA, 알림, 정책 등 기존 설정 후속 기능
- Secure Boot, Flash/NVS Encryption, anti-rollback과 OOB 제조 키 정책

제외 항목은 기존 메뉴 문서의 미구현 목록에서 이동하거나 완료로 표시하지 않는다.

## 3. 통신 신뢰성

### 3.1 MQTT 전달 계약

- Gateway MQTT client ID는 제조 identity의 `gatewayId`에서 결정되는 안정적인 값으로 고정한다.
- Gateway 구독은 persistent session을 사용하고 broker persistence를 활성화한다.
- API publisher가 받은 PUBACK는 broker 수락을 의미하며 장비 적용 완료로 해석하지 않는다. 기존 acceptance/device-status ACK 상태 기계를 유지한다.
- 재연결 시 session present 여부를 확인하고 신규 session일 때만 명령·등록 topic을 다시 구독한다.
- broker 재시작과 Gateway offline 동안 보관된 QoS 1 명령은 재연결 후 전달되고 idempotency journal이 중복 조작을 차단해야 한다.
- broker retention 한계를 넘겨 유효성을 잃은 명령은 API deadline worker가 timeout으로 종료한다.

### 3.2 Gateway 생명주기

- heartbeat timer는 프로세스당 하나만 존재하며 reconnect 시 중복 생성하지 않는다.
- MQTT message handler는 topic별 오류를 포착해 구조화 로그와 health 상태에 반영하고 unhandled rejection을 만들지 않는다.
- health 파일은 마지막 성공 heartbeat 발행 시각, MQTT 연결, BlueZ attach, HCI powered, mapping 검증 결과를 포함한다.
- 인증서 rotation 성공 후 새 인증서로 MQTT client를 재연결한다. 전환 실패 시 기존 유효 연결과 identity를 유지하고 다음 주기에 재시도한다.

## 4. BLE Mesh 상태 동기화

- Config Client는 Generic OnOff Server, Light Lightness Server와 Health Server를 구성한다.
- OnOff와 Lightness publication period는 fixture stale 제한보다 짧은 60초로 설정한다.
- Gateway는 명령 응답뿐 아니라 자발적인 OnOff/Lightness/Health Status를 지속 수신한다.
- 상태 메시지를 fixture mapping으로 해석하고 gateway-scoped MQTT v2 fixture-state event로 발행한다.
- Health fault는 fixture `fault`와 fault code로, 정상 상태는 `online`으로 동기화한다.
- RSSI와 hop count는 BlueZ가 제공하는 값만 기록하고 얻지 못한 값을 임의 생성하지 않는다.
- startup resync는 알려진 모든 node의 OnOff, Lightness와 Health 상태를 조회한다.

## 5. 조명 등록

### 5.1 대상 선택

- 등록 화면에서 현장 내 층과 Gateway를 사용자가 명시적으로 선택한다.
- 세션 생성 API는 `siteId`, `floorId`, `gatewayId`를 받고 세 값의 소유 관계와 operator commission 권한을 검증한다.
- Gateway가 offline이거나 해당 현장에 속하지 않으면 scan을 시작하지 않는다.

### 5.2 등록 정보

- 각 후보는 조명 이름, 정격 전력과 초기 도면 좌표를 사용자가 확인·수정한 뒤 provisioning한다.
- 여러 후보에는 겹치지 않는 임시 좌표를 제안하되 서버 저장 전 사용자가 수정할 수 있다.
- 기존 `deviceUuid`가 다른 Gateway, 현장 또는 Fixture에 연결되어 있으면 재사용하지 않고 명시적인 충돌 오류로 종료한다.

### 5.3 Identify와 완료 상태

- 표준 PB-ADV unprovisioned node는 원격 점멸을 보장할 수 없으므로 provisioning 전 점멸 성공을 표시하지 않는다.
- 후보 식별은 device UUID/serial과 RSSI를 우선 사용한다. provisioning 및 model bind 이후 Health Attention을 전송해 물리 조명을 확인한다.
- identify 요청은 성공·실패 MQTT 결과를 반환하고 API가 `confirmed` 또는 `failed`로 상태를 확정한다.
- provisioning 완료만으로 fixture를 `online` 또는 특정 밝기로 만들지 않는다. 최초 Status가 올 때까지 `offline/provisioning_waiting_state`와 밝기 미확정 상태를 유지한다.
- 실제 Status 수신 후에만 brightness, online/fault, lastSeenAt과 통신 지표를 갱신한다.

## 6. 모니터링 도면

- dashboard floor 응답에 읽기 전용 `mapObjects`를 안정적인 z-index 순서로 포함한다.
- 웹은 배경 도면 위에 rectangle, triangle, line, text를 조명 좌표와 같은 좌표계로 렌더링한다.
- 잠금·visibility·색상·선 굵기·font size를 저장 상태 그대로 반영한다.
- 모니터링은 편집 handler나 Transformer를 포함하지 않는다.
- 1,000개 조명과 도형이 함께 있는 회귀 fixture로 렌더링 시간과 선택 동작을 검증한다.

## 7. 그룹 제어

- Fixture group에 site별 BLE Mesh group address를 영속화하고 provisioning/configuration 시 node model subscription을 설정한다.
- 한 Gateway가 소유한 그룹은 group address에 단일 Lightness Set을 보낸다.
- group message 자체는 대량 acknowledged 응답 폭주를 피하고, 전송 후 대상 node 상태를 제한된 동시성으로 조회해 fixture별 결과를 확정한다.
- 여러 Gateway에 걸친 그룹은 기존 `CommandDispatch`처럼 Gateway별로 분할한다.
- group address가 아직 구성되지 않은 기존 그룹은 제한된 동시성의 개별 전송으로 동작하며 대상 수에 비례한 명시적 timeout을 사용한다.

## 8. HIL과 운영 증거

- 저장소에 `hil-step`과 `pki-step` 실행 파일을 제공하고 runbook의 JSON 배열 명령과 같은 계약을 사용한다.
- `claim`, `bootstrap`, `secure-mqtt`, `scan`, `provision`, `bind`, `individual-control`, `group-control`, `stale-event`, `offline`, `restart-recovery`, `acl-negative`를 실제 API·MQTT·systemd/Docker 명령으로 수행한다.
- 각 단계는 stdout에 secret이 제거된 JSON 하나를 출력하고 성공은 0, 실패는 non-zero로 종료한다.
- 실제 Raspberry Pi와 ESP32-H2가 없으면 runner와 단계 실행기 자동 테스트까지만 완료로 표시한다. 2-node 3회와 72시간 soak 증거가 없으면 양산 E2E 완료로 표시하지 않는다.

## 9. 오류 처리와 호환성

- 기존 MQTT v2 topic과 command ACK schema를 깨지 않는다. 필요한 필드는 optional 추가 후 producer와 consumer를 순서대로 전환한다.
- DB migration은 비파괴 방식으로 group address와 상태 사유 필드를 추가한다.
- 등록·상태·그룹 제어의 조직 및 현장 경계 오류는 기존 opaque `404`와 역할 `403` 규칙을 유지한다.
- Gateway·broker·BLE 오류는 장비 장애와 사용자 입력 오류를 구분하는 안정적인 error code로 저장한다.
- 모든 변경은 mock runtime을 다시 추가하지 않고 테스트 adapter를 `test` 경계에만 유지한다.

## 10. 테스트 기준

- 단위 테스트: MQTT option/session, timer single instance, status decode, group address, 등록 충돌, map object 변환
- PostgreSQL 통합 테스트: 등록 원자성, device UUID 소유권, group address uniqueness, 최초 상태 전환
- MQTT 통합 테스트: offline queue, broker restart persistence, 중복 전달 idempotency, certificate reconnect
- 웹 테스트: 층/Gateway 선택, 등록 정보 수정, identify 실패, map object 읽기 전용 표시, 빈 입력값
- Gateway 테스트: publication 수신, Health fault, startup resync, reconnect, 실제 health 판정
- HIL 자동 테스트: 각 실제 step의 command 구성, timeout, secret redaction과 실패 exit code
- 실장비 수동 관문: Raspberry Pi 1대와 ESP32-H2 2대로 등록·개별/그룹 제어·상태·재부팅을 3회 연속 통과

## 11. 문서 갱신 원칙

- 완료된 역할, 에디터 위치, 실제 Gateway adapter와 factory reset/identify 구현 설명만 현재 코드에 맞게 정정한다.
- 기존 `미구현` 항목은 해당 기능을 실제로 구현한 작업이 아니면 수정하지 않는다.
- 부분 구현을 완료한 작업은 같은 커밋에서 영향을 받는 `docs/menus/*.md`, `docs/database-schema.md`, Gateway/펌웨어 runbook을 갱신한다.
- 계획 체크박스는 구현·테스트·커밋 증거가 있는 과거 작업만 완료로 정정한다.

## 12. 완료 판정

- 자동 테스트 완료와 실장비 검증 완료를 별도로 보고한다.
- 모바일과 명시적 제외 범위는 완료율에 포함하지 않는다.
- 이번 범위의 코드는 전체 자동 검증을 통과하더라도 실장비 증거가 없으면 `코드 완료·실기 미검증`으로 판정한다.
