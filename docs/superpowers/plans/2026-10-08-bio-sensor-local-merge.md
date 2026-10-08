# BIO 센서 기능 로컬 병합 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자 요청대로 검토 완료 센서 브랜치를 `codex/mvp1-cloud-web`에 병합하고 남은 제품 과제를 보고한다.
**Architecture:** 깨끗한 기존 센서 worktree에서 최신 기본 브랜치를 먼저 통합·검증한다. 기본 checkout의 미커밋 목업 문서 2개는 최종 ff-only 전까진 변경하지 않으며, 필요하면 정확한 두 경로만 내구 stash로 보존·복원한다. 전체 센서 코드를 다시 구현하거나 운영 환경에 적용하지 않는다.
**Tech Stack:** Git, React/Vitest/Playwright, TypeScript, NestJS/Prisma, BIO Gateway.
**Spec:** `../specs/2026-10-08-common-bio-sensor-configuration-design.md` 및 사용자 `그럼 일단 머지를 하고, 완벽한 이벤트 기능을 위한 남은 과제는 뭐야`.

## Global Constraints

- 기본 브랜치 기준 `5e173fb4`, 센서 승인 기준 `247a837d`; 양쪽 모바일·지도·알림 lifecycle·정렬·BIO 준비/권한/복원 기능을 보존한다.
- 정상·미준비 등록 조명 inspection, server eligibility-only confirmation, BIO hold10..1800/default60, 공통 준비 패널·모바일 pinch를 유지한다.
- 승인 profile empty·policy OFF, 운영 DB/Pi/RF/PKI/서버 재시작/push 금지. 실제 DB migration은 실행하지 않는다.
- 공유 수정은 `packages/shared/tsconfig.esm.json`의 양쪽 include 목록 결합만 승인한다. 새로운 계약/스키마/기능은 추가하지 않는다.
- 기본 checkout 미커밋 `docs/menus/control.md`, `docs/menus/monitoring.md` 목업 section은 사용자 변경으로 보존하고 병합 커밋에 섞지 않는다.
- 기존 기능 전체 suite/HIL 반복 대신 충돌·자동 합성 접점의 집중 검증과 변경 앱 타입/빌드를 수행한다. 이전 검증 수치를 새 통과로 복사하지 않는다.

## Review Focus

- 최신 모바일 높이/알림 owner를 보존하면서 BIO telemetry와 preparation inspection을 결합한다.
- 미준비 marker는 검사 가능하지만 source 확정은 현재 서버 판정으로 제한한다.
- 최신 컴팩트 이력 UI의 props·접근성·필터와 BIO 전용 이력을 모두 보존한다.
- Shared ESM/browser/CJS export와 최신 통계/화면 소비자 include가 함께 build된다.
- 기존 사용자 목업 문구와 양쪽 메뉴/상태 이력이 유실되지 않는다.

### Task 1: 격리 worktree의 양쪽 변경 통합·검증

**Owner:** web integration 단일 소유자; root 승인 범위에서 docs/Shared include만 함께 해결.
**Files:** 충돌 `apps/web/e2e/{calm-operations-manual-control,control-map-target-selection}.spec.ts`, `apps/web/src/features/control/{CommandHistoryPanel,ControlView}.tsx`, `automation/VehicleEventControlPanel{,.test}.tsx`, `target-selection/SpatialTargetSelector.tsx`; `packages/shared/tsconfig.esm.json`; `docs/{lesson_leared,project-status,menus/control,menus/monitoring,menus/settings}.md`. 자동 합성 Web/Shared/Prisma 접점도 읽기 검증한다.
**Interfaces:** 기존 양쪽 props/typed API를 합성하며 새로운 서버 계약을 만들지 않는다. 한 merge commit과 검증 보고서를 반환한다.

**승인된 최소 Web 합성:** `automation/components/AutomationRuleTable.tsx` 공통 `AutomationRuleActions`의 optional `toggleDisabled=false`를 추가해 토글만 `disabled || toggleDisabled`로 막는다. 기존 전체 disabled/editDisabled·수정/삭제 의미는 보존하며 BIO 비활성의 활성화만 막는 기존 동작과 최신 공통 action UI를 함께 유지한다. 관련 focused 회귀를 소유 범위에 포함한다.

