# iOS 서비스 연결과 실행 완료 계획

> **For agentic workers:** `superpowers:subagent-driven-development` 방식으로 담당별 작업을 실행한다. 총괄은 결과와 증거를 취합하여 체크리스트를 갱신한다.

**Goal:** 별도 브랜치에서 기존 React Native 앱을 실제 iOS 환경에 설치하고 서비스 웹 연결을 검증한다.

**Architecture:** 완료된 Expo57/RN0.86 WebView와 strict bridge를 유지한다. macOS 호환 stable Xcode와 iOS Simulator를 준비한 뒤 Pods·native build·설치·웹 진입을 확인한다. 사용자가 선택한 이 Mac의 iOS 시뮬레이터에 unsigned Debug 앱을 설치한다.

**Tech Stack:** Expo57.0.26, RN0.86.3, React19.2.3, WebView13.16.1, iOS16.4+, Node22/pnpm9.15.0, Xcode/CocoaPods.

**Spec:** `docs/superpowers/specs/2026-10-03-mobile-app-design.md`, 사용자 2026-10-04 iOS까지 최종 연결 및 별도 브랜치 지시.

## Global Constraints

- Base `fc9e7440`; 별도 브랜치 `codex/ios-service-connection-20261004`, 기존 격리 checkout `.worktrees/mobile-webview-audit` 재사용. 기본 브랜치에 병합하지 않는다.
- 기존 Android/Web·쿠키 인증·strict bridge·API/DB/실제 조명 제어 의미를 유지한다. shared/lock/API 변경은 총괄 승인 후 단일 writer로만 한다.
- 미확인 운영 URL·Apple 계정·서명 identity를 만들지 않는다. 비밀번호/OTP는 사람에게 직접 입력받는다. OS 업그레이드·기존 서비스 종료·운영 배포는 수행하지 않는다.
- Xcode 선택은 가능한 `DEVELOPER_DIR` process scope. 최초 설치·license에 필요한 OS 확인은 실제 요청이 발생한 뒤 정확히 안내한다.
- 코드·기기 설치·실제 웹 로그인 진입·인증된 계정/장비 여정을 별개 증거로 기록한다.

## Review Focus

- dev HTTP 주소는 개발 앱에서만 허용하고 운영 HTTPS/ATS 경계를 약화하지 않는다.
- cold WKWebView의 late bootstrap·full reload·background 복귀에서 stale 문서를 재사용하지 않는다.
- 키보드·safe-area·회전에서 로그인 입력과 action을 가리지 않는다.
- OS 공유의 handoff와 실제 파일 저장, byte전송 timeout과 공유창 대기를 구분한다.
- Simulator 성공을 물리 iPhone·TestFlight·실제 인증/조명 HIL 완료로 표현하지 않는다.

## Task 1: 설치·연결 대상 준비

**소유:** toolchain QA(전체 Xcode/Simulator), mobile writer(앱 설정), 총괄(대상·계획).

- [x] 기본 checkout과 기존 모바일 checkout clean/base를 확인하고 별도 브랜치를 만든다.
- [x] 현 macOS26.5.1·free120Gi·CommandLineTools만 존재·simctl 없음 상태를 확인한다.
- [x] 주소와 설치 대상을 비동기로 확인했다. 사용자는 이 Mac의 iOS 시뮬레이터를 선택했으며 운영 주소 답변 전에는 실제 local127.0.0.1:5173로 연결 준비한다.
- [x] OS 호환 stable Xcode26.6(17F113)를 사용자 폴더에 설치하고 archive/app Apple 서명을 검증한다.
- [x] 사용자 직접 설치 후 Xcode약관/SDK관문 해소를 확인했다. Xcode26.6(17F113), iOS/Simulator SDK26.5 조회exit0.
- [x] iOS26.5 runtime설치·LEDscheme eligible destination·taskowned iPhone17 생성/부팅을 확인한다. 실제실행은 사용자GUI최신build23F77이다.
- [x] 앱 native/Pods/URL 환경의 최소 필요한 수정안을 검토한다. 기존 production native 생성본은 ATS로 HTTP를 막으므로 개발 variant로 iOS만 재생성하는 절차를 승인했다. source/계약 수정은 필요하지 않다.

