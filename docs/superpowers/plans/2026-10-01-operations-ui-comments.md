# 운영 화면 주석 22건 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모니터링·제어·통계 주석 22건을 공통 UI와 실제 데이터 계약으로 수정하고 기존 기능을 보존하여 기본 개발 브랜치에 병합한다.

**Architecture:** 기존 API producer → 공통 UI → 페이지 소비자를 한 작성자씩 순차 변경한다. 로그의 보관 정책·명령 안전성과 알람 원본 판정은 유지하고, 개인 읽음만 최소 테이블로 추가한다. 총괄은 기존 담당 세션의 결과와 독립 검토를 취합하며 제품 코드를 직접 병렬 수정하지 않는다.

**Tech Stack:** Node 22.20.0, pnpm 9.15.0, TypeScript, NestJS, Prisma/PostgreSQL, React Query, React Aria, Tailwind, Jest/Vitest/Playwright.

**Spec:** `docs/superpowers/specs/2026-10-01-operations-ui-comments-design.md` 전체. 사용자 ‘계획 작성하고 바로 진행’ 지시로 추가 계획 승인 대기는 생략한다.

## Global Constraints

- 기준 `36a99b2910a03ca9a3b55237a7b24d85a247b7cf`, branch `codex/operations-ui-comments-20261001`, worktree `/Users/kim-jh/Documents/led-control-service/.worktrees/operations-ui-comments-20261001`만 사용한다.
- 기본 checkout·현재 서버·센서/설치 WIP·사용자 DB·실장비를 변경하지 않는다. 운영 migration/DB 초기화/flash/배포/원격 push는 수행하지 않는다.
- 같은 공유 파일·API·Prisma에는 한 작성자만 둔다. 사용자가 지정한 기존 담당 세션을 재사용하며 새 제어 세션만 `gpt-6.1-sol` / `high`다. 기존 센서 제어 세션에는 UI 업무를 보내지 않는다.
- 기존 React Aria·공통 UI·theme 토큰을 재사용한다. `phone-wide=360`, `compact=760`, `tablet=1024` 유지. 962/1017px 전용 분기·새 임의 색/z-index·정책 검사 우회·새 의존성은 추가하지 않는다.
- 실제 timestamp는 `yyyy-MM-dd HH:mm:ss`, Gregorian, `hourCycle: h23`, 자정 `00:00:00`, 잘못된 값 `—`다. 현장/기기/계정 시간대 의미, ISO 정밀도, 날짜 전용·반복 `HH:mm`·PDF 시각 제거 결정은 유지한다.
- 모니터링 로그는 선택 층, 명령 이력은 현장 범위다. 전체 화면 기본 50, 옵션 50/100/500/1000; 소량 ticker/latest 호출은 유지한다. 원본은 DB 시각 기준 3 calendar months이고 기존 명령 rollout을 강제로 켜지 않는다.
- 알람 개인 읽음과 operational acknowledge/resolve는 별개다. 기존 incident에는 3개월 purge를 추가하지 않고 receipt 독립 TTL도 없다. 실제 보이는 항목만 PUT 성공 후 읽음이며 조회/닫힌 센터/화면 밖 항목은 읽음이 아니다.
- 선택 없는 조명 상세는 표시하지 않는다. PC >=1024 비모달 패널, 그 미만 하단 시트. 지도 최소 240 CSS px, 실제 마커 hit 48×48 CSS px. 기존 카메라·휠 포인터 줌·CAD·권한·Gateway 제약·안전 복구를 보존한다.
- 단계마다 RED→GREEN 증거·관련 메뉴 문서·DB 문서(스키마 변경 시)를 같은 기능 커밋으로 남긴다. 총괄만 이 계획과 상태판을 갱신한다. 미해결 P0/P1/P2는 병합 차단이다.
- 모든 명령은 이 worktree에서 Node22 bin을 PATH 앞에 두고 실행한다. frozen install→Prisma generate→workspace:prepare 후 leaf 검증; root gate는 순차 실행한다. 실제 소프트웨어/fixture/실장비 증거를 구분한다.

## Review Focus

