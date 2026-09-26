# 킨다 랜딩 설득력·동작 개편 실행 계획

기준: [개편 설계](../specs/2026-09-26-kinda-landing-conversion-refinement-design.md)

## 파일 책임

- `apps/web/src/features/landing/LandingPage.tsx`: 구매자 중심 이야기, 섹션, 앵커, CTA.
- `apps/web/src/features/landing/DashboardPreview.tsx`: 직접 전환하는 구성 예시와 예시 화면. 실제 API 호출 없음.
- `apps/web/src/features/landing/LandingMotion.tsx` 및 `apps/web/src/features/landing/landing.css`: 공개 랜딩에서만 쓰는 한 번의 등장 동작과 reduced motion 처리. 필요한 경우 하나의 파일로 축소 가능.
- `apps/web/src/features/landing/*.test.tsx`, `apps/web/e2e/landing.spec.ts`: 내용·상태·반응형·접근성 계약.
- `docs/menus/landing.md`: 바뀐 공개 메뉴 기능 현황과 한계.

## 체크리스트

- [x] **1. 설득 구조와 카피.** 기존의 일반적 제목·기능 나열을 `위치 파악 → 제어 → 결과 확인`의 문제/기능/이점 흐름으로 바꾼다. 운영 담당자와 파트너에게 동일한 깊이의 구체적 이점을 제공하고, 상담 전 확인할 항목을 추가한다. 기존 `/login`, `#contact`, 양식은 유지한다. `LandingPage.content.test.tsx`에 구체적 문구와 허위 성과 수치 부재를 검증한다. (`7bc6315b`, 담당 테스트 8/8)
- [x] **2. 예시 대시보드.** 사용자가 지목한 두 상단 문구를 제거한다. 접근 가능한 figure 이름과 예시 데이터 고지는 유지한다. 버튼 세 개로 모니터링/제어/기록의 예시를 전환하고 선택 상태·포커스·본문 동기화를 구현한다. 실제 조명 API와 인증 API 호출이 없어야 한다. 별도 단위 테스트로 세 상태를 검증한다. (`aceb4c8c`, 담당 테스트 4/4)
- [x] **3. 절제된 동작과 반응형.** 첫 화면 순차 등장, 섹션 한 번 등장, 예시 화면 전환을 구현한다. 장식 무한 루프와 자동 재생은 제외한다. `prefers-reduced-motion`에서 동작이 사라지고 콘텐츠는 계속 노출되도록 한다. 기존 320/390/1024/1440px 브라우저 테스트의 가로 넘침, 링크 도달성, 접근성 계약을 유지한다. (`7a62c1a6`, `fa495cfb`; 모션 포함 랜딩 19/19, 정책 61/61, 타입 검사·UI 정책 통과; 브라우저 검증은 Task 4)
- [x] **4. 검증과 문서.** 랜딩 단위 테스트, 웹 타입 검사·빌드, UI 정책, Chromium 랜딩 E2E를 실행한다. `docs/menus/landing.md`를 갱신하고 로그인/문의 API 계약 변경이 없음을 확인했다. 로컬 미리보기와 320·390·1024·1440px 화면을 시각 점검했다. (웹 빌드·UI 정책 통과, Chromium 랜딩 13/13, 전체 웹 단위 테스트 2,377개 통과·3개 건너뜀)

## 완료 기준

사용자가 지목한 두 문구가 화면에 없고, 제품 예시의 세 상태를 직접 전환할 수 있다. 스크롤만 읽어도 두 고객군이 킨다의 실제 기능과 도입 상담의 이유를 이해할 수 있다. 테스트와 4개 폭의 브라우저 검증이 통과하며, 검증되지 않은 성과 주장은 없다.
