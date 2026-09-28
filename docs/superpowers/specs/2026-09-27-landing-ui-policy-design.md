# 랜딩 UI 정책 0건 전환 설계 명세

기준: `6c61995099db7329adaf5910aac323b03fa331de`의 React 공개 페이지와 보관용 정적 시안. 사용자가 선택한 **필요한 의미 기반 토큰만 추가**하는 방향을 구현 전에 검토하기 위한 문서다. 이 문서 작성만으로 정책·토큰·화면 코드를 변경하거나 구현을 승인한 것으로 보지 않는다. 기존 실행 이력과 수치는 [랜딩 UI 정책 실행 계획](../plans/2026-09-27-landing-ui-policy-zero.md), 현재 파일 기준은 `apps/web/src/features/landing/field-day.css`, `apps/web/public/concepts/field-day.*`, `apps/web/scripts/ui-policy.mjs`, `apps/web/src/styles/theme.css`다.

## 1. 보존 계약과 판정 기준

| 너비 | 현재 외형 계약 | 동작 계약 |
| --- | --- | --- |
| 320px | 가로 넘침 없이 15px 양쪽 컨테이너 여백, 모바일 헤더 배치, 760px 최소 높이 히어로, 한 열 장면·데모, 작은 카드에서 보조 글자 숨김 | 헤더·상담·로그인·장면 링크의 터치와 키보드 접근, 팝업 내부 끝까지 스크롤 |
| 390px | `max-width:430px`와 `max-width:720px` 규칙이 함께 적용된 모바일 배치, 히어로 아트와 한 열 장면 유지 | 조명 선택, 밝기 조절, 보고서 형식, 맵 배치·취소, 상담 제출·오류·재시도 |
| 1024px | `max-width:1050px`에서 장면 본문과 데모가 세로로 쌓이고, `max-width:720px`은 적용되지 않음 | 장면 재생·스크롤 복귀·상담 포커스 복귀 |
| 1440px | 1180px 상한 컨테이너, 히어로와 장면의 두 열 배치, 고정 헤더, 다섯 장면과 닫는 CTA·푸터 | 시안 조작 및 `/features`, `/pricing`, `/login` 이동, 상담 팝업 유지 |

React `/`, `/features`, `/pricing`의 글자·색·크기·줄바꿈·간격·그림자·경계·쌓임·반응형 전환을 현재의 비교 기준으로 삼는다. 시안 `/concepts/field-day.html`은 적용 전 독립 기록이어서 React와 원래부터 다른 제목 크기(`clamp(55px, 6.7vw, 100px)` 대 `clamp(55px, 5.3vw, 78px)`), 상담 버튼 밑줄 등 차이가 있다. **각 화면을 자기 자신의 기준 이미지 및 동작과 비교**한다. 둘을 한 화면으로 합치며 기존 차이를 임의로 지우지 않는다. 현재 4너비 PNG의 바이트 일치는 ref 전용 변경에 대한 증거일 뿐 이후 스타일 이전의 픽셀 동일성을 보증하지 않는다. 폰트 렌더링, `svh`, 가변 글자 크기, 애니메이션 프레임과 브라우저 차이는 실측 후 판정한다.

공개 페이지는 인증 조회 없이 열리고, 데모는 예시 데이터이며 실제 조명 명령을 내리지 않는다. 상담은 기존 `InquiryForm`·API 계약, 접수 중 닫기 제한, 실패 시 동일 문의 키 재시도, 503 이메일 경로, 포커스 복귀를 유지한다. 정적 시안도 기존 독립 상담 흐름을 유지하거나 동등한 React 구현으로 이전해야 한다. `/concepts/index.html`의 현장의 하루 링크, `/concepts/field-day.html` 직접 접근·새로고침·뒤로 가기, 상대/절대 자산 URL을 계약에 포함한다.

## Task 8 사용자 승인과 접근성 판정 보완 (2026-09-28)

사용자가 ‘오케이’로 승인한 외형 변경은 다음 **두 foreground 역할의 글자색**이다. React 공개 화면과 공유 보관 시안에 함께 적용한다. 기존 미승인 제안/철회 기록은 승인 전 이력이며 현재 승인과 구별한다.

