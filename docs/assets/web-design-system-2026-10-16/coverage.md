# Web 공통 디자인 시스템 적용·검증 범위

승인일 2026-10-16, 최신 검증일 2026-10-18. 분리 브랜치 `codex/web-design-system-unification-20261016`의 Task1–5 제품을 Task6에서 확인했고, Task7/8 수리 뒤 최신 전체 Web3,938PASS/0FAIL/3SKIP·전체 안전 Chromium226actualPASS+의도된FAIL3을 확인했다. 아래 회차별 실패 이력과 마지막 Task8 기록을 구분한다. 운영 배포·실장비 완료나 독립 최종 리뷰 승인을 뜻하지 않는다. [중앙 가이드](../../ui-design-system.md), [적용 설계](../../superpowers/specs/2026-10-15-web-design-system-unification-design.md), [적용 전 baseline](baseline.md)을 함께 읽는다.

## 증거의 구분과 실행 경계

- 정책: production source lexical 검사와 canonical CSS/HTML/import 검사다. 실제 화면의 모든 색·간격·동작을 증명하지 않는다.
- computed·조작: 실제 Chromium DOM, generated CSS, 정확한 inset/gap/type, Range·hit·focus·keyboard·wheel·mock 요청/상태 전이를 검사한다. 공통 primitive만 통과한 결과를 모든 조건부 소비자의 mounted 검증으로 확대하지 않는다.
- 시각: 아래 대표 PNG의 실제 화면만 사람이 확인했다. 모든 route/state/theme의 pixel review는 아니다.
- 미실행: 기능 또는 조건부 분기는 존재하지만 해당 환경/상태를 이번 브라우저에서 실행하지 않았다. 해당없음(N/A)은 제품에 없는 기능·entry 조합에만 사용한다.

작업 checkout은 `/Users/kim-jh/Documents/led-control-service/.worktrees/web-design-system-unification-20261016`이다. 아래 로그·JSON·PNG의 공통 경로는 `.superpowers/sdd/2026-10-16-web-design-system-unification/`이며 Git 제외 로컬 증거다. 이 coverage 문서는 커밋하고 원 로그는 삭제하지 않는다.

소유 Vite `127.0.0.1:15341`, `--strictPort`, `reuseExistingServer:false`, workers1, Chromium, serviceWorkers:block을 사용했다. 기존5173/4000/8883·다른 worktree·실제 backend/DB·인증/메일/장비·배포/재시작은 실행하지 않았다. 자동 fixture가 미등록 API·외부 write·WebSocket·beacon을 차단·보고하며, 기존 도메인 mock의 미등록 응답은 synthetic404다. 개발 runner의 보고 예외는 실제 Vite handshake의 same-host·문서에 대응하는 ws/wss·루트경로·단일 token query·`vite-hmr` subprotocol 조합으로 한정했다. 이것도 transport 전에 차단한다. 실제 `/@vite/client` 부팅과 함께 same-host 일반경로/일반subprotocol/잘못된경로3시도 모두 차단+보고되는 음성 검사를 통과했다. production memory boundary는 계속 HMR 예외 없이 모든 socket을 보고한다.

## 실제 등록·실행 inventory

고객 leaf는 monitoring1 + control1 + statistics3 + settings7 = 12다. control을 manual/schedule/event/group4mode로 나누면 15surface다. 공개3page와 entry3개를 9page로 합산하지 않는다. operator는4route다. index/wildcard redirect·dialog·query/hash는 page 수에 더하지 않는다.

`design-system-coverage.spec.ts`는 별도 literal 기대집합15/4와 실제 등록 key38개, 단언 완료 뒤 `test.info().title`까지 저장한 실행38개를 대조한다. 자체 배열 길이만 검사하지 않는다. 최종 JSON의 실제 Playwright spec/test 결과와 `registered-executed-inventory` attachment도 함께 대조한다. table의 `coverage customer:{key}:390/1440`와 `coverage operator:{key}:390/1440`가 실제 case title prefix다.

최종 수리에서 `coverage complete consumer cohort`라는 **38소비자+inventory39개 직렬 묶음**으로 실행 계약을 고정했다. 전체 파일/전체 suite 또는 `--grep "coverage complete consumer cohort"`로 선택한다. inventory 시작의 명시적38완료 선행조건과 afterAll의 완주 관문이 부분 grep/file:line/test-list를 거절한다. 소비자 하나가 실패하면 그 원 실패를 유지하며 나머지 묶음을 skip한다. 재시도0으로 다른 worker가 이전 worker의 부분 실행을 이어서 빈 inventory를 검사하지 않는다. 수리 뒤에는 전체 묶음을 새 worker에서 다시 실행해야 한다. 기대집합을 선택된 subset으로 축소하지 않는다. 부분 inventory 선택의 최초 오류는 전체 cohort 실행 방법을 안내하는38완료 선행조건이며 뒤 afterAll 오류도 별도 보존한다. operator행 line 선택은 본문8개 완료 후 완료 관문 실패(7PASS/1FAIL)를 확인한 별도 방어 증거이며 일반 PASS에 합산하지 않는다. worker의 public grep 설정만으로 CLI 선택을 추정하던 초기 보완은 실제 진단에서 효과가 없어 제거했다.