1. 계정·현장 전환 중 늦은 읽음/로그 응답: 이전 사용자 데이터나 수치가 새 화면에 반영되지 않아야 한다(Task 1/2/4/5/6).
2. 같은 timestamp의 많은 행·부분 보관일·DST/월말: 중복/누락 없이 cursor 이동하고 종료일 포함·DB 보관 경계를 지켜야 한다(Task 1).
3. 포인터 중단·두 손가락 전환·입력 Space·invalid 밝기 blur와 Apply 같은 클릭: 유령 선택/자동 명령이 없어야 한다(Task 6).
4. 열린 상세를 1023↔1024로 변경하거나 원래 trigger 삭제: 카메라/스크롤 보존과 유효한 포커스 복귀, 임의 조명 대체 없음(Task 3/5/9).
5. 1000행 로그·320px·짧은 landscape·200% 확대·공백 없는 긴 이름: 주요 도구/페이지 이동/핀을 가리거나 전체 페이지 가로 overflow를 만들지 않아야 한다(Task 3/5/6/7/9).

## 실행 기록과 파일 소유

| Task | 담당 세션/역할 | 상태 | 커밋·검토 |
| --- | --- | --- | --- |
| 준비 | Shell·인증·운영 담당자 | 격리 실행 완료; root test 1건 실패 | lint/typecheck/build exit0, Gateway CLI timeout; API 전체 종료 요약 없음 |
| 1 | Shell backend: 로그 API | 완료·독립 명세/품질 승인 | 5c1d313e + 982f999a; focused119/119 |
| 2 | Shell backend: 개인 알람 읽음 | 구현 반환·독립 검토 진행 | bdb2d9e1; focused97/97(실제DB56 포함) |
| 3 | Shell 공통 UI | 대기 | — |
| 4 | Shell 알람센터 소비 | 대기 | — |
| 5 | 모니터링 페이지 담당자 | 대기 | — |
| 6 | 제어 UI 개선 담당자(GPT-6.1 Sol/high) | 대기 | — |
| 7 | 통계 페이지 담당자 | 대기 | — |
| 8 | 설정 담당 → Shell 운영 담당 | 대기 | — |
| 9 | 디자이너·독립 QA·총괄 | 대기 | — |

API와 공통 파일을 동시에 쓰지 않는다. Task 5는 `FloorScene`/`FloorMapViewport` 작성권을 받고, 반환·검토 후 Task 6에 넘긴다. Task 8의 설정/운영도 순차 배정한다. 소비자가 공통 계약 변경을 원하면 총괄에게 반환하고 producer가 수정·재검토한다. 개별 작업은 지정 파일과 보고서만 작성하며 다른 세션/서브에이전트를 임의 생성하지 않는다.

---

### Task 1: 기간·1000건·scope cursor 로그 API

**Files:**
- Create: `apps/api/src/retention/log-date-range.ts`, `apps/api/src/retention/log-date-range.spec.ts`, `apps/api/src/monitoring-activity/monitoring-activity.controller.spec.ts`.
- Modify: `apps/api/src/monitoring-activity/monitoring-activity.controller.ts`, `apps/api/src/monitoring-activity/monitoring-activity.service.ts`, `apps/api/src/commands/command-status.service.ts`, `docs/menus/monitoring.md`, `docs/menus/control.md`.
- Reuse unchanged: `apps/api/src/commands/commands.controller.ts` already parses the extended imported schema; controller tests verify the transitive contract without a source no-op.
- Test: existing `monitoring-activity.service.spec.ts`, `monitoring-activity.integration.spec.ts`, `commands/command-status.service.spec.ts`, `commands/commands.controller.spec.ts`; paths under the above API directories.

**Interfaces:**
- Both list inputs add optional paired `fromDate?: string`, `toDate?: string` in strict `YYYY-MM-DD`, inclusive local-calendar end; limit accepts 1–1000. Existing defaults monitoring=5/command=20 remain backward compatible; full UI explicitly supplies 50.
- `resolveLogDateRange(input: {fromDate?:string;toDate?:string}, timeZone:string, boundary:{generatedAt:Date;retainedFrom?:Date}): {start:Date|undefined;end:Date}` in `retention/log-date-range.ts`; use `energy/energy-periods.ts` helpers, never host-clock/90day arithmetic. End=min(first actual local instant after the selected ending day,DB generatedAt), start=max(request-start,retainedFrom when enforced); empty intersection returns empty list. A skipped successor date must not reject a valid selected ending day; absent selected local endpoints remain rejected.
- 새 v2 cursor는 principal/site/floor(모니터링)/fromDate/toDate/effective limit, 명령 query/stage를 canonical scope의 SHA-256 digest로 결합하고 원본 timestamp/id를 유지한다. 기존 모니터링 v1·명령 unversioned cursor는 새 날짜 필터가 없고 기존 limit 상한 안에서만 허용하며 구 query/stage 동작은 보존한다. 응답은 항상 v2를 발급한다. v2 조건/scope 불일치·잘못된 cursor는 400, 기존 모니터링 410/명령 400 만료 의미는 유지한다. cursor 상한 512bytes를 늘리지 않고 100자 검색어에서도 길이를 검증한다.
- Preserve `items`, `nextCursor`, `generatedAt`, `retainedFrom`, `retentionEnabled`, ISO precision, same-time id descending, site outside search OR and content redaction. No new response fields/DB schema/shared exports are required.

