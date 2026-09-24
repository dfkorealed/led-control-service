# Kinda Shell, Auth, Session Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인된 Kinda UI/UX 설계에 맞춰 전역 현장 문맥, 선택 현장 Gateway 집계, 재진입 가능한 세션 상태 센터와 비차단 toast, 유한한 인증 요청과 오류별 복구를 공통 Shell에 구현한다.

**Architecture:** 서버·공유 DTO는 변경하지 않고 기존 `GET /sites`와 `GET /sites/:siteId/dashboard`를 사용한다. `CustomerShell`이 URL `siteId`를 전역 문맥의 단일 원천으로 소유하고, 공통 `SessionStatusProvider`가 화면별 query 상태를 선언형 item으로 등록받아 안정 키로 중복 제거한다. 인증 fetch는 요청별 `timeoutMs`를 합성한 signal로 제한하고 401/403/429/5xx/transport/timeout을 명시적으로 분류하되 보호 route는 현재처럼 fail-closed를 유지한다.

**Tech Stack:** React 18.3.1, TypeScript 5.7, React Router, TanStack Query, Tailwind CSS 4.3.3, React Aria Components 1.21.1, Vitest, Testing Library, Playwright

**Spec:** `docs/assets/ux-refresh-2026-09-23/design-review.md`, `docs/superpowers/specs/2026-09-15-tailwind-design-system-migration-design.md` chapter 0, `docs/brand/kinda-brand-foundation.md`

## Global Constraints

- 실제 작업 디렉터리는 `/Users/kim-jh/Documents/led-control-service`, 대상 브랜치는 `codex/mvp1-cloud-web`이다.
- `/sites`가 반환한 인가된 현장만 선택기에 표시한다. 새 서버 endpoint·DB schema·공유 DTO를 추가하지 않는다.
- 현장 전환은 현재 pathname/query/hash를 보존하고 `siteId`만 바꾼다. floor editor에서는 안전한 목록 route로 이탈하며 dirty draft는 확인 전 폐기하지 않는다.
- Gateway 집계는 선택 현장의 `dashboard.gateways`만 사용한다. query가 없거나 실패한 상태는 `오프라인`과 구분해 `확인 불가`로 표시한다.
- cached dashboard가 남은 background 갱신 실패는 마지막 집계를 유지하되 `갱신 지연` warning으로 표시한다. 브라우저에서 heartbeat freshness를 다시 계산하지 않는다.
- toast는 상태의 유일한 저장소가 아니다. 상태 센터 item은 원 query가 해결될 때까지 남고, toast는 안정 키와 fingerprint로 한 번만 알린 뒤 자동 또는 수동 해제한다.
- 모든 상호작용은 ref와 React state를 사용한다. production `querySelector`를 추가하지 않는다.
- 320/390/1024/1440px에서 가로 overflow가 없고 모바일 interactive target은 연속 44×44px 이상이어야 한다.
- 페이지·메뉴 기능 영향은 `docs/menus/monitoring.md`, `control.md`, `statistics.md`, `settings.md`에 함께 기록한다.
- 실행 결과를 이 체크리스트와 `docs/project-status.md`에 같은 근거로 갱신한다.

## Public Contracts

```ts
export interface ApiRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ApiFailureKind =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "server"
  | "transport"
  | "timeout"
  | "other";

export function classifyApiFailure(error: unknown): ApiFailureKind;

export type SessionStatusTone = "info" | "warning" | "danger";

export interface SessionStatusItem {
  id: string;
  fingerprint: string;
  source: "site" | "gateway" | "query" | "command";
  tone: SessionStatusTone;
  title: string;
  description?: string;
  announce?: boolean;
  action?: { label: string; onAction(): void };
}

export interface SessionToastInput {
  id?: string;
  dedupeKey?: string;
  tone: "info" | "success" | "warning" | "danger";
  title: string;
  description?: string;
  durationMs?: number;
}

export function useSessionStatus(sourceId: string, items: readonly SessionStatusItem[]): void;
export function useSessionToast(): {
  publish(input: SessionToastInput): string;
  dismiss(id: string): void;
};
```

---