## Task 2: iOS 연결·빌드

**소유:** mobile writer; `apps/mobile`와 ignored `.local/ios-finalization` 소유.

- [x] 현재 local5173에 GET으로 로그인200·auth/me 미인증401을 확인한다. 운영 URL은 미입력이다.
- [x] 제품 source/config 변경은 필요하지 않음을 확인하고 iOS development 재생성·CocoaPods cwd·DEVELOPER_DIR·unsigned simulator 실행 README를 보완했다. 잘못된 pod project-directory cwd를 실제 재현한 후 iOS 디렉터리 실행으로 교정했다.
- [x] mobile51/51·typecheck exit0, development/production config·iOS development 한정 clean prebuild·Hermes export exit0. Android 생성물 및 정본 source/config/lock SHA 변경0. Ruby3.4.11·CocoaPods1.17.0 설치/version 확인.
- [x] CocoaPods1.17.0을 scoped 설치하고 개발 iOS 생성물의98 Pods/99dependencies·workspace 생성을 확인한다. CLT Xcode 버전 경고가 있어 full Xcode 준비 후 Pods를 재검증한다.
- [x] 선택한 full Xcode로 Pods 재검증 exit0(98Pods), 이전CLT/빈Xcodeversion 경고0을 확인한다.
- [x] iOS runtime/platform 준비 후 unsigned native Debug build를 수행했다. 동일 generic Simulator 명령의 재실행은 `BUILD SUCCEEDED`/exit0이다.
- [x] 검토된 README만 `97bcfd6e`로 scoped commit하고 indexslot을 반환했다.
- [x] `LED.app`·Info.plist/바이너리 검증·전체 파일 SHA manifest·원본 빌드 로그·Metro bundle handoff를 전달했다.

## Task 3: 실제 설치·UX와 최종 인수

**소유:** toolchain/native QA, 독립 reviewer, 총괄.

- [x] task소유 Simulator에 설치·cold launch하고 실제5173 서비스 로그인 진입을 확인했다. background/active와 재실행도 정상 화면으로 복귀했다.
- [x] 가능한 Playwright WebKit 3파일의 portable15/15을 독립 수행했다. expected15/unexpected0/skipped0/flaky0/errors0, Chromium CDP 전용3개는 실제 unsupported를 재현한 명시적 제외다. iOS native 실행과 구분한다.
- [x] 입력/키보드·safe-area·회전·복귀·cold restart를 실제5173에서, CSV 공유/취소/HTTP503 직접 retry는 격리 iOS fixture에서 검증했다. 인증된 메뉴·PDF/실제 저장·renderer 강제 종료·실폰/HIL은 미검증으로 구분한다.
- [x] 최초 focus/reopen의 웹 overflow와 native keyboard frame 정합을 동시에 측정하고 nearest 단일 A/B로 원인을 분리했다.
- [x] synthetic iOS bootstrap/doc boundary·CSV sheet/cleanup·cancel·HTTP503 직접 retry를 확인했다.
- [x] geometry prototype의 실제 center 보정으로 input/ring 가시성 및 Done 복원을 확인했다. 실제 서비스 정식 인수는 아래 최종 관문으로 유지한다.
- [x] 재사용 focus-script의 epoch/focus/gesture/lifecycle/paint 조건을 behavioral tests로 검증하고 정식 WebShell에 연결한다. 기본 환경 mobile9 suites/95tests·typecheck·iOS Hermes export exit0, 독립 wiring 검토 C0/I0/M0이다.
- [x] geometry prototype의 공식 Maestro swipe 실제 전달과 가로 폼/CTA 도달을 확인하고 portrait/keyboard hidden/scroll0으로 복원했다.
- [x] 필요한 시각/페이지 수정을 담당 역할에 순차 배정하여 재검증한다. 재사용 iOS helper와 네 메뉴 현황을 mobile 단일 writer가 갱신했으며 기존 페이지 업무 로직은 유지했다. UI/UX 디자이너가 실제 PW/CTA/가로 및 최종 원본7개를 확인해 지정 Simulator 조건의 V-06을 닫았다.
- [x] 소스·문서·검증 증거 독립 검토와 미해결 지적 처리를 완료한다. 최종 code C0/I0/M0·독립109/types0, source10/실제 PNG/메타데이터/ZIP74파일/원본 보존 및 디자이너 §14를 대조했고 추가 지적0이다. rootdocs2 최종 SHA와 scoped commit은 마지막 정리에서 기록한다.
- [x] 최종 diff·문서/체크리스트·별도 브랜치·산출물을 검증하고 사용자에게 실행 결과를 보고한다. 제품10경로는 `b1b2e01e`로 scoped commit·검토SHA 일치·index empty이며 rootdocs2는 별도 정리 커밋으로 기록한다. 기본 checkout은 clean `fc9e7440`, Metro helper --check exit0/실제5173이며 merge/push 없이 격리 checkout과 증거를 유지한다.

