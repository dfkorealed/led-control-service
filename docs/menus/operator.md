# 운영자 메뉴 기능 현황

최신 공통 검증(2026-10-18 Task2 테스트 서버 수리 후): 실제 main `95a1cc07`에서 **Web 3,941 PASS / 0 FAIL / 기존 3 SKIP**(51.83초), 전체 안전 Chromium229개 **226 actual PASS + 의도된 차단 FAIL3**, unexpected/skip/flaky0(383.418891초)을 확인했다. 실제 무데이터 TCP 연결의 종료 대기를 RED로 입증하고 소유 HTTP 서버 연결만 종료하도록 수리했으며 기존 기능·단언·설정을 유지했다. 단일 브라우저 진단은 원 timeout을 재현하지 않아 원 socket 소유자는 미확정이고, 원 I1의 독립 종료 판정은 총괄의 새 검토 대상이다. inventory38/제어8 물리쓰기0/CAD8 오류0, 공개 기본/QA 검사·타입·빌드·정책79/위반0·계약6+3, 대표 PC/mobile PNG와907source/runner 불변을 확인했다. 실제 backend·장비·native 인증은 아니다. [새 원증거와 한계](../assets/web-design-system-2026-10-16/coverage.md#2026-10-18-task2-테스트-서버-종료-수리와-새-전체-검증)를 따른다.

이전 공통 검증 이력(2026-10-18 기존 브랜치 병합 후): 실제 main `d87a1901`의 마지막 단독 Web 전체는 **3,939 PASS / 0 FAIL / 기존 3 SKIP**(47.05초)다. 전체 안전 Chromium229는 **225 actual PASS + 의도된 차단 FAIL3 + 예상 밖 foundation cleanup timeout1**, skip/flaky0(373.614705초)로 **브라우저 gate는 FAIL**이다. body의 마지막1440px 단언·page.close 뒤 메모리 서버 정리를 기다렸으며 원인은 확정하지 않았다. 추가 진단은 선택 오류로0개 실행되어 해결 근거가 아니다. inventory38/CAD8·기본/QA 정적 랜딩 각6·public landing 각5+모드상3SKIP/service 각8, 타입/E2E타입·빌드·UI정책79/위반0·계약6+3은 통과했다. 소스907/hash·기존 미커밋 변경을 보존했으며 실backend·장비·native 인증은 아니다. [새 원증거와 한계](../assets/web-design-system-2026-10-16/coverage.md#2026-10-18-기존-브랜치-통합-후-새-검증)를 따른다.

이전 공통 검증 이력(2026-10-18 후속 최종 보완): test-only 최종 source의 단독 Web 전체 1회는 **3,939 PASS / 0 FAIL / 기존 3 SKIP**다. 이번 집중 Chromium은 CAD8+foundation7 PASS, 정적 랜딩 기본15185/QA15342 각각6 PASS, public landing 기본5187/QA15342 각각5 PASS+기존 서비스 전용3 SKIP, public service 두 포트 각각8 PASS다. 타입/E2E타입·빌드·UI정책79 PASS/위반0·landing6/public3 계약을 통과했다. 이전 Task8의 전체 안전 Chromium229 expected(실제226 PASS+의도된 차단 FAIL3)는 별도 source의 전체 회차이며 이번 집중 결과와 합산하지 않는다. 제품·기본 config·원 안전 관문을 보존한 mock 소프트웨어 검증이며 실장비·실backend·native 인증은 아니다. [공통 증거와 회차별 한계](../assets/web-design-system-2026-10-16/coverage.md)를 따른다.

이전 공통 검증 이력(2026-10-17 최종 보완): 단독 Web 전체 1회는 **3,928 PASS / 6 FAIL / 3 SKIP**다. 제어5와 CAD `common=true, interruption=site`의 초기 preview-ready1이 실패했다. CAD는 focused1PASS로 미재현됐지만 원인은 미확정이다. 결합212의 cleanup1실패와 후속62expected(실제59PASS+3의도된차단FAIL), 수명helper4unitPASS를 구분한다. 당시 전체 gate는 FAIL이었으며 아래 Task6/Task5 수치는 해당 회차 이력이다. [당시 공통 증거](../assets/web-design-system-2026-10-16/coverage.md)를 따른다.

## 2026-10-17 공통 디자인 시스템 전체 coverage (Task 6)

### 구현 완료

- 운영자4route를390/1440px의 실제 loaded region·단일h1·functional title·main gutter18/14·24/28와 max1160으로 확인했다. fresh 보안/계정/calm24개에서 actual credentials/TOTP/recovery, 양shell password focus, 현장 관리자4행7필드/8라벨·작업과 pending/error/empty 복구 근거를 [coverage](../assets/web-design-system-2026-10-16/coverage.md)에 연결했다.

### 미구현

- 실제 운영자 계정·프로파일 승인/철회·상담/메일·native·장비/HIL은 실행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 현장 관리자 열합1230>최대content1104에 따른 card 상태만 확인했으며 operator table 표시 완료가 아니다. 프로파일·문의의 모든 populated/pending/error/cursor 조건은 browser 미실행이다. 최종 전체 단독 실패와 인과 한계는 coverage QA를 따른다.
- 최종 결합164expected/0unexpected(3expected-teardown포함), 별도auth/operator24PASS다. 단독전체3925PASS/5ControlFAIL/3SKIP이며 CAD85PASS의미재현은과거원인해결증명이아니다.

### 관련 파일

- `apps/web/e2e/{design-system-coverage,design-system-security,account-security,calm-operations-auth-operator}.spec.ts`, `docs/assets/web-design-system-2026-10-16/coverage.md`.

### 갱신 규칙

- 실제 card/table·동작 권한과 source/unit-only 조건부 범위를 구분한다. 상태명이나 mock fixture 이름만으로 기능 성공/오류를 집계하지 않는다.

## 2026-10-16 공통 디자인 시스템 Task 2

### 구현 완료

- 현장 관리자·센서 프로파일·상담 문의·계정 보안의 page 제목 역할, section20px·card grid18px와 일반 카드 inset20/16px를 공통 표현으로 연결했다. 운영자 main은 최대1160px를 유지하며 desktop 좌우28/상하24px, compact 좌우14/상하18px를 사용한다.
- 계정 보안은 operator presentation을 명시하고 shell의 h1 하나를 유지한다. 공통 modal/drawer 일반 inset과 상태 표시를 정합화했으며 기존 권한·API·cursor·프로파일 승인/철회·비밀번호·MFA·세션 수명은 유지한다.

### 미구현

- 실제 운영 계정·NAVER WORKS·서버/장비·native/HIL 검증과 배포는 수행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 현장 관리자 열의 최소폭 합1230px가 현행 operator 최대 content1104px보다 커 현재 지정 viewport에서는 모두 카드 목록이다. 기존 label 기반 시험은 UL을 표로 오인했다. Task2 최초 검증은 고객사/현장/아이디·수정/지정만 행별로 확인했으며 설치·관리자·계정 상태·시각과 모든 행의 재설정/삭제까지 확인한 것은 아니었다. 독립 검토 후5개 폭(320/390/1024/1378/1440)의4행에서7개 표시 필드의 라벨/정확한 값·작업 열, 관리자 있는2행의 수정/재설정/삭제 각3개 활성 상태와 미지정2행의 지정1개 활성 상태를 보강했다. 실제 operator 표 표시 완료로 기록하지 않는다.
- 공통 오버레이 변경은 기반과 Task2 소비 범위다. 타 feature의 별도 내용 inset은 후속 작업과 전체 소비 검증 대상이다.

### 관련 파일

- `apps/web/src/features/operator/{OperatorShell,SensorProfilesView,LandingInquiriesView}.tsx`, `apps/web/src/features/operator/site-admins/SiteAdminManagementView.tsx`, 공통 `apps/web/src/components/ui/{FunctionalLayout,FeedbackState,RouteLoadingState,AppRecoveryState,overlays/DialogBase}.tsx`.
- `apps/web/e2e/{design-system-security,account-security,calm-operations-auth-operator,ui-overlays}.spec.ts`.

### 갱신 규칙

- 카드/표 전환은 viewport 명칭 대신 실제 container 폭과 semantic surface를 확인한다. mock 소프트웨어 시험과 실제 권한·메일·장비 증거를 구분한다.

## 2026-10-14 공통 로딩 표시 적용

### 구현 완료

- 관리자 목록·상담 문의/메일 연결 상태·센서 프로파일 초기조회·승인 등록 및 기존 저장/삭제/로그아웃 버튼을 공통 loading으로 연결했다. 공통 코어는 스피너20px·reduced-motion·disabled/ref/activation을 보존한다.

### 미구현

- 실제 NAVER WORKS 연결/상담 접수·메일 수신/프로파일 등록·운영 계정 mutation을 수행하지 않는다.

### 부족하거나 개선이 필요한 기능

- 실제 Query의 offline→online→빈 목록 단위 검증에서 paused는 busy spinner 없이 연결 대기, online 재개는 spinner, 완료는 빈 결과로 구분했다. 기존 메일 전달/프로파일 준비 상태는 변경하지 않는다.

### 관련 파일

- `features/operator/{LandingInquiriesView,SensorProfilesView,OperatorShell}.tsx`, `site-admins/SiteAdminManagementView.tsx`, `components/ui/{Button,IconTooltipButton,RouteLoadingState,LoadingIndicator,LoadingState}.tsx`, `e2e/common-loading.spec.ts`.

### 갱신 규칙

- 운영자 표시 변경 시 실제 action/query pending과 domain status를 구별하고 mock browser 결과를 live 접수/운영 변경으로 기록하지 않는다.

## 2026-10-12 계정 보안 route 제목 소유 보완

### 구현 완료

- `/operator/security`는 기존 공통 `PageHeader`로 `계정 및 보안` h1 하나를 표시한다. 고객 설정은 기존 `SettingsShell`이 제목을 소유하고, 공통 `AccountSecurityView`의 비밀번호 요약·변경 팝업·MFA·활성 세션을 그대로 소비한다.

### 미구현

- 실제 운영 계정·배포 환경의 로그인/보안 API 확인과 전체 canonical CI는 별도 관문이다.

### 부족하거나 개선이 필요한 기능

- 다른 운영자 route의 기존 제목 소유와 권한·API·로그아웃 계약은 유지한다. 관련 네 파일 116개 단위 회귀는 mock API 범위이며 실제 MFA·메일·실장비 증거가 아니다.

### 관련 파일

- `apps/web/src/features/operator/OperatorShell.tsx`, `OperatorShell.test.tsx`.

### 갱신 규칙

- 공통 계정 화면을 다른 shell에서 소비할 때 제목 소유자를 확인하고 단일 h1, 비밀번호 팝업 진입과 기존 MFA·세션 조회를 함께 검증한다.

## 2026-10-08 센서 호환 프로파일 관리 (Task 5)

- 구현 완료(소프트웨어): 기존 `OperatorShell`·공통 UI·서비스 제공자 활성 operator 권한 경계를 재사용한 `/operator/sensor-profiles`를 추가했다. 현장 관리자 계정 목록과 분리하며 보호된 route 밖에서는 프로파일 API/승인 입력을 마운트하지 않는다.
- 구현 완료(소프트웨어): 서버가 제공하는 profileId/revision/status/evidenceDigest/reuseScope 요약을 표시한다. 승인 폼만 Shared의 strict 전체 프로파일 형식을 검증하고 검증 근거·재사용 범위에 대한 명시적 확인 후 새 승인 revision을 POST한다. 기본 샘플이나 자동 승인/seed는 만들지 않는다. 철회는 공통 확인 dialog 후 서버의 immutable append 경로를 사용한다.
- 구현 완료(이력 경계): profileId별 최대 revision을 현재 기록으로 표시하며 현재 승인 revision에서만 철회를 제공한다. 이전 승인·철회 revision은 읽기 전용 이력으로 유지한다.
- 구현 완료(소프트웨어): append/revoke 뒤 프로파일·dashboard·등록 session의 카탈로그 대조 조회를 무효화한다. 초기 승인 목록이 비어 있음을 명시하며 승인 등록만으로 개별 센서의 사용 가능/건강·현장 정책 ON을 보장하지 않는다.
- 미구현: 실제 장비군 qualification과 최초 승인 근거 확보, 운영 승인 데이터 작성·배포·실장비 검증은 수행하지 않았다. 자동 profile 추정이나 일반 사용자 raw body/fingerprint 입력은 제공하지 않는다.
- 부족하거나 개선이 필요한 기능: 보호된 운영자 폼은 기술 계약 전체를 JSON으로 입력하는 최소 인터페이스다. 새 통신 방식·decoder가 필요한 장비는 데이터 등록만으로 호환되지 않는다. API는 저장 시 현재 운영자 권한과 순차 revision을 재검증한다.
- 관련 파일: `apps/web/src/features/operator/{OperatorShell,SensorProfilesView}.tsx`, `apps/web/src/api/automation.ts`, `apps/web/src/features/operator/{OperatorShell,SensorProfilesView}.test.tsx`.
- 갱신 규칙: 화면 입력 검증·서비스 승인 기록·실제 장비 검증·현장 정책과 개별 준비 상태를 별도 증거로 유지한다. UI 시험용 프로파일 JSON을 운영 승인 데이터로 기록하지 않는다.

## 2026-10-06 공통 Grid 현재 목록 정렬

- 최종 통합 관문 완료: 제품 `1c600eda`에서 전체 Web3258PASS·기존3SKIP, 타입/빌드/UI정책0·관련33브라우저33PASS, 코드/UI 검수 차단0을 확인해 로컬 기본 브랜치에 병합했다. 아래 표적 증거와 실제 운영 계정/메일/native/HIL 한계는 그대로 유지한다.

- 구현 완료: 현장 관리자 목록의 고객사·현장·설치 상태·관리자 이름/아이디/상태·최종 변경과 문의의 접수번호·접수일·회사/담당자·회신 정보·내용·메일 상태에 정렬 값을 연결했다. 관리자 미지정은 누락값으로 처리하고 작업 버튼은 정렬에서 제외한다.
- 구현 완료: 기존 HTML table/caption/중앙 TH와 컨테이너 기반 카드 전환을 유지한다. 표 헤더의 공통 Button/Enter/Space, 활성 TH의 aria-sort/방향 아이콘과 카드의 공통 React Aria SelectBox/방향 버튼이 동일 상태를 소비한다. 한글·numeric 문자열, 숫자·날짜·boolean, 동일값 안정 순서와 누락/잘못된 날짜·비유한 숫자의 양방향 마지막 배치를 지원한다. 원본 행 배열을 변경하지 않고 데이터 갱신·정렬 컬럼 제거에도 유효한 상태만 사용한다.
- 미구현: 서버 커서 전체 정렬/API 정렬은 제공하지 않는다. 화면의 '현재 목록 안에서 정렬'은 전달받은 현재 행만 의미하며 기존 조회·필터·커서 계약을 유지한다.
- 부족하거나 개선이 필요한 기능: 관리자 29개·문의 13개 직접 회귀에서 정렬·관리자 미지정·기존 작업/커서/메일 경로를 확인했다. 실제 운영 계정·메일 전달 검증은 추가하지 않았다. 공통/여섯 소비자의 표적 단위 235개와 정렬 브라우저 2개는 software fixture 범위다. 전체 Web 검증·독립 최종 검수는 총괄 관문이며 실제 native WebView·센서·Gateway·LED HIL의 증거가 아니다.
- 관련 파일: 공통 `apps/web/src/components/ui/DataGrid.tsx` 및 대응 테스트, `apps/web/src/features/operator/LandingInquiriesView.tsx`, `site-admins/SiteAdminManagementView.tsx` 및 대응 테스트.
- 갱신 규칙: 정렬 접근자/헤더/카드 변경 시 현재 목록 범위·표/카드 상태·동일값/누락값·원본 불변·행 작업·기존 pagination 회귀와 실제 키보드/44px 접근을 함께 확인한다.


- 2026-10-05 공통 초기 초점 안정성 보완: Dialog 내부 ref를 안정화해 중첩 Popover가 열린 동안 부모 재렌더·외부 object/callback ref 교체가 사용자 초점을 빼앗지 않으며 이전 ref 정리와 닫힘 시 정리는 유지한다. 직접 공통 회귀와 격리 Chromium 검증 범위이며 실제 native WebView·HIL 및 최종 통합 승인을 뜻하지 않는다.

## 2026-10-05 공통 컨테이너 기반 목록 표시 (추가 운영 UI Task 4)

- 구현 완료: 상담 문의와 현장 관리자 목록은 동일 공통 DataGrid를 소비한다. window가 넓어도 실제 목록 컨테이너 폭이 부족하면 라벨이 붙은 카드로 전환하고, 넓으면 중앙 TH의 HTML table/caption을 제공한다. 이름·시각·메일·문의·상태·기존 작업 버튼은 두 surface에서 동일하게 제공하고 긴 값은 줄바꿈한다.
- 구현 완료: 문의 cursor/메일 연결·관리자 생성/지정/수정/비밀번호/삭제 확인 API와 운영자 Shell 인증·권한/MFA gate는 유지한다. 기존 화면에 검색/상세 필터가 없으므로 가짜 검색이나 새 조회 조건을 만들지 않는다.
- 미구현: 실제 운영 계정/DB·NAVER WORKS OAuth/수신·native/HIL·전체 폭/200% 최종 통합 검증은 별도 관문이다.
- 부족하거나 개선이 필요한 기능: narrow-container 단위 회귀는 데이터·행동 보존 및 mutation 미발생을 검증하며 실제 운영 권한/메일 전송 증거가 아니다. 최종 실제 bounds/overflow 검수는 Task 9에서 수행한다.
- 관련 파일: `apps/web/src/features/operator/LandingInquiriesView.tsx`, `site-admins/SiteAdminManagementView.tsx`와 직접 테스트; 공통 `apps/web/src/components/ui/DataGrid.tsx`는 기존 승인 계약만 소비한다.
- 갱신 규칙: table/card 전환·장문·모든 필드·권한·행동·페이지 이동을 함께 검증하며 기존 API/인가와 표시 변경의 증거를 분리한다.

기준일: 2026-09-27

## 2026-10-02 실제 시각 표시 통일

- 구현 완료: 현장 관리자 계정의 최종 변경 시각(표·모바일 카드)과 상담 문의 접수 시각을 기존 공통 `formatTimestamp`의 `yyyy-MM-dd HH:mm:ss`로 표시한다. 기존 기기 시간대 의미를 유지하며 Gregorian/h23·자정 `00:00:00`·잘못된 시각 `—` 계약을 사용한다. 관리자 미지정의 `-`는 시각이 없는 별도 상태로 유지한다.
- 구현 완료: 운영자 권한·관리자 지정/생성/수정·비밀번호 재설정·현장 삭제 확인, 상담 문의 pagination·발송 상태·NAVER WORKS 연결 동작은 변경하지 않는다. source ISO·저장/API·공개 랜딩도 유지한다.
- 미구현: 실제 운영 계정/DB·NAVER WORKS·HIL 검증은 이번 표시 작업에 포함하지 않는다.
- 부족하거나 개선이 필요한 기능: 직접 화면 테스트는 UTC/Asia-Seoul의 초·자정·invalid 표시와 기존 관리 동작을 검증한다. 브라우저 fixture 및 자동 검사 통과를 실제 운영 인가·메일 수신 증거로 해석하지 않는다. 독립 통합 검토는 총괄의 후속 관문이다.
- 관련 파일: `apps/web/src/features/operator/site-admins/SiteAdminManagementView.tsx`, `apps/web/src/features/operator/LandingInquiriesView.tsx` 및 직접 테스트. 공통 formatter의 기존 export만 소비한다.
- 갱신 규칙: 시간대·접수/갱신 표시 계약을 수정할 때 직접 표시 및 기존 관리/인가 회귀를 함께 실행하고 문서를 갱신한다.

## 구현 완료

- Final Atlas 운영자 셸에 상담 문의 메뉴·라우트를 함께 보존했다. 통합 전체 검증 상태는 [통합 체크리스트](../superpowers/plans/2026-09-27-atlas-landing-integration.md)를 따른다.
- 운영자 전용 `/operator/landing-inquiries` 메뉴에서 최근 상담 문의와 메일 상태를 조회한다. 기존 운영자 기본 경로 `/operator/site-admins`를 유지하며, 익명 요청은 401, 고객 admin/viewer 요청은 403으로 차단한다. 화면도 operator 이외 역할을 고객 모니터링으로 돌린다.
- 문의 목록은 접수번호·접수일·회사/담당자·회신 정보·내용·발송 상태를 최근순으로 보여주고 불투명 커서로 20건씩 이전/다음 페이지를 이동하며, 이후 페이지 조회 실패 중에도 이전 페이지로 돌아갈 수 있다. 만료된 문의는 조회에서 제외한다. 응답은 `Cache-Control: no-store`이며 토큰, 내부 문의 ID와 제공자 응답 원문은 노출하지 않는다.
- 공개 요금제 페이지에서 선택한 Basic/Plus는 별도 DB 필드 없이 기존 문의 `message`의 `선택한 요금제:` 머리말로 접수된다. 운영자는 본문을 바꾼 고객의 문의에서도 이 머리말로 선택 맥락을 확인할 수 있다.
- `GET /operator/landing-mail/status`로 로컬 연결 상태를 확인하고, 미연결 또는 기존 연결을 교체할 때 `POST /operator/landing-mail/authorize`로 독립 NAVER WORKS 구성원 OAuth를 시작한다. `mail` 범위의 인가 URL만 브라우저 이동을 허용한다. 연결된 상태에도 `NAVER WORKS 다시 연결`을 제공한다. 새 인가 시작은 이전 URL을 무효화하며, 단회 10분 state와 PostgreSQL 잠금으로 오래된 callback의 덮어쓰기를 거부한다. 공개 Web origin의 `/api/landing-mail/oauth/callback`은 토큰을 암호화 저장하고 같은 origin의 운영자 문의 화면으로 돌려보낸다. 명시적으로 거부된 refresh 자격 증명은 미연결과 새 문의 503으로 전환하며 일시 장애는 연결을 유지한다.
- 메일 worker는 시작 시와 30초마다 대기 문의를 처리한다. NAVER WORKS HTTP 202만 `provider_accepted`와 응답 후 수락 시각으로 기록하고 `queued`, `retry_wait`, `delivery_uncertain`, `failed`를 구분한다. 호출 전 OAuth 오류 또는 확정 429 거부만 제한적으로 재시도하며 수락 여부가 불확실하면 중복 전송을 막기 위해 닫는다.
- 접수 후 90일이 지난 문의 원본과 발송 메타데이터를 한 번에 최대 100건씩 삭제한다. `landing_inquiry_prune` JSON 이벤트의 숫자 `deletedCount`로 실제 삭제 건수(0 포함)를 관측한다. 삭제 대기 중에도 만료된 문의는 목록과 발송 대상에서 제외한다.
- 소프트웨어 검증은 API의 권한·OAuth·PostgreSQL worker 통합 테스트와 Web 운영자 화면·Chromium 경로 검사를 통과했다.

## 미구현

- 운영자 수동 재발송 버튼/API와 자동 불확실 결과 재발송은 제공하지 않는다.
- NAVER WORKS 받은편지함 도착 여부를 서비스 안에서 확인하는 기능은 제공하지 않는다.

## 부족하거나 개선이 필요한 기능

- 실제 운영 자격 증명으로 OAuth 연결, 발송 및 받은편지함 수신을 아직 검증하지 않았다. 화면의 `연결됨`은 로컬 토큰 준비 상태이고 `제공자 수락`은 HTTP 202이며 최종 수신 증거가 아니다. [운영 절차](../runbooks/landing-mail-setup.md)에 따라 배포 후 확인한다.
- `delivery_uncertain` 또는 `failed`는 접수번호를 NAVER WORKS 보낸메일·수신 상태와 대조하고 회신 필요 여부를 운영자가 판단해야 한다. worker가 중단되거나 대량 만료 백로그가 쌓이면 물리적 삭제가 늦을 수 있다. 메일 사본은 NAVER WORKS 보유 정책을 따른다.

## 관련 파일

- 화면: [운영자 셸](../../apps/web/src/features/operator/OperatorShell.tsx), [문의 화면](../../apps/web/src/features/operator/LandingInquiriesView.tsx), [웹 API 어댑터](../../apps/web/src/api/landing-inquiries.ts)
- API: [문의 조회](../../apps/api/src/landing-inquiries/operator-landing-inquiries.controller.ts), [연결 경로](../../apps/api/src/landing-inquiries/landing-mail.controller.ts), [OAuth](../../apps/api/src/landing-inquiries/landing-mail-oauth.service.ts), [전송](../../apps/api/src/landing-inquiries/landing-mail.transport.ts), [worker](../../apps/api/src/landing-inquiries/landing-mail.worker.ts), [DB 스키마](../database-schema.md)
- 검증: [문의 조회 권한 테스트](../../apps/api/src/landing-inquiries/operator-landing-inquiries.controller.spec.ts), [OAuth 통합 테스트](../../apps/api/src/landing-inquiries/landing-mail-oauth.integration.spec.ts), [worker 통합 테스트](../../apps/api/src/landing-inquiries/landing-mail.worker.integration.spec.ts), [운영자 화면 테스트](../../apps/web/src/features/operator/LandingInquiriesView.test.tsx), [랜딩 브라우저 테스트](../../apps/web/e2e/landing.spec.ts)

## 갱신 규칙

- 운영자 권한, 조회 항목·페이지 방식, OAuth 설정·연결 상태, 전송 결과·재시도, 90일 삭제가 바뀌면 이 문서와 [공개 랜딩 문서](landing.md), [운영 절차](../runbooks/landing-mail-setup.md)를 같은 작업에서 갱신한다.
- API 대역·격리 DB 검증과 실제 NAVER WORKS 연결·수신 검증을 별도로 기록한다.
