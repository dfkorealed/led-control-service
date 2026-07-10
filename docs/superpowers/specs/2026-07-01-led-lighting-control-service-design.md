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

- MVP 1: PC 웹 모니터링 화면에서 선택 층을 전체 화면 에디터로 열어 배경 없음/JPG/PNG/PDF 첫 페이지 배경, 줌/팬, 기본 도형, 텍스트, 조명 위치와 조명 기본 정보를 수동 편집한다. 구현은 진행 중이며 `FloorPlan` 확장과 `FloorMapObject` 추가를 전제로 한다.
- MVP 2: 실제 게이트웨이와 ESP32-H2 provisioning 결과, RSSI, hop count, 명령 성공률을 바탕으로 조명 위치 보정과 통신 품질 확인을 돕는 자동 배치 보조 기능을 추가한다.
- MVP 3: 파일럿 현장 운영 데이터를 반영해 CAD/DWG/DXF 연동, AI 도면 해석, 구역/그룹 후보 자동 생성, 현장 실측 기반 배치 개선을 검토한다.

### 2.4 인증, 회원가입, 자동 로그인

MVP 1의 인증은 고객사별 설치형 운영과 향후 SaaS 전환을 모두 고려해 초대 기반 가입 모델로 시작한다.

초기 설치형에서는 개발사 또는 운영자가 고객사 조직, 현장, 초기 관리자 초대를 생성한다. 고객사 사용자는 전달받은 초대 토큰으로 회원가입 화면에 진입하고, 본인이 직접 이메일, 이름, 비밀번호를 설정한다. 개발사가 고객사 비밀번호를 직접 생성해 전달하는 방식은 계정 공유, 초기 비밀번호 유출, 감사 로그 불명확성 문제가 있으므로 기본 방식으로 사용하지 않는다.

회원가입은 공개 가입이 아니라 초대 토큰 또는 현장 가입 코드가 있어야 가능하게 한다. 이를 통해 초기 B2B 환경에서는 승인된 사용자만 조직에 들어오고, SaaS 전환 시에는 사용자가 직접 가입한 뒤 게이트웨이 시리얼, QR 코드, 현장 claim 코드로 현장을 연결하는 구조로 확장한다.

로그인은 이메일과 비밀번호를 사용한다. 비밀번호는 서버에 평문으로 저장하지 않고 salt가 포함된 단방향 hash로 저장한다. 로그인 성공 시 서버가 무작위 session token을 발급하고, token 원문은 HttpOnly cookie에만 저장한다. DB에는 session token hash만 저장한다.

자동 로그인은 같은 session 구조를 사용하되 만료 기간만 늘린다. 일반 로그인 session은 짧은 기간으로 두고, 자동 로그인을 선택하면 더 긴 만료 시간을 부여한다. 로그아웃, 비밀번호 변경, 계정 비활성화, 권한 변경 시 관련 session은 폐기할 수 있어야 한다.

역할은 `owner`, `admin`, `operator`, `viewer`를 기준으로 한다. MVP 1에서는 `operator` 이상만 조명 제어를 수행할 수 있게 하고, `viewer`는 모니터링과 통계 조회만 가능하게 한다.

## 3. 시스템 아키텍처

### 3.1 전체 구조

- 클라이언트: PC 웹, React Native WebView 앱, 태블릿 WebView
- 클라우드: NestJS, PostgreSQL, Redis, MQTT broker
- 현장 장비: Raspberry Pi 게이트웨이, ESP32-H2 BLE Mesh 노드, LED 드라이버, 센서

클라우드는 인증, 현장/층/도면, 조명 제어, 실시간 상태, 전력 통계, OTA 관리를 담당한다.

게이트웨이는 클라우드와 MQTT 및 HTTP API를 함께 사용한다.

- MQTT 데이터 플레인: 조명 명령, 상태 보고, heartbeat, 이벤트, 명령 ACK
- HTTP 운영 플레인: 게이트웨이 등록, 설정 동기화, OTA manifest 조회, 패키지 다운로드, 도면/메타데이터 조회

