# 주요 기능 페이지 기능 현황

기준일: 2026-10-13

## 구현 완료

- 2026-10-13 실제 공개: 첫 제목의 고정 헤더 간격 및 overview 안내 제거를 r6로 공개했다. 실제637px 제목 여유37px·overview 안내0개, 상세 hash 이동을 확인했다. 정확 소스 `2627a80d`, Public Landing Release unit37/Chromium12 통과. [배포 증거](../assets/landing-mobile-2026-10-13/README.md).

- 2026-10-13 후속 화면 보완: `/features`와 `/pricing`이 공통 `PublicInnerPage`를 사용해 기존 섹션 여백에 디자인 시스템의 40px 보정을 더한다. 고정 헤더 아래 첫 KINDA 문구의 최소 32px 간격과 상세 해시 이동을 보존한다. 기능 요약 하단의 반복 예시 안내 문단을 제거했으며 상세 미리보기 라벨·추정 전력/실측 한계 설명은 유지한다. 공통 상담 팝업은 흰 외곽 프레임/중복 제목을 제거하고 남색 카드 안에 닫기와 요금제 맥락을 표시한다. 화면은 설명용이며 실제 API 조회·조명 제어를 실행하지 않는다.

- 2026-10-13 모바일·이메일 상담·푸터·요금제 안내 보완을 실제 landing-only 운영에 반영했다. 공개 소스 `3222fb34`, release `20261013-landing-ui-r4`의 CI unit37/Chromium12와 회사/CloudFront HTTPS 검증을 통과했다. 실제504px 브라우저에서 새 화면·상담 팝업·요금제 안내·푸터와 메뉴 이동을 확인했다. 자동320/390/504 검증, 실제 이메일 발송/수신·운영 관제/API·장비 검증은 구분한다. [배포 증거](../assets/landing-mobile-2026-10-13/README.md).


- 2026-10-12 공통 회사 푸터에서 회사 소개·제품 소개·인증 현황·회사 소식 목록을 제거했다. 회사 홈페이지 CTA, 회사 정보·전화·팩스·이메일·주소·저작권은 유지한다. 공통 이메일 상담 팝업의 브랜드 카드, 이메일 주소와 CTA, 기존 ModalDialog 포커스 순환·Escape·포커스 복귀를 유지한다. 이번 소스 보완은 실제 이메일 발송이나 API 접수를 뜻하지 않으며 재배포 상태는 운영 검증과 구분한다.

- 2026-10-12 `https://kinda.dfkorealed.com/`의 landing-only 공개 완료. 정확한 커밋 Public Landing Release와 CI proof/로컬 fresh build 해시 검증, 실제 HTTPS·메뉴 이동 검사를 통과했다. `/`, `/features`, `/pricing`만 공개하며 로그인/관제/API는 차단된다. 초기 공개의 상담 팝업은 전화·이메일 방식이었다. 이후 이메일 전용·모바일 UI 보완의 운영 반영 여부는 별도 검증 기록을 따른다.

- 2026-10-11 공개 배포는 단일 `WEB_DEPLOY_MODE=landing|service`와 동일 deploy 명령을 사용한다. 미설정은 landing, 잘못된 값은 오류다. `build:public` → `apps/web/dist-public`에 실제 graph/산출물 검사와 모드·SHA-256 메타데이터를 적용하며 플래그 변경 후 재빌드·재배포해야 한다. 기존 `build:landing`은 독립 로컬 검증용으로 유지한다.
- landing은 `/`, `/features`, `/pricing`만 공개하며 내부 모듈과 API를 제외한다. service는 시안·테스트를 제외한 현재 관제 앱과 기존 인증을 포함한다. 실제 앱의 허용된 중첩 경로는 직접 접속·새로고침을 지원하고 알 수 없는 주소는 두 모드 모두 HTTP 404다.
- 모든 공개 도입 상담 CTA는 브랜드 색상과 공통 Card·LinkButton으로 구성한 이메일 전용 팝업을 연다. 이메일 주소와 `이메일로 상담하기` CTA는 `mailto:kymkjh2002@dfkorealed.com`으로 연결한다. 팝업의 전화 상담은 제거했으며 회사 푸터의 전화 정보는 유지한다. 양식·개인정보 제출·API 접수·접수 완료 표시는 제공하지 않는다. 팝업 닫기와 Escape 후 원래 버튼으로 포커스가 돌아간다.
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

