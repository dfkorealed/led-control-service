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
- Site / Building / Floor: 현장, 건물, 층, 운영 설정
- FloorPlan: 도면 이미지, 좌표계, 버전
- Fixture: 개별 LED 조명, 정격 전력, 설치 위치, 현재 상태
- Zone / Group: 구역 또는 그룹 제어 단위
- Gateway: 라즈베리파이 게이트웨이, 연결 상태, 설정 버전, OTA 버전
- MeshNode: ESP32-H2 노드, BLE Mesh 주소, 펌웨어 버전, 상태
- Schedule / EventPolicy: 시간 기반 제어, 차량 감지 등 이벤트 기반 제어
- Command / CommandLog: 제어 명령, ACK, 실패, 재시도
- EnergyUsage: 추정 전력 사용량, 향후 실측값 보정
- Tariff / BillingEstimate: 전기요금 계산 설정
- OtaPackage / OtaDeployment: 게이트웨이 및 노드 OTA 패키지와 배포 이력

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

라즈베리파이 게이트웨이 개발 언어는 Go를 추천한다. 단일 바이너리 배포, 장기 실행 안정성, MQTT/HTTP/systemd/로컬 큐 구현의 균형이 좋기 때문이다.

게이트웨이 구성 요소:

- MQTT client
- HTTP 설정 동기화 client
- 로컬 스케줄러
- 이벤트 정책 엔진
- 명령 큐와 재시도
- 로컬 저장소 SQLite
- OTA agent
- journald 기반 로그와 cloud upload
- systemd 기반 실행/복구

### 6.2 ESP32-H2 펌웨어

ESP32-H2는 ESP-IDF 기반 C 펌웨어로 개발한다.

펌웨어 구성 요소:

- BLE Mesh node
- provisioning / group address / model 설정
- 디밍 제어
- 상태 보고
- 센서/차량 감지 이벤트 입력
- 펌웨어 버전 보고
- OTA 수신과 결과 보고

LED 드라이버 인터페이스는 실제 제품 사양에 따라 PWM, 0-10V, DALI 등으로 확정한다. MVP에서는 우선 개발 보드와 제어 가능한 드라이버 조합으로 PoC를 수행한다.

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
- ESP32-H2 BLE Mesh 펌웨어
- 실제 조명 디밍 제어
- 상태 보고, heartbeat, fault 보고
- 로컬 스케줄/이벤트 실행
- 게이트웨이 OTA 기본 구조
- 노드 OTA 기본 구조
- RSSI, hop count, 명령 성공률, 응답 지연 수집
- 통신 품질 heatmap

### 9.3 MVP 3: 파일럿 현장 운영

목표: 파일럿 주차장에서 관리자가 일상 관제, 제어, 통계, 장애 대응을 사용할 수 있게 한다.

범위:

- 현장 설치/프로비저닝 플로우
- 도면 보정과 조명 위치 편집
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

## 11. 참고 자료

- Hamina Planner: https://www.hamina.com/planner
- iBwave: https://www.ibwave.com/
- Remcom Wireless InSite: https://www.remcom.com/wireless-insite-propagation-software
- MathWorks Bluetooth Mesh Networking: https://www.mathworks.com/help/bluetooth/mesh-networking.html
- Nordic Babblesim Bluetooth Mesh Simulation: https://github.com/NordicPlayground/Bluetooth-Mesh-Simulation-Using-Babblesim
- ESP-IDF ESP-BLE-MESH 문서: https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/bluetooth/esp-ble-mesh.html