| 고객 surface key | 실제 진입·loaded 단언 | computed·조작 근거 | 추가 상태/한계 |
| --- | --- | --- | --- |
| monitoring | `/monitoring`, 실제 monitoring screen | roles: 일반20/fullview8·같은 root/map·Escape; 이전8수리 지도/선택/wheel | 새 log3소비 검증. 모든 dashboard error/설치 대기 조건의 별도 mounted 검사 아님 |
| manual | `/control?mode=manual`, 실제 실행 panel·선택0 disabled | roles: 일반20/16과 mobile gap4/p0; eight: 실제 선택→mock command1회·잠금·완료 | roles pending/error/empty. 대표 PC/mobile PNG·disabled 분류. 실제 장비 성공 아님 |
| schedule | `/control?mode=schedule`, 실제 빈 목록 | roles:20·20/16·populated 규칙·추가 dialog·focus·calendar503 내부 오류 | 실제 규칙 저장/활성화·모든 calendar 상태는 미실행 |
| event | `/control?mode=event`, 실제 빈 규칙 | roles:20·20/16·populated·추가 dialog·Escape | roles pending/403 error; 실제 감지/활성화는 미실행 |
| group | `/control?mode=group`, 실제 빈 구역 | roles: populated2행 grid18·card16/20·새 구역 취소·같은 Card | roles pending/error; 실제 mesh membership 성공은 미실행 |
| statistics-overview | `/statistics/overview`, 실제 오늘 사용량과 비용 | roles4폭×2theme: 외곽·일반 MetricCard20/16·grid18·제목·단위; 큰 수치4폭×2theme nonzero Text Range | 모든 query pending/error/empty 조합의 mounted 검사는 미실행 |
| statistics-analysis | `/statistics/analysis`, 실제 에너지 사용 비교 | roles: heatmap/순위 detail 외곽과 지표 카드20/16·상세 내부 두 카드 grid18·탭·선택·공통 SidePanel; 큰 수치4폭×2theme | 상세의 테두리 지표2개는 일반 카드다. chart 내부 cell/margin·metric28/34는 보존. 모든 query 오류는 미실행 |
| statistics-reports | `/statistics/reports`, 실제 빈 목록 | roles: 보고서 dialog20/16·56px닫기·단일 reader·Escape; 신규 populated 이력2행/상세 | failed+processing mock job 표시. 실제 PDF/CSV/다운로드·전체 오류/만료 상태 미실행 |
| settings | `/settings`, 설치 이어가기 | 실제 h1 24/26·content owner14/28·18/24; roles grid18·card제목16 | TestDataTools 조건부 활성 mount는 아래 한계 참조 |
| site | `/settings/site`, 현장 구성 | roles: section20/28·card16/24·panel20/16·mock 현장/층 저장; 신규 층2행·수정 modal | 인증 ready 후 feature pending/403 error/empty/paused→online 복구 실제 검사 |
| users | `/settings/users`, 실제 사용자 추가 | roles:2행·검색/clear·grid18·inset16/20; eight 긴 reset-ID·해당 필드 Range | 신규 기본은 empty. 모든 mutation 성공/실패는 이번 mounted 범위 아님 |
| registration | `/settings/registration`, 실제 commissioning 등록 | roles:20·20/16·gateway empty·작은 제목; eight 긴 serial·읽기/scroll | 실제 provisioning/등록/장비 정보 검증 아님 |
| floor-plans | `/settings/floor-plans`, 실제 floor-plan item | roles: card grid18·inset20/16·h1 | 실제 업로드/서버저장 모든 상태는 미실행 |
| floor-editor | `/settings/floor-plans/floor-1/edit`, actual map-ready=true | roles: 정보 panel20/16·p0외곽·280/≤320·title16·≥256/contain:size; eight scroll/긴기록/복구focus | 신규390 toolbar scroll·Tab→편집 정보·우측disabled복구 접근. CAD principal 불확정은 QA 표 참조 |
| security | `/settings/security`, actual sessions card | roles/light+dark·security suite 양shell: grid18·card20/16·h1·modal focus/Tab/Escape | MFA 등록/복구코드·세션종료는 mock. 모든 principal 경합은 unit 근거와 구분 |

고객 새 ready inventory는390×844 dark와1440×900 light다. roles72개는320×600/390×844/1024×768/1440×900 및 고객 light/dark를 직접 확인하며, 이전8수리35개는32functional+3expected-teardown defense다. 서로 다른 case를 수치만 합쳐 같은 화면의 모든 상태로 간주하지 않는다.

| operator key | 실제 내용과 표현 | 상태·조작 및 한계 |
| --- | --- | --- |
| site-admins | 현장 관리자 계정 region, h1 24/26, main18/14·24/28, max1160 | fresh24 suite에서 pending/403 error/empty/다시시도. calm5폭4행의 literal7필드/8라벨·권한별 작업·dialog 조작. 열합1230>최대content1104라 현재 frame에서는 card; operator table 표시 완료 아님 |
| sensor-profiles | 센서 호환 프로파일 region·empty·일반 form20/16·section20 | 승인 버튼 disabled·기술 JSON form. 실제 승인/철회·모든 pending/error 상태 mounted 검사는 미실행 |
| landing-inquiries | 상담 문의 region·empty·메일 상태 card20/16·작은 제목16 | 실제 메일 연결/접수·populated cursor/모든 오류 상태 mounted 검사는 미실행 |
| security | 같은 shared security의 operator presentation·단일h1 | customer와 같은 functional 수치·password modal focus. 실제 운영자 보안 mutation 아님 |

