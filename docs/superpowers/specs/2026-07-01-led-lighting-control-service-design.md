# LED 조명 제어 및 모니터링 서비스 설계

작성일: 2026-07-01

## 1. 목표

주차장에 설치된 LED 조명에 ESP32-H2 기반 BLE Mesh 모듈을 부착하고, PC 웹, 모바일 앱, 태블릿 환경에서 클라우드 서버를 통해 조명을 제어하고 전력/조명 현황을 모니터링할 수 있는 서비스를 개발한다.

개발 우선순위는 다음 순서로 진행한다.

1. PC 웹 중심의 관제 UI, 클라우드, 데이터 모델, Mock 게이트웨이 기반 MVP
2. 라즈베리파이 게이트웨이와 ESP32-H2 BLE Mesh를 연결한 실제 장비 end-to-end MVP
3. 특정 주차장 파일럿 현장 운영 MVP

## 2. 제품 범위

### 2.1 클라이언트 전략

PC 웹을 1차 기준 제품으로 개발한다. React, React Query, Zustand, TypeScript를 사용하며, 관제 업무에 맞는 밀도 높은 UI를 제공한다.

모바일 앱과 태블릿 앱은 React Native 기반 shell을 두고 WebView로 웹 화면을 최대한 재사용한다. 앱 고유 기능은 로그인 세션, 푸시, WebView bridge, 앱 배포 설정 정도로 제한한다. 모바일 화면에서는 2D 맵을 그대로 축소하지 않고 간소화 맵과 리스트 전환을 제공한다.

### 2.2 주요 메뉴

모바일/태블릿에서는 하단 메뉴를 유지하고, PC 웹에서는 좌측 또는 상단 내비게이션으로 변환한다.

- 모니터링: 층별 2D 맵, 조명 위치, 점등/디밍 %, 장애 상태, 게이트웨이 연결 상태
- 제어: 개별 조명, 그룹/구역 단위 밝기 제어, 스케줄 제어, 이벤트 제어
- 통계: 일/월/년 전력 사용량, 층별/전체 사용량, 예상 전기료
- 설정: 현장, 건물/층, 도면, 조명 배치, 그룹, 게이트웨이, OTA, 사용자 권한

### 2.3 2D 맵 관리

초기에는 개발사 또는 운영자가 현장 도면을 받아 세팅한다. 이후 현장 관리자가 웹에서 층 도면을 업로드하고 조명 위치, 그룹, 구역을 직접 수정할 수 있게 한다.

도면 데이터는 도면, 좌표계, 편집 버전, 조명 위치, 그룹/구역, 설치·시운전 상태를 분리해 관리한다.

층별 도면 에디터는 MVP 단계별로 다음 방향을 따른다.

- MVP 1: PC 웹 설정 화면에서 선택 층을 전체 화면 에디터로 열어 배경 없음/JPG/PNG/PDF 첫 페이지 배경, 줌/팬, 기본 도형, 텍스트, 조명 위치와 조명 기본 정보를 수동 편집한다. 도면 에디터는 `/settings/floor-plans/:floorId/edit`에서 제공하고 모니터링 화면은 읽기 전용으로 유지한다.
- MVP 2: 실제 게이트웨이와 ESP32-H2 provisioning 결과, RSSI, hop count, 명령 성공률을 바탕으로 조명 위치 보정과 통신 품질 확인을 돕는 자동 배치 보조 기능을 추가한다.
- MVP 3: 파일럿 현장 운영 데이터를 반영해 CAD/DWG/DXF 연동, AI 도면 해석, 구역/그룹 후보 자동 생성, 현장 실측 기반 배치 개선을 검토한다.

### 2.4 인증, 회원가입, 자동 로그인

MVP 1의 인증은 고객사별 설치형 운영과 향후 SaaS 전환을 모두 고려해 초대 기반 가입 모델로 시작한다.

초기 설치형에서는 개발사 또는 운영자가 고객사 조직, 현장, 초기 관리자 초대를 생성한다. 고객사 사용자는 전달받은 초대 토큰으로 회원가입 화면에 진입하고, 본인이 직접 이메일, 이름, 비밀번호를 설정한다. 개발사가 고객사 비밀번호를 직접 생성해 전달하는 방식은 계정 공유, 초기 비밀번호 유출, 감사 로그 불명확성 문제가 있으므로 기본 방식으로 사용하지 않는다.

회원가입은 공개 가입이 아니라 초대 토큰 또는 현장 가입 코드가 있어야 가능하게 한다. 이를 통해 초기 B2B 환경에서는 승인된 사용자만 조직에 들어오고, SaaS 전환 시에는 사용자가 직접 가입한 뒤 gateway QR 또는 serial과 제조 시 발급된 일회성 claim code로 현장을 연결하는 구조로 확장한다.

로그인은 이메일과 비밀번호를 사용한다. 비밀번호는 서버에 평문으로 저장하지 않고 salt가 포함된 단방향 hash로 저장한다. 로그인 성공 시 서버가 무작위 session token을 발급하고, token 원문은 HttpOnly cookie에만 저장한다. DB에는 session token hash만 저장한다.

자동 로그인은 같은 session 구조를 사용하되 만료 기간만 늘린다. 일반 로그인 session은 짧은 기간으로 두고, 자동 로그인을 선택하면 더 긴 만료 시간을 부여한다. 로그아웃, 비밀번호 변경, 계정 비활성화, 권한 변경 시 관련 session은 폐기할 수 있어야 한다.

역할은 `operator`, `admin`, `viewer` 세 가지다. `operator`는 서비스 운영사에서 배정된 현장의 설치·시운전과 제어를 담당하고, `admin`은 자기 고객사 현장의 운영 설정과 제어를 담당하며, `viewer`는 배정 현장의 모니터링과 통계만 조회한다.

## 3. 시스템 아키텍처

### 3.1 전체 구조

- 클라이언트: PC 웹, React Native WebView 앱, 태블릿 WebView
- 클라우드: NestJS, PostgreSQL, Redis, MQTT broker
- 현장 장비: Raspberry Pi 게이트웨이, ESP32-H2 BLE Mesh 노드, LED 드라이버, 센서

클라우드는 인증, 현장/층/도면, 조명 제어, 실시간 상태, 전력 통계, OTA 관리를 담당한다.

게이트웨이는 클라우드와 MQTT 및 HTTP API를 함께 사용한다.

- MQTT 데이터 플레인: 조명 명령, 상태 보고, heartbeat, 이벤트, 명령 ACK
- HTTPS 운영 플레인: 게이트웨이 bootstrap/claim, 설정 동기화, OTA manifest 조회, 패키지 다운로드, 도면/메타데이터 조회

클라우드 연결이 끊겨도 게이트웨이가 저장된 스케줄, 이벤트 정책, 기본 밝기 정책을 로컬에서 실행할 수 있는 계약과 저장 구조는 유지한다. 다만 MVP 2 첫 실기 단계에서는 수동 디밍과 상태 동기화의 신뢰성 검증에 집중하며, 스케줄/이벤트 정책의 실제 실행 엔진은 범위에서 제외한다.