- [x] Step 1 — Add tests `log_dates_pair_invalid_and_site_day_inclusive`, `log_dates_clamp_db_clock_dst_month_end`, `monitoring_limit_1000_preserves_floor_scope`, `history_v2_binds_actor_query_period_limit`, `log_cursor_ties_and_legacy_compatibility`: assert 1000 accepted/1001 rejected, lone date/impossible leapday/reversed rejected, Seoul 2026-10-01 ends 2026-10-01T15:00:00Z, LA DST day length honored, same timestamp IDs neither duplicated nor omitted, changed scope/limit/filter rejected, old compact default preserved, rollout OFF not silently enforced.
- [x] Step 2 — Run `pnpm --filter @led-control/api run test --runInBand --runTestsByPath src/retention/log-date-range.spec.ts src/monitoring-activity/monitoring-activity.controller.spec.ts src/monitoring-activity/monitoring-activity.service.spec.ts src/commands/command-status.service.spec.ts src/commands/commands.controller.spec.ts`; record expected assertion failures before implementation (not import/environment failures). `run test`로 Jest 인자를 전달하며 pnpm 자체 인자 오류는 RED 증거가 아니다.
- [x] Step 3 — Implement these query/helper/cursor interfaces with DB transaction boundary and existing read authorization. Read Site timezone inside authorized scope; no fallback to device timezone. Keep existing deletion/retention workers and command detail routes unchanged.
- [x] Step 4 — Run the same tests, API typecheck/build, shared response compatibility tests, `git diff --check`; record counts/exit and opt-in integration status separately. Integration DB verification is completed in Task2/9 with disposable infrastructure.
- [x] Step 5 — Update monitoring/control menu limitations and commit `feat: add date-scoped paginated operation logs`; submit base/head, RED/GREEN outputs and exact producer contract for independent review.

Task1 evidence: assertion RED23/89; initial focused114 passed/12 opt-in skipped; repair RED3/116→GREEN119/119, API typecheck/build exit0. Initial API3012/827 skipped and Shared411 are pre-repair evidence; not fresh whole-root results. Independent task and scoped re-review approve spec and quality. Actual PostgreSQL date/1000-row traversal remains Task2/9, whole-root final gate remains Task9. Unrelated failure-fixture logger noise P3 is deferred for final triage.

### Task 2: 계정별 영속 알람 읽음 producer

**Files:**
- Modify: `apps/api/prisma/schema.prisma`, `apps/api/src/monitoring-incidents/monitoring-incidents.dto.ts`, `monitoring-incidents.controller.ts`, `monitoring-incidents.service.ts`, and their existing `*.spec.ts`/`monitoring-incidents.integration.spec.ts`; `docs/database-schema.md`, `docs/menus/monitoring.md`.
- Create: `apps/api/prisma/migrations/20261001100000_monitoring_incident_read_receipts/migration.sql`.
- Test only: extend `apps/api/src/monitoring-activity/monitoring-activity.integration.spec.ts` and `apps/api/src/commands/command-history-db-clock.integration.spec.ts` to execute Task1 date/1000-row/tied-cursor assertions in self-owned disposable PostgreSQL. Keep existing CI opt-in contracts; no additional production log changes.

**Interfaces:**
- Model `MonitoringIncidentReadReceipt(incidentId,userId,readAt)` composite PK, incident/User cascade FKs, DB default readAt, userId lookup index. Do not amend existing migrations or incident operational revision/retention.
- GET `/sites/:siteId/monitoring-incidents`: existing `incidents[]` summaries add `isRead:boolean`, `readAt:string|null`; top `unreadCount:number` counts all retained site incidents without actor receipt, including resolved, independent of filter/cursor. Keep `activeCount` and existing sort/cursors.
- PUT `/sites/:siteId/monitoring-incidents/:incidentId/read`: `markRead(user:AuthenticatedUser,siteId:string,incidentId:string): Promise<{incidentId:string;isRead:true;readAt:string}>`; first readAt immutable, actor server-derived, viewer read permission. Transaction rechecks active actor/site membership and incident belongs to site using existing access lock boundary, no new revision409.
- Existing 401/403/404/400 meanings in spec6.2; no body actor override or manage requirement.