## 공유 DataGrid 다섯 실제 소비자

| 소비자 | 실제 populated 검증 | 조작·기하 근거 |
| --- | --- | --- |
| FixtureGroupsContent | roles `control and users populated customer cards share grid and inset 320/760` |2행·grid18·inset16/20·구역 진입/취소. 필드 내부 gap과 정렬 row는 일반 section 아님 |
| SiteUsersView | 같은 roles320/760 | 사용자2행·검색→1행→clear2행·Text Range |
| SiteOperationsView | coverage `remaining DataGrid floors populated 320/1024` | 실제 층2행·grid18·inset16/20·층 수정 modal/Escape/focus. 열합570;760 단일열에서는table였고1024 tablet2열에서는card다 |
| ReportJobList | coverage `remaining DataGrid reports populated 320/1024` | failed/processing2행·grid18·inset16/20·상세 펼침/실패 안내/닫기. 열합950과 실제 통계content가 card를 결정 |
| MonitoringLogDrawer | coverage `remaining DataGrid logs populated 320/1024` | 실제 운영로그2행·grid18·inset16/20·다음페이지/cursor·닫기/focus. drawer frame/내용 폭상1024에서도card; viewport만 보고table로 가정하지 않음 |

표 셀의 compact12/8px·기본 row·dl/field gap은 공통 DataGrid unit13개와 source 보존 근거다. 위 신규3consumer는 card 상태의 직접 computed 검사이며 모든 소비자의 table 전환을 직접 실행했다고 주장하지 않는다. 초기760층 card와1024로그 table 기대 오류는 제품 RED가 아닌 신규 테스트 전제 오류로 원 로그에 남겼다.

## 인증·공통 상태·overlay

| 상태/소비자 | 실제 실행 근거 | 판정 경계 |
| --- | --- | --- |
| auth pending | coverage auth gate pending, 실제 auth query를 보류하고 labelled main·busy status | feature pending으로 세지 않음 |
| auth paused | 실제 navigator.onLine=false 부팅과 서비스 복구 alert·focus | 정상 초기화의 onlineManager 설정을 통과한 실제 gate. feature offline과 분리 |
| auth503/403 | exact `/api/auth/me`503 세번째 응답 후 복구/forbidden alert·h1 focus·shell0 | retry/deadline 불변; 실제 운영 장애 아님 |
| credentials/TOTP/recovery | fresh security suite320/1440: 로그인 pending disabled→401error→MFA challenge→TOTP focus→recovery input | 모든 TOTP/recovery 성공/거절 조합은 미실행. 실제 MFA 요청/비밀수명 회귀는 account-security mock와 unit 근거 |
| 강제 비밀번호 변경 | coverage390/1440: 실제 App mustChangePassword gate→ready/changing/failed→성공monitoring | 같은 panel20/16·중복activation disabled·실패시3입력삭제/focus·성공unmount. 모든 logout경합은 unit 범위 |
| 현장 feature offline/기타 상태 | ready 인증·monitoring 진입 후 실제 client navigation; settings query pending/error/empty/paused→online | 실제 연결대기 문구·busy/spinner 없음·복구된 현장구성 확인. 전역 auth 실패를 feature 오류로 가장하지 않음 |
| modal/drawer/confirm/menu/popover | Task2 `task-2-overlay-final.log` memory production13PASS; 새 DataGrid/detail·현장·public dialog, roles와freshsecurity |13에는4boundary negative가 포함. pending close잠금·nested focus·typed menu·popover·long reader/axe. 모든 feature overlay 조건부 mount 완료 아님 |
| loading/recovery rendering | foundation generated CSS 및 Task2 common-state memory browser·unit; 새 actual auth gate | 순수 rendering과 App 실제 recovery를 구분. 실제chunk/network 장애 전체 경로는 기존 app-shell-recovery 근거·미실행 조건을 확대하지 않음 |
| developer TestDataToolsPanel | source·unit, `VITE_TEST_DATA_TOOLS_ENABLED=true`+admin+installed 조건 존재 | **활성 browser mount 미실행**, N/A 아님. 승인 token 상속만으로 실제 computed PASS를 주장하지 않음 |
| legacy standalone PasswordChangeCard | `settings/security/PasswordSettingsView.tsx`의 standalone `PasswordSettingsView`/기본 card export와 unit. 현재 AccountSecurityView는 embedded로 소비 | **별도 standalone browser mount 미실행**, legacy 구현이 존재하므로 N/A 아님 |
| editor 도형/다중선택/legacy 세부 panel | source 역할 이동·unit·기본 editor 속성/배치/layer/기록 browser | 개별 조건부 전용 computed mount 미실행. CAD preview 모든 interruption의 pixel review 아님 |

## 공개3page × 실제 entry3