### 3.2 핵심 상태 흐름

```text
웹 제어 요청
→ NestJS 명령 생성
→ MQTT 발행
→ 게이트웨이 명령 수신/검증
→ BLE Mesh 명령
→ 노드 상태 보고
→ 게이트웨이 MQTT 발행
→ 클라우드 상태 갱신
→ 웹 실시간 반영
```

실시간 상태는 Redis에 빠르게 반영하고, PostgreSQL에는 상태 snapshot, 명령 이력, 이벤트 이력, 통계 집계 데이터를 저장한다.

## 4. 데이터 모델 초안

핵심 도메인은 다음 단위로 나눈다.

- Organization / User / Role: 사용자, 조직, 권한
- Invitation / Session: 초대 기반 회원가입, 자동 로그인, 서버 저장 session
- Site / Building / Floor: 현장, 건물, 층, 운영 설정
- FloorPlan: 도면 이미지, 좌표계, 버전
- Fixture: 개별 LED 조명, 정격 전력, 설치 위치, 현재 상태
- Zone / Group: 구역 또는 그룹 제어 단위
- Gateway: 라즈베리파이 게이트웨이, 연결 상태, 설정 버전, OTA 버전
- MeshNode: ESP32-H2 노드, BLE Mesh 주소, 펌웨어 버전, 상태
- ProvisioningSession: 층/구역 단위 조명 검색·등록 작업, 진행 상태, 시작/종료 시각, 작업자
- DiscoveredMeshNode: 검색된 미등록 노드, device UUID, 시리얼/QR, RSSI, OOB capability, 후보 층/구역
- MeshKeySet: 현장별 NetKey/AppKey 버전, key index, 회전 상태, 활성/폐기 상태
- Schedule / EventPolicy: 시간 기반 제어, 차량 감지 등 이벤트 기반 제어
- Command / CommandLog: 제어 명령, gateway acceptance ACK, 조명별 device status ACK, sequence, 멱등성 키, 실패, 재시도
- EnergyUsage: 추정 전력 사용량, 향후 실측값 보정
- Tariff / BillingEstimate: 전기요금 계산 설정
- OtaPackage / OtaDeployment: 게이트웨이 및 노드 OTA 패키지와 배포 이력

모니터링용 현재 상태 snapshot은 화면 조회가 빠르게 가능하도록 `Fixture`와 `Gateway`에도 최근 상태를 보관한다.

- Fixture: brightness, status, lastSeenAt, RSSI, hop count, 명령 성공률
- Gateway: lastHeartbeatAt, firmwareVersion, connection status 계산 기준

장기 이력과 분석용 지표는 별도 metric/event 테이블로 분리하되, MVP 1에서는 최신 상태 snapshot을 dashboard API의 기준 데이터로 사용한다.

## 5. 전력 사용량과 전기료

MVP에서는 추정치 기반으로 시작한다.

```text
사용 전력량 = 조명 정격 전력 × 디밍 비율 × 점등 시간
```

이후 파일럿/양산 단계에서 분전반 계측기, 스마트미터, 별도 전력 계측 데이터를 수집할 수 있도록 EnergyUsage 모델을 source 기반으로 설계한다.

- estimated: 정격 전력, 디밍 %, 점등 시간 기반 추정
- measured: 계측기 또는 외부 시스템에서 수집한 실측
- adjusted: 실측값으로 보정한 집계

예상 전기료는 사이트별 요금제, 계약전력, 단가, 부가세/기금 설정을 분리해 계산한다.

## 6. 게이트웨이와 펌웨어

### 6.1 게이트웨이

라즈베리파이 게이트웨이의 장기 양산 개발 언어는 단일 바이너리 배포, 장기 실행 안정성, MQTT/HTTP/systemd/로컬 큐 구현의 균형을 고려해 Go를 추천한다. 이 권장은 장기 후보에 대한 것이며 MVP 2 첫 실기 단계의 구현 언어를 뜻하지 않는다.

MVP 2 첫 실기 단계는 기존 TypeScript monorepo, shared MQTT schema, mock gateway 테스트 자산을 재사용하는 `apps/gateway` Node.js/TypeScript 앱으로 고정한다. 실제 BLE Mesh 전송부는 Raspberry Pi에서 장기 실행되는 `bluetooth-meshd`/BlueZ Mesh D-Bus 기반 `BleMeshAdapter`로 구현한다. 기존 per-command JSON-lines adapter는 계약 테스트, 장애 주입, mock 실행을 위한 시험 경계로만 유지하며 실제 장비의 운영 경로로 사용하지 않는다. Phase 0과 2-node lab 검증이 끝난 뒤 운영 프로파일링, 배포 및 장애 복구 결과를 근거로 Go 재작성 여부를 별도 결정한다. 따라서 검증 전 Go 재작성은 MVP 2 완료 조건이 아니다.

실제 장비 개발에 앞서 다음 Phase 0 타당성 게이트를 통과해야 한다.

1. Raspberry Pi 내장 BLE와 `bluetooth-meshd`/BlueZ Mesh D-Bus로 ESP32-H2 1~2대의 PB-ADV beacon을 스캔하고 provisioning한다.
2. unicast address 할당, AppKey 추가, Generic OnOff Server 및 Light Lightness Server model bind를 완료한다.
3. Generic OnOff와 Light Lightness 명령 및 상태를 양방향으로 왕복하고 실제 LED 출력과 보고 상태가 일치하는지 확인한다.
4. Raspberry Pi, `bluetooth-meshd`, gateway 앱, ESP32-H2를 재부팅한 뒤 mesh key, 주소, bind 정보와 상태 왕복이 복구되는지 확인한다.

네 항목 중 하나라도 재현 가능하게 통과하지 못하면 Raspberry Pi 내장 BLE provisioner 경로를 중단하고, 전용 ESP32-H2 provisioner를 USB/UART bridge로 연결하는 구조로 전환한다. 이 경우 TypeScript gateway와 MQTT/HTTP 계약은 유지하고 `BleMeshAdapter` 구현만 bridge protocol 기반으로 교체한다.

게이트웨이 구성 요소:

- MQTT client
- HTTP 설정 동기화 client
- BLE Mesh Provisioner
- 로컬 스케줄러 계약과 저장 구조, 실행 엔진은 MVP 2 첫 실기 이후 구현
- 이벤트 정책 엔진 계약과 저장 구조, 실행 엔진은 MVP 2 첫 실기 이후 구현
- 명령 큐와 재시도
- 로컬 저장소 SQLite
- OTA manifest/version/partition 계약, 실제 agent는 MVP 2 첫 실기 이후 구현
- journald 기반 로그와 cloud upload
- systemd 기반 실행/복구