**승인된 test-only API fixture 보완:** 병합 변경이 없는 기존 `apps/api/src/automation/bio-rule-qualification.spec.ts`는 `$queryRaw=[]`가 현재 SQL eligibility를 표현하지 못해 실패했다. exact query discriminator·명시적 synthetic ready/blocked 관측만 보완하고 기타 SQL의 빈 결과/V2 미확인·negative assertions를 유지한다. advertised ready라도 SQL 차단이면 저장 불가 회귀를 추가한다. 제품 SQL/스키마/자격 조건은 변경하지 않는다.

현재 제품은 V2 자격도 동일 SQL predicate에 포함하므로, 오래된 `v2_support_unverified` 응답 assertion은 명시적 `gateway_protocol_unverified` SQL 차단 fixture와 unavailable/blockedReason/create0 검증으로 동기화한다. 제품 허용 조건은 완화하지 않는다.

**승인된 BIO 모바일 터치 보존:** 실제 Chromium320/390에서 최신 공통 action의 44px 둥근 버튼으로 기존 BIO52px 유효 터치 영역이 줄어든 통합 실패를 확인했다. 기존 common Button/RowActions className을 재사용해 BIO compact 영역만 이전52px로 보존한다. 필요하면 private-Web optional action class prop(default empty)을 허용하며 기본 소비자·스케줄/BlueZ/PC의 크기는 유지한다. 현재 merged lockfile의 frozen install은 허용하되 dependency/lockfile 변경과 모바일 전체 회귀는 하지 않는다.

**최종 검토 최소 정리:** 자동 합성 `e2e/support/real-backend-lab.ts`의 동일 `DEV_LOCAL_APP_ONLY:"0"` 중복 키를 하나로 정리하며 실제 환경 의미는 유지한다. focused diff/구문 확인과 Gateway 타입 결과 로그 보완 후 해당 수정만 scoped 재검토한다. 기존 도구·bundle 경고는 후속 정리로 남기며 운영 audit 통과를 주장하지 않는다.

- [x] 양쪽 parent와 conflict hunk를 대조해 기존 독립 기능이 필요한 접점을 확인한다. conflict가 RED이며 별도 신규 기능의 TDD로 과장하지 않는다.
- [x] `apply_patch`로 충돌을 최소 합성하고 필요한 기존 focused 회귀만 보강한다. ours/theirs 파일 전체 선택으로 기능을 버리지 않는다.
- [x] workspace prepare, 필요한 Prisma generate(사용자 DB 접근0), Shared export smoke·Web 충돌 관련 단위·API/Gateway 공통 경로 최소 회귀·앱 타입/빌드·UI정책·실제 기존 Chromium PC/mobile/pinch 표적을 검증한다. 실패는 정확한 원인과 최소 수정 범위를 보고한다.
- [x] 충돌 markers0·diffcheck와 원래 양쪽 기능/문서 보존 자체검토 뒤 소유 merge commit/report를 인계한다. root 독립 통합 검토 후 Task2로 이동한다.

**Task1 증거:** merge `943c2ab8`, 환경키 중복 보완 `cd41dfc9`. Web384+새3/Shared105/API29+기존 다른18/Gateway64·Chromium26, 앱 타입/빌드/UI정책 통과. 최종 검토 SpecPASS/localmergeReady, scoped M1 ADDRESSED/newC0/I0/M0. 기존 launcher/color/chunk 경고와 운영·실장비 미실시 한계는 유지한다.

### Task 2: 기본 checkout 로컬 반영·사용자 문서 복원·인계

**Owner:** root orchestration.
**Interfaces:** Task1 검토 완료 merge HEAD를 기본 `codex/mvp1-cloud-web`에 ff-only 반영; 기존 사용자 2문서 diff는 동일 내용으로 uncommitted 복원.