독립 `task6-public-execution-audit.log`에서 Task5 원로그의 실제 PASS한16폭 testcase와 실제 출력한 route/motion 측정 row96개를 entry별 literal 기대집합과 대조했다. 상수 길이·배포 mode label만으로 검증하지 않았다. `public-deploy.spec.ts` 실제 case 안에서3route×2motion 각각 DOM/computed/연락 dialog를 단언한다. entry graph/artifact는 Task5의 actual build/audit/manifest와 대조하며 최종 `dist-public`은 fix1 landing artifact임을 확인한다. 현재 디렉터리를 service artifact로 부르지 않는다.

| 실제 entry | `/` | `/features` | `/pricing` | 원 실행·직접 검증 |
| --- | --- | --- | --- | --- |
| main `/src/main.tsx` | PASS | PASS | PASS | `task5-main-browser-hit-fixed.log`22PASS/3mode SKIP, 소유15341 scratch main config;96computed행 |
| landing `/src/landing-main.tsx` | PASS | PASS | PASS | `task5-landing-browser-hit-fixed.log`21PASS/4mode SKIP, actual production15342;36local modules/private0;96행 |
| service `/src/service-main.tsx` | PASS | PASS | PASS | `task5-service-browser-hit-fixed.log`24PASS/1mode SKIP, actual production15342;346local modules;96행 |

폭은320/390/1024/1440,429/430/**430.5**/431,719/720/**720.5**/721,1049/1050/**1050.5**/1051이다. 분수는 zoom2 iframe의 실제 CSS document 폭·exact-width media query로 검증했고 정수 label로 치환하지 않았다. 포함형430/720/1050·header82/96·hero·anchor100·normal/reduced-motion·nav containment·연락·plan·login모드를 검사했다. tel/mailto와 외부 HTTPS로그인은 href만 검사하며 실제 전화/메일/외부 방문은 없다.

| 추가 entry/HTML 경계 | 실제 근거 | 해당없음/미실행 구분 |
| --- | --- | --- |
| main/service bootstrap 준비·실패/reload | Task5 `actual private entry keeps bootstrap status, failure and reload...`, actual 각entry에 mock native bridge | main/service 실행; landing은 bootstrap module 자체를 배제하므로 N/A. 실제 iOS/Android native 미실행 |
| JSoff HTTP404 | landing/service actualserver의 HTTP404·hashed canonicalCSS200·script/style/inline0·4폭 title/body/inset·keyboard귀환 | dev Vite fallback은 static404 증거가 아니므로 mode skip |
| React 공개 fallback | `landing-main.tsx` source의 functional 역할 소비 | production server unknown은 독립404를 반환하므로 React fallback 별도 mounted computed는 미실행 |
| public static suite | Task5 최초5PASS 뒤 fix1 **6PASS**(`task5-fix1-green.log`) | 실제 manual-context cleanup 실패에도 context.close·원 Error 보존 검증 포함. 기존72PASS/8modeSKIP public cohort에 새fix1 suite를 중복 합산하지 않음 |
| concept React1/archive5/smoke4 | tracked HTML14 inventory와 base 동일성; actualmain concept/archive URL·local link 보호 | archive 재디자인·smoke 제품화 N/A. smoke4의 각 앱 실행/시각 QA는 미실행 |

HTML14 = 제품 entry4(`index.html`, `landing.html`, `service.html`, `404.html`) + React concept1(`concepts/field-day.html`) + public concept archive5 + map/editor/CAD smoke4다. `task6-independent-invariants.log`에 정확한14경로와 base 대비404만 변경·나머지13원문동일을 기록한다.

## 대표 시각 확인·대비

Task6와 총괄이 `view_image`로 실제 PNG를 직접 확인했다. 초기 `task6-control-{390,1440}.png`의 최근이력404는 기본 mock 미구성 오류 표시였으며 유효 제품 ready/히스토리 성공으로 사용하지 않는다. 최종 `task6-control-ready-{390,1440}.png`는 명시된 빈 이력 응답 후 새 이름으로 촬영했다. `task6-editor-{390,1440}.png`는 실제 ready canvas다.390 toolbar 우측은 의도된 overflow-x:auto reader이며 Tab으로 정보 버튼까지 scroll, 정보 진입, disabled복구 버튼까지 실제 scroll 접근을 검사한다.

`task6-public-contact-390.png`는 긴 페이지의 fullPage 합성이라 fixed backdrop이 viewport 밖 footer까지 덮지 않는 모습이 나타난다. 이를 제품 결함으로 판정하지 않는다. `task6-public-contact-viewport390.png`는 실제390×844 viewport만 촬영하고 fixed backdrop의0,0/390×844, dialog 전부 viewport 안, 바깥 hit가 backdrop, close52×52의5hitpoints, Tab 포함·Escape/원 trigger복귀와 연결한다. 대표 시각 확인 범위는 전체 route/state/theme의 pixel review가 아니다.

실제 computed text/배경 trace·opacity·font-size/weight·합성 foreground/background·반올림하지 않은 대비를 최종 JSON attachment에 남긴다. 완전히 불투명한 panel 뒤의 backdrop은 합성에서 제외하며, 실제 보이는 비sRGB layer/gradient/opacity group은 단순 RGB AA 판정하지 않는다. disabled apply의 opacity0.6은 AA 면제 분류로 ratio=null이다. 일반 text는4.5, 적격 large(24px 일반 또는18⅔px 이상 bold)는3, 필수 primary control fill과 인접 면은3을 적용한다.20px/700 제목의 large 분류와14px 일반 버튼을 구분한다.

