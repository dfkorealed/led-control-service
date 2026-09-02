# Task 5 구현 보고서

## 결과

- 구현 커밋: `5a99ffb feat(web): apply corrected manual control surfaces`
- 수동 명령은 기존 stage를 `명령 접수 → Gateway 전송 → 장비 응답 → 조명 적용` 공통 진행 목록으로 표시한다.
- 프로토콜/API/mock의 `ACK` 원문, command payload, terminal/retry 판정은 변경하지 않았다. 화면에 출력하는 문구에만 `humanizeDeviceResponseMessage`를 적용해 `장비 응답`으로 표시한다.
- 저장 구역 dialog는 현재 목록, 공통 준비 상태 badge, Mesh 구성 version, 편집 Card, 공통 삭제 확인 dialog를 제공하며 CRUD·재동기화·viewer read-only·focus trap/return focus를 보존한다.
- 현재 fixture-group metadata 계약에는 Mesh 주소가 없으므로 주소를 꾸며 표시하지 않고 `주소 정보 없음`을 명시한다.

## TDD 및 회귀 원인

- RED: `ControlView`에는 `명령 진행` 목록이 없었고 서버 오류의 raw `ACK`가 화면에 노출됐다. 저장 구역 list/editor의 새 정보 위계 assertion도 실패했다.
- GREEN: control unit 78개와 신규 4 viewport command-copy E2E를 통과시켰다.
- 삭제 E2E 회귀의 원인은 공통 `ConfirmDialog`의 close button accessible name이 `구역 삭제 확인 닫기`여서 부분 이름 `삭제 확인`과 함께 매칭된 점이다. 실제 confirm action에 `{ exact: true }`를 적용했다.
- 390px 모니터링 회귀의 원인은 긴 document의 fixture selector를 처음 viewport에서 정적으로 측정한 E2E 범위였다. selector는 스크롤하면 정상 44px으로 도달하며, 화면 가림을 보정하는 전역 CSS는 추가하지 않았다. bottom nav는 정적 측정, selector는 scroll-aware helper로 각각 검증한다.

## 검증

- `pnpm --filter @led-control/web test -- src/features/control/ControlView.test.tsx src/features/control/FixtureGroupDialog.test.tsx src/features/control/active-command-store.test.ts` — 3 files, 78 tests passed.
- `pnpm --filter @led-control/web exec playwright test e2e/calm-operations-manual-control.spec.ts e2e/monitoring-control-flow.spec.ts --project=chromium` — 29 passed, 4 viewport 포함.
- `pnpm --filter @led-control/web typecheck` — passed.
- `pnpm --filter @led-control/web build` — passed; 기존 Vite 500 kB chunk-size warning만 발생.
- `git diff --check` — passed.

## 남은 한계

- Chromium route fixture 검증은 실제 Raspberry Pi/BlueZ/ESP32-H2 또는 실제 BLE Mesh terminal ACK 왕복 HIL을 대체하지 않는다. HIL은 `not_executed` 상태다.
