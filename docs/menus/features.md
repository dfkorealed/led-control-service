# 주요 기능 페이지 기능 현황

## 2026-10-16 공개·복구 표현 정합화 (Task 5)

- 구현 완료: `/features`를 공유하는 main·landing·service의 기존 브랜드 font·header·카드·anchor100px와 포함형430/720/1050px 경계를 보존한다. 연락 팝업은 공통 regular inset20/16px를 사용하고,320px 헤더 상담의40.921875px 너비는 공개 레이아웃 caller에서 최소44px로 보완했다. 전화·이메일 href, API/양식 없는 상담과 keyboard·touch 닫기·포커스 복귀를 유지한다.
- 구현 완료: main/service의 준비/실패 공통 표현은 gap20·inset20/16·status/alert·다시 연결을 사용하며 bootstrap/root 수명은 유지한다. landing은 private/bootstrap 모듈을 가져오지 않는다. canonical CSS 독립404는 JS 없이 실제 HTTP404·제목26/24·본문14px와44px 이상 귀환을 제공한다.
- 미구현: 실제 native·Safari/WebKit·OS 키보드·운영 API·전화/메일·배포·장비 검증은 이번 범위에서 하지 않았다.
- 부족하거나 개선이 필요한 기능: 소유15341 main과15342 actual production mode의 Chromium mock 검증으로 범위를 제한한다. 실제 CSS 분수430.5/720.5/1050.5와 exact-width media query를 검증하며 API·외부 write·WebSocket·beacon과 service worker를 차단한다. 기능 설명용 UI를 실제 조명 제어 또는 보고서 실행으로 기록하지 않는다.
- 검증 주의: 최종 Chromium72PASS/8mode제외, 집중 단위10PASS·타입/빌드/정책0·0이다. 마지막 단독 전체 Web은3924PASS/6FAIL/3SKIP으로 전체 GREEN이 아니다. 이전 관측 ControlView5개와 추가 CAD 미리보기 `common=true, interruption=principal` 준비 상태1개 실패를 보존한다. CAD85/85·bootstrap 동시 cohort87/87에서 미재현됐으나 원인은 미확정이다.
- 관련 파일: `apps/web/src/features/landing/PublicSiteLayout.tsx`, `apps/web/src/components/ui/public-site/{SiteFrame,PublicContactDialog}.tsx`, `apps/web/src/components/ui/MobilePreparation.tsx`, `apps/web/404.html`, `apps/web/e2e/{public-deploy,static-landing}.spec.ts`.
- 갱신 규칙: 공개3page와3entry를 중복 page로 합산하지 않는다. 일반 연락·복구 역할과 브랜드 구성을 구분하고 랜딩·요금제 현황과 함께 갱신한다.

## 2026-10-16 공통 오버레이 기반 (Task 2)

- 구현 완료: 공통 modal/drawer 일반 내용 기본 inset20/16px를 적용하고 frame·focus·pending·52px 닫기를 유지했다. 공개 브랜드와 기존 상담 의미는 유지한다.
- 당시 미구현: 주요 기능 페이지 caller의 전용 inset·각 entry 검증은 위 Task5에서 보완했다. 배포는 미실행이다.
- 부족하거나 개선이 필요한 기능: 공통 fixture 통과를 주요 기능 페이지의 전체 overlay 완료로 확대하지 않는다.
- 관련 파일: `apps/web/src/components/ui/overlays/DialogBase.tsx`, `apps/web/e2e/ui-overlays.spec.ts`.
- 갱신 규칙: 공통 기반과 공개 소비·운영 검증의 완료 범위를 구분한다.

기준일: 2026-10-11

## 구현 완료

