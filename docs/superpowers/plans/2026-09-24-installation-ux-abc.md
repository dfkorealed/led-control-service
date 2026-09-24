# 설치·설정 A/B/C 구현 계획

> **작업 방식:** `superpowers:executing-plans`와 TDD를 적용한다. 각 항목은 테스트 실패 확인 후 최소 구현과 집중 회귀로 완료한다.

**목표:** 초기 설치 층 저장 검증, 게이트웨이·조명 등록으로 이어지는 행동, 단일 대상의 안전한 기본 선택을 구현한다.

**구조:** 기존 설치·등록 API와 route를 재사용한다. 화면 상태를 서버 상태로 오인하지 않고, 복구 중인 등록 세션의 층·게이트웨이 선택을 우선한다.

**기술:** React, TypeScript, TanStack Query, Vitest, Testing Library, Playwright.

**설계:** `docs/assets/ux-refresh-2026-09-23/design-review.md`, `docs/superpowers/specs/2026-09-15-tailwind-design-system-migration-design.md` 0장.

## 공통 제약

- 수정 범위는 설치·등록·설정 개요와 그 테스트, `docs/menus/settings.md`이다. 공통 UI·셸·테마·API·DB는 변경하지 않는다.
- 같은 checkout에서 다른 담당자가 작업한다. 이번 단계에서는 git add/commit, 공용 build/전체 test/전체 typecheck를 실행하지 않는다.
- `siteId` URL, role/capability, active 등록 세션 복구, editor lease/dirty/409를 유지한다.
- 시안 수치는 mock이며 하드웨어 HIL을 완료로 기록하지 않는다.

## 검토 초점

- 층수만 수정한 뒤 기존 층 배열이 저장되는 오류를 막는다.
- 층 이름을 직접 바꾼 뒤 재생성할 때 확인 없이 덮어쓰지 않는다.
- 설치 완료 뒤 실제 Gateway 등록 여부에 따라 같은 등록 경로로 안내한다.
- 둘 이상의 층·Gateway가 있으면 임의 자동 선택을 하지 않는다.
- 진행 중인 세션 복구·현장 전환 시 기본 선택이 이전 문맥을 덮지 않는다.

## Task A: 초기 설치 층 검증

**파일:** `apps/web/src/features/setup/SetupWizard.tsx`, `SetupWizard.test.tsx`.

- [x] 층수 변경 뒤 목록이 불일치하면 저장이 비활성화되고 mutation이 호출되지 않는 실패 테스트를 작성·실행한다.
- [x] 음수·소수·상한 초과, 지하/지상 부호별 개수와 실제 목록의 일치 테스트를 작성·실행한다.
- [x] 직접 수정한 이름/level을 재생성 전에 확인하고 취소하면 보존하는 테스트를 작성·실행한다.
- [x] 파서·검증·확인 대화상자를 최소 구현한다. 기존 `createInitialSiteSetup` payload 형식은 유지한다.
- [x] 저장소 쓰기 제한 때문에 `/private/tmp`에 기존 Vite 설정을 불러오는 임시 ESM config를 두고 focused Vitest를 통과했다.

## Task B: 설치 다음 단계 행동

**파일:** `apps/web/src/features/settings/SettingsView.tsx`, `apps/web/src/features/settings/registration/RegistrationSettingsView.tsx`(필요 시), `apps/web/src/features/registration/RegistrationPanel.tsx`, 해당 테스트.

- [x] Gateway 미등록·등록 완료·조명 등록 완료 상태의 CTA 및 viewer 읽기 전용 테스트를 먼저 실패시킨다.
- [x] 설치 완료 직후 `SettingsView`에서 `/settings/registration?siteId=...`로 연결한다. Gateway가 없으면 기존 claim 화면, 있으면 기존 검색 화면을 그대로 사용한다.
- [x] 등록된 조명이 있으면 `/settings/floor-plans?siteId=...`의 맵 배치 링크를 제공한다. 기본 dashboard는 `includeFixtures=false`이므로 미배치 수량을 임의 계산하지 않는다.
- [x] 설정/등록 focused Vitest를 통과했다.
- [ ] 기존 설치 브라우저 여정은 총괄 직렬 통합 게이트에서 실행한다.

## Task C: 등록 대상 안전 기본 선택

**파일:** `apps/web/src/features/registration/RegistrationPanel.tsx`, `RegistrationPanel.test.tsx`.

- [x] 하나의 층·온라인 Gateway, 다중 대상, 오프라인, active session restore, 현장 전환 테스트를 먼저 실패시킨다.
- [x] dashboard와 active session 조회가 완료되고 사용자가 아직 선택하지 않았을 때에만 유일한 층·온라인 Gateway를 기본 선택한다.
- [x] 오프라인 Gateway로 검색 시작은 막고 이유를 표시한다. 복구된 세션·수동 선택을 자동 선택으로 덮지 않는다.
- [x] 등록 focused Vitest를 통과했다.
- [ ] 기존 브라우저 등록 여정은 총괄 직렬 통합 게이트에서 실행한다.

## 마무리

- [x] `docs/menus/settings.md`의 구현 상태·소프트웨어 검증·HIL 미실행을 갱신한다.
- [x] 오프라인 상태 재조회는 게이트웨이 선택 영역의 아이콘·툴팁에 통합하고 별도 수직 안내 행을 제거했다. 설정 CTA 링크의 중복 스타일을 설정 범위에서 공통화했다.
- [x] 본인 범위 focused unit 79개를 통과했다.
- [x] 본인 추적 파일 `git diff --check` 0건, 신규 파일은 별도 공백 점검을 완료했다.
- [ ] Web `tsc --noEmit`은 다른 담당 소유 `src/api/client.ts:152`의 TS2322 때문에 실패했다. 총괄 통합 시 재실행한다.
- [ ] 공용 Web 전체 test/typecheck/build는 총괄이 작업 통합 후 직렬 실행한다. 본인은 수정 파일·명령 출력·잔여 위험을 보고하고 커밋하지 않는다.
