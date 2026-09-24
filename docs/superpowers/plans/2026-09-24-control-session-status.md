# 제어 화면 세션 상태 연계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each task. The source task explicitly forbids stage/commit, Playwright, build, and full Web tests in this shared checkout; those constraints supersede the usual commit step.

**Goal:** 제어 화면의 비차단 경고·안내를 상태 센터/토스트로 이동해 목록과 지도를 밀지 않으면서, 수동 명령의 진행·불확실·부분 실패와 안전한 재확인 경로를 보존한다.

**Architecture:** 이미 제공되는 `useSessionStatus(sourceId, items)`와 `useSessionToast()`를 제어 feature에서 소비한다. 초기 데이터가 없는 오류와 필드·삭제 dialog 오류는 기존 문맥에 남긴다. 서버 명령·자동화 payload/인가/scope 정책은 변경하지 않는다.

**Tech Stack:** React, TanStack Query, `SessionStatusProvider` 공개 API, Vitest/Testing Library.

**Spec:** `docs/assets/ux-refresh-2026-09-23/design-review.md`의 제어 정보 위계·경고/실패 표시 계약.

## Global Constraints

- `apps/web/src/components/ui/session-status/**`, `CustomerShell` 및 공통 UI 구현은 수정하지 않는다. 공개 API가 부족하면 총괄에게 보고한다.
- 수동 command lock, idempotent same-request 확인, ACK/unknown 실제 상태 확인 및 `verified_not_applied`에서만 안전 재적용하는 기존 경로는 유지한다. 패널의 진행·terminal/부분 실패·복구 동작은 토스트로 대체하지 않는다.
- schedule/event 기존 마지막 성공 목록, 권한/401 처리, pagination, site/user scope generation 및 mutation callback 보호를 유지한다.
- background refetch나 다음 페이지 실패처럼 목록이 남은 오류만 센터로 이동한다. 초기 데이터 없는 차단 오류, 필드 validation, 열린 저장/삭제 dialog 오류는 문맥 안에 남긴다.
- 상태 ID와 toast dedupeKey는 현장·모드·항목에 scope한다. 동일 문제의 polling은 반복 알리지 않고 성공/전환 시 해제한다. 이전 현장 mutation 결과는 새 현장에 나타나지 않는다.
- 각 동작을 RED→GREEN focused Vitest로 검증한다. Playwright, 전체 Web tests/build, stage/commit은 총괄 직렬 게이트에 맡긴다.

## Review Focus

- background refetch 실패에도 마지막 성공 규칙이 보이고 오류가 목록 위에 별도 블록으로 쌓이지 않는가.
- 같은 fingerprint로 이어지는 polling 경고가 토스트를 반복하지 않고 성공하면 status/toast가 해제되는가.
- viewer에게 제어 버튼이 나타나지 않으면서 별도 readonly 경고 배너가 화면 높이를 빼앗지 않는가.
- dialog 저장/삭제 오류는 원래 dialog에 남고, 닫힌 상태의 toggle 오류만 센터 또는 toast에서 재발견 가능한가.
- command 불확실·부분 실패 항목을 센터에서 찾아도 실제 확인/재적용은 기존 패널의 안전한 액션으로만 수행하는가.

---

### Task 1: 스케줄·이벤트 자동화 목록의 비차단 상태

**Files:** `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`/`.test.tsx`, `VehicleEventControlPanel.tsx`/`.test.tsx`. 필요하면 `automation/components/` 아래 feature-local 재사용 hook 하나를 추가할 수 있다. 공통 provider/shell은 손대지 않는다.

**Interfaces:** `useSessionStatus(sourceId: string, items: readonly SessionStatusItem[])`; `useSessionToast().publish/dismiss`. 기존 QueryError/FeedbackState, `scheduleQueryKey`, `vehicleEventRuleQueryKey`, mutation callbacks를 소비한다.

- [x] RED: 마지막 성공 목록이 있는 refetch/next-page 오류에서 행 유지, inline QueryError 부재, 상태 센터 retry, 같은 오류 polling의 toast dedupe 및 성공 resolve를 두 panel focused React tests로 고정한다. Viewer badge/배너 제거와 dialog 밖 toggle 오류의 재발견, site switch 오염 방지도 검증한다. `SessionStatusProvider`+`SessionStatusCenter`+`ToastRegion` 실제 컴포넌트로 테스트한다.
- [x] 확인: `pnpm --filter @led-control/web exec vitest run src/features/control/automation/ScheduleControlPanel.test.tsx src/features/control/automation/VehicleEventControlPanel.test.tsx`에서 새 기대가 의도대로 실패한다.
- [x] GREEN: `useMemo<SessionStatusItem[]>`로 각 현재 site/scope에만 status를 등록한다. `queryFailure` 중 cache가 있는 non-blocking 오류를 상태 item으로 옮기고 `action.onAction`은 기존 refetch/fetchNextPage를 부른다. 같은 ID/fingerprint는 polling 동안 유지하고 성공 시 item을 비워 resolve한다. Empty initial error와 dialog 내부 오류는 기존 FeedbackState/Text를 유지한다. Viewer는 PageHeader 쪽 중립 `StatusBadge`로 축소하고 기존 관리 action은 숨긴다. 닫힌 dialog 밖 mutation error는 scoped 상태 item, 성공 확인은 deduped toast로 표시하되 stale callback은 publish하지 않는다.
- [x] GREEN 확인: 지정 focused Vitest 모두 통과. 변경 파일 `git diff --check` 통과. 장비/API payload 파일과 공통 status/shell 파일 변경 없음.

#### Task 1 QA follow-up: 마지막 성공 시각과 규칙별 toggle 실패