- 2026-10-13 후속 화면의 로컬 검증: 공개 단위 37/37, 기본·외곽 없는 공통 대화상자 42/42, Web typecheck와 fresh landing 빌드, UI 정책 기존/신규 0건, 실제 Chromium 모바일·조작 6/6(실패·제외·재시도 0)을 통과했다. 첫 문구 간격은 320·390·504·637·720·721·768·1440px에서 32px 이상이며 637×1226px의 기존 -3px 겹침은 37px로 수정했다. Basic/Plus 카드 내부 맥락, 남색 표면·외곽 여백/테두리 제거·닫기 아이콘 색상·Tab/Escape/포커스 복귀와 상세 해시 이동을 확인했다. 실제 재배포/HTTPS·메일 발송·장비 검증은 별도 기록을 따른다.

- 2026-10-12 모바일·상담 보완 검증: 실제 정적 public 빌드에서 320/390/504px 간격 RED 3개를 재현한 뒤 시각 경계 32px 이상·푸터 비겹침을 통과했다. 공개 unit 37개, Web 전체 typecheck, UI 정책 기존/신규 0건, release 보고서 계약 9개를 확인했다. 공개 release Chromium은 기존 경로/차단 검사 6개를 유지하고 모바일·터치·키보드·축소 모션·pointer depth·섹션 재진입 6개를 추가해 최종 12/12(실패/제외/재시도 0)로 통과했다. 중간 5/6·11/12 실패와 ripple 이탈 RED는 원시 로그에 보존하며 최종 통과와 구분한다. 실제 재배포/HTTPS·메일 도착/장비 검증을 대신하지 않는다.

- 2026-10-12 사용자가 static landing 공개의 별도 보안·기능·접근 차단 관문을 승인했다. Web 빌드/검증 도구까지 fresh 감사하며 Vite6.4.3/Vitest4.1.11 최소 업데이트와 source/산출물 SHA 검증을 완료했다. 공개37unit·실제 Chromium6·계약29 및 scoped finding0을 보존하며 exact final commit Public Landing Release도 실제 성공했다. 기존 전체 서비스 CI·production audit 기준은 유지한다. ACM 인증서·콘텐츠·`kinda` CNAME·최종 HTTPS 공개 검증까지 완료했다. 실제 접수 API와 로그인/관제 앱은 이번 landing 배포 대상이 아니다.

- 2026-10-11 한정 검증: 공개 모드/배포 Node 계약 17/17, 공개·일반 entry·mobile bootstrap 단위 45/45, Web typecheck, UI 정책 0/0·정책 테스트 79/79, 양 모드 실제 production build가 통과했다. production Chromium은 landing 2/2(서비스 전용 2개 제외), service 4/4로 직접 경로·새로고침·401/403·390px 운영자 로그인/쿠키 mock을 확인했다. 전체 canonical CI·실제 AWS/API·native 앱·HIL 검증 결과는 아니다.

- 배포 모드 전환은 로컬 production 빌드/브라우저와 fake AWS로 준비한 기능이다. landing-only AWS 배포·TLS는 실제 검증했다. Service 전환의 쿠키·운영 API는 미검증이며 공개 HTTPS API origin과 전체 Software CI를 준비해야 한다. service 전환은 인증을 우회하지 않는다. CloudFront 전파 동안 이전 모드가 일부 edge에 남을 수 있으며 이미 받은 JS/세션을 회수하지 않는다. 실패 잠금 복구와 모드별 롤백은 [배포 실행서](../runbooks/kinda-static-landing-aws.md)를 따른다.