| 실제 텍스트 소유자 | 원래 foreground / 실제 배경 / 대비 | 승인 foreground / 대비 |
| --- | --- | --- |
| `Scene.tsx` 공통 `DemoCard`의 다섯 `.demo-disclaimer` 하단 안내 | `text-content-secondary` (`#64748b`) / `#f1f5f9` / 4.3439:1 | 기존 `text-content-primary` (`#15324a`) / 12.0787:1 |
| `MapDemo.tsx` `.map-save`의 ‘배치 검토 → 저장’ | `text-brand-blue` (`#256fa1`) / `#dbe7f5` / 4.3343:1 | 기존 `text-content-primary` (`#15324a`) / 10.5613:1 |

원본 axe 4.13.0은 pseudo 배경 때문에 일부 실제 읽는 문구를 `INCOMPLETE`로 남겼다. 승인 변경은 위 두 역할의 glyph 색 차이로 별도 분류한다. 배경·다른 색·배치·폰트·문구·기능·ARIA·테마·정책 예외는 바꾸지 않는다. 원본 124 PNG/manifest는 불변으로 유지한다.

부모의 별도 기술 판정은 [W3C SC 1.4.3의 incidental 조항](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)에 따른 **테스트 분류**만 승인했다. 전체 raw axe 결과를 보존하고 고정 `.scene-watermark`는 순수 장식, `.control-visual__caption`는 실제 lamp/glow/beam/floor 그림에 부수적인 글자로 구분한다. 기존 숨김 소유만으로 예외를 인정하지 않으며 정확한 DOM/문구/그림/위치/대응 제목과 실제 조작 UI/비상호작용 조건을 검사한다. 읽는 안내·맵 힌트와 다른 serious/critical는 계속 실패한다. 규칙 비활성화·subtree 제외·임계 변경이나 제품 DOM/ARIA 변경은 없다.

제어 그림은 pendant **하나**이고 caption의 ‘4개’가 별도 조작 UI에 그대로 중복되지는 않는다. 그룹 명칭은 toolbar/‘출입구 그룹 밝기’ 슬라이더에 대응하지만 숫자 중복이나 네 개 조명 그림을 주장하지 않는다. 이 고정 그림 caption의 incidental 판정과 보존 조건은 독립 검토 대상이다. 실제 raw 장식 실패와 분류 후 잔여 0을 구분하며 ‘raw axe 0’으로 기록하지 않는다. 독립 리뷰의 완전 clip/React 위임 이벤트 지적은 테스트에서 원래 beam polygon·실제 그림 교차/기하와 정확한 장식 JSX·소유 조상 event props/spreads 검사로 보완했다. 기존 Card의 rest forwarding은 DemoCard 명시 props와 정확한 직접 전달 소스 계약으로 한정하며 조작 버튼 형제의 이벤트를 금지하지 않는다. 새 124 화면의 두 글자색 차이와 잔여는 동일 소스 전체 화면·crop 반복 및 그림자 인과로 분류했고 부모 Node 22 전체 관문은 통과했다. 후속 테스트 보완의 독립 재검토·전체 브랜치 리뷰는 남아 있으며 최종 보고서를 따른다.

## 2. 필요한 토큰의 좁은 승인 후보

현 테마의 브랜드·표면·본문·상태 색은 이미 다수의 `--navy`, `--blue`, `--panel` 별칭에 대응한다. 같은 숫자라는 이유만으로 새 토큰을 만들지 않는다. 아래 횟수는 **현재 활성 CSS의 선언 또는 사용 횟수**이고, 정적 CSS나 TSX의 추가 사용은 별도로 적었다. 먼저 값·역할·재사용 범위를 정하고, 해당 역할이 실제 컴포넌트에 모였을 때만 추가한다.

