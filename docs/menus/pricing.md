# 요금제 페이지 기능 현황

## 2026-10-16 공개·복구 표현 정합화 (Task 5)

- 구현 완료: `/pricing`의 가격·준비중·선택plan·브랜드 카드 geometry와 main·landing·service별 기존 로그인 모드를 보존한다. 연락 팝업의 일반 inset만20/16px로 정합화하고 전화/이메일 href·선택 Plus 맥락·양식/API 없는 상담·keyboard/touch 닫기와 포커스 복귀를 유지한다.320px 헤더 상담에서 실제 관측한40.921875px 너비는 공개 레이아웃 caller의 최소44px로 보완했다.
- 구현 완료: main/service 준비·실패는 공통 gap20·inset20/16·status/alert·다시 연결을 소비하고 기존 bootstrap/root 수명을 유지한다. 독립404는 canonical CSS로 JS 없이 HTTP404·제목26/24·본문14px·44px 이상 홈 귀환을 제공한다. landing bundle의 private/auth/API/mobile/concept 배제는 유지한다.
- 미구현: 온라인 결제·요금제 변경·문의 접수 API를 추가하지 않았다. 실제 전화/메일 응답·native WebView·운영 API·배포·장비 검증은 미실행이다.
- 부족하거나 개선이 필요한 기능: 소유15341 실제 main과15342 각 production mode의 Chromium mock 검증으로 한정한다. 기본4viewport와 포함형 공개 경계·실제 CSS 분수430.5/720.5/1050.5, normal/reduced-motion·modal focus를 구별하며, API·외부 write·WebSocket·beacon과 service worker를 차단한다. 실제 과금·계약 적용이나 모든 브라우저 검증으로 확대하지 않는다.
- 검증 주의: 최종 Chromium72PASS/8mode제외, 집중 단위10PASS·타입/빌드/정책0·0이다. 마지막 단독 전체 Web은3924PASS/6FAIL/3SKIP으로 전체 GREEN이 아니다. 이전 관측 ControlView5개 외 CAD 미리보기 `common=true, interruption=principal` 준비 상태1개가 실패했다. CAD85/85·새 bootstrap 동시 cohort87/87에서는 미재현됐으나 원인은 미확정이며 전체 실패를 덮지 않는다.
- 관련 파일: `apps/web/src/features/landing/PublicSiteLayout.tsx`, `apps/web/src/components/ui/public-site/PublicContactDialog.tsx`, `apps/web/src/components/ui/MobilePreparation.tsx`, `apps/web/src/{main,service-main,landing-main}.tsx`, `apps/web/404.html`, `apps/web/e2e/{public-deploy,static-landing}.spec.ts`.
- 갱신 규칙: 공개3page와3entry/mode 검증을 구분하고 랜딩·주요 기능 메뉴와 함께 갱신한다. 요금제 맥락을 온라인 전송/실제 계약 완료로 표시하지 않는다.

## 2026-10-16 공통 오버레이 기반 (Task 2)

- 구현 완료: 공통 modal/drawer 일반 내용 기본 inset20/16px를 적용하고 frame·focus·pending·52px 닫기를 유지했다. 선택 요금제 맥락·기존 tel/mailto 상담과 공개 브랜드는 유지한다.
- 당시 미구현: 요금제 상담 caller의 전용 inset·각 entry 검증은 위 Task5에서 보완했다. 배포는 미실행이다.
- 부족하거나 개선이 필요한 기능: 공통 fixture 통과를 요금제 상담 전체 정합화나 실제 문의 접수/메일 검증으로 확대하지 않는다.
- 관련 파일: `apps/web/src/components/ui/overlays/DialogBase.tsx`, `apps/web/e2e/ui-overlays.spec.ts`.
- 갱신 규칙: 공통 기반과 공개 소비·운영 검증의 완료 범위를 구분한다.

기준일: 2026-10-11

## 구현 완료

- 2026-10-15 소스 수정: Plus 가격은 금액 대신 `준비중`으로 표시하고 월 단위 표시는 숨긴다. Basic은 월 99,000원, Plus의 기능 안내와 도입 상담은 유지한다. 이번 소스 변경의 운영 배포는 별도 확인이 필요하다.