## 진행 기록

- 2026-10-04: 사용자 지시에 따라 이전 완료 브랜치와 기본 checkout을 보존하고 `fc9e7440` 기준 별도 브랜치로 전환했다. Xcode 설치 QA와 native 연결 writer의 독립 범위를 배정했다. 이전 Android 도구와 QA 증거는 보존한다.

- 2026-10-04: 도구 담당이 App Store 설치를 실제 시도했으나 최신 Xcode가 macOS26.6+를 요구하여 현재26.5.1에서 차단됐다. OS 변경 대신 호환 stable Xcode 아카이브를 Apple Developer에서 받는 경로를 준비했으며 해당 Chrome 로그인 탭에서 사용자 직접 인증을 기다린다. sudo 자동 실행도 password required로 사용할 수 없어 관리자 인증이 필요한 단계는 사용자 직접 입력으로 진행한다.
- 2026-10-04: mobile 담당은 현재 URL 정책이 개발127.0.0.1:5173를 이미 허용함을 확인했다. ignored iOS 생성본은 production ATS이므로 development 명시·iOS 한정 prebuild 및 unsigned simulator Debug build 절차를 보완한다. 시스템 Ruby2.6 대신 toolchain 담당이 Ruby3.4를 준비하고 mobile 담당이 scoped GEM_HOME CocoaPods를 설치한다.

- 2026-10-04: Ruby3.4.11/CocoaPods1.17.0 준비 및 mobile51/51·types·양 variant config·iOS 한정 clean prebuild·iOS Hermes642modules/1.7MB export를 완료했다. dev native bundleID/ATS는 확인했으며 Android 생성물3개 및 package/tsconfig/lock SHA가 원본과 일치한다. Pods 실행의 잘못된 cwd를 실제 재현하고 문서 명령을 고쳤다. full Xcode가 필요한 다음 관문은 미실행/실패로 유지한다.
- 2026-10-04: 독립 QA가 별도 포트/fixture에서 mobile bootstrap·settings lifecycle·statistics files를 Playwright WebKit으로 확인한다. 기존 실제 서버나 계정·조명에 요청하지 않으며 브라우저 엔진 회귀를 native 설치 완료로 해석하지 않는다.

- 2026-10-04: 사용자가 최종 설치 대상을 이 Mac의 iOS 시뮬레이터로 선택했다. 올바른iOScwd의 pod install exit0/98Pods·LED.xcworkspace를 확인했으나 CommandLineTools xcodebuild 요구/빈 Xcode버전 경고가 남아 native build는 실행하지 않았다. full Xcode 후 Pods 재설치·빌드를 이어간다. README 준비품의 별도 독립 검토를 배정했다.

- 2026-10-04: 사용자가 Apple Developer 직접 로그인 완료를 알렸다. toolchain 담당을 재개하여 실제 인증 화면 확인→호환 stable 아카이브 다운로드·서명검증→scoped Xcode·SDK·Simulator 준비를 진행한다. 설치 성공은 아직 기록하지 않는다.

