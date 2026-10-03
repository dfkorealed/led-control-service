# Android·iOS WebView 앱 구현 명세

## 사용자 요청과 완료 기준

사용자는 기존 조명 관제 서비스를 React Native로 Android·iOS에서 실행하도록 구현하고, 기존 UI/UX 디자이너와 각 페이지 담당 채팅이 협업하여 모바일 사용 불편을 수정하도록 요청했다. 2026-09-29 WebView 검토의 후속 구현이다. 기존 웹·쿠키 인증·현장 제어를 재사용하고, 실행 가능한 앱 구성과 필요한 OS 기능을 제공한다.

완료 증거는 실행 구성, 양 플랫폼 JS 번들, 타입·자동 테스트, 모바일 웹 주요 여정과 디자이너 검토다. 네이티브 빌드·기기 실행은 실제 도구가 가능한 범위에서 수행하고, 미실행을 통과로 기록하지 않는다. 스토어 제출·운영 배포·계정 생성·서명 자격증명·기존 DB·실장비 변경은 별도 작업이다.

## 기준과 역할

- 기준 소스: `1ea3fb6e`, 최신 `codex/mvp1-cloud-web`.
- 작업 checkout: `.worktrees/mobile-webview-audit`, 브랜치 `codex/mobile-app-20261003`. 기존 모바일 검토 브랜치는 보존한다.
- 총괄: 설계·공유 계약 승인·실행 체크리스트와 상태판·통합 검증.
- 모바일 구현 역할: `apps/mobile`, root 의존성 잠금 파일의 변경, 모바일 실행 보조 구성.
- 기존 Shell 담당 채팅: 모바일 shared 계약의 단일 writer, 이후 `apps/web` 공통 셸·브리지.
- 기존 페이지 담당 채팅: 각 메뉴 코드와 해당 메뉴 문서. 같은 파일은 한 writer만 수정한다.
- 기존 UI/UX 디자이너 채팅: 모바일 기준 검토와 최종 화면 확인. 전면 개편 시안의 미승인 변경을 섞지 않는다.

## 앱 구성

Expo의 안정 SDK를 이용한 React Native 앱으로 기존 `apps/mobile`을 완성한다. 초기 기준은 SDK 57, React Native 0.86 및 SDK가 요구하는 React 조합이며, Android 7 이상·iOS 16.4 이상이다. 더 오래된 iPhone 지원 요청이 오면 양 플랫폼 지원 조건을 맞추는 안정 SDK로 조정한다. Beta/canary를 사용하지 않는다.

앱 진입점, 앱 ID와 표시명, Metro/Babel, 개발 실행, 양 플랫폼 native 생성, 번들/export 및 로컬 빌드 명령을 제공한다. 앱 ID는 개발 기본값으로 문서화하며 상용 등록된 회사 앱 ID로 확인됐다고 주장하지 않는다. 환경 파일에는 URL 같은 공개값만 넣으며 비밀번호·서버 secret은 넣지 않는다.

`EXPO_PUBLIC_WEB_URL`을 명시적으로 설정한다. 개발 private HTTP는 개발 빌드에 한정하고 운영은 HTTPS다. 기본 URL이 서비스 origin만 가리키면 로그인 경로로 진입한다. 누락/잘못된 URL은 render 예외로 앱을 종료시키지 않고 연결 준비 실패 화면으로 안내한다. 실제 운영 URL 미정이어도 개발 URL 설정과 release 입력 방법을 제공한다.

네이티브 safe-area를 단일 소유자로 두고 웹의 중복 inset을 방지한다. Android 키보드 resize와 iOS 키보드 동작을 검증하며 글자 확대를 무조건 비활성화하지 않는다. 시스템 status bar와 앱 배경색은 기존 서비스 토큰과 조화시킨다.

## WebView 셸 동작