- 2026-10-09 정적 배포 검증: 공개 연락·내용·서비스 URL 집중 단위 테스트 36/36, 실제 Rollup 문의 API import 차단을 포함한 정적 계약 6/6, 기본 production Chromium 5/5와 최신 명시 HTTPS 주소 홈의 직접 진입·새로고침·상담 확인 1/1, UI 정책 위반 0/0·정책 단위 67/67, Web typecheck와 일반/정적 build가 통과했다. 시안 전용 레이아웃 추출 후 시안·공개 헤더 반응형 집중 브라우저 14/14도 통과했다. 일반 앱의 기존 브라우저 72개는 첫 실행 실패 범위를 좁혀 재검증했고 모든 시나리오를 통과했다. 전체 Web 단위 첫 실행의 Prisma Client 준비·비동기 지연 실패는 필요한 Client 생성과 해당 App/운영자/편집 활성화 범위 82/82 재검증으로 해소했다. 전체 suite의 동일 시점 재실행 결과가 아닌, 최초 실행과 실패 범위 후속 검증을 취합한 증거다.

- 실제 AWS 공개 배포·도메인/DNS 연결 및 전화/이메일 응답은 별도 운영 검증이 필요하다. 브라우저·정적 HTTP 검증은 실제 하드웨어 검증이 아니다.

- **현재 검증 (2026-09-28)**: 랜딩 정책 전환 Task 1–8의 구현과 작업별 독립 검토를 완료했다. 승인 앵커는 `7b2617b173618d376e7b3a90ec31e1392c3b7bc0`의 375개 역할이며 UI 정책 기존 0/신규 0·정책 65/65다. 부모의 Node 22 기본 root test/lint/typecheck/build를 모두 통과했다(Web 2,577 passed/3 skipped). 최종 124 PNG와 실제 nginx 경로, 관련 Chromium 80/80 및 후속 집중 검사의 증거는 [랜딩 현황](landing.md)에 유지한다. raw axe 장식 결과를 보존하고 정확한 두 역할의 수동 WCAG 분류 후 잔여 0과 구별한다. 최종 전체 브랜치 리뷰의 I1 문서 지적은 `3fe4c3a4` 수정 재검토에서 ADDRESSED이고 새 Critical/Important는 0이다. 전체 검토를 완료했으며 최종 `24be5748`의 개발 기준 fast-forward와 실제 통합 checkout의 Node 22 test/lint/typecheck/build를 완료했다. 로컬 여섯 HTML 경로 200과 홈 렌더링을 확인했다. 실제 장비·메일 수신·배포·모든 브라우저 동일성은 미검증이다.

- **Task 4 완료 시점 이력 (2026-09-28)**: 당시 기능·요금제 소프트웨어 검증은 집중92개, Chromium24개, typecheck/build다. 각 경로의320·390·1024·1440px 원본 기준 PNG52개와 계산 스타일, 3개 경계의 직전/해당/직후9너비를 비교했다. 당시 52개는 이전 승인된 공통 껍질 화면과 pixel-identical이며, 원본 기준38개 동일·14개 차이는 같은 공통 껍질의 색/합성 직렬화 차이로 유지된다. 기능·요금제 대상 선택자와 새 소비자 정책 위반은0개다. 당시 전체 정책은 441건(남은 field-day.css436·공개 CSS import1·데모 raw button3·정적 시안1)으로 실패했으며 Scene·데모·정적 시안 전환은 당시 후속 작업이었다. 실제 장비·메일 수신·배포·모든 브라우저 동일성을 검증한 결과는 아니다. 당시 전체 Web 검증은 Task 3의 2,577개였으며 Task 4에서는 반복 실행하지 않았다.

- 기능 화면과 설명은 제품 이해를 위한 예시다. 현장별 제공 범위와 장비 연결 조건은 도입 상담에서 확인해야 한다.
- 현재 공통 정적 `index.html`의 설명/공유 메타를 사용하므로 `/features` 링크의 검색·공유 미리보기가 홈과 동일할 수 있다. 경로별 서버 HTML 메타 제공은 후속 작업이다.

