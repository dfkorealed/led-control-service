# 주요 기능 페이지 기능 현황

기준일: 2026-09-28

## 구현 완료

- 기능 요약·상세 구획과 기존 장식 DOM을 승인된 유틸리티로 전환했다. 공통 Card의 `landingFeature`가 카드 프레임·격자·여백·그림자를 소유하며 18px 미리보기 창, 확대 화면, 세 단계 번호와 100px 앵커 여백을 보존한다. 작은 카드·확대 상세에 재사용하는 모니터링/맵 편집 격자는 검토된 background-image 토큰을 사용한다.


- 공통 공개 헤더·회사 푸터·상담 팝업을 승인된 유틸리티와 공통 Button·LinkButton·Card 변형으로 전환했다. 320·390·1024·1440px의 기존 배치·글자·팝업 스크롤/포커스 복귀 및 `/login`의 401 로그인 화면 계산 스타일을 비교했다. 팝업 모서리는 원래 CSS 우선순위로 표시되던14px을 보존한다.

- 공개 `/features`를 로그인 없이 직접 열고 새로고침할 수 있다. 공통 고정 헤더, 회사 푸터, 도입 상담 팝업을 사용하고 브라우저 제목은 `주요 기능 | 킨다`다.
- 모니터링, 제어, 통계, 맵 편집을 각각 독립된 큰 구획으로 설명한다. 각 기능에 실제 제품 사용 순서를 바탕으로 한 3단계 흐름, 운영 이점, 추상 UI 예시, 홈의 해당 관제 장면 링크가 있다.
- 모니터링은 층·구역 선택, 도면의 조명 위치, 연결·최근 확인 상태를 안내한다. 제어는 개별·그룹 점등/밝기와 반복 일정 흐름을 안내한다.
- 통계는 상태 기반 **추정** 전력 그래프와 PDF 보고서 요청 및 생성 이력을 함께 안내한다. CSV 원본 내보내기는 보고서와 별도 기능이다. 맵 편집은 CAD 후보 검토, 도형·조명 위치 조정, 운영자 확인 후 저장을 안내한다.
- 요약 카드의 자세히 보기 링크는 페이지 내부 상세 구획으로 이동한다. 직접 해시 진입 시에도 고정 헤더 아래 상세 구획을 볼 수 있다. 모바일 가로 넘침과 기본 접근성을 브라우저 테스트로 확인한다.

## 미구현

- 페이지의 추상 UI는 실제 현장 데이터 조회·조명 제어·보고서 생성·맵 저장 기능을 실행하지 않는다. 실제 기능은 로그인 후 관제 화면에서 사용한다.
- CAD 후보를 통한 자동 조명 등록, 실측 전력 표시, 절감률 보장은 제공하지 않는다.

## 부족하거나 개선이 필요한 기능

- **현재 검증 (2026-09-28)**: 랜딩 정책 전환 Task 1–8의 구현과 작업별 독립 검토를 완료했다. 승인 앵커는 `7b2617b173618d376e7b3a90ec31e1392c3b7bc0`의 375개 역할이며 UI 정책 기존 0/신규 0·정책 65/65다. 부모의 Node 22 기본 root test/lint/typecheck/build를 모두 통과했다(Web 2,577 passed/3 skipped). 최종 124 PNG와 실제 nginx 경로, 관련 Chromium 80/80 및 후속 집중 검사의 증거는 [랜딩 현황](landing.md)에 유지한다. raw axe 장식 결과를 보존하고 정확한 두 역할의 수동 WCAG 분류 후 잔여 0과 구별한다. 최종 전체 브랜치 리뷰의 I1 문서 지적은 `3fe4c3a4` 수정 재검토에서 ADDRESSED이고 새 Critical/Important는 0이다. 전체 검토를 완료했으며 최종 `24be5748`의 개발 기준 fast-forward와 실제 통합 checkout의 Node 22 test/lint/typecheck/build를 완료했다. 로컬 여섯 HTML 경로 200과 홈 렌더링을 확인했다. 실제 장비·메일 수신·배포·모든 브라우저 동일성은 미검증이다.

- **Task 4 완료 시점 이력 (2026-09-28)**: 당시 기능·요금제 소프트웨어 검증은 집중92개, Chromium24개, typecheck/build다. 각 경로의320·390·1024·1440px 원본 기준 PNG52개와 계산 스타일, 3개 경계의 직전/해당/직후9너비를 비교했다. 당시 52개는 이전 승인된 공통 껍질 화면과 pixel-identical이며, 원본 기준38개 동일·14개 차이는 같은 공통 껍질의 색/합성 직렬화 차이로 유지된다. 기능·요금제 대상 선택자와 새 소비자 정책 위반은0개다. 당시 전체 정책은 441건(남은 field-day.css436·공개 CSS import1·데모 raw button3·정적 시안1)으로 실패했으며 Scene·데모·정적 시안 전환은 당시 후속 작업이었다. 실제 장비·메일 수신·배포·모든 브라우저 동일성을 검증한 결과는 아니다. 당시 전체 Web 검증은 Task 3의 2,577개였으며 Task 4에서는 반복 실행하지 않았다.

- 기능 화면과 설명은 제품 이해를 위한 예시다. 현장별 제공 범위와 장비 연결 조건은 도입 상담에서 확인해야 한다.
- 현재 공통 정적 `index.html`의 설명/공유 메타를 사용하므로 `/features` 링크의 검색·공유 미리보기가 홈과 동일할 수 있다. 경로별 서버 HTML 메타 제공은 후속 작업이다.

## 관련 파일

- 화면: [공개 경로](../../apps/web/src/main.tsx), [공통 레이아웃](../../apps/web/src/features/landing/PublicSiteLayout.tsx), [기능 페이지](../../apps/web/src/features/landing/FeaturesPage.tsx), [기능 설명](../../apps/web/src/features/landing/field-day/FeatureOverview.tsx), [공통 CSS entry](../../apps/web/src/styles.css), [정본 테마](../../apps/web/src/styles/theme.css), [공통 Card](../../apps/web/src/components/ui/Card.tsx), [공통 Button](../../apps/web/src/components/ui/Button.tsx), [공통 LinkButton](../../apps/web/src/components/ui/LinkButton.tsx)
- 검증: [내용 테스트](../../apps/web/src/features/landing/FeaturesPage.content.test.tsx), [브라우저 테스트](../../apps/web/e2e/landing-field-day.spec.ts)

## 갱신 규칙

- 기능 설명, 경로, UI 예시 또는 실제 제품 범위가 바뀌면 이 문서와 영향을 받는 [랜딩](landing.md), [모니터링](monitoring.md), [제어](control.md), [통계](statistics.md), [설정](settings.md) 문서를 같은 작업에서 갱신한다.
- 예시 화면과 실제 관제 기능의 차이, 자동 테스트와 실제 현장 검증 여부를 구분해 적는다.