최종 구현 방향은 라즈베리파이 게이트웨이를 BLE Mesh Provisioner로 두는 것이다. 클라우드는 현장, 층, 구역, 조명, 권한, 정책, 이력을 관리하는 원장 역할을 하고, 실제 BLE Mesh 네트워크 생성과 노드 등록은 현장 게이트웨이가 수행한다. 모바일 앱이나 태블릿은 기본 provisioner가 아니라 클라우드 UI를 표시하는 조작 단말로 본다.

BlueZ 기반 실제 `BleMeshAdapter`의 책임:

- PB-ADV unprovisioned beacon scan과 중지
- device UUID, 시리얼/QR, RSSI, OOB capability 수집
- NetKey 기반 provisioning과 충돌 없는 unicast address 할당
- AppKey 추가와 Generic OnOff, Light Lightness, Health model bind
- group subscription과 상태 publication 설정
- Generic OnOff 및 Light Lightness get/set/status 왕복, Health status 조회
- 개별 및 group address 제어
- identify 명령으로 현장 점멸 확인
- D-Bus 요청 timeout, 취소, 오류 매핑, `bluetooth-meshd` 재연결과 재부팅 복구
- 등록 진행률, 실패 원인, 통신 품질 지표 보고
- 로컬 SQLite에 mesh mapping과 마지막 설정 버전 캐시
- 클라우드 재연결 시 미보고 결과와 상태 재동기화

클라우드는 대상 fixture를 소유 gateway별로 분할해 gateway마다 독립된 command를 발행하고, gateway는 자신에게 매핑된 fixture만 실행한다. 명령 수신, schema/권한/sequence 검증 및 로컬 큐 저장이 끝나면 `acceptance ACK`를 발행하고, BLE Mesh status 응답 또는 timeout이 확정되면 각 fixture의 `device status ACK`를 별도로 발행한다. 그룹 명령도 fixture별 결과를 `succeeded`, `failed`, `timed_out`으로 반환한다. 모든 명령은 `commandId`, 클라우드가 발급한 idempotency key와 gateway 단위 단조 증가 sequence를 포함하며, 두 ACK는 같은 식별자를 돌려준다. 게이트웨이는 마지막 처리 결과를 저장해 중복 명령에는 같은 결과를 반환하고 오래된 sequence는 실행하지 않는다.

모든 fixture state event는 중복 제거용 `eventId`, gateway별 단조 증가 `sequence`, 장치에서 상태가 발생한 시각 `occurredAt`을 포함한다. consumer는 이미 처리한 `eventId`를 중복 저장하지 않고, 저장된 값보다 낮은 `sequence`의 이벤트를 폐기한다. `sequence`가 같으면 더 오래된 `occurredAt`의 이벤트를 폐기하며, 이 규칙으로 지연 도착한 오래된 상태가 최신 snapshot을 덮어쓰지 못하게 한다. 기본 heartbeat 주기는 30초, gateway offline TTL은 90초, fixture offline TTL은 마지막 유효 상태 보고 후 120초로 두며 site 설정으로 조정할 수 있다. gateway heartbeat TTL이 지나 gateway가 offline이 되면 그 gateway에 속한 모든 fixture에 gateway-offline 원인을 전파하고, 개별 fixture TTL 만료는 해당 fixture만 offline 처리한다. gateway 앱 또는 `bluetooth-meshd` 시작 시 로컬 mapping을 복구하고 모든 알려진 노드에 Generic OnOff, Light Lightness, Health status를 조회한 뒤 startup resync 결과를 같은 fixture state event 계약으로 발행한다.

MQTT는 실시간 명령/이벤트 플레인으로 사용하고, HTTPS API는 게이트웨이 bootstrap/claim, 설정 동기화, OTA manifest, 등록 세션 생성 같은 운영 플레인으로 분리한다. MQTT anonymous 접속은 허용하지 않으며 TLS를 필수로 하고, 양산 장치에는 mTLS 장치 인증서와 장치별 ACL을 적용한다. 각 gateway identity는 자신에게 할당된 `siteId/gatewayId` prefix만 publish/subscribe할 수 있다.

제조 시 각 gateway에 고유 serial, 일회성 claim code, 장치별 인증서와 private key를 주입한다. 서버는 claim code 원문을 저장하지 않고 salt가 포함된 단방향 hash만 저장하며, private key는 장치 밖으로 내보내지 않는다. gateway 이미지의 `.env`에는 `siteId`와 `gatewayId`를 미리 넣지 않는다. 최초 부팅 시 제조 credential로 HTTPS mTLS bootstrap을 호출해 장치 identity를 증명하고, 아직 claim되지 않았으면 대기 상태로 남는다. 사용자가 QR 또는 serial과 일회성 claim code를 입력해 gateway를 site에 binding하면 bootstrap 응답으로 `siteId`, `gatewayId`, MQTT endpoint, ACL에 필요한 assignment와 설정 버전을 받는다. gateway는 이 assignment를 소유자만 읽고 쓸 수 있는 권한 `0600`의 로컬 파일에 원자적으로 저장한다. claim 성공 트랜잭션에서 claim code hash를 폐기해 재사용을 차단하고, 실패한 code는 rate limit과 감사 로그를 적용한다.

### 6.2 ESP32-H2 펌웨어

ESP32-H2는 ESP-IDF 기반 C 펌웨어로 개발한다. PlatformIO는 일반 개발 편의성은 좋지만, ESP32-H2 보드 지원과 BLE Mesh, OTA partition, 보안 설정 같은 상용화 필수 기능에서 공식 지원 추적이 늦을 수 있다. 실제 테스트에서도 PlatformIO가 ESP32-H2 보드를 찾지 못한 문제가 있었으므로, 상용화 기준의 기본 SDK는 Espressif 공식 ESP-IDF로 고정한다.

펌웨어 구성 요소:

- BLE Mesh node
- provisioning / group address / model 설정
- 디밍 제어
- 상태 보고
- 센서/차량 감지 이벤트 입력
- 펌웨어 버전 보고
- OTA partition/version/결과 보고 계약, 실제 수신·적용은 MVP 2 첫 실기 이후 구현

MVP 2 실제 장비 펌웨어는 다음 동작을 포함한다.

- provisioning 전후 identify 명령에 대한 구분 가능한 짧은 점멸
- NVS에 마지막 유효 brightness 저장 및 재부팅 복구
- OnOff off 이전 brightness 보존과 on 시 이전 brightness 복원
- transition time을 적용한 점진적 Light Lightness 변경과 완료 상태 보고
- LED driver 또는 내부 오류의 Health fault 등록, 조회, clear
- 물리 입력에 의한 factory reset과 mesh/NVS 자격 정보 삭제
- main task 및 통신 task watchdog과 비정상 재부팅 원인 보고
- device UUID/serial, product/model, hardware revision, firmware version, mesh address, 마지막 적용 command sequence 보고