- 최초 로딩, 긴 로딩, 네트워크/HTTP 실패, 재시도, WebView 프로세스 종료 복구를 제공한다. 이미 표시한 화면을 polling마다 가리지 않는다.
- 허용한 웹 origin만 WebView 안에서 실행한다. whitelist의 OS handoff를 포함해 외부 링크 정책을 실제 동작 기준으로 구현한다. 임의 URL·scheme을 네이티브 권한으로 실행하지 않는다.
- 정적 초기 script는 모바일 표시·safe-area flag만 제공한다. 현재 문서의 onLoadEnd에서 fresh documentId와 AppState/online bootstrap을 전달하고 웹 첫 mount는 이를 기다린다. 기다림이 window load를 막는 top-level await가 되면 안 된다. Android loading=false SPA history는 같은 문서를 유지한다.
- native AppState와 네트워크 상태는 저빈도로 웹에 전달한다. 지도 camera·조명 제어 명령은 네이티브 브리지로 옮기지 않는다.
- Android back은 웹 모달·변경사항 확인·라우터 이동을 처리한 뒤 최상위에서 앱의 기본 종료를 사용한다. 웹 처리 지연/실패를 근거로 미저장 편집 확인을 우회하지 않는다.
- 새 문서·origin 변경·프로세스 종료 시 이전 문서의 callback과 파일 작업을 정리한다. stale 응답으로 다른 문서에 작업하지 않는다.

## 최소 shared 브리지

`packages/shared/src/mobile-webview-contracts.ts`에 strict v1 메시지와 `@led-control/shared/mobile-webview-contracts` subpath를 제공한다. Shell 담당만 먼저 구현·검증·커밋하고 소비자가 사용한다. React/DOM/Node 전용 의존성은 계약에 넣지 않는다.

계약 범위는 웹 준비·뒤로가기 처리 결과, 파일 저장/공유 요청과 결과, 모바일 환경/AppState/online이다. 모든 요청은 유한 길이의 requestId, 허용 type과 명시적 version을 사용하며 알려지지 않은 필드·형식·과대 메시지는 거부한다. 세션 토큰·임의 script·제어 명령·임의 native API를 허용하지 않는다.

파일은 기존 웹 권한으로 읽은 PDF·CSV 바이트를 네이티브에 전달한다. native가 임의 외부 URL을 가져오거나 WebView 쿠키를 복제하지 않는다. 최대 파일은 20MiB, 기본 chunk는 64KiB 이하이고 순서·중복·선언/실제 byte 수를 검증한다. 한 번에 한 파일, 30초 inactivity 제한, 실패/문서 변경 시 부분 파일 정리를 적용한다. 파일명은 경로 구분·상대 경로·제어문자를 거부/정규화하고 앱의 전용 임시 저장소에만 쓴다.

최신 메인의 보고서는 PDF 전용이다. CSV 내보내기를 유지하며 XLSX 기능을 되살리지 않는다. 웹 브라우저에서는 기존 다운로드 동작을 유지한다. 앱에서 저장/공유 진행·실패·취소를 안내하며 실패를 성공으로 표시하거나 몰래 브라우저로 우회하지 않는다.

Expo Sharing의 반환값은 실제 파일 저장 여부나 OS 공유창의 취소 여부를 구분하지 못한다. 따라서 공유창 종료는 handoff 완료로만 표현하고 실제 저장 성공이라고 표시하지 않는다. 웹에서 명시적으로 요청한 취소와 바이트 전송 오류는 별도의 결과로 처리한다.

## 웹 공통 동작

native active/online 이벤트를 React Query focus/online 상태와 연결하여 복귀 시 인증·관제·활성 명령을 재검증한다. reconnect에서 제어 POST를 자동 재전송하지 않는다. 진행 중 명령은 기존 서버 이력/멱등키를 이용하며 principal·tenant 전환 시 다른 계정의 복구 데이터가 노출되지 않도록 유지한다.

검증된 모바일 환경에서만 versioned 사용자·사이트별 동기 저장 adapter로 원본 요청과 미완료 상태 확인 UUID를 보존한다. 기존 브라우저 sessionStorage 의미는 유지하고, 로그아웃·사용자 변경·완료 후 정리를 함께 구현한다. 읽기/쓰기 실패는 복구 가능으로 숨기지 않고 새 제어 요청을 차단하며 쿠키·인증 토큰은 기록하지 않는다. 모바일 판별 bootstrap은 첫 React mount보다 먼저 제공한다.