- 2026-10-04: WebKit3파일 portable15/15, retries0·worker1·36.7s·제품699파일hash 동일·소유서버/브라우저 cleanup 완료. 설정 realtouch pan/lifecycle/back2와320CSVscroll1은 ChromiumCDP전용 지원불가3개이며 통과/skip에 포함하지 않았다.
- 2026-10-04: 준비품 독립 검토에서 README/resume의 `--no-bundler --port` 조합을 실제 설치CLI함수로 재현하여 Important1을 기록했다. mobile 담당에 최소명령수정·원재현GREEN·재검토를 순차 배정했다.

- 2026-10-04: 인증 후 Apple 공식 Xcode26.6 AppleSilicon 아카이브2,318,258,791bytes를 정식 browser file download API로 받았고 pkgutil AppleSoftwareUpdate→AppleRoot 서명검사 exit0. 기존 부분 다운로드는 보존했다. 사용자 폴더에 xip 확장/설치를 진행하며 기존 developer path는 유지한다.
- 2026-10-04: mobile 담당이 `--no-bundler --port` Important1을 최소 README/resume에서 보정하고 설치CLI 원함수 RED1→GREEN0을 확인했다. README만 변경한 새14파일fingerprint를 기록했고 독립 재검토를 배정했다.

- 2026-10-04: Xcode26.6(17F113) 설치 `/Users/kim-jh/Applications/LED-iOS-Xcode-26.6/Xcode.app`, `xcodebuild -version` 확인. archive SHA256 `06384762f286fb4d20440f7a67ba40cdf79bedb1cbee9e5111e3030a53a6cb81`, pkgutil/codesign deep strict/spctl 모두exit0·Apple trust. SDK조회는 EULA미동의로69, Xcode약관 GUI에서 사용자 직접Agree/필요한OS관리자인증을 요청했다. 컴퓨터 제어 도구는 법적동의에 action-time 확인을 요구하므로 임의로 동의하지 않았다.
- 2026-10-04: Expo옵션 Important1 독립원함수RED→GREEN 재검토 APPROVED, 현재준비검토Critical/Important/Minor0. writer에 README단독scopedcommit/indexslot을 배정했다.

- 2026-10-04: README단독 `97bcfd6e` 커밋, 검토SHA 일치·cached diff check0·indexempty·모바일trackedclean을 확인했다. 총괄소유 진행문서는 별도로 갱신하며 기본 `codex/mvp1-cloud-web`의 `fc9e7440` clean 상태는 유지한다.

- 2026-10-04 재개: 사용자가 직접 설치 완료를 알렸다. 실제 scoped Xcode26.6/17F113·showsdks exit0(iOS/Simulator26.5)·simctl runtimes[] exit0을 확인했다. 라이선스 추가 동의 요청 없이 native writer는 fullXcode Pods재검증/unsignedgenericSDKDebug build, toolchain은 iOSruntime 다운로드/독립Simulator준비를 병행한다. 기본 developer path와 기본branch는 유지한다.

- 2026-10-04: fullXcode Pods재검증98Pods exit0·이전CLT/UnexpectedXcodeversion 경고0, generatedNode경로22.20.0 확인. 첫genericSDKunsignedDebug는컴파일 전 destinationresolve exit70(`iOS26.5 is not installed`), -showdestinations도eligible0였다. SDK목록조회만으로빌드가능하지않다는실제환경증거를보존하고 source/config조건완화나반복빌드없이runtime완료를기다린다.
- 2026-10-04: 정식 `xcodebuild -downloadPlatform iOS -buildVersion26.5 -architectureVariantarm64`는actual iOS26.5(23F73)8.52GB 다운로드progress를표시한다. source/nativefreeze14+prebuild6hash 변경0. runtime준비와schemeEligibility 확인 뒤 동일빌드를재개한다.

- 2026-10-04: iOS26.5(23F73)runtime설치exit0 후scheme destination AnyIOSSimulator/iPhone17 arm64OS26.5 eligible/ineligible0. 사용자GUI23F77/runtime와기본장비11개도등장하여보존했다. 정확23F73bundlePath로생성해도CoreSimulator가같은identifier의최신23F77을선택하므로 실제QA는23F77로기록한다.
- 2026-10-04: taskdevice `LED Control iOS QA 20261004` iPhone17/UDID `CCF7305C-BDC3-44BB-AFBE-AFCB0BC5CF93`, bootstatusFinishedexit0(41s firstlaunch)·simctlgetenv build23F77/modeliPhone18,3·SimulatorGUI확인. initialboot/bootstatus405 race는원기록을보존하고재부팅/삭제없이 bootexit0→bootstatus관찰로완료했다. writer동일nativebuild는destination통과·sourcecompile후actool리소스처리진행중이다.

