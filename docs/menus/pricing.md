# 요금제 페이지 기능 현황

기준일: 2026-09-28

## 구현 완료

- 요금 카드와 상담 버튼을 승인된 유틸리티 및 공통 Card `landingPlan`·`landingPlanFeatured`, Button `landingPlanSecondary`·`landingPlanPrimary`로 전환했다. 프레임·여백·그림자·48px 버튼과 원래 transform hover의 0.2초/ease를 공통 컴포넌트가 소유한다. Basic/Plus 가격·설명과 선택 플랜 문의 전달·포커스 복귀는 유지한다.


- 공통 공개 헤더·회사 푸터·상담 팝업을 승인된 유틸리티와 공통 Button·LinkButton·Card 변형으로 전환했다. 320·390·1024·1440px의 기존 배치·글자·팝업 스크롤/포커스 복귀 및 `/login`의 401 로그인 화면 계산 스타일을 비교했다. 팝업 모서리는 원래 CSS 우선순위로 표시되던14px을 보존한다.

- 공개 `/pricing`을 로그인 없이 직접 열고 새로고침할 수 있다. 공통 고정 헤더, 회사 푸터, 도입 상담 팝업을 사용하고 브라우저 제목은 `요금제 | 킨다`다.
- Basic은 월 99,000원, 기본 기능·로그 3개월 보존·보고서 월 10회 생성을 안내한다. Plus는 월 199,000원, 기본 기능·로그 1년 보존·보고서 무제한 생성·AI 기능 도입 상담 시 안내를 표시한다.
- 각 요금제의 도입 상담 버튼은 선택한 플랜을 팝업에 보여준다. 문의 본문은 편집 가능하며, 제출 시 선택 플랜을 기존 API `message`에 별도 머리말로 합쳐 전달한다. 본문을 완전히 바꾸어도 플랜 맥락이 보존되고 길이·4KB 제한 및 멱등 키는 최종 전송 내용에 적용된다.
- 요금은 월 기준 안내이며 부가세·계약 조건·상품 적용 범위는 상담에서 확인하도록 표시한다. 모바일 가로 넘침, 상담 팝업 포커스 복귀, 제출 payload를 브라우저 테스트로 확인한다.

## 미구현

- 온라인 결제, 계정별 플랜 변경, 실제 과금, 로그 보존·보고서 생성 횟수 제한 집행은 제공하지 않는다.
- Plus의 AI 기능 실제 제공 상태와 일정은 확인되지 않았다. 이 페이지의 문구는 AI가 현재 사용 가능하다는 보증이 아니다.

## 부족하거나 개선이 필요한 기능

- **현재 검증 (2026-09-28)**: 랜딩 정책 전환 Task 1–8의 구현과 작업별 독립 검토를 완료했다. 승인 앵커는 `7b2617b173618d376e7b3a90ec31e1392c3b7bc0`의 375개 역할이며 UI 정책 기존 0/신규 0·정책 65/65다. 부모의 Node 22 기본 root test/lint/typecheck/build를 모두 통과했다(Web 2,577 passed/3 skipped). 최종 124 PNG와 실제 nginx 경로, 관련 Chromium 80/80 및 후속 집중 검사의 증거는 [랜딩 현황](landing.md)에 유지한다. raw axe 장식 결과를 보존하고 정확한 두 역할의 수동 WCAG 분류 후 잔여 0과 구별한다. 최종 전체 브랜치 리뷰의 I1 문서 지적은 `3fe4c3a4` 수정 재검토에서 ADDRESSED이고 새 Critical/Important는 0이다. 전체 검토를 완료했으며 최종 `24be5748`의 개발 기준 fast-forward와 실제 통합 checkout의 Node 22 test/lint/typecheck/build를 완료했다. 로컬 여섯 HTML 경로 200과 홈 렌더링을 확인했다. 실제 장비·메일 수신·배포·모든 브라우저 동일성은 미검증이다.

- **Task 4 완료 시점 이력 (2026-09-28)**: 당시 기능·요금제 소프트웨어 검증은 집중92개, Chromium24개, typecheck/build다. 각 경로의320·390·1024·1440px 원본 기준 PNG52개와 계산 스타일, 3개 경계의 직전/해당/직후9너비를 비교했다. 당시 52개는 이전 승인된 공통 껍질 화면과 pixel-identical이며, 원본 기준38개 동일·14개 차이는 같은 공통 껍질의 색/합성 직렬화 차이로 유지된다. 기능·요금제 대상 선택자와 새 소비자 정책 위반은0개다. 당시 전체 정책은 441건(남은 field-day.css436·공개 CSS import1·데모 raw button3·정적 시안1)으로 실패했으며 Scene·데모·정적 시안 전환은 당시 후속 작업이었다. 실제 장비·메일 수신·배포·모든 브라우저 동일성을 검증한 결과는 아니다. 당시 전체 Web 검증은 Task 3의 2,577개였으며 Task 4에서는 반복 실행하지 않았다.

- 표시 가격의 실제 견적, 계약 단위, 부가세, 제공 조건은 도입 상담에서 확정해야 한다.
- 현재 공통 정적 `index.html`의 설명/공유 메타를 사용하므로 `/pricing` 링크의 검색·공유 미리보기가 홈과 동일할 수 있다. 경로별 서버 HTML 메타 제공은 후속 작업이다.

## 관련 파일

- 화면: [공개 경로](../../apps/web/src/main.tsx), [공통 레이아웃](../../apps/web/src/features/landing/PublicSiteLayout.tsx), [요금제 페이지](../../apps/web/src/features/landing/PricingPage.tsx), [요금 카드](../../apps/web/src/features/landing/field-day/PricingSection.tsx), [상담 양식](../../apps/web/src/features/landing/InquiryForm.tsx), [공통 CSS entry](../../apps/web/src/styles.css), [정본 테마](../../apps/web/src/styles/theme.css), [공통 Card](../../apps/web/src/components/ui/Card.tsx), [공통 Button](../../apps/web/src/components/ui/Button.tsx), [공통 LinkButton](../../apps/web/src/components/ui/LinkButton.tsx)
- 검증: [상담 단위 테스트](../../apps/web/src/features/landing/InquiryForm.test.tsx), [브라우저 테스트](../../apps/web/e2e/landing-field-day.spec.ts)

## 갱신 규칙

- 가격, 플랜 혜택, 상담 흐름, 공개 경로 또는 실제 상품 집행 상태가 바뀌면 이 문서와 [랜딩](landing.md), 영향받는 [운영자 상담](operator.md) 문서를 같은 작업에서 갱신한다.
- 판매 안내와 제품에서 실제 집행되는 기능을 명확히 구분하고 테스트/운영 검증 근거를 기록한다.
