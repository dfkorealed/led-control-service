# 제어 위계·이벤트 흐름·모바일 자동화 카드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each task. Tasks are assigned sequentially because this is a shared checkout; do not commit or run Playwright/build.

**Goal:** 수동 제어의 대상→밝기→결과 흐름, 이벤트의 센서→조명→동작 흐름을 명료화하고 모바일 자동화 목록의 가로 표를 정보가 빠지지 않는 카드로 전환한다.

**Architecture:** 도메인 상태·API/서버 payload는 그대로 두고 기존 제어 feature의 표시 구조와 문구만 정돈한다. schedule/event 목록은 같은 데이터·action 함수를 데스크톱 표와 모바일 카드에서 재사용한다. 공통 셸/status/toast/SidePanel 공개 API를 추측해 자체 구현하지 않는다.

**Tech Stack:** React 18, TypeScript, 공통 UI 컴포넌트, Tailwind v4 의미 토큰, Vitest/Testing Library, Playwright assertion(실행은 총괄 게이트).

**Spec:** `docs/superpowers/specs/2026-09-15-tailwind-design-system-migration-design.md` 0장 및 `docs/assets/ux-refresh-2026-09-23/design-review.md` 승인 시안 03, 07, 11.

## Global Constraints

- 변경 범위는 `apps/web/src/features/control/**`, 소유 `apps/web/e2e/**` spec, `docs/menus/control.md`와 이 계획만이다.
- 수동 lock, idempotency, ACK/unknown 확인, `verified_not_applied`에서만 원래 snapshot 재적용, 권한/site scope/단일 Gateway/1,000개 제한을 유지한다.
- 이벤트 sensor `supported`+verified, same Gateway, source gateway 변경 시 target clear, immutable target snapshot을 유지한다. BIO 0x09 production 미검증을 완료로 표현하지 않는다.
- schedule/event API query·mutation·polling·pagination·sync·retry와 desktop table은 변경하지 않는다. 모바일 카드에도 목록 표의 상태·기간/센서·대상·동작·최근 결과·action을 모두 제공한다.
- 공통 셸/status/toast/SidePanel과 theme은 수정하거나 페이지 로컬 복제하지 않는다. 해당 연계는 다음 단위에 남긴다.
- TDD RED→GREEN focused Vitest만 실행한다. E2E spec 수정은 가능하지만 Playwright/전체 Web test/build/typecheck는 총괄의 직렬 통합 검증에서 실행한다.
- 같은 checkout의 타 담당자 파일을 보존하고 `git add`/`git commit`하지 않는다. 총괄이 결과 취합 후 stage/commit한다.

## Review Focus

- 명령 진행 중 대상·밝기·이력 잠금, 응답 유실 동일 요청 확인과 verification-only 재적용 경로가 시각 변경 뒤에도 남는가.
- 모바일 하단 시트의 접힌 상태에서 밝기·적용이 계속 접근 가능하고 지도/시트/본문 scroll이 겹치지 않는가.
- 이벤트에서 source 변경·capability 철회·gateway 불일치 시 조명 선택과 저장이 fail-closed 하는가.
- 390/320px 카드가 가로 스크롤 없이 모든 운영 필드와 액션을 제공하고 viewer에게 관리 액션을 숨기는가.
- 데스크톱 표·키보드 focus·삭제 확인·polling stale/partial failure 표시가 기존과 동일한가.

---

### Task 1: 수동 제어 위계

**Files:** `apps/web/src/features/control/ControlView.tsx`, `ControlView.test.tsx`, 필요 시 `CommandHistoryPanel.tsx`와 그 테스트, `target-selection/TargetSelectionToolbar.tsx`와 selector 테스트.

**Interfaces:** 기존 `ControlSelection`, `SpatialTargetSelector`, `DimmingExecutionControls`, `ManualControlFeedback`를 소비한다. 명령 제출/복구 함수 시그니처는 변경하지 않는다.

