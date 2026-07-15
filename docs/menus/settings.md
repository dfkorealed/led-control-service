# 설정 메뉴 기능 현황

> PKI onboarding은 코드 완료·실기 미검증이다. 실물 장비와 offline Root/Vault backup 승인 증거는 별도 확인 전까지 완료로 표시하지 않는다.

기준일: 2026-07-15

## 구현 완료

- 현장이 없으면 `초기 설치 설정` 마법사를 표시한다.
- 초기 설치에서 현장명, 주소, kWh 단가, 층 이름과 층 level을 등록한다. 이 단계에서는 Gateway 레코드를 만들지 않는다.
- 현장 생성 후 제조 원장의 시리얼과 일회성 등록 코드로 gateway를 claim한다. 성공한 장비만 Gateway 레코드와 현장 assignment를 가진다.
- 초기 설치 화면과 초기 설치 API는 gateway firmware version을 사용자 입력값으로 사용하지 않고, gateway heartbeat의 `firmwareVersion` 값으로 자동 갱신한다.
- 현장, 층/도면, 그룹, 게이트웨이, OTA, 사용자 권한 설정 카드를 표시한다.
- 게이트웨이 카드에 실제 gateway 이름, 시리얼, 온라인/오프라인 상태를 표시한다.
- 현장이 있으면 `조명 등록` 패널을 제공한다.
- 조명 등록 세션을 시작할 수 있다.
- 발견된 BLE Mesh 후보 노드를 표시한다.
- 후보 노드 점멸 확인 명령을 보낼 수 있다.
- 후보 노드 등록 요청 시 API가 pending fixture 정보를 저장하고 gateway `provision-device` 명령을 발행한다.
- gateway `provisioning-completed` 이벤트 수신 시 API가 `MeshNode`와 `Fixture`를 생성한다.
- gateway `provisioning-failed` 이벤트 수신 시 후보 노드를 실패 상태와 실패 사유로 갱신한다.
- 등록 세션을 완료할 수 있다.
- 백엔드에 제조 장비 원장 기반 `POST /gateways/claim` API를 구현했다. 조직의 owner/admin만 현장에 장비를 연결할 수 있고 일회성 claim code는 성공 시 폐기된다.
- 백엔드에 장비 인증서 기반 `POST /gateway-bootstrap` API를 구현했다. 인증된 TLS peer certificate의 SHA-256 fingerprint와 제조 원장을 대조한 뒤 assignment만 반환한다.
- claim 성공/실패 감사 로그와 15분 내 연속 실패 rate limit을 적용했다.
- Raspberry Pi Docker appliance가 실제 BlueZ scan/provisioning adapter를 사용하며 mesh identity/token과 fixture-unicast mapping을 영속 저장한다.
- 등록 완료 시 discovered node ID를 Fixture ID로 사용해 gateway mapping과 이후 제어 ID가 일치한다.
- ARM64 image build/checksum/deploy 스크립트와 Pi 설치·인증서·ESP32 적용·복구 runbook을 제공한다.
- 실제 Raspberry Pi gateway가 MQTT scan 명령을 처리할 때만 후보 조명이 나타나며 mock 검색 실행 경로는 제거했다.
- 파괴적인 demo seed를 제거하고, 빈 DB에서만 owner를 생성하는 `auth:bootstrap-owner` 명령을 제공한다.

## 미구현

- 현장 정보 수정
- 층 추가/수정/삭제 UI
- 도면 파일 업로드
- 조명 위치 편집
- fixture group 생성/수정/삭제
- 여러 gateway 추가 등록과 QR claim UI
- gateway별 층/구역 coverage 설정
- ESP32-H2 factory reset UI/명령 연동
- provisioning 전 vendor identify 점멸 protocol
- 사용자 초대, 권한 변경, 계정 비활성화
- OTA 패키지 업로드
- OTA 배포 생성, 중단, 롤백
- 설정 변경 감사 로그
- 현장 삭제 또는 초기화 workflow

## 부족하거나 개선이 필요한 기능

- 설정 카드는 대부분 요약 표시이며 상세 편집 화면으로 연결되지 않는다.
- 최초 gateway의 수동 생성 우회를 제거하고 제조 원장 기반 claim UI를 구현했다. 여러 gateway 추가 등록 UX는 아직 없다.
- gateway firmware version은 heartbeat 기반 자동 갱신으로 바뀌었지만, 실제 라즈베리파이 배포 시 정확한 `GATEWAY_FIRMWARE_VERSION` 주입 정책이 필요하다.
- `gateway:enroll-inventory` 명령으로 `GatewayInventory`에 serial, scrypt claim code hash, 인증서 fingerprint를 비파괴 적재한다. 양산 제조 PKI/ERP 연동 전까지 사용하는 운영 도구다.
- 운영 mTLS에는 API server certificate/key, device CA 배포와 인증서 폐기·교체 절차가 필요하다. 이 값들은 Git이나 DB에 private key 형태로 저장하지 않는다.
- 조명 등록은 첫 번째 floor와 첫 번째 gateway를 중심으로 동작하므로 층 선택/게이트웨이 선택 UI가 필요하다.
- 등록된 조명 위치는 자동 좌표로 배치되며 실제 도면 위 위치 조정이 필요하다.
- 표준 BLE Mesh는 provisioning 전 Generic 모델 점멸이 불가능하므로 현재 식별 명령은 명시적 미지원 오류를 반환한다. 유지하려면 vendor provisioning identify protocol이 필요하다.
- Pi Phase 0의 network 생성/token 재연결은 확인했지만 실제 ESP32-H2 검색·등록·model bind는 아직 실기 검증이 필요하다.
- ESP32-H2가 이미 provisioning된 상태면 검색되지 않으므로 `erase-flash` 또는 펌웨어 factory reset 절차가 필요하다.
- 정적 RF 안내 패널은 기능처럼 보이지 않도록 화면에서 제거했다. 실제 RF 시뮬레이션과 heatmap은 미구현 상태다.
- 초기 현장 생성과 gateway claim을 분리했고 수동 Gateway 생성 API를 제거했다. 제조 원장 적재, 웹 claim, appliance bootstrap의 실장비 연속 검증은 아직 필요하다.

## 관련 파일

- `apps/web/src/features/settings/SettingsView.tsx`
- `apps/web/src/features/setup/SetupWizard.tsx`
- `apps/web/src/features/setup/GatewayClaimPanel.tsx`
- `apps/web/src/features/registration/RegistrationPanel.tsx`
- `apps/web/src/features/rf/RfPlanningPanel.tsx`
- `apps/web/src/api/setup.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/gateway/src/gateway.ts`
- `apps/gateway/src/index.ts`
- `apps/web/src/api/registration.ts`
- `apps/api/src/setup`
- `apps/api/prisma/enroll-gateway-inventory.ts`
- `apps/api/src/registration`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260710093000_add_provisioning_pending_fixture/migration.sql`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `apps/gateway/compose.raspberry-pi.yml`
- `docs/runbooks/raspberry-pi-gateway-appliance.md`
- `packages/shared/src/mqtt.ts`
- `packages/shared/src/schemas.ts`

## 갱신 규칙

설정 메뉴의 현장, 층, 도면, 그룹, 게이트웨이, 사용자 권한, OTA, RF 계획 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