- 2026-10-11 공개 배포는 단일 `WEB_DEPLOY_MODE=landing|service`와 동일 deploy 명령을 사용한다. 미설정은 landing, 잘못된 값은 오류다. `build:public` → `apps/web/dist-public`에 실제 graph/산출물 검사와 모드·SHA-256 메타데이터를 적용하며 플래그 변경 후 재빌드·재배포해야 한다. 기존 `build:landing`은 독립 로컬 검증용으로 유지한다.
- landing은 `/`, `/features`, `/pricing`만 공개하며 내부 모듈과 API를 제외한다. service는 시안·테스트를 제외한 현재 관제 앱과 기존 인증을 포함한다. 실제 앱의 허용된 중첩 경로는 직접 접속·새로고침을 지원하고 알 수 없는 주소는 두 모드 모두 HTTP 404다.
- 모든 공개 도입 상담 CTA는 전화 `032-528-2953`과 이메일 `kymkjh2002@dfkorealed.com`을 제공하는 공통 연락 안내 팝업을 연다. `tel:0325282953`·`mailto:kymkjh2002@dfkorealed.com` 링크이며 양식·개인정보 제출·API 접수·접수 완료 표시는 제공하지 않는다. 팝업 닫기와 Escape 후 원래 버튼으로 포커스가 돌아간다.
- landing 헤더는 기본 native disabled `준비 중`이며 기존 선택적인 HTTPS 외부 로그인 URL 설정도 유지한다. service 헤더는 추가 URL 설정 없이 같은 origin `/login`으로 이동한다. 일반 dev/build 헤더와 관제 진입점의 `/login`, AppRoot 세션·역할·tenant·모바일 bootstrap은 기존 동작을 유지한다.
- 기존 브랜드·장면·반응형·애니메이션·공통 CSS entry/테마/375 역할 정책 앵커는 유지한다. 상담 팝업의 본문은 연락 안내로 변경했다. 아래 2026-09-28 검증 수치는 당시 이력이며 이번 정적 배포 검증을 대신하지 않는다.

- 요금 카드와 상담 버튼을 승인된 유틸리티 및 공통 Card `landingPlan`·`landingPlanFeatured`, Button `landingPlanSecondary`·`landingPlanPrimary`로 전환했다. 프레임·여백·그림자·48px 버튼과 원래 transform hover의 0.2초/ease를 공통 컴포넌트가 소유한다. Basic/Plus 가격·설명과 선택 플랜 문의 전달·포커스 복귀는 유지한다.


- 공통 공개 헤더·회사 푸터·상담 팝업을 승인된 유틸리티와 공통 Button·LinkButton·Card 변형으로 전환했다. 320·390·1024·1440px의 기존 배치·글자·팝업 스크롤/포커스 복귀 및 `/login`의 401 로그인 화면 계산 스타일을 비교했다. 팝업 모서리는 원래 CSS 우선순위로 표시되던14px을 보존한다.

- 공개 `/pricing`을 로그인 없이 직접 열고 새로고침할 수 있다. 공통 고정 헤더, 회사 푸터, 도입 상담 팝업을 사용하고 브라우저 제목은 `요금제 | 킨다`다.
- Basic은 월 99,000원, 기본 기능·로그 3개월 보존·보고서 월 10회 생성을 안내한다. Plus 가격은 `준비중`이며 기본 기능·로그 1년 보존·보고서 무제한 생성·AI 기능 도입 상담 시 안내를 표시한다.
- 각 요금제의 도입 상담 버튼은 선택한 플랜을 팝업에 보여준다. 선택 플랜은 전화·이메일 연락 안내의 맥락이며 온라인 전송은 없다.
- 요금은 월 기준 안내이며 부가세·계약 조건·상품 적용 범위는 상담에서 확인하도록 표시한다. 모바일 가로 넘침, 상담 팝업 포커스 복귀, 연락 링크와 API 비호출을 production 브라우저 테스트로 확인한다.

## 미구현

- 온라인 결제, 계정별 플랜 변경, 실제 과금, 로그 보존·보고서 생성 횟수 제한 집행은 제공하지 않는다.
- Plus의 AI 기능 실제 제공 상태와 일정은 확인되지 않았다. 이 페이지의 문구는 AI가 현재 사용 가능하다는 보증이 아니다.

