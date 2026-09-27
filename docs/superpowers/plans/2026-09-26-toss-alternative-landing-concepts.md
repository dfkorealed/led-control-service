# 킨다 토스 기반 대안 시안 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 킨다 랜딩과 구조가 다른 독립적인 정적 시안 세 개와 비교 갤러리를 제공한다.

**Architecture:** 각 시안은 `apps/web/public/concepts/`의 독립 HTML로 둔다. 갤러리 역시 같은 폴더에서 링크만 제공한다. 현재 React 랜딩과 문의 API에는 손대지 않는다.

**Tech Stack:** HTML, CSS, SVG, 작은 순수 JavaScript, Vite 정적 파일 서빙.

**Spec:** `docs/superpowers/specs/2026-09-26-toss-alternative-landing-concepts-design.md`

## Global Constraints

- 영상과 외부 이미지·라이브러리 없이 정적 시안으로 제작한다.
- `prefers-reduced-motion`에서 등장 효과를 제거한다.
- 상담 CTA는 `/#contact`로 연결한다.
- 미검증 성과·자동 등록·실측 전력을 주장하지 않는다.
- 기존 `/` 랜딩을 변경하지 않는다.

## Review Focus

- 작은 화면에서 큰 글자와 장식 요소가 가로 넘침을 만들지 않는가.
- 예시 화면·수치가 실제 고객 데이터로 오인되지 않는가.
- 큰 화면의 고정 요소가 모바일에서 본문을 가리지 않는가.
- 모션 없이도 콘텐츠가 보이고 탐색 가능한가.
- 모든 시안에서 상담 링크가 실제 페이지 내 양식으로 이어지는가.

---

### Task 1: 관제실 시안

**Files:**
- Create: `apps/web/public/concepts/control-room.html`

- [x] 남색 몰입형 첫 화면과 큰 도면, 상태 카드를 만든다.
- [x] 뒤따르는 섹션은 수평 흐름과 큼직한 단일 메시지로 구성한다.
- [x] 모바일·축소 동작·상담 링크를 자체 점검한다.

### Task 2: 에디토리얼 시안

**Files:**
- Create: `apps/web/public/concepts/editorial.html`

- [x] 밝은 바탕의 타이포그래피 중심 첫 화면과 전체 폭 제품 장면을 만든다.
- [x] 번호와 선을 활용한 편집형 기능 설명을 구성한다.
- [x] 모바일·축소 동작·상담 링크를 자체 점검한다.

### Task 3: 현장의 하루 시안

**Files:**
- Create: `apps/web/public/concepts/field-day.html`

- [x] 점검·운영·확인의 하루를 세로 타임라인으로 만든다.
- [x] 각 장면에 실제 기능 범위 내 UI 예시를 연결한다.
- [x] 모바일·축소 동작·상담 링크를 자체 점검한다.

### Task 4: 비교 갤러리와 문서

**Files:**
- Create: `apps/web/public/concepts/index.html`
- Modify: `docs/menus/landing.md`

- [x] 기존 시안과 대안 세 개를 목적·분위기·링크로 비교한다.
- [x] 메뉴 문서에 검토용 정적 시안만 추가됐음을 기록한다.
- [x] 세 링크와 로컬 서버의 HTTP 200을 확인한다.

### Task 5: 통합 검토

- [x] 320·390·1440px 가로 넘침과 주요 화면을 확인한다.
- [x] 각 시안의 첫 화면과 본문이 충분히 다른지 확인한다.
- [x] 브라우저에 비교 갤러리를 열어 전달한다.