| 승인 후보 | 정확한 현재 값 | 사용처·현재 반복 | 중복 제거 판단 |
| --- | --- | --- | --- |
| `--text-landing-hero-fluid` | `clamp(55px, 5.3vw, 78px)` | React `.hero h1` 1규칙 | 다른 제목과 공유하지 않는다. 기존 `--text-landing-hero: 4rem`은 별도 역할이므로 덮어쓰지 않는다. 필요 시 제목의 `line-height: 1.15`·`letter-spacing: -.085em`도 **한 역할의 동반 속성**으로 검토한다. |
| `--text-landing-eyebrow` | `13px` | `.eyebrow` 1규칙, CSS의 `font-size: 13px` 전체 7회 | 7회 모두 같은 의미가 아니다. 장면 작은 머리글에만 우선 적용하고, 탐색·카드·푸터는 현재 토큰 또는 별도 역할 적합성을 확인한다. |
| `--radius-landing-glass-panel` | `18px` | 히어로 아트 패널 1규칙, 기능 미리보기 1규칙 | 공통 유리/미리보기 카드 역할이 합의될 때만 공유한다. 상담 팝업의 TSX `rounded-[18px]!` 1회까지 무조건 묶지 않는다. 팝업은 공통 `ModalDialog` 크기·반경 계약을 먼저 확인한다. |
| `--shadow-landing-demo-card` | `0 18px 55px rgb(21 50 74 / .10)` | `.field-day` 선언 1회, `.demo-card` 사용 1회 | 다섯 데모가 같은 `DemoCard`를 재사용하는 단일 역할이다. 기존 `--shadow-panel`의 다른 값으로 근사하지 않는다. |
| 좁음·쌓임·넓음 화면 전환 | 원래 `max-width: 430px`, `720px`, `1050px` | 각 미디어 블록 1개, 블록 안 다수 규칙 | 세 전환을 재사용 가능한 이름으로 승인하되 **Tailwind `max-*`의 경계 의미를 별도 검토**한다. 단순 `430px`·`720px`·`1050px` 토큰 추가만으로 포함 경계가 보존되지는 않는다. |

정적 시안의 히어로 `clamp(55px, 6.7vw, 100px)`은 React 히어로와 다른 역할/값으로 유지한다. `field-day.css`의 font-size 표현 36종, 줄 간격 14종, 자간 20종, 반경 23종, 그림자 20종과 승인 간격 단계 밖 픽셀 수치 57종·175회는 **전수 분류 대상**이다. 표의 대표 후보만 승인해도 0건이 되지 않는다. 이 모두를 토큰 1개씩으로 치환하는 안도 채택하지 않는다. 같은 시각 역할이 반복되는 값은 기존 토큰 또는 위 후보에 합치고, 데모 기하·일회성 장식 치수는 값 변경 없이 허용 가능한 Tailwind 크기/위치 유틸리티로 옮길 수 있는지 검사한다. 정확한 간격·서체 값이 정책상 표현 불가하면 독립된 의미와 재사용 근거를 적어 **추가 승인 관문**으로 올리거나, 화면 차이를 명시해 재승인받는다. 허용되지 않은 임의 간격·글자·색·반경 유틸리티로 밀어 넣지 않는다.

## 3. 정책 의미를 보존하는 정식 승인 경로

현 스캐너는 정본 `src/styles/theme.css`의 정확히 하나인 `@theme static`과 **승인 Git 객체**의 이름→값을 비교한다. `approvedSourceRef`는 현재 `24b5ea593e860575f7bf1007781146cf1101beb7`이고 `ui-policy-baseline.json`의 `sourceRef`와 같아야 하며 `files`는 `{}`여야 한다. 따라서 테마에 선언만 추가하면 `unapproved-theme-token`으로 실패한다. `reviewedThemeTokenAdditions`에 임시 항목을 넣는 것은 기존 예외 목록을 늘리는 방식이므로 새 토큰의 정식 장기 승인 경로로 쓰지 않는다.

1. 디자이너가 역할·정확 값·사용 위치·반복 횟수·기존 토큰과의 차이를 표로 제출하고 총괄·웹 소유 역할이 승인한다. 필요한 토큰만 `theme.css`의 `@theme static`에 넣어 **토큰 전용 검토 커밋**을 만든다.
2. 그 커밋을 기준으로 `ui-policy.mjs`의 `approvedSourceRef`와 빈 baseline의 `sourceRef`를 함께 갱신한다. 스캐너는 계속 승인 Git 객체를 읽고 이름·값·중복·누락을 검증한다. 같은 ref를 하드코딩한 `apps/web/scripts/ui-policy.test.mjs`의 fixture도 갱신하고 `docs/ui-spacing.md`의 정본·역할 표를 갱신한다. 승인 Git 객체가 CI의 전체 이력 checkout에서 확보되는지도 확인한다.
3. 반응형 이름을 새로 쓰면 스캐너의 승인된 반응형 접두사 집합만 그 이름으로 확장하고, 임의 `max-[777px]` 거부 테스트를 유지한다. 정확한 포함 경계용 `@custom-variant`를 택한다면 정본 `src/styles.css`에 승인된 세 선언만 두고 스캐너·테스트에 이름과 미디어 값을 고정한다. 새 `@utility`, 별도 CSS 진입점, 공개 CSS, 광범위 예외는 허용하지 않는다.
4. 토큰/정책 커밋 검증 후 React·정적 경로를 옮긴다. 마지막에 `ui:check` **0/0**, `test:ui-policy` 통과와 빈 baseline을 확인한다. 정책 파일이나 baseline을 단순히 수정해 위반 수를 낮추는 것은 통과로 보지 않는다.