- [ ] Step 1 — Add `read_receipt_is_actor_scoped_idempotent_and_filter_independent`, `read_receipt_races_revocation_parent_delete_and_user_delete` tests: accountA read≠B read; duplicate concurrent PUT samefirsttime; resolved unread counts; polling sameID remains read, recurrence newID unread; crosssite404/viewerallowed/expired401/password403; deletes cascade with no orphan and revoked membership cannot insert receipt.
- [ ] Step 2 — Run `pnpm --filter @led-control/api run test --runInBand --runTestsByPath src/monitoring-incidents/monitoring-incidents.dto.spec.ts src/monitoring-incidents/monitoring-incidents.service.spec.ts`; record RED assertions.
- [ ] Step 3 — Implement migration/model/DTO/service/controller; use existing transaction site-access race protections and uniqueness, preserve additive consumer compatibility. Generate Prisma Client in this worktree only.
- [ ] Step 4 — GREEN focused tests, API typecheck/build. In an identity-checked disposable PostgreSQL apply all migrations and run actual receipt/log integration/cascade/concurrency tests in band; never point at user `led_control` DB. Record schema before/after and cleanup. If infrastructure absent, report explicit unverified gate; do not mark Task2 complete on mocks alone.
- [ ] Step 5 — Update DB/menu docs with actual migration execution limits and commit `feat: persist account-scoped alarm read receipts`; independent review before web consumer starts.

### Task 3: 공통 필터·로그·페이지·시각·상세 surface

**Files:**
- Create: `apps/web/src/components/ui/FilterPanel.tsx`, `FilterPanel.test.tsx`, `LogView.tsx`, `LogView.test.tsx`, `DetailSheet.tsx`, `utils/formatTimestamp.ts`, `utils/formatTimestamp.test.ts`.
- Modify: `apps/web/src/components/ui/PaginationBar.tsx`, `PaginationBar.test.tsx`, `overlays/DialogBase.tsx`, `overlays/overlays.test.tsx`, `index.ts`.

**Interfaces:**
- `formatTimestamp(value:string|Date|null|undefined, options?:{timeZone?:string}):string`; omitted timezone preserves browser-device timezone. Invalid value/zone→`—`, no current-time fallback, strict actual timestamp (date-only remains other formatter). Use Intl formatToParts/h23 and export ui index.
- `FilterPanel({label:string,children:ReactNode,chips?:ReactNode,actions?:ReactNode,className?:string})`; controlled fields go in children, reuse existing FormField/ReactAria fields, responsive wrapping. No query/date validation/reset implementation inside it. Designer readiness identifies no existing FieldGroup export; do not invent another field abstraction.
- Extend `PaginationPageSize` with500/1000, optional `pageSizeOptions:readonly PaginationPageSize[]` default existing10/20/50/100, `isPending?:boolean`. Props union existing total variant(default `mode?:"total"`, `totalCount:number`) and `mode:"cursor",itemCount:number,totalCount?:never`; common existingcallbacks/page/flags preserved. Cursor variant shows currentpage/currentrows only, never total/end/jump; disable controls while pending.
- `LogView({label:string,filters:ReactNode,pagination:ReactNode,status:ReactNode,children:ReactNode,className?:string})` provides fixed header/footer + min-h-0 independently scrollable body. Callers own loading/empty/error/count/query/command diagnosis.
- Add `surface:"sheet"` to DialogBase with bottom alignment, safe-area and body-only scroll, keep existing modal compact760/drawer unaffected. Export `DetailSheet(props:ModalDialogProps)` wrapper; PC panel remains feature's nonmodal aside, never DialogBase.

- [ ] Step 1 — Add formatter assertions Seoul seconds/midnight/offset/DST/devicezone/invalid, total PaginationBar unchanged and cursor hidesfake total/accepts4logoptions/pending disables; filter slots/tab order, sheet focus/Escape/pending/restore and 1000-row LogView footer accessible.
- [ ] Step 2 — Run `pnpm --filter @led-control/web test src/components/ui/utils/formatTimestamp.test.ts src/components/ui/PaginationBar.test.tsx src/components/ui/FilterPanel.test.tsx src/components/ui/LogView.test.tsx src/components/ui/overlays/overlays.test.tsx`; record RED.
- [ ] Step 3 — Implement these presentation interfaces using existingtokens. No timestamp/date calculations in wrappers, no CSS policy exemptions/newdeps/newbreakpoints. Keep overlay-stack nestedclose and trigger fallback contracts.
- [ ] Step 4 — Same tests GREEN, Web typecheck/build, `pnpm --filter @led-control/web ui:check` and overlays/date/field regression, `git diff --check`.
- [ ] Step 5 — Commit `feat: unify operation filters logs and detail surfaces`; record exported props and return shared-file ownership for independent review.

