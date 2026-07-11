# 설정 메뉴 기능 현황

기준일: 2026-07-11

## 구현 완료

- 현장이 없으면 `초기 설치 설정` 마법사를 표시한다.
- 초기 설치에서 현장명, 주소, kWh 단가, 층 이름, 층 level, 게이트웨이 이름, 게이트웨이 시리얼을 등록한다.
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
- 별도 mock-gateway process로 조명 검색과 등록 완료 이벤트의 cloud pipeline을 검증할 수 있다.
- 등록 세션을 완료할 수 있다.
- RF 계획 패널에서 Hamina Planner 기반 사전 검토 방향을 안내한다.
- 백엔드에 제조 장비 원장 기반 `POST /gateways/claim` API를 구현했다. 조직의 owner/admin만 현장에 장비를 연결할 수 있고 일회성 claim code는 성공 시 폐기된다.
- 백엔드에 장비 인증서 기반 `POST /gateway-bootstrap` API를 구현했다. 인증된 TLS peer certificate의 SHA-256 fingerprint와 제조 원장을 대조한 뒤 assignment만 반환한다.
- claim 성공/실패 감사 로그와 15분 내 연속 실패 rate limit을 적용했다.

## 미구현

- 현장 정보 수정
- 층 추가/수정/삭제 UI
- 도면 파일 업로드
- 조명 위치 편집
- fixture group 생성/수정/삭제
- gateway 추가 등록 UI
- gateway claim 또는 QR 등록 UI
- gateway별 층/구역 coverage 설정
- 실제 라즈베리파이 BLE Mesh provisioner command 구현체
- ESP32-H2 factory reset UI/명령 연동
- 사용자 초대, 권한 변경, 계정 비활성화
- OTA 패키지 업로드
- OTA 배포 생성, 중단, 롤백
- 설정 변경 감사 로그
- 현장 삭제 또는 초기화 workflow

## 부족하거나 개선이 필요한 기능

- 설정 카드는 대부분 요약 표시이며 상세 편집 화면으로 연결되지 않는다.
- 초기 설치 후 gateway를 누락할 수 없도록 막았지만, 추가 gateway 등록 UI는 아직 없다.
- gateway firmware version은 heartbeat 기반 자동 갱신으로 바뀌었지만, 실제 라즈베리파이 배포 시 정확한 `GATEWAY_FIRMWARE_VERSION` 주입 정책이 필요하다.
- 제조 단계에서 `GatewayInventory`에 serial, scrypt claim code hash, 인증서 fingerprint를 안전하게 적재하는 운영 도구가 필요하다.
- 운영 mTLS에는 API server certificate/key, device CA 배포와 인증서 폐기·교체 절차가 필요하다. 이 값들은 Git이나 DB에 private key 형태로 저장하지 않는다.
- 조명 등록은 첫 번째 floor와 첫 번째 gateway를 중심으로 동작하므로 층 선택/게이트웨이 선택 UI가 필요하다.
- 등록된 조명 위치는 자동 좌표로 배치되며 실제 도면 위 위치 조정이 필요하다.
- 실제 하드웨어 등록은 Raspberry Pi Phase 0 통과 후 BlueZ Mesh adapter 구현이 필요하며, 그 전에는 양산 gateway 시작이 차단된다.
- ESP32-H2가 이미 provisioning된 상태면 검색되지 않으므로 `erase-flash` 또는 펌웨어 factory reset 절차가 필요하다.
- RF 계획 패널은 정적 안내이며 실제 시뮬레이션 파일, RSSI heatmap, 현장 체크리스트와 연결되어 있지 않다.

## 관련 파일

- `apps/web/src/features/settings/SettingsView.tsx`
- `apps/web/src/features/setup/SetupWizard.tsx`
- `apps/web/src/features/registration/RegistrationPanel.tsx`
- `apps/web/src/features/rf/RfPlanningPanel.tsx`
- `apps/web/src/api/setup.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/gateway/src/gateway.ts`
- `apps/gateway/src/index.ts`
- `apps/web/src/api/registration.ts`
- `apps/api/src/setup`
- `apps/api/src/registration`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260710093000_add_provisioning_pending_fixture/migration.sql`
- `packages/shared/src/mqtt.ts`
- `packages/shared/src/schemas.ts`

## 갱신 규칙

설정 메뉴의 현장, 층, 도면, 그룹, 게이트웨이, 사용자 권한, OTA, RF 계획 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