### Task 1: 인증 요청 제한시간과 오류 분류

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/api/client.recovery.test.ts`
- Modify: `apps/web/src/api/auth.ts`
- Modify: `apps/web/src/features/auth/AuthView.tsx`
- Modify: `apps/web/src/features/auth/AuthView.test.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] `apiGet`/`apiPost`의 `ApiRequestOptions.timeoutMs`가 caller signal과 독립적으로 합성되고 timer/listener를 항상 정리하는 RED 테스트를 작성한다.
- [ ] timeout은 `ApiTimeoutError`, 네트워크 fetch 실패는 `ApiTransportError`, 호출자 취소는 원래 abort로 남는 분류 테스트를 RED로 확인한다.
- [ ] `classifyApiFailure`와 `isTransientApiError`가 401/403/429/5xx/transport/timeout/other를 정확히 구분하도록 최소 구현한다.
- [ ] `/auth/me`, `/auth/login`, `/auth/login/mfa`, 복구 logout에 명시적 제한시간을 적용한다. 일반 장기 요청에는 전역 기본 timeout을 강제하지 않는다.
- [ ] `/auth/me`의 React Query signal을 fetch에 전달하고 auth 요청 deadline은 8초, 복구 logout은 기존 5초로 고정한다. 각 timer와 abort listener는 성공·실패·취소 모두에서 정리한다.
- [ ] login/MFA POST timeout·transport 실패는 같은 POST를 자동 재시도하지 않고 제한시간이 있는 `/auth/me`를 먼저 조회한다. 인증된 principal이 확인되면 정상 완료하고, 401이면 명시적 재시도 안내로 돌아가며 다시 transient면 연결/시간 초과 복구 문구를 유지한다.
- [ ] 로그인/MFA 화면이 401 자격 증명, 403 접근 거절, 429 제한, 5xx 서비스 장애, transport 연결 실패, timeout 응답 지연을 서로 다른 한국어 복구 문구로 표시하게 한다.
- [ ] `App`의 401 로그인 수렴, transient recovery, 비일시 오류의 fail-closed 권한 복구와 principal/cache 세대 격리를 회귀 테스트한다.
- [ ] Run: `pnpm --filter @led-control/web test -- src/api/client.test.ts src/api/client.recovery.test.ts src/features/auth/AuthView.test.tsx src/App.test.tsx`

### Task 2: 선언형 세션 상태 센터와 비차단 toast 공통 API

**Files:**
- Create: `apps/web/src/components/ui/session-status/SessionStatusProvider.tsx`
- Create: `apps/web/src/components/ui/session-status/SessionStatusCenter.tsx`
- Create: `apps/web/src/components/ui/session-status/ToastRegion.tsx`
- Create: `apps/web/src/components/ui/session-status/session-status.test.tsx`
- Modify: `apps/web/src/components/ui/index.ts`
- Modify: `apps/web/scripts/overlay-bundle.mjs`

- [ ] provider가 source별 item을 등록·unregister하고 동일 `id + fingerprint`를 한 번만 toast로 전환하는 RED 테스트를 작성한다.
- [ ] item이 원 query 성공으로 사라지면 센터와 연관 toast가 해제되고, 새 fingerprint는 다시 한 번 알리는 RED 테스트를 작성한다.
- [ ] success/info/warning/danger toast의 기본 표시 시간, 수동 닫기, 같은 `dedupeKey` 갱신, 최대 표시 개수와 timer 정리를 RED로 고정한다.
- [ ] `SessionStatusProvider`, `useSessionStatus`, `useSessionToast`, `SessionStatusCenter`, `ToastRegion`을 Tailwind token과 공통 Button/Popover만 사용해 구현한다.
- [ ] 상태 센터 trigger의 `aria-expanded`/`aria-controls`, dialog label, Escape·바깥 클릭 닫기, trigger focus 복귀, toast의 `role=status|alert`를 테스트한다.
- [ ] `components/ui/index.ts`에 위 public contract를 export하고 overlay bundle gate에 실제 consumer를 추가한다.
- [ ] Run: `pnpm --filter @led-control/web test -- src/components/ui/session-status/session-status.test.tsx && pnpm --filter @led-control/web test:overlay-bundle`

### Task 3: 전역 현장 선택과 선택 현장 Gateway 상태를 Shell에 연결