정확한 경계는 별도 결정이 필요하다. 원래 `@media (max-width:430px)`는 430px을 포함하지만 Tailwind의 보통 `max-landing-narrow:`는 `not all and (min-width: 430px)` 형태로 430px을 제외한다. 720·1050px도 같다. 권장 경로는 **정식 검토된 포함형 custom variant**(`@media (max-width: 430px)` 등)를 정본에 만들고 네이티브 규칙과 같은 경계인지 컴파일 CSS로 확인하는 것이다. 대안인 다음 정수 폭 431·721·1051px의 named `max-*`는 정수 CSS 픽셀 테스트에서는 같아도 430~431px 사이의 분수 폭에서 다르므로 완전 동치로 간주하지 않는다. 최소한 429/430/431, 719/720/721, 1049/1050/1051px에서 경계 양쪽을 검증한다.

## 4. 선택자·상태·미디어·애니메이션 대응

`field-day.css`의 919건은 CSS 파일 자체 1, 일반 선택자 481, 간격 237, 서체 164, 원시 색상 32, 폼 선택자 4건이다. 스캐너는 임의 CSS 파일과 일반 선택자를 금지하며 `base.css`의 극히 일부 전역 선택자만 허용한다. 그러므로 토큰만 늘려도 481 선택자와 파일·폼 규칙은 남는다. 현재 TSX/정적 경로를 합친 전체 925건의 나머지 6건은 `PublicSiteLayout.tsx` CSS import 1·임의 18px 반경 1, 데모 컴포넌트의 직접 폼 스타일 3, `public/concepts/field-day.css` 자체 1이다. 이 수치는 이 커밋에서 `inspectWorkspace`로 재확인한 결과다.

| 현재 표현 | 옮길 구조 |
| --- | --- |
| `.field-day` 및 `@scope`, `.scene--*`, `.is-scrolled`, `.is-playing`, `.is-complete`, `.has-placed` | 공개 최상위 루트 아래의 컴포넌트별 `className` 조합. 헤더 스크롤·장면 재생·배치 상태는 기존 React state에서 조건부 클래스를 결정한다. 공통 `Scene`/`DemoCard`/`Button`/`Card`의 variant 매핑은 한 폴더에 모은다. 인증 앱 루트에 전역 규칙을 확산하지 않는다. |
| 자손·`nth-child`·`:not`·`::before/after`와 카드의 작은 도형 | 의미 있는 상태/장식 노드를 컴포넌트에 명시하고 각 노드에 utility를 준다. 장식은 `aria-hidden`; 번호·상태·대체 텍스트는 기존 접근성 의미를 지킨다. `before:`/`after:`·`first:`·`nth-*:`가 정확한 결과를 내면 사용하되 생성 CSS와 계산 스타일을 확인한다. DOM 순서만을 위해 접근성 순서를 바꾸지 않는다. |
| hover·focus-visible·선택·disabled와 slider thumb | 공통 버튼·카드 및 폼 primitive의 variant/state 클래스, `hover:`·`focus-visible:`·`disabled:`·`aria-pressed:` 등으로 표현한다. `input[type=range]::-webkit-slider-thumb`·`::-moz-range-thumb`는 공통 Slider 컴포넌트 소유권을 먼저 정하고 동일 브라우저 외형을 확인한다. 기능 컴포넌트에 새 원시 `<input>/<button>` 직접 스타일을 두지 않는다. |
| 430·720·1050px 미디어 | 승인된 **포함형** 화면 전환 variant를 같은 요소의 utility에 적용한다. 320·390·1024·1440px 외에 양측 경계를 검사한다. |
| `@keyframes`, `prefers-reduced-motion`, 장면·차트·보고서·맵의 재생 | 기존 React `SceneMotion`·`IntersectionObserver`·Web Animations API의 타이밍과 상태를 보존한다. 정적 타이밍은 utility의 승인된 animation 계약으로 표현할 수 있는지 확인한다. CSS keyframes를 JS 문자열이나 인라인 스타일로 숨겨 정책을 피하지 않는다. `motion-safe:`/`motion-reduce:`와 완료 상태의 최종 프레임, 다시 보기·스크롤 이탈 취소를 테스트한다. |
| 밝기에 따른 `--brightness-pct`, `--glow-opacity`, `--beam-opacity`, `--floor-glow`와 맵 좌표 | 실제 사용자 조작으로 변하는 수치다. 디자인 토큰 후보가 아니며 현재 React/정적의 계산과 동일하게 컴포넌트 상태·위치 계산으로 유지하되, 인라인 CSS를 정책 우회 수단으로 확대하지 않는다. 정적 고정 치수·색상은 유틸리티 또는 승인 토큰으로 이동한다. |