LED 드라이버 인터페이스는 실제 제품 사양에 따라 PWM, 0-10V, DALI 등으로 확정한다. MVP에서는 우선 개발 보드와 제어 가능한 드라이버 조합으로 PoC를 수행한다.

2026-07-08 수동 제어 MVP에서는 `apps/esp32-h2-firmware`를 ESP-IDF 프로젝트 구조로 만들고, LEDC PWM 기반 `led_driver`, 밝기 상태 관리 `control_state`, 앱 부팅 진입점 `app_main`을 추가했다. ESP-IDF v5.5의 ESP32-H2 target으로 전체 펌웨어 빌드와 링크를 통과했고, 하드웨어 독립적인 `control_state`도 C 컴파일 테스트로 검증했다. 다만 실제 보드에서 PB-ADV provisioning, AppKey/model bind, Generic OnOff/Light Lightness status 왕복 E2E는 아직 검증하지 않았으며 `6.1`의 Phase 0에서 수행한다.

펌웨어 상태는 다음 상태머신으로 관리한다.

```text
BOOT
→ SELF_TEST
→ UNPROVISIONED_ADVERTISING
→ PROVISIONING
→ CONFIGURING
→ PROVISIONED_IDLE
→ APPLYING_COMMAND
→ REPORTING_STATUS
→ FAULT
→ OTA_READY / OTA_DOWNLOADING / OTA_APPLYING / OTA_ROLLBACK
→ FACTORY_RESET
```

ESP32-H2 노드는 최소한 device UUID, product/model, hardware revision, firmware version, LED driver type, provisioning state, mesh address, bound AppKey index, last command sequence, dimming level, fault code를 보고할 수 있어야 한다.

현장 식별을 위해 등록 전/후 identify 명령을 받으면 짧은 점멸 패턴을 수행한다. 공장초기화는 BLE Mesh node reset, 물리 버튼 길게 누름, 전원 패턴 중 최소 1개 이상의 방식을 제공하고, 초기화 후 NetKey/AppKey, mesh address, group subscription을 삭제한 뒤 unprovisioned 상태로 돌아간다.

보안 키는 장기적으로 클라우드 평문 보관을 피한다. 운영 초기에는 암호화 저장과 접근 로그를 적용하고, 양산 단계에서는 KMS 또는 secure element/TPM 기반 보호를 검토한다. 클라우드는 key version과 배포 상태를 관리하고, 게이트웨이는 현장 실행에 필요한 key material을 제한적으로 보유한다.

### 6.2.1 상태 보고와 통신 품질 지표

ESP32-H2 노드는 실제 펌웨어 단계에서 디밍 상태, 장애 상태, 마지막 명령 sequence, 펌웨어 버전을 게이트웨이에 보고한다. 게이트웨이는 BLE Mesh 통신 결과를 취합해 클라우드에 다음 지표를 MQTT로 전송하며, startup resync와 일반 상태 보고에 동일한 fixture-state schema를 사용한다.

fixture-state schema에는 `eventId`, gateway별 단조 증가 `sequence`, `occurredAt`이 필수이며, gateway는 재부팅 후에도 sequence가 역행하지 않도록 마지막 발급 값을 로컬 저장소에서 복구한다.

- 조명별 brightness, powerOn, status, lastSeenAt
- 조명별 RSSI, hop count, 명령 성공률
- gateway heartbeat와 firmware version
- command ACK, 실패 사유, 재시도 결과

MVP 1에서는 mock 게이트웨이가 같은 MQTT 계약으로 fixture-state와 gateway heartbeat를 발행한다. API는 이를 PostgreSQL 최신 상태 snapshot에 반영하고, 웹 모니터링 화면은 dashboard API polling으로 표시한다.

### 6.3 조명 검색과 등록

최종 등록 방식은 게이트웨이 중심의 층/구역 단위 일괄 등록으로 결정한다. 지하주차장은 콘크리트, 철근, 차량, 금속 배관, 층간 구조 때문에 한 장소에서 모든 층의 조명을 안정적으로 등록하는 방식을 기본값으로 두지 않는다. 설치자는 각 층 또는 구역 단위로 이동하며 등록 세션을 열고, 현장 게이트웨이가 가까운 미등록 조명을 스캔해 등록한다.

조명 검색 전에는 현장, 층, 게이트웨이가 먼저 등록되어 있어야 한다. 최초 가입 또는 빈 DB 상태에서는 조명 등록 화면보다 `초기 설치 설정` 마법사를 먼저 제공한다. 이 마법사는 현장명, 주소, 전기요금 단가, 층 이름, 층 level을 받아 `Site`와 `Floor`를 생성하고, gateway QR 또는 serial과 일회성 claim code를 받아 제조 장치 레코드를 해당 site의 `Gateway`에 binding한다. 입력된 serial만으로 임의의 `Gateway`를 새로 생성하지 않는다.

층은 게이트웨이 검색 결과로 자동 생성하지 않는다. 게이트웨이는 물리 장비라서 층 정보를 스스로 정확히 알기 어렵고, 지하주차장에서는 위층/아래층 신호가 섞일 수 있다. 따라서 사용자가 층 구조를 먼저 정의하고, 게이트웨이 검색 또는 시리얼 입력은 등록된 현장에 장비를 연결하는 보조 단계로 사용한다.

등록 흐름:

```text
현장 생성
→ 층 등록
→ 게이트웨이 QR 또는 serial + 일회성 claim code 입력
→ 제조 장치 인증 정보 확인 및 site binding
→ 게이트웨이 HTTPS mTLS bootstrap과 assignment 저장
→ 층/구역 선택
→ 게이트웨이 unprovisioned scan 시작
→ 발견 노드 목록 표시
→ QR/시리얼/OOB code 매칭
→ identify 점멸 확인
→ 선택 노드 일괄 provisioning
→ mesh address, group, model 설정
→ Fixture와 MeshNode 매핑
→ RSSI/hop count/명령 성공률 검증
→ 도면 위치 보정
→ 다음 층/구역 반복
```

운영 UX 원칙:

- 최초 로그인 후 현장이 없으면 `초기 설치 설정`을 먼저 보여준다.
- 층 등록 시 필수 입력은 층 이름과 층 level이다. 예: `B2`는 `-2`, `B1`은 `-1`, `1F`는 `1`.
- 사용자가 지하 층수와 지상 층수를 입력하면 `B3`, `B2`, `B1`, `1F` 같은 기본 층 목록을 자동 생성할 수 있게 한다.
- 도면은 나중에 등록할 수 있어야 하며, 도면이 없을 때도 조명 등록 전 단계까지는 진행 가능해야 한다.
- 최초 로그인 후 등록된 조명이 없으면 모니터링 화면 대신 `조명 등록 시작` 상태를 보여준다.
- 등록은 반드시 현장, 건물, 층, 구역을 먼저 선택한 뒤 시작한다.
- QR/시리얼은 자산 식별과 오입력 방지에 사용하고, OOB 값은 provisioning 보안에 사용한다.
- 천장 접근이 어렵거나 QR이 손상된 경우를 대비해 시리얼 수동 입력, RSSI 근접 후보, identify 점멸 확인을 보조 수단으로 둔다.
- 일괄 등록 중 일부 노드가 실패해도 전체 세션을 중단하지 않고, 실패 노드와 원인을 분리해 재시도할 수 있게 한다.
- 등록 완료 후 통신 품질 검증 결과를 2D 맵에 표시하고 음영 후보를 남긴다.