| 실제 대상 | raw foreground / 합성 background | 분류·최소 기준 | 반올림하지 않은 ratio |
| --- | --- | --- | --- |
| 현장390dark 제목 | `rgb(234,241,250)` / `rgb(24,35,52)` |20px/700 large·3 |13.892617182041104 |
| 현장1440light 제목 | `rgb(21,44,67)` / `rgb(255,255,255)` |20px/700 large·3 |14.254603719867495 |
| 층 추가390dark 글자 | `rgb(15,23,36)` / `rgb(148,185,255)` |14px/700 normal·4.5 |9.109264941293205 |
| 층 추가1440light 글자 | `rgb(255,255,255)` / `rgb(36,95,232)` |14px/700 normal·4.5 |5.416368864052123 |
| primary fill390dark / 인접 면 | `rgb(148,185,255)` / `rgb(15,23,36)` |필수 control nontext·3 |9.109264941293205 |
| primary fill1440light / 인접 면 | `rgb(36,95,232)` / `rgb(244,247,251)` |필수 control nontext·3 |5.040816410635919 |
| 공개 상담 제목 | `rgb(21,50,74)` / `rgb(255,255,255)` |20px/700 large·3 |13.232437312996261 |
| 수동 apply390/1440 | opacity0.6, disabled=true |disabled 면제; group opacity 합성 AA를 계산하지 않음 |`null` |

위 원수치는 `contrast-*`/`primary-control-nontext-boundary` JSON attachment와 연결한다. 실제 보이는 배경은 모두 sRGB solid/opacity1이며 공개 modal의 불투명 white panel은 뒤 backdrop을 완전히 가린다. 최종 수리는 텍스트와 nontext가 같은 solid/opacity 적격 검사를 사용하게 했다. nontext는 fill과 인접 면 양쪽의 전체 ancestor trace를 확인하고 gradient/image 또는 group opacity가 있으면 비율이 높아도 PASS할 수 없다. fill/adjacent × opacity/gradient4개 음성 검사가 이를 증명하며 별도 pixel 분석 없이 해당 측정을 적합 판정하지 않는다. raw ratio·기존3/4.5 기준은 유지한다. 선택한 조합의 통과가 모든 palette 조합·focus ring·오류/상태/graphic 대비 통과를 뜻하지 않는다. 도형/CAD 원본색·disabled·장식과 필수 UI의 분류를 혼동하지 않는다.

## 독립 baseline QA와 실패 판정

`ControlView.test.tsx` SHA256은`d74b722ee546b1b5ea3057247d5326b976c936064497a1026f9689054f5ba623`, CAD test는`d1bdebbf1728933e9c778f6ccc5025474c2b6b91a97c6e306b9f1b0b7ddc9fe0`로 fresh baseline과 동일하다. 원 fixture·조건·assertion·raw logs를 직접 읽었다. 같은 실패 현상이 관측됐다는 판정과 같은 원인이라는 인과 판정은 다르다.

| 원 관측 | 원 조건·assertion 대조 | 독립 판정 |
| --- | --- | --- |
| Control narrow historical detail1 | verified_applied 이력 클릭→expandRecentDetails 뒤 :991 최근 결과 상세 region 없음 | focused 재현: mobile More의 active=null/hidden 상태에서 findByText는 숨겨진 결과도 찾지만 helper는 accessible 상세 보기만 query해 열지 않는다. 실제 접근 경로는 더보기→상세 보기다. 원 assertion 미수정; 후속 시험 조건/정책 결정 필요 |
| Control close transition2 | 같은 verified_applied 이력. singleColumn=false는 rerender 뒤 :1016 close부재, true는 초기 :1012 oldClose부재 | false→true는 열린 상세가 초기 닫힌 More portal로 이동해 접근 불가; true 초기 조건도 More를 열지 않는다. close focus 단언 전에 실패한다. More 표시·이력/focus 생명주기를 변경하지 않았고 원 단언을 유지한다 |
| Control roving2 | End/ArrowLeft로group 이동 후 :2397/:2582 focus 불일치 | handler는 기존 tab에 focus한 뒤 mode를 바꾼다. manual의 Fragment/provider 아래 tab이 group의 최상위 PageStack 분기로 이동하며 unmount되어 body로 focus가 빠진다. circular 시험은 이전 group DOM 참조도 보유한다. 제품 상호작용/시험 identity 계약의 별도 후속 결정 필요 |
| 역사적 CAD 여섯째·Task5 CAD principal | common=true/principal 또는 onSaved-purge; automatic=false singleton callback→:1442 preview-ready=true 기대/false | prepared CAD85PASS, Task4 floor interruption 실패/후속미재현, Task5 full principalFAIL/85·87focusedPASS는 별도 관측. 미재현을 해결/flake/인과 무관으로 확정하지 않음 |
| 원 E2E manual locator1 | marker 선택 후 `조명 목록 열기` 대기30초; 원복사본은 import분리1행만 차이 | 현재UI의 `조명 목록`/compact drawer 경로와 다른 locator 전제오류. 그 뒤 원 payload 전체 여정의 최종 성공을 증명하지 않음 |
| 원 E2E settings locator4 |320/390×light/dark, h2 설정 visible 기대 | 현재 shell의 실제h1 설정과 불일치. locator 전제오류4; 원case 전체 후속 상태를 실행 완료로 바꾸지 않음 |
| 원 E2E users locator1 | `/settings/users`에서 heading 유저 관리 기대 | 실제h1 사용자 관리와 region 유저 관리의 구분 오류. 원 mutation·비밀수명 전체 여정 성공으로 확대하지 않음 |