색상 `rgb(...)`는 기존 의미 토큰과 불투명도 조합이 시각·계산 색상 모두 일치하는지 확인한다. 그림자·gradient·clip-path·backdrop blur는 상용 유틸리티로 정확히 표현 가능한 것과 새 의미 토큰이 필요한 것을 분리한다. 정책이 검사하지 않는 속성이라는 이유만으로 대량 인라인 스타일이나 검사 밖 CSS로 옮기지 않는다.

## 5. 정적 시안 URL과 빌드 구조

| 구조 | 장점 | 구현·운영 확인 사항 |
| --- | --- | --- |
| Vite 다중 페이지 + React 시안 | `/concepts/field-day.html` 실파일을 `dist`에 생성하여 현재 URL의 물리 파일 성질을 유지한다. | HTML을 `public` 밖의 프로젝트 루트 `concepts/field-day.html`로 옮기고 `rollupOptions.input`에 기존 `index.html`과 함께 등록한다. 두 HTML 모두 동일한 `src/main.tsx`를 module entry로 참조하고, 그 파일의 경로 분기에서 별도 React 시안 컴포넌트를 렌더링한다. `src/App.tsx`가 이미 소유하는 canonical `./styles.css` import 경로를 공유하므로 새 CSS entry/import가 없어야 한다. 갤러리·자산 링크와 nginx의 실제 파일 응답을 확인한다. |
| 기존 SPA의 React 경로 | `main.tsx`의 공개 경로 선택과 `PublicSiteLayout`, `InquiryForm`, 공통 데모를 재사용하기 쉽다. 정책이 허용하는 기존 CSS 진입점을 공유한다. | `public/concepts/field-day.html`을 그대로 두면 물리 파일이 우선 제공되므로 경로 전환 시 제거해야 한다. Vite dev와 nginx의 `/index.html` fallback이 **확장자 `.html` 경로에서도** 실제로 동작하는지 직접 확인해야 한다. 고유한 시안 카피·외형·상담 흐름을 React route에 보존하고 gallery `href="field-day.html"`을 유지한다. |

**권장:** Vite 다중 페이지 + React 시안. 물리 `.html` URL과 production 산출물의 예측 가능성을 유지하면서 React 공통 UI·상담 구현을 공유한다. 현재 `index.html` 단일 entry·`src/main.tsx` 경로 선택 구조를 확장하며, 별도 `src` entry에서 새 CSS import를 만드는 방식은 현행 단일 CSS 소유 계약과 충돌한다. SPA 경로 방식은 같은 코드를 더 단순하게 공유할 수 있으나 `.html` 확장자 fallback이 개발·운영 양쪽에서 확인될 때 대안으로 채택한다. 두 구조 모두 `/concepts/field-day.html`의 URL·갤러리·문의 미리보기와 production Docker 빌드의 `dist` 산출물, nginx `try_files $uri $uri/ /index.html`에서의 직접 접근을 검증한다. `field-day-design-system.html` 및 다른 갤러리 항목은 범위 변경 없이 보존한다.

## 6. 전환 완료 게이트