MVP 2 목표 MQTT topic 계약:

다음 topic은 TLS/mTLS와 장치별 ACL을 적용하는 MVP 2의 gateway-scoped 목표 계약이다. MVP 1 mock gateway가 사용하는 기존 topic과 혼동하지 않으며, MVP 2 전환 시 producer와 consumer를 함께 변경한다.

```text
sites/{siteId}/gateways/{gatewayId}/commands/dimming
sites/{siteId}/gateways/{gatewayId}/commands/provisioning/scan-start
sites/{siteId}/gateways/{gatewayId}/commands/provisioning/scan-stop
sites/{siteId}/gateways/{gatewayId}/commands/provisioning/provision-device
sites/{siteId}/gateways/{gatewayId}/commands/provisioning/identify-device
sites/{siteId}/gateways/{gatewayId}/acks/acceptance
sites/{siteId}/gateways/{gatewayId}/acks/device-status
sites/{siteId}/gateways/{gatewayId}/state/fixtures
sites/{siteId}/gateways/{gatewayId}/state/heartbeat
sites/{siteId}/gateways/{gatewayId}/events/provisioning/unprovisioned-device-found
sites/{siteId}/gateways/{gatewayId}/events/provisioning/progress
sites/{siteId}/gateways/{gatewayId}/events/provisioning/completed
sites/{siteId}/gateways/{gatewayId}/events/provisioning/failed
sites/{siteId}/gateways/{gatewayId}/events/mesh-node-metrics
```

Broker ACL은 장치 인증서의 gateway identity와 topic의 `gatewayId`를 일치시키고, API와 MQTT consumer는 topic의 `siteId/gatewayId`가 DB의 `Gateway.siteId` 관계와 일치하는지 다시 검증한다. dimming payload의 fixture 또는 group은 모두 해당 gateway에 매핑되어 있어야 하며, 다른 gateway나 site의 식별자가 하나라도 포함되면 명령 전체를 거부한다. state, ACK, heartbeat를 저장할 때도 payload의 fixture, command, gateway 관계를 같은 기준으로 검증해 topic 문자열만으로 권한을 신뢰하지 않는다.

HTTP API 초안:

```text
POST /gateways/claim
POST /gateways/bootstrap
GET  /gateways/{gatewayId}/config
POST /gateways/{gatewayId}/sync-result
POST /sites/{siteId}/registration-sessions
POST /registration-sessions/{sessionId}/nodes/{nodeId}/identify
POST /registration-sessions/{sessionId}/nodes/{nodeId}/bind-fixture
POST /registration-sessions/{sessionId}/complete
POST /mesh-nodes/{meshNodeId}/factory-reset
GET  /ota/manifest?target=gateway|node
```

SaaS 전환 시에는 사용자가 직접 가입한 뒤 현장 생성, gateway QR 또는 serial과 일회성 claim code 입력, site binding, 조명 검색/등록 순서로 진행한다. 초기 B2B 구축형에서는 운영자가 조직과 초대 계정을 만들고, 현장 설치자가 동일한 등록 플로우를 사용한다. 즉 계정 생성 방식은 달라도 mTLS bootstrap, gateway claim과 provisioning 플로우는 동일하게 유지한다.

MVP 1 구현 상태:

- `ProvisioningSession`과 `DiscoveredMeshNode`를 Prisma 모델과 migration에 반영했다.
- `POST /registration-sessions`로 등록 세션을 만들고 gateway scan MQTT command를 발행한다.
- 현재 코드가 사용하는 `sites/{siteId}/gateways/{gatewayId}/events/unprovisioned-device-found` 이벤트를 수신해 발견 노드를 저장한다.
- `POST /registration-sessions/{sessionId}/nodes/{nodeId}/identify`로 점멸 확인 상태를 관리한다.
- `POST /registration-sessions/{sessionId}/nodes/{nodeId}/register` 요청은 pending fixture 정보를 저장하고 gateway에 `provision-device` 명령을 발행한다.
- `provisioning-completed` 이벤트를 수신하면 pending fixture 정보와 provisioning 결과를 결합해 `MeshNode`와 `Fixture`를 생성하고 매핑한다.
- 등록 API는 session/site/floor/gateway를 사용자 조직 범위 안에서만 조회한다.
- MQTT 발견 이벤트는 topic의 siteId/gatewayId와 활성 등록 세션을 대조한 뒤 저장한다.
- 같은 게이트웨이 안에서 mesh address가 중복되지 않도록 DB 유니크 제약을 둔다.
- PC 웹 설정 화면과 조명 0개 모니터링 빈 상태에서 `조명 검색 시작` 플로우를 제공한다.
- 현장에 층/도면이 없으면 조명 검색을 시작할 수 없는 이유를 화면에 표시한다.
- 현장 자체가 없으면 조명 검색이 아니라 현장/층/게이트웨이 초기 설치 마법사를 먼저 표시한다.
- 모니터링 화면의 층 선택, 도면 배경, 조명 선택, 통신 품질 상세 패널을 실제 dashboard API와 연결했다.
- fixture-state MQTT event의 RSSI, hop count, 명령 성공률을 DB에 저장하고 상세 패널에 표시한다.
- gateway heartbeat MQTT event를 DB에 저장하고 gateway online/offline 상태로 표시한다.
- dashboard API는 로그인 사용자의 조직 범위 안에서만 site를 조회한다.
- ESP32-H2 펌웨어에는 물리 GPIO factory reset, BLE Mesh Health Attention 기반 identify 점멸, Health fault test/clear와 watchdog fault 기록이 구현되어 있다. 다만 gateway의 원격 `identify-device` 명령을 실제 BlueZ adapter의 Health Attention Set으로 전달하는 연결과 ESP32-H2 실제 보드 검증은 아직 미완료다. 실제 provisioning, AppKey/model bind, group subscription은 MVP 2 범위이며 OTA는 partition/version 계약과 보고 필드만 유지하고 실제 배포 구현은 MVP 2 첫 실기 범위에서 제외한다.

### 6.4 실제 장비 검증 계획과 완료 기준

하드웨어 입수 직후 `6.1`의 Phase 0을 먼저 수행하고 통과한 adapter 경로만 MVP 2 구현에 사용한다. 이어서 Raspberry Pi 1대와 ESP32-H2 2대로 고정한 2-node lab test를 수행한다.