원 브라우저복사본 세 파일을 현재 원본과 diff해 import분리·끝빈줄 외 assertion/locator/deadline 동일을 확인했다. 신규 coverage는 정확한 현재 owner/heading을 검사하지만 원 locator6case를 고쳤거나 원 전체 여정을 재실행했다고 주장하지 않는다. Task3 최초 동시run의 App2/CommandHistory1 timeout도 후속101/101·serial full 미재현과 별도로 원인 미확정 이력을 보존한다.

## 필수 gate·최종 판정

`pnpm workspace:prepare`를 leaf 검증 전에 실행했다. 최종 결합 명령은 `pnpm --filter @led-control/web exec playwright test --config=playwright.design-system.config.ts e2e/design-system-coverage.spec.ts e2e/design-system-roles.spec.ts e2e/ui-eight-layout-regressions.spec.ts`이며 JSON reporter와 scratch output 경로만 추가했다. 최종 `task6-browser-final-fixed.json`은 **164expected/0unexpected/0skip**(57coverage+72roles+35eight; 실제161passed+3expected-teardown failure),265.586848초,exit0이다. `task6-browser-final-audit.log`에서 실제 등록·실행 title38과 완료 attachment38의 일치 및 raw 대비·toolbar 측정을 독립 확인했다. 별도 fresh auth/security/operator3suite는24/24PASS다.

첫 결합 `task6-browser-final.json`의162expected/2unexpected도 보존한다. foundation의 computed·click/counter1은 끝났으나 memory HTTP server 정리 대기에서30초timeout이 발생했고, worker 재시작 뒤 나중 inventory가module 실행집합을 잃어[]가 됐다. 실제38route case 자체는 모두PASS였다. 새test의 page→server 정리와 원오류보존, literal38 바로 뒤 inventory 위치를 보완한 focused40PASS·최종정리1PASS 뒤 총괄이 승인한 동일164 결합을 재검증했다. 제품/helper/timeout/retry 변경은 없다. 실패를 build timeout/제품 role RED 또는원인불명의flake로부르지 않는다.

소프트웨어 gate는 typecheck/build exit0, UI policy79PASS, ui:check0/0, landing계약6PASS, public계약3PASS다. 최종 e2e source도 explicit TypeScript 검사exit0이다. canonical Web full은 모든 소유 browser/build/unit heavy 작업 종료 후 단독1회 실행하며 재시도/worker/timeout/정책을 완화하지 않는다. 그 최종 결과는 아래 후속 판정과 Task6 보고서를 따른다. 전체 mono-repo canonical CI를 실행한 것으로 기록하지 않는다.

최종 canonical `pnpm --filter @led-control/web test` 단독1회는 **3925PASS/5FAIL/3SKIP**,265files(263PASS/1FAIL/1SKIP),56.67초,exit1이다. 원로그는 `task6-web-full-final-alone.log`다. 실패는 위 Control5이며 prepared원로그와동일한991/1016(false)/1012(true)/2397/2582의조건·단언을직접대조했다. 새추가실패는없었고 전체rerun은하지않았다. CAD85/85는통과했지만 Task5principal/역사적onSaved-purge/Task4floor interruption 및Task3App2/History1의과거원인을해결·flake·인과무관으로확정하지않는다. 기존skip은 `src/api/floor-editor.test.ts`1개와 `src/features/cad-scene/cad-scene-actual-display.test.ts`2개다. 전체 GREEN은 아니다.

독립 AST 검사는 Vite 의존 PostCSS로 `@theme static`1개/738선언, 승인 anchor `e841c57b11321a5ae35d15920031020089f06ee2`, theme 원문 anchor동일, policy anchor/baseline sourceRef일치, `files:{}`를 확인했다. root font-size16 강제·zoom disable·새 token/정책 예외·baseline allowance·API/route·backend/native/shared/service config 변경은 없다.

실제 운영 API·인증/메일·전화·PDF/다운로드·배포·LED/Gateway HIL·Safari/WebKit/Firefox·실기기·iOS/Android WebView·OS키보드·브라우저 확대/사용자 font 변경은 미실행이다. 지원하지 않는 새 테마를 만들지 않았다. Task6 독립 task review와 whole-branch final review는 총괄이 별도로 수행하며 이 기록이 그 승인을 대신하지 않는다.

## 2026-10-17 최종 리뷰의 단일 수정 묶음 — Task7/8 이전 이력