### Task 4: 실제 알람센터와 보이는 항목 읽음

**Files:**
- Create: `apps/web/src/api/monitoring-incidents.ts`, `monitoring-incidents.test.ts`, `apps/web/src/components/ui/session-status/useMonitoringIncidents.ts`, `useMonitoringIncidents.test.tsx`.
- Modify: `apps/web/src/components/ui/session-status/SessionStatusCenter.tsx`, `SessionStatusProvider.tsx`, `session-status.test.tsx`, `apps/web/src/features/shells/CustomerShell.tsx`, `CustomerShell.test.tsx`, `CustomerShell.monitoring.test.tsx`, `docs/menus/monitoring.md`.

**Interfaces:**
- API `listMonitoringIncidents(siteId,input:{limit?:number;cursor?:string;status?:existingStatus;type?:existingType})`, `markMonitoringIncidentRead(siteId,incidentId)` validate Task2 actual response; noitemsrename/no new operationalwrite actions.
- `useMonitoringIncidents(userId:string|undefined,siteId:string|undefined,open:boolean)` exposes server unreadCount/list loading/error/stale state + cursorpaging and read action; query keys include principal/site. Closed uses GETlimit1, open paginated25; retain in-flight dedupe per scopedID, only visible active-document center rows PUT.
- Center title/trigger/close ‘알람센터’; durable list + separate ‘현재 화면 상태’. Badge uses durable unreadCount only, no optimistic subtraction/zero onfailure. Success refetch canonical counts; pagevisibility/focusrefresh syncdevices.

- [ ] Step 1 — Add `closed_hidden_next_page_alarms_are_not_read`, `visible_read_succeeds_refetches_and_failure_preserves_badge`, `account_site_switch_discards_late_read`, `transient_status_actions_are_not_alarm_count`: assert visible PUT exactlyonce, offscreen/closed0, serverrelogin read persists, sameincidentpoll no newread, PUTfail unread preserved, stale GET labeled, previous scope abandoned, transientretry/progress remains available.
- [ ] Step 2 — Run focused `pnpm --filter @led-control/web test src/api/monitoring-incidents.test.ts src/components/ui/session-status src/features/shells`; record RED.
- [ ] Step 3 — Implement validation/hook/center/CustomerShell using existing session lifecycle and ReactQuery scoped cache; IntersectionObserver only inside open center+documentactive, dispose observer onclose/scopechange. No autoack/resolve or dispatch command.
- [ ] Step 4 — GREEN same tests + Web typecheck/build/ui:check; browser center keyboard/open/scroll/read-failure/route-switch assertions in `apps/web/e2e/operations-ui-comments.spec.ts` (created here, downstream add serially).
- [ ] Step 5 — Update monitoring menu and commit `feat: replace session badge with persistent alarm center`; independent review.

### Task 5: 모니터링 지도·명시 선택·상세·공통 로그

**Files:** Modify files and timestamp consumers in spec rows1–4/6/8/21/22 and section5: `features/monitoring/{MonitoringView,FloorMap,FixtureDetailPanel,FixturePinPopover,MonitoringFixtureFinder,MonitoringLogDrawer,MonitoringLogTicker}.tsx`, `fixture-status-presentation.ts`, `monitoring-time.ts`, `monitoring-activity-presentation.ts`, `useMonitoringActivity.ts`; `features/floor-map/{FloorScene,FloorMapViewport}.tsx`; their existing tests, `apps/web/e2e/operations-ui-comments.spec.ts`, `docs/menus/monitoring.md`.

**Interfaces:** Consume Task1 `fromDate/toDate/limit` and Task3 exports. Full log explicitlylimit50, cursorstack/infinitequery key includes actor/site/floor/period/limit; ticker stillsmall. Three independent states `selectedFixtureId:string|null`, finderopen, detailedsurfaceopen; no runtime/list arrival fallback. Map defaultpan unchanged for later control-policy extension.

