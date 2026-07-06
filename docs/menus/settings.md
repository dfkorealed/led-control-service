# 설정 메뉴 기능 현황

기준일: 2026-07-05

## 구현 완료

- 현장이 없으면 `초기 설치 설정` 마법사를 표시한다.
- 초기 설치에서 현장명, 주소, kWh 단가, 층 이름, 층 level, 게이트웨이 시리얼을 등록한다.
- 현장, 층/도면, 그룹, 게이트웨이, OTA, 사용자 권한 설정 카드를 표시한다.
- 게이트웨이 카드에 실제 gateway 이름, 시리얼, 온라인/오프라인 상태를 표시한다.
- 현장이 있으면 `조명 등록` 패널을 제공한다.
- 조명 등록 세션을 시작할 수 있다.
- 발견된 BLE Mesh 후보 노드를 표시한다.
- 후보 노드 점멸 확인 명령을 보낼 수 있다.
- 후보 노드를 fixture/mesh node로 등록할 수 있다.
- 등록 세션을 완료할 수 있다.
- RF 계획 패널에서 Hamina Planner 기반 사전 검토 방향을 안내한다.

## 미구현

- 현장 정보 수정
- 층 추가/수정/삭제 UI
- 도면 파일 업로드
- 조명 위치 편집
- fixture group 생성/수정/삭제
- gateway 추가 등록 UI
- gateway claim 또는 QR 등록
- gateway별 층/구역 coverage 설정
- 사용자 초대, 권한 변경, 계정 비활성화
- OTA 패키지 업로드
- OTA 배포 생성, 중단, 롤백
- 설정 변경 감사 로그
- 현장 삭제 또는 초기화 workflow

## 부족하거나 개선이 필요한 기능

- 설정 카드는 대부분 요약 표시이며 상세 편집 화면으로 연결되지 않는다.
- 초기 설치 후 gateway를 누락할 수 없도록 막았지만, 추가 gateway 등록 UI는 아직 없다.
- 조명 등록은 첫 번째 floor와 첫 번째 gateway를 중심으로 동작하므로 층 선택/게이트웨이 선택 UI가 필요하다.
- 등록된 조명 위치는 자동 좌표로 배치되며 실제 도면 위 위치 조정이 필요하다.
- RF 계획 패널은 정적 안내이며 실제 시뮬레이션 파일, RSSI heatmap, 현장 체크리스트와 연결되어 있지 않다.

## 관련 파일

- `apps/web/src/features/settings/SettingsView.tsx`
- `apps/web/src/features/setup/SetupWizard.tsx`
- `apps/web/src/features/registration/RegistrationPanel.tsx`
- `apps/web/src/features/rf/RfPlanningPanel.tsx`
- `apps/web/src/api/setup.ts`
- `apps/web/src/api/registration.ts`
- `apps/api/src/setup`
- `apps/api/src/registration`
- `apps/api/prisma/schema.prisma`

## 갱신 규칙

설정 메뉴의 현장, 층, 도면, 그룹, 게이트웨이, 사용자 권한, OTA, RF 계획 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