## 관련 파일

- 2026-10-13 후속 화면 보완: [공개 안쪽 페이지 틀](../../apps/web/src/components/ui/public-site/PublicInnerPage.tsx), [공통 대화상자](../../apps/web/src/components/ui/overlays/DialogBase.tsx), [이메일 상담 카드](../../apps/web/src/components/ui/public-site/ContactEmailCard.tsx), [모바일·팝업 회귀](../../apps/web/e2e/public-mobile-polish.spec.ts)

- 2026-10-12 공통 보완: [이메일 상담 카드](../../apps/web/src/components/ui/public-site/ContactEmailCard.tsx), [인터랙티브 히어로](../../apps/web/src/components/ui/public-site/HeroIllustration.tsx), [모바일·조작 회귀](../../apps/web/e2e/public-mobile-polish.spec.ts), [공개 release 브라우저 관문](../../apps/web/playwright.landing-release.config.ts)

- 모드 배포: [공개 빌드](../../apps/web/vite.public.config.ts), [서비스 entry](../../apps/web/src/service-main.tsx), [모드/경로/산출물 계약](../../apps/web/scripts/public-deploy-contract.mjs), [배포/복구](../../scripts/landing/deploy.mjs), [CloudFront 템플릿](../../scripts/landing/template.mjs), [생산 브라우저 검증](../../apps/web/e2e/public-deploy.spec.ts)

- 정적 배포: [전용 HTML](../../apps/web/landing.html), [전용 entry](../../apps/web/src/landing-main.tsx), [Vite 설정](../../apps/web/vite.landing.config.ts), [그래프/산출물 계약](../../apps/web/scripts/static-landing-contract.mjs), [백엔드 없는 preview](../../apps/web/scripts/serve-static-landing.mjs), [production 브라우저 검증](../../apps/web/e2e/static-landing.spec.ts)
- 공통 공개 UI: [연락처 정본](../../apps/web/src/components/ui/public-site/public-contact.ts), [연락 안내](../../apps/web/src/components/ui/public-site/PublicContactDialog.tsx), [로그인 상태](../../apps/web/src/components/ui/public-site/PublicLogin.tsx), [연락 안내 단위 검증](../../apps/web/src/features/landing/PublicContact.test.tsx)

- 화면: [공개 경로](../../apps/web/src/main.tsx), [공통 레이아웃](../../apps/web/src/features/landing/PublicSiteLayout.tsx), [기능 페이지](../../apps/web/src/features/landing/FeaturesPage.tsx), [기능 설명](../../apps/web/src/features/landing/field-day/FeatureOverview.tsx), [공통 CSS entry](../../apps/web/src/styles.css), [정본 테마](../../apps/web/src/styles/theme.css), [공통 Card](../../apps/web/src/components/ui/Card.tsx), [공통 Button](../../apps/web/src/components/ui/Button.tsx), [공통 LinkButton](../../apps/web/src/components/ui/LinkButton.tsx)
- 검증: [내용 테스트](../../apps/web/src/features/landing/FeaturesPage.content.test.tsx), [브라우저 테스트](../../apps/web/e2e/landing-field-day.spec.ts)

## 갱신 규칙

- 공개 모드, 로그인 활성화, 서비스 route 또는 배포 산출물 계약 변경 시 공개 메뉴 세 문서와 배포 실행서를 함께 갱신한다.

- 기능 설명, 경로, UI 예시 또는 실제 제품 범위가 바뀌면 이 문서와 영향을 받는 [랜딩](landing.md), [모니터링](monitoring.md), [제어](control.md), [통계](statistics.md), [설정](settings.md) 문서를 같은 작업에서 갱신한다.
- 예시 화면과 실제 관제 기능의 차이, 자동 테스트와 실제 현장 검증 여부를 구분해 적는다.