- 2026-10-04: runtime 준비 후 동일 unsigned Debug build가 약5분에 exit0/BUILD SUCCEEDED. 개발 bundleID `com.ledcontrol.mobile.development`, SDK26.5·minimum16.4·arm64/x86_64를 검증했다. Metro 실제 iOS bundle GET과 local5173 값은 확인했으나 설치/cold launch 후 RN loader가127.0.0.1:8081을 요청하여 IPv6전용Metro에 접속하지 못했다. 실패 화면/로그를 보존하고 producer에게 소유 서버의 IPv4 binding 교정을 배정했다. 실제 서비스 진입/IME는 아직 미통과다.

- 2026-10-04: 설치 ExpoCLI가localhost를Node 기본DNS순서로IPv6에bind하는 원인을 확인했다. 소유Metro만정상종료/재시작하며 process-scoped `NODE_OPTIONS=--dns-result-order=ipv4first`를적용했다. 새PID46147은127.0.0.1:8081 loopback만열고양주소status200과실제로더형식iOSbundle4,651,346bytes/dev flag/local5173포함GET을확인했다. LAN노출·제품source수정없이REDcurl7→GREEN0을기록하고nativeUI QA를재개한다.

- 2026-10-04: 실제로그인UI·아이디dummy/비밀번호마스킹 입력·Done키보드닫기·Home/foreground동일PID46664·terminate/coldrestart새PID48609를확인했다. 실제로그인제출0이며최종입력은빈상태다. PNG03 focusedpassword하단border일부가림/PNG04가로폼scroll미분리는디자이너·읽기전용검토에맡긴다. source root/scroll차단논리없음과실제로컬served AuthView소스동일을확인중이다.
- 2026-10-04: IPv4README4줄변경을독립검토C0/I0/M0으로인수했고README단독 `e75fbd73`커밋·indexempty를확인했다. Node옵션기존보존/loopback만bind·정본13source와Android6·app74hash불변이다.

- 2026-10-04: 기존 UI/UX 디자이너가 실제 PNG03/04를 직접 읽고 V-06/P2(비밀번호 focus 하단 부분 가림)1건을 확정했다. 가로 스크롤 접근은 미확정 관문으로 유지한다. 단순 코드 일치/문자 입력 성공으로 인수하지 않고 mobile 담당에게 WK focus/inset/keyboard geometry 원인 분리와 국소 보완을 배정했다. fixture QA는 별도 loopback16542에서 진행하며 제품/실제 서비스 변경 없이 수행한다.

- 2026-10-04: 실제 iOS synthetic fixture의 bootstrap/new document, 64KiB CSV OS sheet 반환/handoff·cache0, protocol cancel/cancelled·cache0, top503 native 안내→직접 다시 시도→새 document ready를 확인했다. 실제 저장/PDF/renderer 종료는 별도 미검증이다. 기존 CUA drag/scroll는 긴 fixture에서도 이동 전달 증거가 부족해 가로 접근 관문에 쓰지 않는다.
- V-06 원인 분리 추가 범위: mobile 담당이 실제 AuthView/공통 입력 소스를 ignored browser bundle로 직접 묶고 실제 compiled CSS를 고정한 own16543 관찰 화면을 준비한다. submit capture 차단·own /api 거절, 입력 값 없는 viewport/focus rect/scroll 수치만 관찰한다. WebShell에는 백업/SHA를 보존한 development 전용 임시 keyboard/frame observer만 단일 writer로 넣고 최종 제거한다. native bridge/서비스/DB 정책은 바꾸지 않는다. 독립 도구 담당은 task-local Maestro/JDK17 기반의 지원 Simulator gesture harness를 준비하며 실제 UI 조작은 native QA 소유자에게 순차 배정한다.