1. 제조 credential을 가진 초기화 gateway가 mTLS bootstrap 대기 상태에 진입하고, 사용자 claim 후 올바른 assignment를 `0600`으로 저장한다.
2. 두 노드를 PB-ADV로 발견해 각각 provisioning하고 unicast address, AppKey, Generic OnOff/Light Lightness/Health bind와 동일 group subscription을 설정한다.
3. 웹에서 개별 및 group 디밍을 실행해 gateway acceptance ACK와 두 fixture의 device status ACK가 분리되고, 밝기/OnOff/transition 결과가 실제 LED와 화면에 일치하는지 확인한다.
4. 중복 idempotency key와 `eventId`, 역전된 command/state sequence, 오래된 `occurredAt`, 한 노드 timeout을 주입해 중복 실행·저장 방지, stale event 무시, fixture별 부분 실패가 계약대로 보고되는지 확인한다.
5. gateway heartbeat 중단 시 두 fixture에 offline을 전파하고, 노드 하나의 TTL 만료는 해당 fixture만 offline 처리하는지 확인한다.
6. Raspberry Pi, gateway 앱, `bluetooth-meshd`, 두 노드를 순차 및 동시 재부팅해 mapping/NVS brightness 복구와 startup resync를 확인한다.
7. identify, Health fault, watchdog reset report, factory reset 후 재등록을 각 노드에서 확인한다.
8. MQTT anonymous 접속과 다른 gateway prefix 접근이 거부되고, topic의 site/gateway/fixture 관계가 DB와 다르면 consumer가 저장하지 않는지 확인한다.

실제 장비 E2E 완료 기준은 위 2-node lab test 전체를 초기화 상태부터 3회 연속 통과하고, 웹 명령부터 실제 LED 변화와 상태 화면 반영까지 추적 가능한 command/fixture 결과가 남으며, 재부팅 후 수동 복구 없이 제어가 재개되는 것이다. 이 단계에서는 스케줄/event 엔진, OTA 실제 배포, 5~10대 이상 확장 및 대규모 RF/지하주차장 음영 검증을 수행하지 않는다. 다만 gateway와 node 모두 OTA partition layout, firmware version, manifest target, 적용 결과/rollback 상태 계약은 유지해 후속 구현과 데이터 호환성을 보장한다.

## 7. OTA

OTA는 게이트웨이와 ESP32-H2 노드로 나누어 설계한다.

### 7.1 게이트웨이 OTA

MVP 2 첫 실기 단계에서는 아래 상태와 manifest/version 계약, rollback 가능한 partition/설치 구조만 확정하고 실제 배포 agent 구현은 후속 단계로 둔다.

1. 클라우드에서 OTA manifest 조회
2. 패키지 다운로드
3. 서명 검증
4. 단계적 설치
5. 서비스 재시작
6. 상태 점검
7. 성공/실패 보고
8. 실패 시 rollback

### 7.2 노드 OTA

MVP 2 첫 실기 단계에서는 ESP-IDF OTA partition layout과 firmware version/report schema를 확정하고 실제 BLE Mesh firmware distribution 구현은 후속 단계로 둔다.

1. 클라우드에서 펌웨어 배포 정책 생성
2. Gateway가 펌웨어 다운로드
3. 대상 노드별 순차 배포
4. 노드별 성공/실패 수집
5. 클라우드에 배포 결과 보고

파일럿 단계에서는 단계적 배포, 배포 중단, 재시도, 롤백 정책을 운영 화면에서 관리한다.

## 8. 통신 시뮬레이션과 음영 검증

### 8.1 선정 도구

1차 통신 시뮬레이션 도구는 Hamina Planner로 선정한다.

선정 이유:

- 웹 기반이라 도입과 공유가 쉽다.
- 주차장 도면 업로드 후 2D/3D 기반으로 검토할 수 있다.
- Wi-Fi뿐 아니라 BLE/IoT 계열 무선 설계 검토에 적합하다.
- 예상 음영 지역과 배치 검토 보고서를 파일럿 산출물로 만들기 쉽다.

### 8.2 적용 방식

MVP 1에서는 Hamina Planner로 주차장 도면 기반 통신 음영 후보를 사전 검토하고, 서비스 내에는 간이 연결성/음영 검토 화면을 추가한다.

MVP 2 첫 실기 단계에서는 실제 ESP32-H2 노드와 게이트웨이에서 다음 지표를 수집한다.

- RSSI
- hop count
- 명령 성공률
- 응답 지연
- 재전송률
- last seen

2-node lab E2E 완료 후 수집한 지표를 2D 맵의 통신 품질 heatmap과 조명 위치 보정/자동 배치 보조에 연결한다. 이 후속 화면 작업은 첫 실기 완료 게이트에는 포함하지 않는다.

MVP 1에서는 heatmap 이전 단계로 조명 상세 패널에 RSSI, hop count, 명령 성공률을 표시한다. 이 값은 mock 게이트웨이 fixture-state event로 먼저 검증하고, 하드웨어 입수 후 실제 게이트웨이와 ESP32-H2 펌웨어의 상태 보고 계약으로 교체한다.

MVP 3 파일럿에서는 Hamina 예측 결과와 현장 실측 결과를 비교해 최종 조명/relay 배치와 설치 기준을 확정한다.

### 8.3 보조 도구

Mesh 파라미터 연구가 필요할 때만 MathWorks Bluetooth Toolbox 또는 Nordic/Babblesim을 별도 PoC로 사용한다. 기본 플랜의 주 도구는 Hamina Planner다.

## 9. 개발 로드맵

### 9.1 MVP 1: 클라우드 + PC 웹 + Mock 게이트웨이

목표: 실제 장비 없이도 관제 화면에서 상태 변화와 명령 흐름을 데모할 수 있게 한다.

범위:

- NestJS 백엔드 기본 구조
- PostgreSQL schema
- Redis 기반 실시간 상태 저장
- React PC 웹 관제 화면
- 현장/층/도면/조명 배치 관리
- 2D 맵 모니터링
- 층별 도면 에디터 1차 구현: 도면 배경 등록, 배경 없는 캔버스, 줌/팬, 도형/텍스트 편집, 조명 위치와 기본 정보 수동 편집
- 개별/그룹 제어 UI
- 스케줄/이벤트 정책 UI
- 전력 사용량 추정 통계
- React Native WebView shell
- Mock 게이트웨이와 MQTT topic 흐름
- Hamina Planner 기반 사전 RF 검토 프로세스
- 서비스 내 간이 연결성/음영 검토 화면

### 9.2 MVP 2: 게이트웨이 + BLE Mesh End-to-End

목표: 웹 명령으로 실제 조명이 디밍되고, 장비 상태가 클라우드와 화면에 반영되게 한다.

범위:

- TypeScript 기반 라즈베리파이 게이트웨이와 장기 실행 `bluetooth-meshd`/BlueZ Mesh D-Bus adapter
- Phase 0 내장 BLE 타당성 게이트와 실패 시 ESP32-H2 provisioner USB/UART bridge 전환
- HTTPS mTLS bootstrap, 일회성 claim, MQTT TLS/mTLS 및 장치별 ACL
- 게이트웨이 중심 BLE Mesh provisioning
- 층/구역 단위 조명 검색·등록 API와 UI
- ESP32-H2 BLE Mesh 펌웨어
- 실제 조명 개별/group 디밍과 transition 제어
- acceptance/device status ACK 분리, fixture별 결과, 멱등성/sequence 처리
- 상태 TTL/offline 전파, heartbeat, Health fault, startup resync
- gateway/node OTA partition, version, manifest 및 결과 계약
- RSSI, hop count, 명령 성공률, 응답 지연 수집
- 공장초기화, 재등록, 교체 등록 기본 플로우
- Raspberry Pi 1대와 ESP32-H2 2대의 실제 장비 E2E lab test
- E2E 완료 후 통신 품질 heatmap과 조명 위치 보정/자동 배치 보조

MVP 2 첫 실기 단계에서는 스케줄/event 본 구현, OTA 실제 배포, 통신 품질 heatmap/자동 배치 보조, 5~10대 이상 확장 및 대규모 RF 검증을 제외한다. heatmap과 자동 배치 보조는 2-node E2E 완료 뒤 같은 MVP 2의 후속 작업으로 진행한다. 장기 양산 언어로서 Go 권장은 유지하되, 위 실제 장비 완료 기준을 통과한 후 TypeScript 운영 결과를 평가해 Go 재작성 여부를 별도 결정한다.

### 9.3 MVP 3: 파일럿 현장 운영

목표: 파일럿 주차장에서 관리자가 일상 관제, 제어, 통계, 장애 대응을 사용할 수 있게 한다.

범위:

- 현장 설치/프로비저닝 플로우
- SaaS형 사용자 직접 가입과 게이트웨이/현장 claim 플로우
- 도면 보정과 조명 위치 편집
- CAD/DWG/DXF 연동, AI 도면 해석, 구역/그룹 후보 자동 생성 검토
- 사용자/역할/권한
- 장애 로그와 운영 알림
- OTA 배포 정책과 롤백
- 전기료 계산 보정
- Hamina 예측 보고서와 현장 측정 보고서
- 파일럿 운영 리포트

## 10. 초기 PoC 리스크

MVP 1과 병행해 다음 리스크를 별도 PoC로 확인한다.

- 지하주차장 BLE Mesh 통신거리와 음영
- 콘크리트, 철근, 차량, 기둥, 금속 배관에 따른 2.4GHz 감쇠
- LED 드라이버 디밍 방식
- 차량 감지 센서 인터페이스
- OTA 실패 복구
- 현장 네트워크 방식: 유선 LAN, Wi-Fi, LTE/5G 라우터
- 클라우드 장애 시 로컬 스케줄/이벤트 유지
- 라즈베리파이 provisioner 스택 선택과 안정성
- BLE Mesh NetKey/AppKey 저장, 회전, 분실 복구
- QR/시리얼/OOB 기반 조명 식별과 오등록 방지

## 11. 참고 자료

- Hamina Planner: https://www.hamina.com/planner
- iBwave: https://www.ibwave.com/
- Remcom Wireless InSite: https://www.remcom.com/wireless-insite-propagation-software
- MathWorks Bluetooth Mesh Networking: https://www.mathworks.com/help/bluetooth/mesh-networking.html
- Nordic Babblesim Bluetooth Mesh Simulation: https://github.com/NordicPlayground/Bluetooth-Mesh-Simulation-Using-Babblesim
- Bluetooth Mesh Provisioning: https://www.bluetooth.com/blog/provisioning-a-bluetooth-mesh-network-part-1/
- Espressif ESP-BLE-MESH: https://docs.espressif.com/projects/esp-idf/en/stable/esp32h2/api-guides/esp-ble-mesh/ble-mesh-index.html
- ESP-IDF BLE Mesh Examples: https://github.com/espressif/esp-idf/tree/master/examples/bluetooth/esp_ble_mesh

## 12. 모니터링·제어 양산 보완 설계

### 12.1 목표와 완료 판정

모니터링·제어 양산 보완의 목표는 mock/stub 성공을 실제 장비 성공으로 오인하지 않고, 단일 프로세스 장애와 gateway 재시작, MQTT 중복, 장비 timeout, 1,000개 조명 규모에서도 상태와 명령 결과가 일관되게 유지되도록 하는 것이다.

완료 수준은 다음 세 단계로 분리한다.

1. `자동 검증 완료`: unit/contract/E2E/typecheck, ESP-IDF build, 1,000 fixture 성능 시험이 통과한다.
2. `실험실 장비 완료`: Raspberry Pi BlueZ Phase 0과 ESP32-H2 2-node HIL이 3회 연속 통과한다.
3. `파일럿 완료`: 실제 주차장 RF walk test, 72시간 soak, 장애 복구와 운영자 workflow가 통과한다.

2단계 전에는 실제 장비 제어 완료, 3단계 전에는 양산 준비 완료로 표시하지 않는다.

### 12.2 Gateway adapter 선택

Gateway 본체에는 test mode, stub adapter, 범용 shell command adapter를 포함하지 않는다. 실행 가능한 adapter는 검증된 `BlueZMeshAdapter` 또는 Phase 0 실패 후 선정한 `EspProvisionerBridgeAdapter`뿐이며, 실제 adapter 초기화와 capability 검증이 끝나지 않으면 MQTT 연결 전에 종료한다. Mock gateway 런타임은 제공하지 않고 자동 테스트는 test directory의 dependency injection만 사용한다.

adapter interface는 dimming, scan, provision, identify를 분리하되 production adapter가 다음 결과를 반환해야 한다.

- fixture별 실제 Light Lightness Status
- timeout/fault code
- RSSI와 hop count 또는 수집 불가 사유
- provisioning 단계별 진행 상태
- startup 시 전체 등록 node의 현재 상태 snapshot

Raspberry Pi Phase 0 전에는 실제 BlueZ 구현을 완료로 간주하지 않는다. 다만 production mode 차단, timeout, 상태 snapshot과 adapter factory는 하드웨어 없이 먼저 구현한다.

### 12.3 명령 timeout과 gateway journal

Cloud dispatch와 BLE Mesh 실행 timeout은 분리한다.

- MQTT acceptance 제한: 기본 10초
- BLE Mesh fixture status 제한: 기본 8초, fixture별 결과 기록
- dispatch 전체 제한: 기본 30초
- 값은 환경변수로 조정할 수 있지만 1~300초 범위만 허용한다.

Gateway는 idempotency key를 journal에 기록한 후 acceptance ACK를 보낸다. accepted 상태에서 재시작해 terminal result가 없는 명령은 자동 재실행하지 않고 `indeterminate` 결과로 보고한다. 운영자가 새 command ID로 명시적으로 다시 실행해야 한다.