- [x] 기본/작업 HEAD와 dirty target2 경로를 다시 확인한다. 원격 동기화가 필요하면 fetch/ff-only만 허용하고 unrelated 원격 병합·push는 하지 않는다.
- [x] 두 문서만 필요시 exact stash로 보존한 뒤 승인 HEAD를 ff-only 반영한다. stash는 검증 전 삭제하지 않는다.
- [x] 사용자 문구·미커밋 상태 보존 및 기본 HEAD의 센서·최신 UI 포함을 확인한다. local workspace producer/대표 consumer smoke·diffcheck로 병합 후 상태를 확인한다.
- [x] 상태판/체크리스트 동기화 후 로컬 merge 결과와 필수 실장비/운영 과제 및 선택 확장을 분리해 보고한다. 임시 기존 보호 자료가 있는 센서 worktree는 보존한다.

**Task2 완료:** 기본 `codex/mvp1-cloud-web`을 검토 코드 `943c2ab8`+`cd41dfc9` 및 승인 기록 `825b9c1a`로 ff-only 반영했다. main에서 workspace:prepare·Web 타입·공통 action3/3·diffcheck를 확인했다. 사용자 목업2문서의 추가23/22줄 내용은 정확히 동일하며 uncommitted/index-empty 상태로 보존한다. exact backup stash `71a8a17d59e5bad64ab710529c9c81bd1b9966ff`와 기존5stash·보호 증거를 가진 센서 worktree는 보존한다. remote push/운영 migration·배포·실장비 변경은0이다.

## 병합 판단 기록

- 기본 checkout의 사용자 변경 보호를 위해 격리 worktree에서 최신 main을 먼저 합성했다. 잘못된 합성이면 원 parent에서 재통합하며 사용자 변경은 버리지 않는다.
- 반복 전체 suite 대신 충돌·자동 합성 접점에 집중했다. 빠진 위험이 확인되면 해당 경계의 회귀를 추가하며 전체/HIL 통과로 확대하지 않는다.
- BIO 활성화만 별도 optional toggleDisabled로 제한했다. 판단이 잘못되면 해당 private Web prop/panel만 재조정하고 기존 편집/삭제·일반 소비자는 보존한다.
- BIO compact action만 기존52px로 복원했다. 잘못된 배치라면 private class prop/caller를 수정하며 PC·일반 메뉴 크기는 바꾸지 않는다.

## 병합 이후 남은 이벤트 제품 과제

1. 실제 장비 식별 조합과 검증 근거로 최초 하드웨어 프로파일을 승인한다. 기존 A→B 적용·유지 연장·원복 증거는 재사용하되 전체 감지 의미/미검증 payload/다른 장비군 호환 증거로 확대하지 않는다. 승인된 동일 조합은 이후 개별 개발자 연결 없이 UI 준비로 재사용한다.
2. 별도 운영 승인 후 forward migration, API/Web/Gateway 및 MQTT 계약 호환 배포, 현장 장애 담당자/대응 시간/에스컬레이션 정책을 적용한다. 이 로컬 병합은 운영 적용이 아니며 catalog empty/policy OFF를 유지한다.
3. 정식 UI에서 준비→규칙 저장·활성→감지·유지 연장→기존 밝기 복귀와 최소 장애 회복을 짧게 확인한다. 기존 임시 pilot이나 fake-transport를 실제 서비스 전체 E2E로 대신하지 않는다.
4. 후속 확장: 감지 센서 조명 자체의 sensor-safe 밝기 명령, 한 규칙의 복수 BIO 센서 및 겹치는 대상의 우선순위/합성, BIO 장애 전용 알림·담당자 에스컬레이션 연계. 필요에 따라 별도 설계한다.
5. 현재 방식은 펄스와 마지막 신호 기준 유지시간(10~1,800초)이다. 정확한 재실/부재 판단이 필요하면 상태형 프로토콜·펌웨어 근거가 추가로 필요하며 신호가 없다는 사실만으로 사람이 없다고 단정하지 않는다.
