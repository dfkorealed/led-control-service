# 현장의 하루 React 랜딩 적용 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 `field-day.html` 시안을 서비스의 공개 `/` 랜딩으로 적용하고, 기존 상담 API에 연결된 팝업을 제공한다.

**Architecture:** 기존 `LandingPage`를 진입점으로 유지하되, 히어로·공통 장면 틀·장면별 예시·상담 팝업을 분리한다. 시안의 색과 레이아웃은 `theme.css` 토큰에 연결하고, 장면의 자동 재생·재진입 재생은 React 효과에서 정리한다. 상담 필드와 제출 로직은 기존 `InquiryForm`/`submitLandingInquiry`를 재사용한다.

**Tech Stack:** React 18, TypeScript, Vite, CSS, React Aria 공통 UI, Vitest, Playwright.

**Spec:** [승인된 현장의 하루 시안](../../../apps/web/public/concepts/field-day.html), [시안 구현 기록](2026-09-26-field-day-interactive-concept.md), 현재 [랜딩 기능 현황](../../menus/landing.md).

## Global Constraints

- `/`는 인증 없이 열리고 최초 진입에서 `/api/auth/me`를 호출하지 않는다. 로그인 버튼은 `/login`으로 이동한다.
- 5개 장면의 설명·예시·재생 동작은 시안과 같고, 예시는 실제 장비/운영 데이터를 호출하지 않는다.
- 애니메이션은 장면이 다시 보일 때 재생하며, `prefers-reduced-motion`에서는 최종 상태를 즉시 보여준다.
- 상담 버튼 세 곳은 현재 페이지의 팝업을 열고, 기존 90일 동의·4KB 검사·UUID 재시도·15초 제한·503 이메일 대체 계약을 유지한다.
- 공통 버튼·카드는 `apps/web/src/components/ui`의 기존 컴포넌트를 우선 사용하고, 재사용되는 새 변형만 그 폴더에 둔다.
- 기존 작업 중인 다른 메뉴와 API 계약, DB 스키마는 변경하지 않는다.

## Review Focus

- 직접 `/#contact`로 진입하거나 뒤로 가기를 누를 때 낡은 인라인 상담 위치가 남지 않도록 팝업 동선을 확인한다.
- 제출 중 닫기·Escape·배경 클릭·중복 제출과 키보드 포커스/진행 안내를 함께 확인한다.
- 320/390px에서 팝업과 다섯 장면의 가로 넘침, 터치 대상, 스크롤 가능 여부를 확인한다.
- 보이지 않는 장면의 타이머/애니메이션 정리와 재진입 시 재생, 사용자 조작의 결과를 확인한다.
- 실패 뒤 내용·멱등 키 유지, 내용 변경 뒤 새 키, 503 외에는 이메일 대체 링크가 없는지 확인한다.

---

### Task 1: 시안 레이아웃과 공통 컴포넌트

**Files:** `apps/web/src/features/landing/LandingPage.tsx`, 새 `apps/web/src/features/landing/field-day/*`, `apps/web/src/features/landing/field-day.css`, 필요 시 `apps/web/src/components/ui/*`, `apps/web/src/styles.css`.

- [x] **Step 1:** `/`의 헤더, 히어로, 다섯 장면, 마지막 상담 유도 영역을 시안과 비교하는 브라우저 테스트를 작성하고 기존 화면에서 실패를 확인한다.
- [x] **Step 2:** 시안의 구조·문구·반응형 CSS를 컴포넌트로 옮긴다. 공통 장면 틀, 예시 카드, 액션 버튼의 중복을 줄이고 브랜드 토큰을 쓴다.
- [x] **Step 3:** 데스크톱과 모바일에서 구조·시각 차이 및 스크롤 넘침을 확인하고 관련 테스트를 통과시킨다.

### Task 2: 다섯 장면의 상태와 재생

**Files:** `apps/web/src/features/landing/field-day/*`, `apps/web/src/features/landing/field-day.css`, 관련 Vitest/Playwright 테스트.

- [x] **Step 1:** 조명 선택, 밝기 적용, 그래프 그리기, 보고서 형식, 맵 배치·이동과 화면 재진입 재생의 실패 테스트를 만든다.
- [x] **Step 2:** 각 장면의 예시 상태를 React로 소유하고, 공통 재생 훅에서 관찰자·타이머·취소를 정리한다. 키보드·포인터 조작과 축소 동작을 적용한다.
- [x] **Step 3:** 테스트와 실제 브라우저에서 장면별 조작·재생·재진입을 확인한다.

### Task 3: 상담 팝업과 기존 접수 계약

**Files:** `apps/web/src/features/landing/InquiryForm.tsx`, `apps/web/src/features/landing/field-day/*`, 필요 시 `apps/web/src/components/ui/overlays/*`, 관련 Vitest/Playwright 테스트.

- [x] **Step 1:** 세 CTA의 팝업 열기, 닫기/포커스 복귀, 필드 검증, 201·429·503·타임아웃·재시도, 제출 중 키보드 경계의 실패 테스트를 만든다.
- [x] **Step 2:** 기존 `InquiryForm`을 팝업에 맞게 재사용하고 기존 `submitLandingInquiry`만 호출한다. 제출 중 진행 안내와 포커스를 팝업 안에 유지한다.
- [x] **Step 3:** 모의 API E2E와 모바일 팝업 화면을 확인한다. 실제 NAVER WORKS 메일 도착 검증과 구분한다.

### Task 4: 기존 랜딩 정리와 기록

**Files:** `apps/web/src/features/landing/*`, `apps/web/e2e/landing.spec.ts`, `docs/menus/landing.md`, `docs/project-status.md`.

- [x] **Step 1:** 더 이상 쓰이지 않는 이전 랜딩 미리보기/모션 코드를 정리하고 기존 테스트를 새 화면 계약으로 갱신한다.
- [x] **Step 2:** `docs/menus/landing.md`에 실제 `/` 적용과 시안/모의 데이터·메일 검증 한계를 기록한다.
- [x] **Step 3:** `pnpm --filter @led-control/web typecheck`, `test`, `build`, 관련 Playwright, `git diff --check`를 실행한다. 결과를 `docs/project-status.md`와 이 체크리스트에 맞춰 갱신한다.

최종 검증(2026-09-27): Web 단위 테스트 165 files·2,362 passed·3 skipped, 랜딩 Playwright 22/22, Web typecheck·build·`git diff --check` 통과. 로컬 Vite `/` HTTP 200 및 실제 브라우저 히어로·상담 팝업 표시를 확인했다. 상담은 모의 API 응답으로 검증했고 실제 NAVER WORKS 메일 도착은 운영 환경 점검이 남아 있다. 독립 QA의 맵 자동 이동·터치 드래그·CSV 보고서 표현 지적 3건을 반영했다.