- 2026-10-11 공개 배포는 단일 `WEB_DEPLOY_MODE=landing|service`와 동일 deploy 명령을 사용한다. 미설정은 landing, 잘못된 값은 오류다. `build:public` → `apps/web/dist-public`에 실제 graph/산출물 검사와 모드·SHA-256 메타데이터를 적용하며 플래그 변경 후 재빌드·재배포해야 한다. 기존 `build:landing`은 독립 로컬 검증용으로 유지한다.
- landing은 `/`, `/features`, `/pricing`만 공개하며 내부 모듈과 API를 제외한다. service는 시안·테스트를 제외한 현재 관제 앱과 기존 인증을 포함한다. 실제 앱의 허용된 중첩 경로는 직접 접속·새로고침을 지원하고 알 수 없는 주소는 두 모드 모두 HTTP 404다.
- 모든 공개 도입 상담 CTA는 전화 `032-528-2953`과 이메일 `kymkjh2002@dfkorealed.com`을 제공하는 공통 연락 안내 팝업을 연다. `tel:0325282953`·`mailto:kymkjh2002@dfkorealed.com` 링크이며 양식·개인정보 제출·API 접수·접수 완료 표시는 제공하지 않는다. 팝업 닫기와 Escape 후 원래 버튼으로 포커스가 돌아간다.
- landing 헤더는 기본 native disabled `준비 중`이며 기존 선택적인 HTTPS 외부 로그인 URL 설정도 유지한다. service 헤더는 추가 URL 설정 없이 같은 origin `/login`으로 이동한다. 일반 dev/build 헤더와 관제 진입점의 `/login`, AppRoot 세션·역할·tenant·모바일 bootstrap은 기존 동작을 유지한다.
- 기존 브랜드·장면·반응형·애니메이션·공통 CSS entry/테마/375 역할 정책 앵커는 유지한다. 상담 팝업의 본문은 연락 안내로 변경했다. 아래 2026-09-28 검증 수치는 당시 이력이며 이번 정적 배포 검증을 대신하지 않는다.

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

- 2026-10-11 한정 검증: 공개 모드/배포 Node 계약 17/17, 공개·일반 entry·mobile bootstrap 단위 45/45, Web typecheck, UI 정책 0/0·정책 테스트 79/79, 양 모드 실제 production build가 통과했다. production Chromium은 landing 2/2(서비스 전용 2개 제외), service 4/4로 직접 경로·새로고침·401/403·390px 운영자 로그인/쿠키 mock을 확인했다. 전체 canonical CI·실제 AWS/API·native 앱·HIL 검증 결과는 아니다.

- 배포 모드 전환은 로컬 production 빌드/브라우저와 fake AWS로 준비한 기능이다. 실제 AWS 배포·TLS·쿠키·운영 API는 미검증이며 최초에 정확한 계정/리소스와 HTTPS API origin을 구성해야 한다. service 전환은 인증을 우회하지 않는다. CloudFront 전파 동안 이전 모드가 일부 edge에 남을 수 있으며 이미 받은 JS/세션을 회수하지 않는다. 실패 잠금 복구와 모드별 롤백은 [배포 실행서](../runbooks/kinda-static-landing-aws.md)를 따른다.

- 2026-10-09 정적 배포 검증: 공개 연락·내용·서비스 URL 집중 단위 테스트 36/36, 실제 Rollup 문의 API import 차단을 포함한 정적 계약 6/6, 기본 production Chromium 5/5와 최신 명시 HTTPS 주소 홈의 직접 진입·새로고침·상담 확인 1/1, UI 정책 위반 0/0·정책 단위 67/67, Web typecheck와 일반/정적 build가 통과했다. 시안 전용 레이아웃 추출 후 시안·공개 헤더 반응형 집중 브라우저 14/14도 통과했다. 일반 앱의 기존 브라우저 72개는 첫 실행 실패 범위를 좁혀 재검증했고 모든 시나리오를 통과했다. 전체 Web 단위 첫 실행의 Prisma Client 준비·비동기 지연 실패는 필요한 Client 생성과 해당 App/운영자/편집 활성화 범위 82/82 재검증으로 해소했다. 전체 suite의 동일 시점 재실행 결과가 아닌, 최초 실행과 실패 범위 후속 검증을 취합한 증거다.

- 실제 AWS 공개 배포·도메인/DNS 연결 및 전화/이메일 응답은 별도 운영 검증이 필요하다. 브라우저·정적 HTTP 검증은 실제 하드웨어 검증이 아니다.

- **현재 검증 (2026-09-28)**: 랜딩 정책 전환 Task 1–8의 구현과 작업별 독립 검토를 완료했다. 승인 앵커는 `7b2617b173618d376e7b3a90ec31e1392c3b7bc0`의 375개 역할이며 UI 정책 기존 0/신규 0·정책 65/65다. 부모의 Node 22 기본 root test/lint/typecheck/build를 모두 통과했다(Web 2,577 passed/3 skipped). 최종 124 PNG와 실제 nginx 경로, 관련 Chromium 80/80 및 후속 집중 검사의 증거는 [랜딩 현황](landing.md)에 유지한다. raw axe 장식 결과를 보존하고 정확한 두 역할의 수동 WCAG 분류 후 잔여 0과 구별한다. 최종 전체 브랜치 리뷰의 I1 문서 지적은 `3fe4c3a4` 수정 재검토에서 ADDRESSED이고 새 Critical/Important는 0이다. 전체 검토를 완료했으며 최종 `24be5748`의 개발 기준 fast-forward와 실제 통합 checkout의 Node 22 test/lint/typecheck/build를 완료했다. 로컬 여섯 HTML 경로 200과 홈 렌더링을 확인했다. 실제 장비·메일 수신·배포·모든 브라우저 동일성은 미검증이다.

