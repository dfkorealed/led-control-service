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
- [ ] Xcode 약관·필요한 관리자 인증 후 iOS SDK/Simulator runtime을 준비한다.
- [x] 앱 native/Pods/URL 환경의 최소 필요한 수정안을 검토한다. 기존 production native 생성본은 ATS로 HTTP를 막으므로 개발 variant로 iOS만 재생성하는 절차를 승인했다. source/계약 수정은 필요하지 않다.

## Task 2: iOS 연결·빌드

**소유:** mobile writer; `apps/mobile`와 ignored `.local/ios-finalization` 소유.

- [x] 현재 local5173에 GET으로 로그인200·auth/me 미인증401을 확인한다. 운영 URL은 미입력이다.
- [x] 제품 source/config 변경은 필요하지 않음을 확인하고 iOS development 재생성·CocoaPods cwd·DEVELOPER_DIR·unsigned simulator 실행 README를 보완했다. 잘못된 pod project-directory cwd를 실제 재현한 후 iOS 디렉터리 실행으로 교정했다.
- [x] mobile51/51·typecheck exit0, development/production config·iOS development 한정 clean prebuild·Hermes export exit0. Android 생성물 및 정본 source/config/lock SHA 변경0. Ruby3.4.11·CocoaPods1.17.0 설치/version 확인.
- [x] CocoaPods1.17.0을 scoped 설치하고 개발 iOS 생성물의98 Pods/99dependencies·workspace 생성을 확인한다. CLT Xcode 버전 경고가 있어 full Xcode 준비 후 Pods를 재검증한다.
- [ ] 선택한 full Xcode로 Pods 재검증·iOS native build를 수행한다.
- [x] 검토된 README만 `97bcfd6e`로 scoped commit하고 indexslot을 반환했다.
- [ ] native 실행 산출물·원본 로그를 전달한다.

## Task 3: 실제 설치·UX와 최종 인수

**소유:** toolchain/native QA, 독립 reviewer, 총괄.

- [ ] task소유 Simulator/기기에 설치·cold launch하고 실제 서비스 로그인 진입을 확인한다.
- [x] 가능한 Playwright WebKit 3파일의 portable15/15을 독립 수행했다. expected15/unexpected0/skipped0/flaky0/errors0, Chromium CDP 전용3개는 실제 unsupported를 재현한 명시적 제외다. iOS native 실행과 구분한다.
- [ ] 입력/키보드·safe-area·회전·reload·복귀·파일·오류 복구를 가능한 실제 범위에서 검증한다.
- [ ] 필요한 시각/페이지 수정을 담당 역할에 순차 배정하여 재검증한다.
- [ ] 소스·문서·검증 증거 독립 검토와 미해결 지적 처리를 완료한다.
- [ ] 최종 diff·문서/체크리스트·clean/별도 브랜치·산출물을 검증하고 사용자에게 실행 결과를 보고한다.

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