## 부족하거나 개선이 필요한 기능

- 2026-10-11 한정 검증: 공개 모드/배포 Node 계약 17/17, 공개·일반 entry·mobile bootstrap 단위 45/45, Web typecheck, UI 정책 0/0·정책 테스트 79/79, 양 모드 실제 production build가 통과했다. production Chromium은 landing 2/2(서비스 전용 2개 제외), service 4/4로 직접 경로·새로고침·401/403·390px 운영자 로그인/쿠키 mock을 확인했다. 전체 canonical CI·실제 AWS/API·native 앱·HIL 검증 결과는 아니다.

- 배포 모드 전환은 로컬 production 빌드/브라우저와 fake AWS로 준비한 기능이다. 실제 AWS 배포·TLS·쿠키·운영 API는 미검증이며 최초에 정확한 계정/리소스와 HTTPS API origin을 구성해야 한다. service 전환은 인증을 우회하지 않는다. CloudFront 전파 동안 이전 모드가 일부 edge에 남을 수 있으며 이미 받은 JS/세션을 회수하지 않는다. 실패 잠금 복구와 모드별 롤백은 [배포 실행서](../runbooks/kinda-static-landing-aws.md)를 따른다.

- 2026-10-09 정적 배포 검증: 공개 연락·내용·서비스 URL 집중 단위 테스트 36/36, 실제 Rollup 문의 API import 차단을 포함한 정적 계약 6/6, 기본 production Chromium 5/5와 최신 명시 HTTPS 주소 홈의 직접 진입·새로고침·상담 확인 1/1, UI 정책 위반 0/0·정책 단위 67/67, Web typecheck와 일반/정적 build가 통과했다. 시안 전용 레이아웃 추출 후 시안·공개 헤더 반응형 집중 브라우저 14/14도 통과했다. 일반 앱의 기존 브라우저 72개는 첫 실행 실패 범위를 좁혀 재검증했고 모든 시나리오를 통과했다. 전체 Web 단위 첫 실행의 Prisma Client 준비·비동기 지연 실패는 필요한 Client 생성과 해당 App/운영자/편집 활성화 범위 82/82 재검증으로 해소했다. 전체 suite의 동일 시점 재실행 결과가 아닌, 최초 실행과 실패 범위 후속 검증을 취합한 증거다.

- 실제 AWS 공개 배포·도메인/DNS 연결 및 전화/이메일 응답은 별도 운영 검증이 필요하다. 브라우저·정적 HTTP 검증은 실제 하드웨어 검증이 아니다.

- **현재 검증 (2026-09-28)**: 랜딩 정책 전환 Task 1–8의 구현과 작업별 독립 검토를 완료했다. 승인 앵커는 `7b2617b173618d376e7b3a90ec31e1392c3b7bc0`의 375개 역할이며 UI 정책 기존 0/신규 0·정책 65/65다. 부모의 Node 22 기본 root test/lint/typecheck/build를 모두 통과했다(Web 2,577 passed/3 skipped). 최종 124 PNG와 실제 nginx 경로, 관련 Chromium 80/80 및 후속 집중 검사의 증거는 [랜딩 현황](landing.md)에 유지한다. raw axe 장식 결과를 보존하고 정확한 두 역할의 수동 WCAG 분류 후 잔여 0과 구별한다. 최종 전체 브랜치 리뷰의 I1 문서 지적은 `3fe4c3a4` 수정 재검토에서 ADDRESSED이고 새 Critical/Important는 0이다. 전체 검토를 완료했으며 최종 `24be5748`의 개발 기준 fast-forward와 실제 통합 checkout의 Node 22 test/lint/typecheck/build를 완료했다. 로컬 여섯 HTML 경로 200과 홈 렌더링을 확인했다. 실제 장비·메일 수신·배포·모든 브라우저 동일성은 미검증이다.