통계 ordinary 지표 카드는 위 역할 계약으로 수리했고 `MetricCard` producer/default16px는 보존했다. roles8개와 큰 수치16개(overview/analysis×320/390/1024/1440×light/dark)가 actual20/16px·상세 형제grid18px·metric28/34px·전체 숫자/단위·카드 내 Range/overflow를 확인했다. analysis selected detail390/1440light의 `final-fix-browser-results/ui-eight-layout-regression-{0ed14-stay-inside-cards-390-light,9f25d-tay-inside-cards-1440-light}-chromium/numeric-cards.png`2개도 직접 열어 확인했다. PC의 kWh 줄바꿈을 포함해 숫자/단위가 모두 보이고 카드 안에 배치된다. 이는 해당2장면 확인이며 전체 화면 pixel 검증이 아니다.

확장 결합 `final-fix-browser-final.json`은212개/343.797979초/exit1,211expected/1unexpected(실제208PASS+3의도된sentinelFAIL+foundation cleanup1timeout)다. 모든 foundation1440px CSS/hit/6클릭counter/브랜드18px단언은 끝났으나 열린page연결 때문에 memory server.close가30초까지 대기했다. 원JSON·trace와 실패를 보존한다. 총괄 승인으로 동일wave 안에서 두foundation소비자만 `withFoundationFixture`의 page→server정리로 연결하고 기존coverage의 오류보존을 test-only `runFoundationLifetime`으로 공통화했다. 정상순서·원body Error동일성·단일cleanup Error동일성/후속정리·복수3오류동일성/순서4unit은4RED→4PASS다.

212가 시작된 뒤 선택guard와cleanup의 test-only delta가 있으므로 이를 새212전체PASS로 기록하지 않는다. 총괄 승인한 마지막 집중명령 `--grep 'coverage complete consumer cohort|coverage foundation generated CSS|fixture |functional computed'`는 실제62개를 선택했다(coverage40+foundation7+기존eight15). `final-fix-delta-final.json`은62expected/0unexpected/0skip,실제59PASS+3의도된sentinelFAIL,67.517238초/exit0이다. 수리된foundation functional은2.497초PASS, inventory는등록/기대/실행38개의key가정확히일치했다. 일반 `fixture `필터가 기존eight case15개도 선택했으며 최초 예상48개와 실제62개를 혼동하지 않는다. 부분inventory 선택의명시선행조건1FAIL과부분operator행선택7PASS/1FAIL은별도방어로그이며기능PASS에합산하지않는다. 최종run에서는beforeAll의CLI필터추측을제거하고실제완료선행조건+afterAll완주계약을검사한다.

마지막 source의 build(TSC포함)와 explicitE2ETSC는exit0, UI정책79PASS·최종ui:check0/0, landing/public계약6+3PASS다. theme1블록/738선언·anchor원문동일·빈baseline과producer/Control원코드·원test/HTML불변을확인했다. pnpm설정/색출력/큰chunk경고는보존하고의존성정책/번들구조를변경하지않았다. 모든소유heavy/15341listener를종료하고 `final-fix-source-freeze.sha256`를기록한뒤 canonicalWeb전체를단독1회실행한다. 그결과와Control5의실패관문은최종보고서를따르며통계/도구수리로면제하지않는다.

그 단독1회 `final-fix-web-full-alone.log`의 실제 결과는 **3928PASS/6FAIL/3SKIP**,266files(263PASS/2FAIL/1SKIP),46.63초/exit1이다. 새수명4unit은PASS했다. 기존Control5에 더해 CAD `previews CAD review results and applies with editor authority (common map: true, interruption: 'site')`가 :1442 `data-preview-ready=true` 기대/false로 실패했다. site interruption(:1492이후) 수행 전 초기paint단계다. 정확한case만 원단언/설정 그대로 실행한 `final-fix-cad-site-focused.log`는1PASS/84필터제외이며 전체를 반복하지 않았다. 위 Task6의3925/5/3과 Task5 principal·Task4 floor·과거onSaved-purge는 각 회차의 다른 관측이다. 이번 미재현을 원인 해결/flake/인과 무관으로 확정하지 않는다.

CAD 경계 조사에서 원test는 `previewPaint.automatic=false`, 모든 `MapSceneCanvas` 렌더가 같은 `previewPaint.props` singleton을 덮어쓰며 :1441의 onPaintReady는 그 마지막 props를 호출한다. 제품 `CadImportSceneCanvas`는 source/generation/revision/attempt/viewKey를 fence하고 `CadImportPreview`는 해당token의ready display를 요구한다. 이 경계는 확인했지만 원full에서 실제 어느owner/view의callback이호출됐는지 입증한 계측은 없어 singleton/스케줄 경합을 확정 원인으로 쓰지 않는다. CAD 제품/원시험/단언은 수정하지 않았다. 전체 gate는6FAIL로 유지하고 별도 callback owner 추적·후속 방향 결정이 필요하다. 메뉴8문서의 최신 공통 검증도 이 최종값으로 일치시켰다.

## 2026-10-18 Task8 — 최신 전체 통합 검증