- [x] RED: 01 대상·02 밝기·03 최근 결과 순서와 하나의 primary 실행 CTA를 컴포넌트 테스트로 고정했다. 승인 디자인 재검토 후 기술 전송 방식은 고객 화면에서 제거하는 회귀 테스트도 추가했다. 접힌 compact sheet의 밝기/실행과 펼친 결과 접근은 유지했다.
- [x] 확인: 새 위계 1 failed/90 passed, compact 단계 라벨 1 failed/77 skipped으로 의도한 RED를 확인했다.
- [x] GREEN: 기존 컴포넌트/토큰으로 위계만 정돈하고 명령 제출/복구 함수는 건드리지 않았다. focused Vitest 3 files/91 passed.
- [x] E2E: 수동 spec에 데스크톱 위계 assertion을 추가했으며 Playwright 실행은 총괄 직렬 게이트 대기다.

### Task 2: 이벤트 원인→결과→동작 흐름

**Files:** `apps/web/src/features/control/automation/VehicleEventDialog.tsx`, `VehicleEventDialog.test.tsx`, 필요 시 `automation-presenters.ts`/test.

**Interfaces:** 기존 `sourceSelection`, `targetSelection`, `changeSource`/`changeTarget`, `isVehicleEventSource`, `vehicleEventSummary`를 소비한다. API input·검증 함수는 변경하지 않는다.

- [x] RED: 기본 설정에서 감지 센서→실행 조명→동작(밝기·유지 시간) 순서와 실행 요약을 검증하는 테스트를 추가했다. 기존 source 자격·Gateway·target clear 회귀도 함께 남겼다.
- [x] 확인: 지정 focused Vitest의 새 위계 기대가 heading 부재로 1 failed/21 passed였다.
- [x] GREEN: 번호/연결 문구와 요약 배치를 정돈하고 선택·검증 함수는 유지했다. 지정 focused Vitest 3 files/22 passed.
- [x] E2E: `automation-control-flow.spec.ts`의 이벤트 생성 여정에 단계 순서/요약 assertion을 추가했고 Playwright는 총괄 직렬 게이트 대기다.

### Task 3: 모바일 schedule/event 목록 카드

**Files:** `apps/web/src/features/control/automation/components/AutomationRuleTable.tsx`, 필요 시 같은 폴더의 공통 카드 컴포넌트, `ScheduleControlPanel.tsx`/test, `VehicleEventControlPanel.tsx`/test, `apps/web/e2e/calm-operations-automation.spec.ts`.

**Interfaces:** `ScheduleResponse`/`VehicleEventRuleResponse`의 기존 row 데이터와 `EnabledBadge`/`SyncBadge`/최근 결과, toggle/edit/delete handler를 소비한다. 데스크톱 table DOM·API query/mutation은 유지한다.

- [x] RED: 두 panel의 모바일 카드가 상태·다음 실행/최근 감지·기간/센서·대상·밝기/유지·Gateway sync·최근 결과·관리 action을 모두 포함하고 desktop table도 남는지 focused React 테스트로 고정했다.
- [x] 확인: 지정 focused Vitest에서 새 카드 기대 4개 실패·기존 52개 통과를 확인했다.
- [x] GREEN: 공통 feature-local 카드 wrapper/필드 패턴을 만들고 schedule/event 값을 각각 매핑했다. 카드/표 action은 같은 handler를 사용하고 viewer에는 action을 렌더링하지 않는다. focused Vitest 2 files/56 passed, 뒤이은 통합 focused Vitest 8 files/169 passed.
- [x] E2E: 390/320px에 카드 정보/액션 도달성을 검증하도록 기존 표 가로-scroll assertion을 교체하고 desktop 표 assertion을 남겼다. Playwright 실행은 총괄 직렬 게이트 대기다.

### Task 4: 문서·통합 전달

**Files:** `docs/menus/control.md`, 이 계획.

- [x] 세 feature의 실제 구현 상태와 공통 셸 연계/HIL/브라우저 미검증을 메뉴 현황에 반영했다.
- [x] 소유 파일 diff와 `git diff --check`, 각 RED→GREEN focused unit 및 통합 focused Vitest 8 files/169 passed를 확인했다. 다른 담당자 변경은 stage/commit하지 않았다.
- [x] 총괄에게 변경 파일·테스트 출력·잔여 위험과 브라우저/전체 Web gate 필요성을 보고했다.