- [ ] Step 1 — Add tests for realstatuslegendpresentonly/unknown/fault+offline, no countoverlay, all3selectionstates initiallynull; search/KPI0 doesn'tselect, explicitpinatomicfilterclear keepsID, changedfilter/floor/site/principal or deletedID clears not substitutes. Savedpinbefore runtime keepsselectedID withloading. Full logs date/size resetfirstpage/stale responseignored/410recover/no fake0.
- [ ] Step 2 — RED focused `pnpm --filter @led-control/web test src/features/monitoring src/features/floor-map`; browser RED for responsive map, circlemarker/detail before changes.
- [ ] Step 3 — Implement data-linked legend oldhintposition/countremoval, statuscircle/noncolor/48pxhit, flexheightchain/min240/pageoverflow, formatter adapters, LogView/FilterPanel/PaginationBar consumer and PCaside/mobileDetailSheet. Expand opens samefixture and hides duplicatepopover; switchingwidth preserves camera/scroll/validfocus. No logsDrawer fordetail.
- [ ] Step 4 — GREEN focused tests + typecheck/build/ui:check; Playwright `operations-ui-comments.spec.ts monitoring-navigation-confidence.spec.ts monitoring-control-flow.spec.ts calm-operations-monitoring.spec.ts monitoring-1000.spec.ts` Chromium workers1. Include bounds/focus/camerachecks at320/390/768/962/1017/1023/1024/1025/1440 and shortheights; isolate known editor1000 performance failure without raisingthreshold or claimingpass.
- [ ] Step 5 — Update monitoring menu and commit `feat: refine monitoring map selection detail and log ux`; report shared map ownership returned and independent review before control.

### Task 6: 제어 직접 조작·단일 밝기·스케줄·공통 이력

**Files:** Modify `apps/web/src/features/control/target-selection/{TargetSelectionToolbar,SpatialTargetSelector,FixtureSelectionDrawer}.tsx`, `ControlView.tsx`, `CommandHistoryPanel.tsx`, `control-time.ts`, `CommandRiskReconcileDialog.tsx`, `CommandVerificationCases.tsx`, `automation/{ScheduleControlPanel,VehicleEventControlPanel}.tsx`, `automation/components/{AutomationRuleControls,AutomationRuleCard,AutomationWorkspaceSurface}.tsx`; `apps/web/src/features/floor-map/{FloorMapViewport.tsx,map-gestures.ts}`; `apps/web/src/api/commands.ts`(여기에 `useCommandHistory`도 존재), 각 파일의 기존 테스트, E2E와 `docs/menus/control.md`.

**Interfaces:** Viewport policy `interactionPolicy?:"pan"|"direct-selection"` defaultpan; selection owner SpatialTargetSelector. Direct individual: clicktoggle, blankleftdrag additivearea, Spaceleft/middlepan; floor/group blankdragpan. Touchtap toggle/onepan/twopinch/blanklongpress400ms then area; drag8CSSpx. Existingselectlimits1000fixtures/100groups/gateway/permissions/offline/lockedmode remain everypath.
- Brightness valid integer0–100+drafterror, onebold NumberField+% and slider. Invaliddraft applydisabled; blur restoresannouncedlastvalid but sameblurclick cannot apply. Enter onlycommit/noformsubmit. No command until separate explicitApply.
- CommandHistoryInput/hook add `fromDate/toDate`; entire input in querykey and resets pageIndex onperiod/size; compactlimit1, full50 options. Preserve DB retention clock/rollout/400 expiry/recovery/stage/search300ms diagnostics.

- [ ] Step 1 — Add tests `direct_gestures_cancel_and_never_cross_input_focus`, `longpress_second_pointer_cancel_has_no_ghost_click`, `brightness_invalid_blur_apply_requires_new_click`: threshold7/8px,399/400ms, holdmoved>=8pan, touchsecondcancel, captureloss/blur/Esc cancels, keyboardinputspace notstolen, additiveeligibility, denied/offline/otherGateway/limit excluded; inputsliderEnterpresetPOST0, invalidemptydecimal101Apply0, announcedrestore then explicitapplyonly1.
- [ ] Step 2 — RED focused `pnpm --filter @led-control/web test src/features/control src/features/floor-map/map-gestures.test.ts src/features/floor-map/FloorMapViewport.test.tsx`; browser RED oldmodes/brightness/nameperiod/synccolumn/historyperiod then change.
- [ ] Step 3 — Implement policy+gesture state/timers/clicksuppression cleanup, removemodes, singlebrightness. Schedulecount only‘조건에 맞는 규칙 N건’, longnamewrap, PCperiodcolumn/mobilefield, remove independent sync but pending/failure nexttoactivation and allsummary/filter/poll/safety remain. Apply commonhistory+formatter and don't auto-first-select drawerfixtures.
- [ ] Step 4 — GREEN focused +typecheck/build/ui:check, Chromium workers1 `control-map-target-selection.spec.ts calm-operations-manual-control.spec.ts automation-control-flow.spec.ts command-retention.spec.ts operations-ui-comments.spec.ts`. Confirm monitoring defaultpan/wheel and nohardwarecommands fromtests.
- [ ] Step 5 — Update control menu and commit `feat: simplify direct control and unify command history`; independent review. Do not message protected sensor owner or cherry-pick sensorcode.

