# 공개 주요 기능·요금제 페이지 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자 수정에 따라 `주요 기능`과 `요금제`를 각각 독립 공개 페이지로 제공하고, 홈의 주석 수정과 회사 푸터를 유지한다.

**Architecture:** `main.tsx`는 `/`, `/features`, `/pricing`을 인증 없는 공개 화면으로 라우팅한다. 공통 공개 레이아웃이 고정 헤더·회사 푸터·상담 팝업/선택 요금제를 소유하고, 홈은 기존 다섯 장면을 유지한다. `/features`는 네 기능별 상세 스토리와 추상 UI, `/pricing`은 두 요금 비교와 상담 연결을 담당한다.

**Tech Stack:** React 18, TypeScript, CSS/design tokens, Vitest, Playwright.

**Spec:** 사용자 최신 요청·브라우저 주석, [기존 홈](../../../apps/web/src/features/landing/LandingPage.tsx), [회사 홈페이지 푸터](/Users/kim-jh/Documents/dfkorea-homepage/led-lighting-website/src/components/layout/TheFooter.vue).

## Global Constraints

- 헤더의 `주요 기능`은 `/features`, `요금제`는 `/pricing`으로 이동한다. 두 URL은 직접 진입·새로고침·뒤로가기 시에도 인증 요청 없이 열린다.
- 홈의 승인된 히어로·다섯 장면·상담 팝업은 유지한다. 히어로 둘째 문장은 다음 줄, 상담 버튼의 평상시 테두리는 제거하고 키보드 포커스 표시를 유지한다.
- `/features`는 모니터링·제어·통계(그래프+보고서)·맵 편집의 동작과 구매자 이점을 각각 자세히 설명한다. 각 기능마다 기존 장면 UI를 닮은 추상 화면을 크게 보여주고, 실제 데이터/제어로 오인되지 않게 한다.
- `/pricing`: Basic 월 99,000원(기본 기능·로그 3개월·보고서 월 10회), Plus 월 199,000원(기본 기능·로그 1년·보고서 무제한·AI). 제공/시행이 확인되지 않은 AI와 상품 정책을 현재 가동 중이라고 주장하지 않는다. 부가세·계약 기간은 임의로 확정하지 않는다.
- 상품 선택 상담은 현재 페이지 모달에서 선택 상품을 표시하고 편집 가능한 문의 기본 문장에 담아 기존 API message로 전송한다. 일반 상담은 상품 선택 없이 시작한다. 기존 API/DB 스키마는 변경하지 않는다.
- 공통 헤더·푸터·팝업은 세 페이지에서 같은 구현을 쓴다. 회사 푸터의 전화·팩스·메일·주소·링크는 회사 홈페이지 소스를 따른다.
- `docs/menus/landing.md`와 새 메뉴별 `docs/menus/features.md`, `docs/menus/pricing.md`, 루트 `AGENTS.md` 메뉴 목록, `docs/project-status.md`를 실제 최종 경로에 맞춰 갱신한다.

## Review Focus

- `/features`와 `/pricing`이 AppRoot 인증으로 넘어가 `/api/auth/me`를 호출하지 않아야 한다.
- 로그인 링크 `/login`은 기존 인증 화면을 계속 연다.
- 페이지 간 헤더 이동과 브라우저 뒤로가기/직접 URL 진입에서 기능·요금 콘텐츠와 상담 팝업이 일치해야 한다.
- 좁은 화면(320/390px)에서 헤더, 상세 기능, 요금 카드, 푸터에 가로 넘침이 없어야 한다.
- Basic 상담 뒤 일반 상담 또는 `/#contact`로 열면 이전 상품 선택이 남지 않아야 한다.

---

### Task 1: 공개 레이아웃과 세 경로

**Files:** `apps/web/src/main.tsx`, `apps/web/src/features/landing/LandingPage.tsx`, 새 `PublicSiteLayout.tsx`/페이지 파일, `field-day.css`, 관련 테스트.

- [x] **Step 1:** `/features`·`/pricing` 직접 진입, 헤더 경로, 공개 인증 비호출의 실패 테스트를 작성하고 RED를 확인한다. 기존 경로는 인증 화면으로 연결되어 실패했다.
- [x] **Step 2:** 공통 고정 헤더·회사 푸터·상담 모달을 분리하고 세 경로를 공개 분기에 연결한다. 홈의 기능/요금 섹션은 제거하고 기존 다섯 장면을 보존한다.
- [x] **Step 3:** 히어로 줄바꿈·버튼 테두리 수정, 세 페이지 헤더·로그인/뒤로가기 동작을 브라우저에서 확인한다.

### Task 2: 주요 기능 상세 페이지

**Files:** 새 `FeaturesPage.tsx`, `field-day/FeatureOverview.tsx`와 추상 시각 구성, `field-day.css`, 관련 테스트.

- [x] **Step 1:** 네 기능별 상세 제목·동작 단계·운영 이점·추상 화면 및 그래프/보고서 구분을 검사하는 실패 테스트를 작성한다.
- [x] **Step 2:** `/features`에 각 기능의 큰 독립 구획을 구현한다. 화면 예시, 기능 설명, 현장 운영 이점을 연결하고 확인되지 않은 정량 효과·AI 동작은 주장하지 않는다.
- [x] **Step 3:** 데스크톱·320/390px·키보드·축소 동작·가로 넘침을 검증한다.

### Task 3: 요금제 페이지와 상담 선택 맥락

**Files:** 새 `PricingPage.tsx`, `field-day/PricingSection.tsx`, `InquiryForm.tsx`, 공통 모달, 관련 테스트.

- [x] **Step 1:** 두 가격/항목, Basic·Plus CTA의 선택 상품 표시와 API message, 일반 상담의 빈 문의에 대한 실패 테스트를 작성한다.
- [x] **Step 2:** `/pricing` 비교 화면과 상품 선택 상담을 구현하고 90일 동의/멱등·오류/포커스 계약을 유지한다.
- [x] **Step 3:** 모바일 비교 화면, 직접 진입·뒤로가기, 모의 API 접수, 이전 상품 선택 초기화를 검증한다.

### Task 4: 회사 푸터·문서·최종 확인

**Files:** `field-day/CompanyFooter.tsx`, `field-day.css`, `docs/menus/landing.md`, `docs/menus/features.md`, `docs/menus/pricing.md`, `AGENTS.md`, `docs/project-status.md`.

- [x] **Step 1:** 회사 홈페이지 소스와 푸터 값·링크를 대조하고 세 공개 경로에서 보이는지 검사한다.
- [x] **Step 2:** Web typecheck·unit·build, 관련 Playwright, `git diff --check`, 실제 브라우저의 세 화면을 확인한다. 단위 166파일·2,371개, Chromium 랜딩 31/31 통과했고 세 경로 로컬 HTTP 200 및 브라우저 화면을 확인했다.
- [x] **Step 3:** 기능 현황과 상태판에 랜딩 안내와 실제 상품/AI 집행의 차이, NAVER WORKS 메일 미검증 범위를 기록한다.