- **Task 4 완료 시점 이력 (2026-09-28)**: 당시 기능·요금제 소프트웨어 검증은 집중92개, Chromium24개, typecheck/build다. 각 경로의320·390·1024·1440px 원본 기준 PNG52개와 계산 스타일, 3개 경계의 직전/해당/직후9너비를 비교했다. 당시 52개는 이전 승인된 공통 껍질 화면과 pixel-identical이며, 원본 기준38개 동일·14개 차이는 같은 공통 껍질의 색/합성 직렬화 차이로 유지된다. 기능·요금제 대상 선택자와 새 소비자 정책 위반은0개다. 당시 전체 정책은 441건(남은 field-day.css436·공개 CSS import1·데모 raw button3·정적 시안1)으로 실패했으며 Scene·데모·정적 시안 전환은 당시 후속 작업이었다. 실제 장비·메일 수신·배포·모든 브라우저 동일성을 검증한 결과는 아니다. 당시 전체 Web 검증은 Task 3의 2,577개였으며 Task 4에서는 반복 실행하지 않았다.

- 기능 화면과 설명은 제품 이해를 위한 예시다. 현장별 제공 범위와 장비 연결 조건은 도입 상담에서 확인해야 한다.
- 현재 공통 정적 `index.html`의 설명/공유 메타를 사용하므로 `/features` 링크의 검색·공유 미리보기가 홈과 동일할 수 있다. 경로별 서버 HTML 메타 제공은 후속 작업이다.

## 관련 파일

- 모드 배포: [공개 빌드](../../apps/web/vite.public.config.ts), [서비스 entry](../../apps/web/src/service-main.tsx), [모드/경로/산출물 계약](../../apps/web/scripts/public-deploy-contract.mjs), [배포/복구](../../scripts/landing/deploy.mjs), [CloudFront 템플릿](../../scripts/landing/template.mjs), [생산 브라우저 검증](../../apps/web/e2e/public-deploy.spec.ts)

- 정적 배포: [전용 HTML](../../apps/web/landing.html), [전용 entry](../../apps/web/src/landing-main.tsx), [Vite 설정](../../apps/web/vite.landing.config.ts), [그래프/산출물 계약](../../apps/web/scripts/static-landing-contract.mjs), [백엔드 없는 preview](../../apps/web/scripts/serve-static-landing.mjs), [production 브라우저 검증](../../apps/web/e2e/static-landing.spec.ts)
- 공통 공개 UI: [연락처 정본](../../apps/web/src/components/ui/public-site/public-contact.ts), [연락 안내](../../apps/web/src/components/ui/public-site/PublicContactDialog.tsx), [로그인 상태](../../apps/web/src/components/ui/public-site/PublicLogin.tsx), [연락 안내 단위 검증](../../apps/web/src/features/landing/PublicContact.test.tsx)

- 화면: [공개 경로](../../apps/web/src/main.tsx), [공통 레이아웃](../../apps/web/src/features/landing/PublicSiteLayout.tsx), [기능 페이지](../../apps/web/src/features/landing/FeaturesPage.tsx), [기능 설명](../../apps/web/src/features/landing/field-day/FeatureOverview.tsx), [공통 CSS entry](../../apps/web/src/styles.css), [정본 테마](../../apps/web/src/styles/theme.css), [공통 Card](../../apps/web/src/components/ui/Card.tsx), [공통 Button](../../apps/web/src/components/ui/Button.tsx), [공통 LinkButton](../../apps/web/src/components/ui/LinkButton.tsx)
- 검증: [내용 테스트](../../apps/web/src/features/landing/FeaturesPage.content.test.tsx), [브라우저 테스트](../../apps/web/e2e/landing-field-day.spec.ts)

## 갱신 규칙

- 공개 모드, 로그인 활성화, 서비스 route 또는 배포 산출물 계약 변경 시 공개 메뉴 세 문서와 배포 실행서를 함께 갱신한다.

- 기능 설명, 경로, UI 예시 또는 실제 제품 범위가 바뀌면 이 문서와 영향을 받는 [랜딩](landing.md), [모니터링](monitoring.md), [제어](control.md), [통계](statistics.md), [설정](settings.md) 문서를 같은 작업에서 갱신한다.
- 예시 화면과 실제 관제 기능의 차이, 자동 테스트와 실제 현장 검증 여부를 구분해 적는다.