네이티브 back 요청은 기존 라우터와 dirty editor 보호를 사용한다. 모달·drawer·날짜 선택 같은 일시적인 화면을 먼저 닫고 웹 history로 이동한다. 인증 방식이나 API/DB 계약은 바꾸지 않는다.

## 페이지별 모바일 UX

공통 기준은 320/390px에서 page 가로 overflow가 없고, 주요 동작이 잘림/겹침 없는 44px 이상의 터치 영역을 가지며, keyboard와 하단 navigation이 주요 동작을 가리지 않는 것이다. 긴 기술 설명을 추가하거나 화면을 임의로 전면 개편하지 않는다.

- 모니터링: 실제 수동 상태 확인·지도/목록·선택 상세를 유지하고 좁은 화면의 상세 스크롤·지도 터치 충돌·하단 선택 action을 검토한다.
- 제어: 대상 선택·설정 밝기·관측 밝기 의미와 확인 필요를 유지한다. 재시작/복귀에서 서버 결과 확인을 제공하고 중복 명령 재전송을 막는다.
- 통계: PDF/CSV의 앱 공유 흐름을 연결한다. 날짜·차트·표·데이터 없음과 실제 0의 의미를 유지한다.
- 설정: 가로 스크롤 탭·계정 입력·파일 선택을 검토한다. native background에서 dirty draft를 저장하고 복귀 시 편집 lease·권한·renderer 상태를 검증한다. 업로드 재개를 구현한 것처럼 표시하지 않는다.

## 검증과 문서

의미 있는 RED→GREEN 회귀로 hostile bridge input, 외부 navigation, bootstrapping, back 처리, file limit/순서/timeout/취소, reconnect와 명령 복구를 검사한다. 앱 기본 URL 누락, offline, 프로세스 종료, 계정 전환을 검증한다.

모바일 테스트와 양 플랫폼 bundle/export, Web 타입·단위·build·UI 정책, 관련 Playwright touch context를 실행한다. native prebuild와 실제 APK/iOS build 가능성은 도구 상태를 확인한 뒤 판단한다. 실제 authenticated 장비 여정·GPU·OS 파일 picker 검증이 없는 부분은 한계로 남긴다.

메뉴 변경과 함께 `docs/menus/{monitoring,control,statistics,settings}.md`를 소유 담당이 최신화한다. 총괄은 `docs/project-status.md`와 활성 실행 체크리스트를 함께 갱신한다.

## 결정 기록

- 2026-10-03: 사용자 요청은 앞선 WebView 검토를 구현하라는 지시와 담당 세션 협업을 포함한다. 해당 범위의 설계·계획·코드 구현을 연속 진행한다.
- 2026-10-03: native worktree 도구는 이 채팅의 artifact 폴더가 Git 저장소가 아니라 생성 불가를 반환했다. 깨끗한 기존 모바일 검토 checkout에 최신 메인 기준 새 브랜치를 만들어 기존 작업을 보존했다.
- 2026-10-03: Xcode는 CommandLineTools만 활성화돼 있고 adb 연결 기기는 없으며 Android SDK는 아직 확인되지 않았다. JS 번들과 native 실행 증거를 구분한다.

- 2026-10-04: native 최종 Android APK·실제 fixture 검증 완료. 원본 문서 ID가 일치하지 않는 queued generic 주입은 bootstrap 전/새 문서에서 dispatch하지 않는다. 공유창 대기 시간은 바이트 전송 inactivity 제한에서 제외하며 sheet 반환까지 임시 파일 소유권을 유지한다.

- 2026-10-04 최종: Android 실제 로그인 IME 가림을 KAV height/default offset0으로 보정하고 두 번 열기·닫기 및 최종 APK 설치를 재검증했다. Native51·양 플랫폼 Hermes export, canonical root lint/typecheck/test/build와 관련 Chromium118/118을 완료했다. 디자이너 국소 지적 인수·독립 재검토를 마치고 검증한 제품 코드를 기존 기본 checkout에 로컬 반영했다. URL 설정/재빌드·iOS native·실제 인증/HIL·운영 signing/배포는 위 완료 기준과 구분한다.