**Files:** 위 Task 1의 두 panel과 두 test, `docs/menus/control.md`만 수정한다. 기존 상태 센터 공개 API와 query/mutation payload는 유지한다.

- [x] RED: 전체 재조회 성공 시각을 기억한 뒤 재조회 실패와 다음 페이지 성공을 연속으로 재현해, 센터의 `마지막 성공`이 다음 페이지 시각으로 바뀌지 않는 테스트를 스케줄·이벤트 각각 추가하고 의도한 실패를 확인한다. 실제 전체 재조회 성공 시에만 시각이 갱신되는 것도 검증한다.
- [x] GREEN: 기존 QueryCache `updated` 구독에서 `fetchMeta.fetchMore.direction`을 구별해 초기/전체 재조회 성공 시각을 별도로 추적한다. `dataUpdatedAt`은 다음 페이지 성공의 공통 시각이므로 실패 상태의 설명에 직접 쓰지 않는다. 현장·사용자 전환과 401 차단 시 이전 범위의 시각이 표시되지 않게 한다.
- [x] RED: 규칙 A의 toggle 실패 뒤 새 규칙/다른 규칙 편집을 열거나 규칙 B의 toggle이 성공해도 A의 센터 항목이 남고, A의 성공 또는 범위 종료 뒤에만 사라지는 테스트를 두 panel 각각 추가해 의도한 실패를 확인한다. 서로 다른 규칙의 같은 오류 문구도 독립 항목인지 확인한다.
- [x] GREEN: toggle 실패를 operation/rule ID별 상태로 보존하고 해당 작업 성공 또는 명시적 해제에만 제거한다. save/delete dialog 오류는 문맥에 남기며, 401·site/user generation guard와 toast dedupe를 유지한다.
- [x] 두 panel focused Vitest, Web typecheck, 소유 파일 `git diff --check`를 실행하고 제어 메뉴 문서의 `마지막 성공` 및 toggle 실패 수명 계약을 갱신한다. Playwright/전체 suite/build/stage/commit은 총괄 직렬 게이트에 맡긴다.

#### Task 1 QA follow-up review: 삭제된 규칙의 실패 정리

- [x] RED: 두 panel에서 규칙 A의 toggle 실패 후 A 삭제 성공 시 상태 센터에서 A의 실패가 제거되는 테스트를 추가해 기존 결함을 확인한다. 다른 규칙 B의 실패는 유지한다.
- [x] GREEN: 실제 삭제가 성공한 현재 범위에서 삭제된 규칙의 toggle 실패만 제거한다. 삭제 실패 또는 다른 규칙의 저장·삭제 성공으로 A 실패가 사라지지 않는 계약을 유지한다.
- [x] 두 panel focused Vitest, Web typecheck, 소유 파일 `git diff --check`와 제어 메뉴 문서를 재검증한다. stage/commit 없이 총괄에게 보고한다.

### Task 2: 수동 명령의 안전한 상태 재진입

**Files:** `apps/web/src/features/control/ControlView.tsx`/`.test.tsx`.

**Interfaces:** 기존 `ManualControlFeedback`, `CommandOutcomeActions`, command status polling/store를 그대로 사용한다. 필요 시 공개 `useSessionStatus`만 추가한다. status center action은 manual mode로 이동만 하며 command 재전송을 직접 수행하지 않는다.

- [x] RED: 정상 진행·terminal 결과·partial/unknown의 기존 패널·이력 액션 보존과, 불확실/부분 실패의 세션 상태 재진입, site/user 전환 resolve를 focused React tests로 고정한다. 별도 readonly 경고 배너는 없고 기존 neutral badge/disabled 제어는 유지한다.
- [x] 확인: `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/control/CommandHistoryPanel.test.tsx src/features/control/CommandOutcomeActions.test.tsx`에서 새 기대가 의도대로 실패한다.
- [x] GREEN: `ManualControlFeedback`의 결과/복구 UI는 삭제·축약하지 않는다. 현재 scope에서 미해결 command/status-check·`partial_failed`/`failed`/`timed_out`/`verification_required`/`verified_not_applied`/`verified_partial`만 `source:"command"` status로 등록하고 성공·닫기·scope 변경 시 해제한다. 상태 action은 수동 탭 재진입까지만 수행하고 원래 `onCheck`/`onReapply`의 안전 조건을 우회하지 않는다. Readonly inline 경고는 neutral badge 안내로 축소한다.
- [x] GREEN 확인: 지정 focused Vitest 모두 통과. `git diff --check` 통과. command API/전송 경로 변경 없음.

### Task 3: 문서·통합 전달

**Files:** `docs/menus/control.md`, 이 계획.

- [x] 새 상태 센터 연계와 남긴 문맥 오류, software-only 검증 한계를 메뉴 문서의 기존 다섯 절에 반영한다.
- [x] Task 1/2 focused tests를 묶어 재실행하고 Web typecheck, `pnpm --filter @led-control/web ui:check` 및 소유 파일 `git diff --check`를 확인한다. 전역 checkout의 다른 변경은 건드리지 않는다. 결과: 전체 Web Vitest 2,300 pass/3 skipped, typecheck와 소유 diff-check pass; `ui:check`는 타 소유 `FloorEditorView.tsx:440`의 `md:` 3건으로 실패해 총괄에게 분리 보고했다.
- [x] 총괄에게 구현 범위·테스트 출력·미실행 브라우저/HIL 및 필요한 공통 API 이슈를 보고한다. 설치 여정 RealBackendLab E2E 2/2 pass; 상태 센터 브라우저 상호작용과 실장비 HIL은 별도 검증 범위다.