클라우드 연결이 끊겨도 게이트웨이는 저장된 스케줄, 이벤트 정책, 기본 밝기 정책을 로컬에서 계속 실행한다.

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
- Command / CommandLog: 제어 명령, ACK, 실패, 재시도
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

라즈베리파이 게이트웨이의 장기 양산 개발 언어는 Go를 추천한다. 단일 바이너리 배포, 장기 실행 안정성, MQTT/HTTP/systemd/로컬 큐 구현의 균형이 좋기 때문이다.

다만 2026-07-08 수동 제어 MVP 구현에서는 기존 TypeScript monorepo, shared MQTT schema, mock gateway 테스트 자산을 재사용하기 위해 `apps/gateway`를 Node.js/TypeScript 실행 앱으로 먼저 만든다. 이 앱은 실제 라즈베리파이에서 MQTT 명령 수신, command ACK, fixture state, heartbeat 발행을 검증하는 골격이며, BLE Mesh 전송부는 `BleMeshAdapter` 인터페이스 뒤에 둔다. 하드웨어 확보 후 이 adapter를 BlueZ D-Bus 또는 검증된 BLE Mesh provisioner 스택으로 교체하고, 양산 단계에서 Go 단일 바이너리로 재작성할지 결정한다.

게이트웨이 구성 요소:

- MQTT client
- HTTP 설정 동기화 client
- BLE Mesh Provisioner
- 로컬 스케줄러
- 이벤트 정책 엔진
- 명령 큐와 재시도
- 로컬 저장소 SQLite
- OTA agent
- journald 기반 로그와 cloud upload
- systemd 기반 실행/복구

최종 구현 방향은 라즈베리파이 게이트웨이를 BLE Mesh Provisioner로 두는 것이다. 클라우드는 현장, 층, 구역, 조명, 권한, 정책, 이력을 관리하는 원장 역할을 하고, 실제 BLE Mesh 네트워크 생성과 노드 등록은 현장 게이트웨이가 수행한다. 모바일 앱이나 태블릿은 기본 provisioner가 아니라 클라우드 UI를 표시하는 조작 단말로 본다.

게이트웨이의 provisioning 책임:

- unprovisioned beacon 스캔
- device UUID, 시리얼/QR, RSSI, OOB capability 수집
- NetKey/AppKey 기반 provisioning 수행
- unicast address 할당
- model binding, group subscription, publication 설정
- identify 명령으로 현장 점멸 확인
- 등록 진행률, 실패 원인, 통신 품질 지표 보고
- 로컬 SQLite에 mesh mapping과 마지막 설정 버전 캐시
- 클라우드 재연결 시 미보고 결과와 상태 재동기화

MQTT는 실시간 명령/이벤트 플레인으로 사용하고, HTTP API는 게이트웨이 claim, 설정 동기화, OTA manifest, 등록 세션 생성 같은 운영 플레인으로 분리한다. 게이트웨이와 클라우드 인증은 장치별 credential, mTLS 또는 이에 준하는 장치 인증을 사용한다.

### 6.2 ESP32-H2 펌웨어

ESP32-H2는 ESP-IDF 기반 C 펌웨어로 개발한다. PlatformIO는 일반 개발 편의성은 좋지만, ESP32-H2 보드 지원과 BLE Mesh, OTA partition, 보안 설정 같은 상용화 필수 기능에서 공식 지원 추적이 늦을 수 있다. 실제 테스트에서도 PlatformIO가 ESP32-H2 보드를 찾지 못한 문제가 있었으므로, 상용화 기준의 기본 SDK는 Espressif 공식 ESP-IDF로 고정한다.

펌웨어 구성 요소:

- BLE Mesh node
- provisioning / group address / model 설정
- 디밍 제어
- 상태 보고
- 센서/차량 감지 이벤트 입력
- 펌웨어 버전 보고
- OTA 수신과 결과 보고

LED 드라이버 인터페이스는 실제 제품 사양에 따라 PWM, 0-10V, DALI 등으로 확정한다. MVP에서는 우선 개발 보드와 제어 가능한 드라이버 조합으로 PoC를 수행한다.