- V-06 측정: 처음 focus/재개방 시 웹 input이 viewport 아래에 남았지만 native frame 하단은 keyboard 상단과 정확히 맞고 contentInset은0이었다. 예: ID bottom427/viewport409(18px), password reopen bottom498/viewport436(62px). 문자 입력/키보드 Next 후에는 정상 스크롤되어, native 고정 offset 대신 WK focus-scroll→KAV resize 이후 scroll 복원 순서를 원인 후보로 분리했다.
- 단일 A/B: own16543 fixture에서 native keyboardDidShow 뒤 두 animation frame 후 여전히 가려진 active text control에 nearest scroll을 한 번 적용한다. 사용자 제스처/focus 변경은 예약 보정을 취소하며 origin/current document/main frame guard를 유지한다. native KAV/inset/CSS/toolbar는 변경0, 관찰 원본은 별도 보존한다. 결과 후 정식 국소 보완을 결정한다.
- 공식 Maestro2.11.0 ZIP/digest/checksum·전용 JDK17/env·ownUDID inventory와 최초 driver hierarchy exit0을 확인했다. 새 권한창은 없었고 driver/flow를 실제 swipe 성공으로 확대하지 않는다. 아직 swipe flow 실행0이다.

- Center A/B는 새 HTML의 옵션1개만 변경하고 cold launch PID87617까지 완료했지만 Mac 잠금으로 컴퓨터 제어 도구가 중단됐다. 사용자 직접 잠금 해제를 비동기 요청했으며 focus/swipe/최종 시각 인수는 미실행이다. 다른 UI 경로로 잠금을 우회하지 않는다. 원 서비스/Simulator/서버 상태를 보존하고 화면 조작 없는 focus guard 설계 검토만 진행한다.

- 잠금 동안 독립 설계 검토가 정식화 전 Important4(문서/keyboard 수명 취소, blur/re-focus/gesture 경계, keyboard 유지 Next trigger, ring-only clip 판정)를 확인했다. 현재 development fixture의 제한이며 최종 제품 완료로 인수하지 않는다.
- 화면 조작 없는 후속 구현: mobile 단일 writer가 별도 재사용 focus-script 후보와 behavioral 테스트를 TDD로 준비한다. 현재 observer/16543/Metro와 실제 UI 조건은 보존하고 정식 WebShell wiring/임시 observer 제거는 center 실제 관측 후 순차 수행한다. 후보는 미인수/미배포이고 commit하지 않는다. epoch·focus revision·사용자 의도·keyboard hide/background/fail·paint extent를 검증한다.

- 사용자 요청 후 CUA 읽기 전용 getAXState 재확인1회가 locked 오류 없이 현재 Simulator 상태를 반환해 실제 잠금 해제를 확인했다. 비밀번호/우회 조작 없이 기존 승인된 center A/B를 재개한다. 후보 모듈 TDD는 별도 단일 writer로 진행하며 정식 WebShell wiring은 아직 미실행이다.

- Center A/B fresh 조건: ID viewport409/input181..227, password first/reopen viewport436/input195..241·CTA317..361. native frame/keyboard 경계 정합, Done778/scroll0. 잠금 전 stalePID87617 및 keyboard paint 없는 중간PNG19/20은 stable 인수에서 제외하고 PNG18/21/22를 보존했다.
- CUA click `noWindowsAvailable`는 앱 재획득 후에도 같았으나 잠금 해제 화면은 읽기 전용으로 확인했다. 이미 준비한 지정 UDID Maestro native tap으로 실제 focus 변화를 확인하여 A/B를 완료했다. 새 권한창은 없었다.
- 가로 prototype는 native874×402/frame750×382·web750×382/document728h. native swipe1은 실제 heading/card 이동·scrollY151, swipe2 이내 CTA259..303이382h 안에 들어왔다. portrait 복원은 web402×778/scroll0/keyboard{}이다. 최종 실제5173 복원 QA와 구분한다.
- 후보 독립 검토 Important1(이전 gesture 취소가 같은 field의 새 keyboard opening에 잔존)을 재현했고 boundary 최소 수정 RED3→후보32GREEN/typecheck0을 확인했다. 임시 observer를 위한 process-global full83 진단은 canonical 통과로 기록하지 않는다. v2 재검토·observer 제거/정식 wiring·기본 환경 전체 검증을 진행한다.