**Files:**
- Modify: `apps/web/src/features/sites/SiteSwitcher.tsx`
- Modify: `apps/web/src/features/sites/SiteSwitcher.test.tsx`
- Create: `apps/web/src/features/sites/useGuardedSiteSelection.ts`
- Create: `apps/web/src/features/sites/useGuardedSiteSelection.test.tsx`
- Create: `apps/web/src/features/shells/gateway-status.ts`
- Create: `apps/web/src/features/shells/gateway-status.test.ts`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.test.tsx`
- Modify: `apps/web/src/features/settings/SettingsShell.tsx`
- Modify: `apps/web/src/features/settings/SettingsShell.test.tsx`

- [ ] Shell이 `useSites`의 loading/error/data와 URL `siteId`를 사용해 전역 selector를 렌더링하는 RED 테스트를 작성한다. 목록 밖 `siteId`는 선택 가능한 것처럼 표시하지 않는다.
- [ ] dirty floor editor에서 현장 변경 취소/승인, route·query·hash 보존, 승인 시 draft 1회 폐기와 editor 목록 route 이탈을 RED로 고정한다.
- [ ] `useGuardedSiteSelection`에 기존 Settings 소유 확인 로직을 옮기고 `SettingsShell`의 중복 selector/dialog를 제거한다.
- [ ] `gateway-status.ts`가 미등록, 전체 연결, 일부/전체 오프라인, dashboard unavailable, cached data + background error의 `갱신 지연`을 구분하는 RED 테스트를 작성한다.
- [ ] Shell이 Gateway aggregate를 상태 센터의 Gateway item과 연결하고 `확인 불가`를 offline으로 오인하지 않게 구현한다.
- [ ] 모바일 topbar를 제목·상태 action 행과 현장 문맥 행으로 재배치해 editor 포함 320/390px에서도 logout·selector·status trigger가 44px 이상이고 overflow가 없게 한다.
- [ ] Shell이 `SessionStatusProvider`와 `ToastRegion`을 소유하고 site/dashboard query의 retry action을 상태 센터 item으로 선언한다.
- [ ] Run: `pnpm --filter @led-control/web test -- src/features/sites/SiteSwitcher.test.tsx src/features/sites/useGuardedSiteSelection.test.tsx src/features/shells/gateway-status.test.ts src/features/shells/CustomerShell.test.tsx src/features/settings/SettingsShell.test.tsx`

### Task 4: 반응형 Chromium, 정책, 전체 Web과 문서 검증

**Files:**
- Modify: `apps/web/e2e/support/settings-api.ts`
- Modify: `apps/web/e2e/calm-operations-shell.spec.ts`
- Modify: `apps/web/e2e/calm-operations-auth-operator.spec.ts`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-24-kinda-shell-auth-session-status.md`

- [ ] Chromium fixture에 복수 인가 현장, Gateway 전체/부분/없음, site/dashboard 실패와 인증 timeout을 추가한다.
- [ ] 320/390/1024/1440px에서 전역 현장 전환, Gateway aggregate, 상태 센터 open/Escape/focus return, toast dedupe/resolution, touch/overflow를 검증한다.
- [ ] 로그인 401/403/429/5xx/transport/timeout 및 `/auth/me` fail-closed 복구를 관련 Chromium spec으로 검증한다.
- [ ] Run: `pnpm --filter @led-control/web lint`
- [ ] Run: `pnpm --filter @led-control/web typecheck`
- [ ] Run: `pnpm --filter @led-control/web test`
- [ ] Run: `pnpm --filter @led-control/web ui:check`
- [ ] Run: `pnpm --filter @led-control/web build`
- [ ] Run: `pnpm --filter @led-control/web exec playwright test e2e/calm-operations-shell.spec.ts e2e/calm-operations-auth-operator.spec.ts --project=chromium --workers=1`
- [ ] 네 메뉴 문서에 전역 selector/Gateway/status center의 구현 범위와 세션 한계, 인증 복구 경계를 기록한다.
- [ ] 자동 Chromium과 실제 Gateway/MQTT/HIL·수동 in-app 시각 QA를 구분해 `docs/project-status.md`와 이 체크리스트에 최종 증거를 동기화한다.
- [ ] `git diff --check`와 `git status --short`로 own-files-only를 확인한 뒤 경로를 명시해 stage/commit한다.
