# 랜딩 기능 소개·요금제·회사 푸터 Implementation Plan

> 사용자가 2026-09-27에 기능·요금제를 각각 별도 페이지로 바꾸고 기능 상세 설명을 요청했다. 이 계획의 같은 페이지 섹션 전제는 [공개 제품 페이지 개정 계획](2026-09-27-public-product-pages.md)으로 대체한다. 체크된 항목은 개정 전 중간 구현 기록이며 최종 완료 상태가 아니다.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 `현장의 하루` 랜딩에 구매 결정에 필요한 기능 요약과 Basic/Plus 요금제, 검증된 회사 정보를 더하고 사용자의 화면 주석을 반영한다.

**Architecture:** 공개 `/`의 기존 다섯 장면은 유지한다. 고정 헤더의 `주요 기능`·`요금제` 메뉴는 같은 페이지의 새 섹션으로 이동한다. 기능 요약, 요금 카드, 회사 푸터는 랜딩 전용 컴포넌트로 분리하고 공통 Button/Card를 재사용한다. 요금제는 공개 안내와 기존 상담 팝업 연결이며 실제 과금·계정별 제한을 바꾸지 않는다.

**Tech Stack:** React 18, TypeScript, CSS/design tokens, Vitest, Playwright.

**Spec:** 이번 사용자 요청·브라우저 주석, [현재 랜딩](../../../apps/web/src/features/landing/LandingPage.tsx), [회사 홈페이지 푸터](/Users/kim-jh/Documents/dfkorea-homepage/led-lighting-website/src/components/layout/TheFooter.vue).

## Global Constraints

- 가격은 Basic 월 99,000원, Plus 월 199,000원으로 표시한다. 부가세 포함 여부·계약 단위는 확인되지 않았으므로 임의로 확정하지 않는다.
- Basic: 모든 기본 기능, 로그 3개월 보존, 보고서 월 10회 생성. Plus: 모든 기본 기능, 로그 1년 보존, 보고서 무제한 생성, AI 기능.
- 현재 제품에 계정별 상품·과금·한도 집행 및 AI 기능이 구현되었다고 주장하지 않는다. 가격 섹션은 상담 안내로 제공하고 AI는 제공 상태 확인 전 `도입 상담 시 안내` 등 신중한 문구를 쓴다.
- 기존 문의 팝업·메일 API 계약과 실제 제품 화면의 예시/실데이터 구분을 유지한다.
- 회사 연락처·주소는 회사 홈페이지의 `TheFooter.vue`를 출처로 삼고, 회사 홈페이지로 이동하는 외부 링크는 정확한 도메인을 쓴다.
- 기존 페이지/다른 메뉴/DB 스키마는 변경하지 않는다. `docs/menus/landing.md`와 `docs/project-status.md`를 갱신한다.

## Review Focus

- 헤더 고정 상태에서 해시 이동 시 새 섹션 제목이 가려지지 않아야 한다.
- 320/390px에서 새 메뉴와 요금 카드가 가로로 넘치지 않아야 한다.
- 상담 CTA는 가격 카드에서도 현재 페이지 팝업을 열고 닫을 때 포커스가 복귀해야 한다.
- 카드의 AI·보존 기간은 계약 안내로 읽히고, 현재 제품에 적용된 제한처럼 오인되지 않아야 한다.
- Basic/Plus 상담 버튼으로 팝업을 열면 선택한 요금제가 팝업과 전송 내용에 남아야 한다.
- `prefers-reduced-motion`에서 기능 요약 시각 효과가 정보 접근을 막지 않아야 한다.

---

### Task 1: 주석의 세 수정과 헤더 내비게이션

**Files:** `apps/web/src/features/landing/LandingPage.tsx`, `field-day.css`, 관련 테스트.

- [x] **Step 1:** 히어로 보조 문장 줄바꿈, 상담 버튼 장식 제거, 고정 헤더의 주요 기능/요금제 해시 링크에 대한 실패 테스트를 만든다.
- [x] **Step 2:** 문장 두 번째 문장을 새 줄에서 시작하게 하고, 버튼의 불필요한 평상시 테두리를 없애되 키보드 포커스 표시를 유지한다.
- [ ] **Step 3:** 새 섹션 내비게이션과 모바일 헤더를 구현하고 320/390px 및 스크롤 앵커를 확인한다.

### Task 2: 네 가지 주요 기능 소개

**Files:** `apps/web/src/features/landing/field-day/FeatureOverview.tsx` 등, `field-day.css`, 관련 테스트.

- [x] **Step 1:** 모니터링·제어·통계·맵 편집의 제목, 구매자 관점 장점, 각 기존 장면으로 가는 링크를 검사하는 실패 테스트를 만든다.
- [x] **Step 2:** 각 기능을 기존 예시 UI와 시각 언어가 이어지는 추상적 미리보기로 표현한다. 정량 성능·실시간/AI 결과 등 확인되지 않은 주장은 넣지 않는다.
- [ ] **Step 3:** 키보드·모바일·축소 동작·가로 넘침을 검증한다.

### Task 3: Basic/Plus 요금 안내

**Files:** `apps/web/src/features/landing/field-day/PricingSection.tsx` 등, `field-day.css`, 관련 테스트.

- [x] **Step 1:** 두 가격과 정확한 포함 항목, 상담 팝업 CTA를 검증하는 실패 테스트를 만든다.
- [x] **Step 2:** 두 카드 비교와 상담 연결을 구현한다. 가격은 월 기준으로 표시하고 미정인 세금·계약/정책 시행을 단정하지 않는다.
- [ ] **Step 3:** Basic/Plus 선택을 팝업에 표시하고 편집 가능한 문의 기본 문장으로 전달한다. 일반 상담은 빈 문의로 시작한다.
- [ ] **Step 4:** 320/390px 카드와 팝업 연결·요금제 전달, 앵커 도달을 브라우저에서 검증한다.

### Task 4: 회사 푸터와 기록·최종 검증

**Files:** `apps/web/src/features/landing/field-day/CompanyFooter.tsx` 등, `field-day.css`, `docs/menus/landing.md`, `docs/project-status.md`.

- [x] **Step 1:** (주)디에프코리아, 전화·팩스·메일·주소, 회사/제품 링크를 회사 홈페이지 소스와 대조하는 테스트를 만든다.
- [x] **Step 2:** 랜딩 톤에 맞는 반응형 푸터를 컴포넌트로 적용하고 기존 하단 고지를 보존한다.
- [ ] **Step 3:** Web typecheck·unit·build, 랜딩 Playwright, `git diff --check`, 실제 브라우저 화면을 확인하고 문서/체크리스트를 갱신한다.