1. 동일 브라우저·폰트·뷰포트 높이·reduced-motion 조건에서 **기준 React와 기준 시안 각각** 320·390·1024·1440px 전체 페이지 및 히어로·데모·상담 팝업 PNG를 남긴다. 새 화면과 겹침/차이 이미지로 비교하고 차이가 있는 모든 영역은 계산 스타일·폰트·레이아웃·렌더링 오차로 분류한다. 무근거의 허용 임계값이나 “완전 픽셀 동일” 주장을 두지 않는다.
2. 429/430/431·719/720/721·1049/1050/1051px의 레이아웃·가로 넘침·헤더/장면 전환을 확인한다. 기본 4너비에서는 스크롤 위치, 고정 헤더, 장면 높이, 텍스트 줄바꿈, 로그인 `/login`과 앱 shell의 CSS 계산값도 비교한다. 공개 클래스가 인증 화면에 새 스타일을 주지 않아야 한다.
3. 키보드 Tab·Shift+Tab·Enter·Space, skip link, `focus-visible`, 44px 터치 영역, slider, map pointer drag·취소, 다시 보기·이탈/복귀, 상담 열기·닫기·포커스 복귀·접수 중 제한을 재검증한다. axe serious/critical 0, `prefers-reduced-motion: reduce`의 최종 정보 표시와 no-preference 애니메이션 시점을 확인한다.
4. `pnpm --filter @led-control/web test:ui-policy`, `pnpm --filter @led-control/web ui:check` 0/0, typecheck, test, build, 관련 Chromium Playwright (`landing.spec.ts`, `landing-field-day.spec.ts`, `field-day-inquiry.spec.ts`, 로그인/운영자 회귀) 및 루트 `pnpm test`를 실행한다. production build를 실제 nginx 경로에서 열어 `/`, `/features`, `/pricing`, `/concepts/index.html`, `/concepts/field-day.html`, `/login`의 새로고침·자산 응답을 확인한다. 스크립트 통과와 운영 배포 완료를 혼동하지 않는다.
5. 구현 시 페이지 기능 현황이 변하면 `docs/menus/landing.md`와 영향을 받는 메뉴 문서를 같은 변경에서 갱신한다. CSS/JS 이전만으로 동작이 바뀌지 않았으면 그 사실과 검증 결과를 기록한다. 실제 운영 배포는 별도 승인·배포 절차를 따른다.

현재 결론은 **설계상 경로가 있으나 실증 전**이라는 것이다. 전수 분류 후 필요한 추가 토큰 승인, 경계 variant의 컴파일 결과, 시안 `.html`의 실제 production 응답과 4너비 시각 비교가 완료되어야 0건 및 외형·동작 보존을 주장할 수 있다.

## 7. 기존 실행 계획과의 차이 및 실행 순서

기존 [실행 계획](../plans/2026-09-27-landing-ui-policy-zero.md)은 정책·토큰을 그대로 둔 상태에서 일반 CSS를 유틸리티로 옮기는 경로를 먼저 가정했다. 조사 결과 정확한 값을 가진 승인 토큰과 **430·720·1050px 포함 경계**가 없으면 화면 보존과 정책 0건을 동시에 증명할 수 없다. 또한 정적 시안의 독립 CSS는 파일을 이동하는 것만으로 해결되지 않는다. 이 명세는 최소 토큰의 정식 승인, 포함형 반응형 variant, Vite 다중 페이지의 React 시안 전환을 선행 설계로 추가한다. `--radius-landing-dialog` 등 기존 계획의 후보 명칭은 확정이 아니며, 공통 컴포넌트의 실제 역할을 검토해 위 표처럼 좁혀 승인한다.

실행 순서는 **① 925건 전수 분류와 기준 화면·동작 채증 → ② 필요한 토큰·variant의 값 및 사용처 승인 → ③ 토큰 전용 커밋과 승인 Git ref 회전·정책 회귀 → ④ React 컴포넌트·유틸리티 전환 → ⑤ 정적 시안의 URL 보존 전환 → ⑥ 4너비·경계·기능·production 경로 검증과 UI 정책 0건 확인**이다. 각 단계의 정확한 변경 파일과 테스트 명령은 이 명세에 대한 사용자 검토 후 활성 실행 체크리스트에 반영한다.