### Task 7: 통계 표시 정리·공통 필터·시각

**Files:** Modify `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`, `EnergyComparisonChart.tsx`, `analysis/StatisticsAnalysisPage.tsx`, `analysis/EnergyHeatmap.tsx`, `reports/{ReportHistoryFilters,StatisticsReportsPage,ReportJobTable,ReportJobCards,ReportJobList}.tsx`, `reports/report-job-view-model.ts`, existing tests; `apps/web/e2e/statistics-flow.spec.ts`, `operations-ui-comments.spec.ts`, `docs/menus/statistics.md`.

**Interfaces:** Task3 FilterPanel accepts existing controlledconditions/chips/reset slots; noanalysisreset/URLaddition. Overvieweachperiodline `YYYY-MM-DD ~ YYYY-MM-DD` fromitsownselectedperiod; no overline/estimate-gapbadges. Task3 formatter for actualtimestamps only, retained site/device timezone branches.

- [ ] Step 1 — Assert removed3copy/badges, selectedquickrange textonly, actual0≠missing—, chartconnectNullsfalse and isolatedcompletepoint, comparisonblocked/incomplete/errors/retry/responsemismatch remain. Analysislocalconditions querymatch, reportURLbackforward/search300ms/requestdate90days/PDFonly/signeddownload retain; lengthyfilters nooverflow.
- [ ] Step 2 — RED `pnpm --filter @led-control/web test src/features/statistics` focused newassertions.
- [ ] Step 3 — Apply FilterPanel and timestampadapter, delete onlyunusedpresentation/imports notstatecalculators/datamodels, do not relabelestimateasmeasured. Keep filter dateinput/source responsibilities and report PDF/CSV workflows.
- [ ] Step 4 — GREEN statistics tests +Webtypecheck/build/ui:check +Chromium `statistics-flow.spec.ts operations-ui-comments.spec.ts` workers1 at320/390/962/1440/200%zoom with0/missing/partialstates.
- [ ] Step 5 — Update statistics menu and commit `feat: unify statistics filters and simplify period context`; independent review.

### Task 8: 설정·운영 timestamp 소비 마무리

**Files:** Modify only actual timestamp presentation in specsection5: `apps/web/src/features/settings/security/AccountSecurityView.tsx`, `settings/users/SiteUsersView.tsx`, `features/floor-editor/FloorEditorView.tsx`, `features/operator/site-admins/SiteAdminManagementView.tsx`, `features/operator/LandingInquiriesView.tsx`, their tests, `docs/menus/settings.md`, `docs/menus/operator.md`.

**Interfaces:** Consume Task3 formatTimestamp with omittedtimezone for existingdevice-display consumers; ISO storage/revision/dateonly/accountpolicy unchanged. Settingsthread receives ourworktree only, preservesownserialbranchWIP; afterreturnedreviewShellconsumesoperatorfiles.

- [ ] Step 1 — Add assertions login/expiry/create/update/revision secondsandformat while dateonly/recurrence remains unchanged; no removedsecuritymanagement/editactions.
- [ ] Step 2 — RED `pnpm --filter @led-control/web test src/features/settings/security/AccountSecurityView.test.tsx src/features/settings/users/SiteUsersView.test.tsx src/features/operator/site-admins/SiteAdminManagementView.test.tsx src/features/operator/LandingInquiriesView.test.tsx` for respectiveowner's subset.
- [ ] Step 3 — Replace displayformatter only usingsharedexport; sourcewide actualtimestamp audit reports otherconsumers before touchingthem. Nofloor-editorfeature/perftuning/installationimplementation/publiclandingdesignchange.
- [ ] Step 4 — GREEN above +existingflooreditorunit/layout consumers +typecheck/build/ui:check; preserve existingTZ and sourceISO, report anyunmigratedactualtimestamp.
- [ ] Step 5 — Eachownerupdatesaffectedmenu andcommitsownsubset `refactor: unify settings timestamp presentation` / `refactor: unify operator timestamp presentation`; independent combinedreview afterbothreturned.