Journal은 모든 command 이력을 영구 보관하지 않는다. 다음 두 저장 영역으로 분리한다.

- 최근 idempotency terminal result: TTL 24시간, 최대 10,000건
- fixture latest snapshot: fixture별 정확히 1건

startup resync는 fixture latest snapshot만 새 event sequence로 발행하고, 원래 command의 오래된 `occurredAt`을 재사용하지 않는다. resync 발생 시각과 `statusReason=startup_resync`를 사용한다. 실제 adapter가 전체 node status를 조회할 수 있으면 저장 snapshot보다 실제 조회 결과를 우선한다.

### 12.4 Outbox 다중 인스턴스와 dead-letter

API outbox publisher는 row lease를 사용한다. `lockedBy`, `lockedAt`, `leaseExpiresAt`을 원자적으로 갱신하거나 PostgreSQL `FOR UPDATE SKIP LOCKED`로 한 publisher만 batch를 소유한다. MQTT publish 성공 후 동일 lease owner만 `publishedAt`을 기록한다.

재시도는 지수 backoff와 jitter를 사용하고 최대 10회 또는 15분을 초과하면 dead-letter 상태로 전환한다. dead-letter dispatch는 `failed`와 명확한 error code를 기록하고 상위 Command 집계를 갱신한다. acceptance/device ACK가 제한 시간을 넘으면 dispatch와 pending fixture result를 `timed_out`으로 닫는다.

API replica 2개를 동시에 실행해 같은 outbox가 한 번만 소유되는 통합 테스트를 필수로 한다. MQTT QoS 1 재전송은 gateway idempotency journal이 최종 방어선이지만 publisher 중복을 정상 동작으로 의존하지 않는다.

### 12.5 모니터링 데이터 모델과 UI

Dashboard fixture 응답에 `gatewayId`, `gatewayName`, `gatewayConnectionStatus`, `statusReason`, `lastStateOccurredAt`을 포함한다. 상세 패널은 첫 gateway가 아니라 선택 fixture가 실제 연결된 gateway를 표시한다.

상태 사유는 다음 한국어 문구로 구분한다.

- `reported`: 정상 보고
- `startup_resync`: 재시작 동기화
- `fixture_stale`: 조명 상태 수신 지연
- `gateway_offline`: 게이트웨이 연결 끊김
- `command_failed`: 최근 명령 실패

1,000개 조명 현장은 전체 dashboard를 3초마다 다시 전송하지 않는다. 현장·층·그룹 metadata와 fixture snapshot 조회를 분리하고, 층 선택 시 해당 층 fixture를 cursor/page 단위로 조회한다. 상태 변경은 SSE 또는 WebSocket delta event로 반영하며 연결이 끊기면 증가형 sync cursor로 누락분을 복구한다. 지도는 viewport 안의 marker만 상세 렌더링하고 zoom level에 따라 cluster 또는 compact marker를 사용한다.

도면 원본과 렌더 이미지는 S3 호환 Object Storage에 저장한다. DB에는 object key, content type, size, checksum, version만 저장하고 data URL은 운영 API에서 허용하지 않는다. 테스트는 실제 S3 API와 호환되는 로컬 object storage를 사용한다. 업로드 크기, MIME, 확장자, 이미지 decode, PDF page 제한을 서버에서 검증한다.

### 12.6 제어 UI와 운영자 결과 확인

offline, gateway offline, provisioning 중, mesh mapping 없음 상태는 기본적으로 제어 버튼을 비활성화한다. 그룹에 제어 불가능한 fixture가 포함되면 전송 전 대상 수와 제외/실패 정책을 표시한다. 이번 범위에서는 하나라도 제어 불가능하면 명령 전체를 거부해 부분 대상 오인을 막는다.

`POST /commands/dimming` 응답은 command ID와 dispatch 수를 반환한다. 제어 화면은 command status endpoint를 polling하거나 push event로 구독해 `접수`, `gateway 수신`, `장비 적용`, `부분 실패`, `timeout`을 구분한다. fixture별 실패 사유를 표시하고 사용자가 새 command로 재시도할 수 있게 한다. 이전 idempotency key를 재사용하는 retry는 허용하지 않는다.

### 12.7 테스트 전략

자동 테스트는 다음 계층으로 운영한다.

1. Unit: adapter factory, timeout, journal prune/latest snapshot, outbox lease/backoff/dead-letter, UI 상태 제한.
2. Integration: PostgreSQL replica 2개 publisher 경쟁, Mosquitto 중복/단절, API ACK timeout 집계, Object Storage upload 검증.
3. Browser E2E: fixture 1,000개 층 전환, viewport marker, offline 제어 차단, command 단계별 결과.
4. HIL: Raspberry Pi 1대와 ESP32-H2 2대의 scan/provision/bind/individual/group/timeout/restart/ACL 시나리오 3회.
5. Soak: 72시간 heartbeat, 10초 간격 상태 event, 주기적 명령, MQTT/API/gateway 재시작에서 memory, journal, DB 증가량과 누락을 측정한다.

자동 성능 기준은 개발 장비에서 1,000 fixture 층 조회 API p95 1초 이하, 상태 delta 반영 p95 2초 이하, 지도 pan/zoom 중 장시간 30fps 미만 구간이 없고 브라우저 메모리가 30분 동안 지속 증가하지 않는 것이다. HIL 기준은 명령 100회에서 중복 실제 제어 0회, 최종 결과 누락 0회, 재부팅 후 수동 DB 수정·재provision 0회다.

### 12.8 구현 순서

1. production adapter factory와 stub 차단
2. BLE timeout, indeterminate recovery, journal snapshot/TTL/prune
3. outbox lease, backoff, dead-letter, dispatch timeout worker
4. fixture별 gateway 응답과 offline 제어 차단, command status UI
5. metadata/snapshot 분리 API와 1,000 fixture 성능 시험
6. Object Storage 도면 업로드
7. Raspberry Pi Phase 0 후 실제 adapter
8. 2-node HIL 3회와 72시간 soak

### 12.9 양산 단일 기준 원칙

설계와 구현에는 테스트 전용 런타임 분기를 두지 않는다. 자동 테스트는 양산 코드의 interface에 fake dependency를 주입하거나 PostgreSQL, Redis, Mosquitto, S3 호환 storage의 실제 프로토콜을 로컬에서 실행해 검증한다. `NODE_ENV=test` 헤더 우회, production에서만 활성화되는 보안 검사, 현장 ID를 직접 넣는 test assignment 같은 분기는 제거한다.

개발 편의를 위한 mock은 별도 process와 별도 package로 격리하고 양산 gateway/API/Web build에 import되지 않아야 한다. 모든 필수 credential, TLS, adapter capability, storage endpoint 검사는 환경에 관계없이 동일하게 적용한다. 로컬 개발도 개발용 CA와 인증서를 사용하며 평문 MQTT fallback을 제공하지 않는다.