위 마지막 문단은 당시의 미확정 결론이다. Task7에서 제어5건과 h1 보완을 수리했고, Task8은 CAD의 regions 응답→native scene→reviewKey 전환에서 먼저 캡처한 DOM이 분리되는 시험 수명 문제를 입증했다. `task-8-stale-preview-red.log`의 통제된 regions 지연은 원 site case 초기 paint 단언에서84PASS/1FAIL이며 `capturedConnected=false/currentReady=true`를 동시에 기록한다. 같은 source/generation/revision/camera의 현재 callback은 정상적으로 현재 DOM을 ready로 만들었다. 제품 paint fence나 singleton 오배달로 분류하지 않는다. 실제 renderer 준비 뒤 현재 DOM을 캡처하는 test-only 수정으로 관련111PASS, 원85case/337 matcher·기대값 보존(신규6)이다. 별도 과거 floor/onSaved-purge 관측까지 같은 원인으로 일반화하지 않는다.

새 CAD actual-App8의 첫 실행은6PASS/2FAIL(`task-8-cad-browser-green.json`)이었다. store reset만 하면 동일 route/query가 durable review를 다시 읽으므로 scope 부재라는 시험 전제가 틀렸다. 동일 document의 `window.history.pushState`/popstate BrowserRouter floor 전환, 기존 html identity 유지, 새floor query를 확인하는 방식으로 바꿨다. 명시 floor2 404만 mock하고 unknown API는 계속 거절한다. 첫 고정 QA `task-8-qa-gYODU9`는 Web 타입PASS 뒤 module mock `history` 이름 충돌 E2E타입FAIL에서 멈췄으며 전체 Web은 시작하지 않았다. 브라우저 전역을 명시한 최소 보완 후 `task-8-qa-ZPz7QN`의 scope2PASS와 전체 runner CAD8PASS를 확인했다.

최종 원증거 디렉터리는 `task-8-qa-ZPz7QN/`이다. 각 단계의 `.command`와 `.log`, raw JSON reporter 본문인 `browser-full.log`, classification·trace·PNG·API attachment를 보존한다. 승인된 고정 `task-8-final-qa.sh`를 primary가 실행했고 session79194 exit0으로 완료했다. 최초 infra의 Vite `listen EPERM`과 mandatory 승인 대기/중단 시간은 testcase 실행 시간에 합산하지 않는다.

| 최종 gate | 실제 결과 |
| --- | --- |
| Web/E2E TypeScript | 둘 다 exit0; E2E는 새 preservation와 기존 CAD journey spec 포함 |
| 전체 안전 Chromium | 229 expected = **226 actual PASS + 의도된 차단 FAIL3**, unexpected/skip/flaky0, 356.402829초 |
| 전체 inventory | 직렬38소비자+inventory39 완주; 기대/등록/실행38 key·title 일치 |
| CAD/제어 | CAD8 PASS, 기존 제어9 PASS; CAD 적용4·cancel2·scope2 포함 |
| build / UI정책 / ui:check | exit0 / 79PASS / 기존0·신규0 위반 |
| landing/public 계약 | 6PASS / 3PASS |
| 단독 Web 전체1회 | **3,938PASS / 0FAIL / 기존3SKIP**, 265PASS/1SKIP 파일(총266), 54.46초 |
| source/프로세스 | 907파일 SHA256 before/after 전부일치, 소유heavy0·15341listener0·diff check0 |

CAD current4는320/390light·1024/1440dark에서 provisional/held tile ready=false·disabled 물리API0→실제 renderer ready→dirty/undo·확인 취소 focus·44px hit→mock apply ACK를 검증한다. 적용 payload는 candidateIds[]/expectedRevision1/confirmMapResettrue/leaseTokenlease-floor-1/leaseFence1이며 mock4회다. cancel/scope4는320/1440에서 각각 held1/released1의 늦은 응답 후 preview0/apply0을 확인했다. 전체 CAD8의 unknown/unhandled0, mockcancel총2이며 실제 backend/장비 write는 없다.

최종 `browser-full-results/control-cad-preservation-C-8e946-nt-dirty-and-mock-apply-390-chromium/cad-review-390.png`와 `control-cad-preservation-C-07a31-t-dirty-and-mock-apply-1440-chromium/cad-review-1440.png`를 실제 열었다. light/dark의 fixture3도형·preview containment·표시완료 안내·apply를 확인했다. 이는 합성 fixture 대표2장면이며 실제 DWG 변환·모든 CAD 색의 AA 인증이 아니다. 아래 취소 action은 내부 scroll 대상이다. 추가로320applied/1440scope PNG도 열었으며 후속 맵loading 상태이므로 새 맵 완전paint/404표시완료로 확대하지 않는다.

fixture 추출 직후 기존함수/등록본문동일을 확인했고 이후 canvas parameter와 prepared tile descriptor의 type-only 보완을 별도로 했다. 원 CAD expect200은 spec+support 합산 그대로이며 기존 제어 E2E52도 유지한다. 기존 legacy CAD journey 전체는 이 runner에 없으며 새8건/타입 검사를 그 전체 PASS로 기록하지 않는다. 기존3SKIP·pnpm ignored-overrides·색출력/큰chunk·Konva 경고와 운영backend/native/HIL/확대·OS키보드 등 미검증 경계는 유지한다. 원212실패·후속delta62와 이번 새로운 전체229를 혼합하지 않는다. 독립 task/whole-branch 리뷰와 병합은 총괄의 별도 관문이다.