2026-07-08 수동 제어 MVP에서는 `apps/esp32-h2-firmware`를 ESP-IDF 프로젝트 구조로 만들고, LEDC PWM 기반 `led_driver`, 밝기 상태 관리 `control_state`, 앱 부팅 진입점 `app_main`을 추가했다. 로컬에는 `idf.py`가 없어 전체 ESP-IDF 빌드는 수행하지 못했지만, 하드웨어 독립적인 `control_state`는 C 컴파일 테스트로 검증한다. 실제 보드에서는 `idf.py set-target esp32h2`, `idf.py build`, `idf.py flash monitor` 순서로 검증한다.

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

ESP32-H2 노드는 실제 펌웨어 단계에서 디밍 상태, 장애 상태, 마지막 명령 sequence, 펌웨어 버전을 게이트웨이에 보고한다. 게이트웨이는 BLE Mesh 통신 결과를 취합해 클라우드에 다음 지표를 MQTT로 전송한다.

- 조명별 brightness, powerOn, status, lastSeenAt
- 조명별 RSSI, hop count, 명령 성공률
- gateway heartbeat와 firmware version
- command ACK, 실패 사유, 재시도 결과

MVP 1에서는 mock 게이트웨이가 같은 MQTT 계약으로 fixture-state와 gateway heartbeat를 발행한다. API는 이를 PostgreSQL 최신 상태 snapshot에 반영하고, 웹 모니터링 화면은 dashboard API polling으로 표시한다.

### 6.3 조명 검색과 등록

최종 등록 방식은 게이트웨이 중심의 층/구역 단위 일괄 등록으로 결정한다. 지하주차장은 콘크리트, 철근, 차량, 금속 배관, 층간 구조 때문에 한 장소에서 모든 층의 조명을 안정적으로 등록하는 방식을 기본값으로 두지 않는다. 설치자는 각 층 또는 구역 단위로 이동하며 등록 세션을 열고, 현장 게이트웨이가 가까운 미등록 조명을 스캔해 등록한다.

조명 검색 전에는 현장, 층, 게이트웨이가 먼저 등록되어 있어야 한다. 최초 가입 또는 빈 DB 상태에서는 조명 등록 화면보다 `초기 설치 설정` 마법사를 먼저 제공한다. 이 마법사는 현장명, 주소, 전기요금 단가, 층 이름, 층 level, 필수 게이트웨이 시리얼을 받아 `Site`, `Floor`, `Gateway`를 생성한다.

층은 게이트웨이 검색 결과로 자동 생성하지 않는다. 게이트웨이는 물리 장비라서 층 정보를 스스로 정확히 알기 어렵고, 지하주차장에서는 위층/아래층 신호가 섞일 수 있다. 따라서 사용자가 층 구조를 먼저 정의하고, 게이트웨이 검색 또는 시리얼 입력은 등록된 현장에 장비를 연결하는 보조 단계로 사용한다.

등록 흐름:

```text
현장 생성 또는 SaaS 현장 claim
→ 층 등록
→ 게이트웨이 QR/시리얼 claim
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

MQTT topic 초안:

```text
sites/{siteId}/gateways/{gatewayId}/commands/provisioning-scan-start
sites/{siteId}/gateways/{gatewayId}/commands/provisioning-scan-stop
sites/{siteId}/gateways/{gatewayId}/commands/provision-device
sites/{siteId}/gateways/{gatewayId}/commands/identify-device
sites/{siteId}/gateways/{gatewayId}/events/unprovisioned-device-found
sites/{siteId}/gateways/{gatewayId}/events/provisioning-progress
sites/{siteId}/gateways/{gatewayId}/events/provisioning-completed
sites/{siteId}/gateways/{gatewayId}/events/provisioning-failed
sites/{siteId}/gateways/{gatewayId}/events/mesh-node-metrics
```

HTTP API 초안:

```text
POST /gateways/claim
GET  /gateways/{gatewayId}/config
POST /gateways/{gatewayId}/sync-result
POST /sites/{siteId}/registration-sessions
POST /registration-sessions/{sessionId}/nodes/{nodeId}/identify
POST /registration-sessions/{sessionId}/nodes/{nodeId}/bind-fixture
POST /registration-sessions/{sessionId}/complete
POST /mesh-nodes/{meshNodeId}/factory-reset
GET  /ota/manifest?target=gateway|node
```

SaaS 전환 시에는 사용자가 직접 가입한 뒤 현장 생성, 게이트웨이 claim, 조명 검색/등록 순서로 진행한다. 초기 B2B 구축형에서는 운영자가 조직과 초대 계정을 만들고, 현장 설치자가 동일한 등록 플로우를 사용한다. 즉 계정 생성 방식은 달라도 게이트웨이 claim과 provisioning 플로우는 동일하게 유지한다.

MVP 1 구현 상태:

- `ProvisioningSession`과 `DiscoveredMeshNode`를 Prisma 모델과 migration에 반영했다.
- `POST /registration-sessions`로 등록 세션을 만들고 gateway scan MQTT command를 발행한다.
- `sites/{siteId}/gateways/{gatewayId}/events/unprovisioned-device-found` 이벤트를 수신해 발견 노드를 저장한다.
- `POST /registration-sessions/{sessionId}/nodes/{nodeId}/identify`로 점멸 확인 상태를 관리한다.
- `POST /registration-sessions/{sessionId}/nodes/{nodeId}/register`로 `MeshNode`와 `Fixture`를 생성해 매핑한다.
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
- 실제 ESP32-H2 provisioning, AppKey bind, group subscription, OTA, 공장초기화는 MVP 2 범위다.

### 6.4 하드웨어 입수 후 PoC 순서

1. ESP32-H2 2대 이상으로 BLE Mesh node와 provisioning 기본 예제를 검증한다.
2. 라즈베리파이에서 provisioner 역할을 수행할 스택을 검증한다.
3. 단일 노드 QR/시리얼 매핑, identify 점멸, 디밍 명령 end-to-end를 확인한다.
4. 5-10개 노드로 group address, 구역 제어, 상태 보고, ACK/재시도를 확인한다.
5. 층/구역 등록 세션을 클라우드 API/MQTT 계약과 연결한다.
6. 공장초기화 후 재등록, 중복 등록, 교체 등록을 테스트한다.
7. NetKey/AppKey 저장, 백업, 회전, 게이트웨이 재설치 시나리오를 검증한다.
8. 실제 LED 드라이버 PWM/0-10V/DALI 중 확정 후 전기적 제어 안정성을 테스트한다.
9. 지하주차장 유사 환경에서 RSSI, hop count, 명령 성공률, 지연시간을 측정한다.
10. OTA, 전원 차단, 네트워크 단절, 게이트웨이 재부팅 복구를 테스트한다.

## 7. OTA

OTA는 게이트웨이와 ESP32-H2 노드로 나누어 설계한다.

### 7.1 게이트웨이 OTA

1. 클라우드에서 OTA manifest 조회
2. 패키지 다운로드
3. 서명 검증
4. 단계적 설치
5. 서비스 재시작
6. 상태 점검
7. 성공/실패 보고
8. 실패 시 rollback

### 7.2 노드 OTA

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

MVP 2에서는 실제 ESP32-H2 노드와 게이트웨이에서 다음 지표를 수집한다.

- RSSI
- hop count
- 명령 성공률
- 응답 지연
- 재전송률
- last seen

수집한 지표는 2D 맵에 통신 품질 heatmap으로 표시한다.

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

- Go 기반 라즈베리파이 게이트웨이
- MQTT/HTTP 클라우드 연동
- 게이트웨이 중심 BLE Mesh provisioning
- 층/구역 단위 조명 검색·등록 API와 UI
- ESP32-H2 BLE Mesh 펌웨어
- 실제 조명 디밍 제어
- 상태 보고, heartbeat, fault 보고
- 로컬 스케줄/이벤트 실행
- 게이트웨이 OTA 기본 구조
- 노드 OTA 기본 구조
- RSSI, hop count, 명령 성공률, 응답 지연 수집
- 통신 품질 heatmap
- provisioning 결과와 통신 품질 지표를 활용한 조명 위치 보정 및 자동 배치 보조
- 공장초기화, 재등록, 교체 등록 기본 플로우

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