- **Task 4 완료 시점 이력 (2026-09-28)**: 당시 기능·요금제 소프트웨어 검증은 집중92개, Chromium24개, typecheck/build다. 각 경로의320·390·1024·1440px 원본 기준 PNG52개와 계산 스타일, 3개 경계의 직전/해당/직후9너비를 비교했다. 당시 52개는 이전 승인된 공통 껍질 화면과 pixel-identical이며, 원본 기준38개 동일·14개 차이는 같은 공통 껍질의 색/합성 직렬화 차이로 유지된다. 기능·요금제 대상 선택자와 새 소비자 정책 위반은0개다. 당시 전체 정책은 441건(남은 field-day.css436·공개 CSS import1·데모 raw button3·정적 시안1)으로 실패했으며 Scene·데모·정적 시안 전환은 당시 후속 작업이었다. 실제 장비·메일 수신·배포·모든 브라우저 동일성을 검증한 결과는 아니다. 당시 전체 Web 검증은 Task 3의 2,577개였으며 Task 4에서는 반복 실행하지 않았다.

- 표시 가격의 실제 견적, 계약 단위, 부가세, 제공 조건은 도입 상담에서 확정해야 한다.
- 현재 공통 정적 `index.html`의 설명/공유 메타를 사용하므로 `/pricing` 링크의 검색·공유 미리보기가 홈과 동일할 수 있다. 경로별 서버 HTML 메타 제공은 후속 작업이다.

## 관련 파일

- 모드 배포: [공개 빌드](../../apps/web/vite.public.config.ts), [서비스 entry](../../apps/web/src/service-main.tsx), [모드/경로/산출물 계약](../../apps/web/scripts/public-deploy-contract.mjs), [배포/복구](../../scripts/landing/deploy.mjs), [CloudFront 템플릿](../../scripts/landing/template.mjs), [생산 브라우저 검증](../../apps/web/e2e/public-deploy.spec.ts)

- 정적 배포: [전용 HTML](../../apps/web/landing.html), [전용 entry](../../apps/web/src/landing-main.tsx), [Vite 설정](../../apps/web/vite.landing.config.ts), [그래프/산출물 계약](../../apps/web/scripts/static-landing-contract.mjs), [백엔드 없는 preview](../../apps/web/scripts/serve-static-landing.mjs), [production 브라우저 검증](../../apps/web/e2e/static-landing.spec.ts)
- 공통 공개 UI: [연락처 정본](../../apps/web/src/components/ui/public-site/public-contact.ts), [연락 안내](../../apps/web/src/components/ui/public-site/PublicContactDialog.tsx), [로그인 상태](../../apps/web/src/components/ui/public-site/PublicLogin.tsx), [연락 안내 단위 검증](../../apps/web/src/features/landing/PublicContact.test.tsx)

- 화면: [공개 경로](../../apps/web/src/main.tsx), [공통 레이아웃](../../apps/web/src/features/landing/PublicSiteLayout.tsx), [요금제 페이지](../../apps/web/src/features/landing/PricingPage.tsx), [요금 카드](../../apps/web/src/features/landing/field-day/PricingSection.tsx), [연락 안내](../../apps/web/src/components/ui/public-site/PublicContactDialog.tsx), [공통 CSS entry](../../apps/web/src/styles.css), [정본 테마](../../apps/web/src/styles/theme.css), [공통 Card](../../apps/web/src/components/ui/Card.tsx), [공통 Button](../../apps/web/src/components/ui/Button.tsx), [공통 LinkButton](../../apps/web/src/components/ui/LinkButton.tsx)
- 검증: [상담 단위 테스트](../../apps/web/src/features/landing/PublicContact.test.tsx), [브라우저 테스트](../../apps/web/e2e/landing-field-day.spec.ts)

## 갱신 규칙

- 공개 모드, 로그인 활성화, 서비스 route 또는 배포 산출물 계약 변경 시 공개 메뉴 세 문서와 배포 실행서를 함께 갱신한다.

- 가격, 플랜 혜택, 상담 흐름, 공개 경로 또는 실제 상품 집행 상태가 바뀌면 이 문서와 [랜딩](landing.md), 영향받는 [운영자 상담](operator.md) 문서를 같은 작업에서 갱신한다.
- 판매 안내와 제품에서 실제 집행되는 기능을 명확히 구분하고 테스트/운영 검증 근거를 기록한다.