### Task 9: 엄격한 UI/UX 관문·실제 격리 소프트웨어·기본 브랜치 통합

**Files:** QA 증거는 ignored 계획 workspace에 기록한다. 지속 요약은 본 계획과 `docs/project-status.md`, 필요한 회귀 테스트 수정은 해당 기능 담당자에게 배정한다. QA는 제품 코드를 쓰지 않는다.

**Interfaces:** Task 1–8 커밋과 단계별 읽기 전용 검토 결과를 소비한다. 디자이너는 설계의 주석 22행을 감사하고, 새 whole-branch reviewer가 기준 `36a99b29`→최종 HEAD를 확인한다. 이후 변경까지 검토했다고 확대하지 않는다. 병합 대상은 실제 저장소의 `codex/mvp1-cloud-web`이며 Git `main`이 아니다.

- [ ] Step 1 — 22행을 단언·시각 증거로 재현한다: 폭 320/390/768/962/1017/1023/1024/1025/1440px, 390×320/768×390/1024×480, 200% 확대, 긴 이름, 0/로딩/오류/정보 미수신/장애/오프라인. 전체 페이지 가로 overflow·필수 조작 잘림/겹침·선택 핀 가림·포커스 유실 0건을 요구한다. 표 내부 스크롤만 예외이며 제스처/키보드/scroll bounds까지 확인한다.
- [ ] Step 2 — 디자이너가 P0/P1/P2와 증거 경로를 보고하면 총괄이 기능 담당자에게 수정·재검증을 배정한다. 가장 역량 높은 모델의 새 whole-branch reviewer가 전체 spec/plan/diff/보고서로 요구·보안·API 호환성을 검토한다. 중복 검토자나 구체적 의심 없는 전체 suite 재실행은 만들지 않는다.
- [ ] Step 3 — fresh root `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`를 순차 실행하고 UI 정책 위반 0을 확인한다. 관련 disposable DB migration/integration 뒤 one-worker RealBackendLab에서 실제 읽음 저장/로그 필터를 검증한다. 운영 DB/실제 Gateway는 쓰지 않는다. skip/외부 도구 부재는 미검증이지 통과가 아니다.
- [ ] Step 4 — 새 P0/P1/P2·변경 영향 회귀는 병합 차단이다. 담당자의 RED/GREEN과 scoped 재검토를 거친다. 기존 편집기 1000개/8초 실패와 production audit High 2건은 별도 보고하고 한도/예외를 바꾸지 않는다. 기준 비교로 동일한 기존 실패만 구분하며 조용히 skip하지 않는다.
- [ ] Step 5 — 22행 완료표·체크박스·상태판·한계를 실제 증거로 갱신한다. 기본 branch/HEAD와 clean 상태를 확인하고 그대로면 일반 fast-forward 병합, 변경됐으면 통합 담당자가 검토된 커밋만 조정·재검증한다. 사용자가 별도 브랜치 후 병합을 요청했으므로 추가 병합 승인 대기는 없다. reset/stash drop/다른 WIP cherry-pick/push/서버 재시작은 하지 않는다. 인계까지 브랜치/보고서를 보존한다.
- [ ] Step 6 — 구현 결과·병합 SHA·실제 테스트 수와 한계, 운영 DB migration 미적용/HIL 미실행을 보고한다. 필요한 증거를 복구 가능하게 보존한 뒤에만 작업공간을 정리하며 현재 5173 서버에 새 schema가 적용됐다고 주장하지 않는다.

## 계획 자기 검토

- [x] 주석1–22를 Task4/5/6/7에 모두 대응하고 시각공통Task3/8을 포함했다.
- [x] producer필드·shape·기존default·backwardcompatibility·책임을 고정했고 consumer는같은이름을 사용한다.
- [x] ReviewFocus5개 모두소유Task의 구체테스트에 대응한다. 준비/문서/전제는각deliverable에 묶고 task별freshreview를 둔다.
- [x] spec범위 밖인운영DB·HIL·설치/센서WIP·PDF표시·새요금제는제외하고 기존권한·보관·진단을 명시했다.
- [x] 추가승인대기를 생략하는 근거는명시적사용자지시이며 계획작성만을제품완료로 표시하지 않는다.