- 정식화: 후보 v2 재검토 C0/I0/M0 후 임시 native observer를 제거하고 iOS 한정 preload/bootstrap·keyboard show/hide·background·fail/renderer·epoch·unmount cleanup을 연결했다. 실제 wiring12회귀를 포함한 기본 명령9 suites/95tests와 typecheck·iOS Hermes export exit0이며 독립 reviewer도 동일 freeze95/95·types0·C0/I0/M0을 확인했다. Android에는 해당 설치/리스너를 추가하지 않았다. 네 메뉴 문서를 동일 작업에서 갱신했다.
- 정식 script 단독 synthetic native QA: ID356..402/viewport409, first password195..241/viewport436, reopen382..428/viewport436에서 테두리와 외부 ring 가시성을 확인했다. Next 이동과 허용1회 사용자 swipe 후 자동 위치 복귀 없음, Done 후 web778/scroll0/빈 세로 화면도 확인했다(PNG27~32). 이미 보이는 입력창의 중심 좌표는 요구하지 않는다. 실제5173 연결과 최종 디자이너 인수는 다음 관문이다.
- 실제 서비스 원복: producer가 자신의 Metro98094만 정상 종료 후 PID1658/session82136을127.0.0.1:8081 IPv4 loopback으로 시작했다. 실제5173/dev flag/정식 helper 포함 bundle GET200(4,658,350bytes·SHA256 `82f91ed398b369a17081eb73592e5d69a5afb054bab9a3d61e86faa7a1111f01`), fixture16542/16543·temporary observer 없음, /login200·/api/auth/me401·helper --check exit0을 확인했다. 메타데이터 restoreRequired=false이며 최종 actual native 화면 재인수는 별도 진행한다.
- 실제 서비스 정식 첫 차수(PNG33~42): logo/login, dummy 입력·Next/password masking·Done/reopen의 전체 ring/CTA, ID 사용자1swipe CTA, 가로2swipe 이내 전체 입력/CTA, 세로 복원·foreground동일PID2102·coldrestart새PID4463를 확인했다. 빈 세로/keyboard hidden/ready 상태로 UI를 멈췄다. 최초 ID425..471이 accessory 경계471에 붙어 아래 ring 여유가 없어 **미통과로 보존**한다. 이 차수 cold blank first password는 미실행이다. 실제 CSS focus token/입력 source는 fixture와 동일하므로 스타일 변경 원인으로 확정하지 않았다. actual5173 원본을 유지하며 값/selection/본문을 수집하지 않는 일시 숫자 관측으로 시점 원인을 분리하고, 관측 제거 후 최종 native 재인수를 수행한다.
- actual 숫자 관측의 firstID에서는 paint3px·current epoch/focus/work 유효·gesture0, 두 RAF에서409h로 바뀐 뒤 center1회/scroll200을 확인했고800ms까지 유지돼 원 RED는 재현되지 않았다. 계측의 타이밍 영향 가능성을 배제하지 않아 원 PNG34 FAIL을 유지한다. 독립 소스 검토는 별도 코드 반례를 확인했다: 두 RAF 당시 fully-visible no-op 이후 같은 opening/focus의 viewport만 줄면 resize trigger가 없어 재평가되지 않는다. 원 사진의 정확 원인으로 확정하지 않고 이 국소 반례를 TDD로 보완한다. 이미 보정된 opening·사용자 gesture·epoch/focus/lifecycle 취소 뒤 추가 보정0, resize burst coalesce·dispose listener 제거를 요구한다. 임시 관찰 source/SHA를 먼저 복원하며 observer 없는 코드·native 최종 재인수가 필요하다.
- 관측 종료: 첫 PW도DidShow→RAF2 correction1회 후800ms까지 input195..241/436h로 유지됐다(PNG44). 실제 Done/fresh hierarchy/PNG45는 빈 세로·keyboard hidden·web778/scroll0이며 UI를 멈췄다. writer가 관찰 source2를 정식 원본SHA로 복원하고10개 원본SHA 일치를 확인했다. viewport 반례는 module3/45 실패·integration1/13 실패로 RED를 확보했고, 기존 live guard를 재사용한 visualViewport resize listener/pending coalescing 최소 수정 후 집중58/58 GREEN이다. 기본 전체·types/Hermes·독립 재검토·observer 없는 실제 service 최종 QA는 별도 관문으로 유지한다.
- viewport 정식 freeze: 기본9suites/109tests·typecheck·iOS Hermes export·diff check exit0, 독립 검토 C0/I0/M0 및 독립109/109·types0을 확인했다. WebShell/mock 기존 정식SHA 유지, helper의 resize/pending coalescing만 변경했다. 실제5173/dev flag/정식helper 포함 bundle4,658,864bytes SHA256 `30d2a35002c351d96f6b8f0e4ca6a8bc524b2392066ab7499fcb71802345f1f6`, 모든 관측/fixture/prototype 없음, own Metro8677/session45170·helper --check0·restoreRequired=false를 확인했다. observer 없는 coldID2회/Next/별도coldPWfirst/reopen/gesture/Done actual QA를 순차 배정했다. 원PNG34 FAIL은 새 실제 증거 인수 전까지 유지한다.
- 최종 actual observer-free 인수(PNG46~52): coldID1 PID9337의 native367..413, 별도coldID2 PID9731의420..466에서 전체 ring을 확인했다(두번째는3px ring 포함 accessory471 위2pt 여유). Next, 별도coldPWfirst 및 같은PWreopen PID10299는257..303/CTA379..423으로 전체 ring/CTA가 보였다. 승인1회 margin swipe 후PW416..463으로 실제159~160pt 이동한 위치가 stablePNG/hierarchy까지 유지돼 사용자 의도 취소도 확인했다. Doneexit0 뒤 빈 세로·keyboard hidden·실제 킨다 login ready/PID10299 유지로 UI를 멈췄다. 원34FAIL은 이전 manager 조건의 실패 이력으로 보존하고 이 새 observer 없는 두cold조건을 최종 결과로 분리한다. 실제 모든기기/타이밍의 무결함 보증으로 확대하지 않는다. 디자이너 최종 시각 인수·문서/metadata 독립 인수와 scoped commit을 이어간다.
- 최종 디자이너 인수: 기존 `UI/UX 디자이너` 채팅이 원본46~52의7개를 직접 읽고 `.local/mobile-app-collaboration/designer-visual-qa.md` §14에서 지정 actual Simulator 조건의 V-06/P2를 닫았다. 추가 필수 시각 지적0, ID2의2pt 여유/기기다양성·큰글자·운영출시 미검증 한계는 유지한다. task소유16542/16543 fixture를 각 담당이 정확 소유 확인 후 정상 종료하고 원34/수치trace/산출물을 보존했다. 앱PID10299/IPv4 Metro8677·실제5173는 유지한다. 사용자 Debug app ZIP74파일은 native manifest·현재 `.app`에 다시 byte/SHA 완전 일치했다. rootdocs2와 README/menu/source/evidence의 독립 최종 검토를 이어간다.
- 최종 독립 인수 `.local/ios-finalization/ios-final-acceptance-review.md` C0/I0/M0, 제품10/문서12 SHA·실제PNG7·Designer§14·ZIP74·fixture 원자료 전후 보존·기본checkout/index를 대조했다. finalfreeze의 디자이너pending은 저장 시점의 역사 metadata이며 최신§14 closed 결과와 구분했다. 검토된 제품10경로만 `b1b2e01ebeda6fc029460e141672a886a8e20a99`로 커밋했고 source10 SHA 불변·indexempty·rootdocs2만 남음을 확인했다. 총괄이 정리문서2를 별도 커밋하고 fresh clean/현재 helper를 최종 확인한다. native Debug/현재 로그인·검증된 조건의 완료이며 실제 인증 메뉴·PDF/저장·renderer 강제 종료·실폰/기기다양성/HIL/운영 출시 한계는 유지한다.
