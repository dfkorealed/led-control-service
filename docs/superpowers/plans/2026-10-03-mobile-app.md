# Android·iOS WebView 앱 구현 계획

> **For agentic workers:** 기존 담당 채팅과 모바일 구현 서브에이전트가 아래 소유 범위별로 실행한다. 총괄은 보고와 검증을 취합하고 이 체크리스트를 갱신한다.

**Goal:** 기존 관제 웹을 Android·iOS React Native 앱에서 실행하고 모바일 사용자 흐름을 보완한다.

**Architecture:** Expo 안정 SDK의 WebView 셸을 사용한다. 웹 인증·제어는 기존 서버 경로를 유지하고, strict shared bridge로 앱 상태·뒤로가기·파일 공유만 연결한다.

**Tech Stack:** Expo SDK 57 기준, SDK 호환 React Native/React, react-native-webview, Expo 파일/공유/네트워크 모듈, 기존 React Query·React Router 웹.

**Spec:** `docs/superpowers/specs/2026-10-03-mobile-app-design.md`

## Global Constraints

- 초기 소스 `1ea3fb6e`, 작업 브랜치 `codex/mobile-app-20261003`.
- 기존 웹·쿠키 인증·API/DB/MQTT·현장 제어 의미를 유지한다.
- 보고서는 현재 PDF 전용이며 CSV를 유지한다. XLSX를 복원하지 않는다.
- 한 파일에는 한 writer만 사용한다. shared 계약은 Shell 담당이 먼저 커밋·검증한다.
- 파일 최대 20MiB, chunk 64KiB 이하, 한 번에 한 파일, inactivity 30초.
- 운영 URL은 HTTPS. private HTTP는 개발 빌드에 한정한다.
- 320/390px overflow·44px 터치·keyboard·safe-area를 검증한다.
- 실제 장비·DB 초기화·자격증명·스토어/운영 배포·push는 이번 코드 구현에 포함하지 않는다.

## Review Focus

- origin/document가 바뀐 뒤 늦은 bridge 메시지와 파일 응답을 거부한다.
- 파일 chunk의 누락·중복·순서 오류·크기 초과·timeout은 부분 파일을 정리한다.
- 통신 응답 유실·앱 종료·복귀에서 제어 POST를 새 명령으로 자동 재전송하지 않는다.
- 모달·dirty editor가 있는 Android back은 확인을 우회하지 않는다.
- 쿠키 만료·principal/tenant 전환 뒤 이전 계정의 데이터/명령 복구를 노출하지 않는다.

## 실행 체크리스트

### Task 1: 디자이너·페이지 담당 기준 취합과 shared 계약

**소유:** 기존 UI/UX 디자이너와 페이지 담당 검토, shared 단일 writer는 Shell 담당.

**Files:** `packages/shared/src/mobile-webview-contracts.ts`, 그 단위 테스트, `packages/shared/package.json`, 필요한 export 구성. 검토 결과는 `.local/mobile-app-collaboration/*-review.md`.

- [x] 최신 메인과 모바일 검토 checkout의 변경 없음 상태를 확인하고 새 브랜치를 준비한다.
- [x] 기존 디자이너·네 페이지·Shell 담당 채팅에 읽기 전용 검토를 요청한다.
- [x] 디자이너·Shell·네 페이지 보고서를 취합하고 writer 경계를 합의한다. 공통 bridge/back은 Shell, 페이지 consumer는 각 담당, native는 모바일 writer가 소유한다.
- [x] shared bridge strict schema의 정상/악성/경계 입력 assertion RED(30 failed/1 passed)를 확인한다.
- [x] v1 메시지·상한·requestId·subpath를 구현한다. focused32와 exports65, typecheck·CJS/ESM build를 검증한다.
- [x] `3c0ef9d6` 계약 커밋과 독립 spec/quality 검토(Critical/Important0, focused32 및 import smoke)를 완료하고 native/web 소비자에 타입을 전달한다.

### Task 2: 실행 가능한 모바일 앱과 네이티브 사용자 흐름

**소유:** 모바일 구현 서브에이전트. root lockfile 변경도 이 writer만 수행한다.

**Files:** `apps/mobile/package.json`, `App.tsx`, entry·Expo/Metro/Babel 설정, `src/WebShell.tsx`, 분리된 `src/components`·bridge/file/network helpers, 테스트·README·env 예제·native 생성/build 설정, `pnpm-lock.yaml`.

- [x] 기존 mobile 타입과 단위 6/6 기준을 확인한다.
- [x] SDK 호환 의존성과 실행·export·prebuild·양 플랫폼 run/build 명령을 설정한다. Web18/Native19 React 타입 context를 optional peer hook으로 분리한다.
- [x] missing/release URL·외부 origin·bootstrap·back·process recovery의 실패 테스트를 정의한다.
- [x] safe-area·keyboard·상태표시줄·로딩/오류/재시도·앱 상태를 구현한다. 실제 Android 로그인 IME 가림 수정과 두 번의 열기·닫기 재검증을 완료했다.
- [x] shared 계약 기반 bounded 파일 저장/공유·취소·timeout·부분 파일 정리를 구현한다.
- [x] mobile typecheck/test 및 Android·iOS JS bundle/export를 검증한다.
- [x] native prebuild와 build 도구를 확인하고 가능한 실제 native 빌드를 수행한다.
- [x] 실행 방법·실기기 재현 절차와 검증 한계를 기록하고 scoped commit을 만든다.

### Task 3: 공통 웹 셸·앱 복귀·뒤로가기

**소유:** 기존 Shell 담당 채팅, Task 1 계약 검증 후 시작.

**Files:** `apps/web/src/features/mobile` 공통 bridge helpers, `main.tsx` 또는 공통 부팅, `features/shells`·dirty guard·공통 UI의 합의 파일, 관련 테스트.

- [x] native active/online·back·stale document·파일 응답의 실패 회귀를 정의한다.
- [x] 초기 native 환경을 복구하고 Query focus/online·인증/활성 명령 재조회를 연결한다.
- [x] overlay→dirty guard→router back→최상위 종료 응답을 구현한다.
- [x] 페이지 writer가 사용할 파일 공유 helper의 타입·정상/실패 Promise를 제공한다.
- [x] 공통 320/390px·키보드·safe-area UX와 touch context 회귀를 검증하고 scoped commit을 만든다.

### Task 4: 페이지별 모바일 UX 적용

**소유:** 기존 각 페이지 담당 채팅. 공통 파일 수정은 Shell 담당에게 요청한다.

**Files:** 각 `features/{monitoring,control,statistics,floor-editor,settings}` 소유 파일과 `docs/menus` 해당 문서, scoped unit/E2E.

- [x] 디자이너 권고와 기존 구현을 비교하고 상세 스크롤 재현, 제어 요청키 보존, PDF/CSV 공유, 편집 터치·초안/lease 복귀를 담당별로 배정한다.
- [x] 모니터링 상세 스크롤·지도 터치·하단 action을 보완하고 검증한다.
- [x] 제어 복귀/재실행 시 기존 요청키·서버 결과 복구를 보완하고 중복 재전송 차단을 검증한다.
- [x] 통계 PDF·CSV를 공통 native 공유 helper에 연결하고 브라우저 fallback·오류/취소·중복 클릭을 검증한다.
- [x] 설정 dirty draft·lease·앱 복귀·모바일 편집/파일 UX를 보완하고 검증한다.
- [x] 영향받는 메뉴 문서를 갱신하고 각 writer가 소유 파일만 커밋한다.

### Task 5: 통합 QA와 실행 산출물

**소유:** 총괄 검증 취합, 독립 QA, 기존 디자이너 시각 검토.

- [x] writer별 보고·commit·검증 증거를 취합하고 계약/메뉴 문서 일치를 검토한다.
- [x] fresh mobile 타입/test/export, Web 타입/test/build·UI 정책·관련 touch E2E를 실행한다.
- [x] 네이티브 빌드 환경과 결과를 확인하고 가능한 Android 설치용 산출물을 생성한다.
- [x] 320/390px 핵심 화면을 디자이너가 확인하고 수정은 소유 writer에게 전달한다.
- [x] 전체 diff 독립 검토와 지적 수정·재검토를 완료한다.
- [x] `git diff --check`, 상태판/체크리스트·README 실행 명령·산출물 경로를 검증한다.
- [x] 사용자 보고용 실행 방법·산출물·실제 기기/운영 검증의 남은 범위를 정리한다.
- [x] 깨끗한 기존 로컬 서비스 브랜치에 검증한 제품 코드를 fast-forward하고 frozen install·Prisma client 생성·canonical root typecheck를 확인한다.

## 진행·결정 기록

- 2026-10-03: 사용자 명시 구현·담당 세션 협업 지시로 진행. 기존 디자이너 및 페이지 담당은 초기 읽기 전용 검토 중이며 Shell 담당에게 shared 계약의 단일 writer를 배정했다.
- 2026-10-03: native worktree 생성 도구가 artifact cwd의 `Not a git repository`를 반환했다. 기존 깨끗한 모바일 전용 checkout을 재사용하여 새 브랜치를 시작했고 이전 브랜치는 보존했다.
- 2026-10-03: baseline frozen install exit0. Expo SDK57/RN0.86.3/React19.2.3 의존성 전환은 모바일 writer가 단독 진행한다. 새 graph에서 사라진 image-size1.2.1 patch selector만 제거하도록 승인했으며 과거 patch 회귀/현재 parser와 production audit는 별도 검증한다.
- 2026-10-03: Expo Sharing은 실제 저장/OS 취소를 구분하지 못하므로 결과는 공유 sheet handoff 종료로만 표현한다. 명시적 웹 취소와 전송 실패는 별도로 구분한다.
- 2026-10-03: 전체 Xcode 미설치·adb 연결 기기 없음·Android SDK 미확인이다. 독립 native build 담당이 격리된 로컬 도구와 가능한 Android APK 빌드를 조사한다.
- 2026-10-04: 격리 JDK17/SDK36/NDK27.1/Node22와 Android36 arm64 에뮬레이터를 준비했다. 중간 debug·개발 서명 standalone release 빌드/설치/cold launch를 실제 수행했다. 실제 WebView에서 64KiB CSV·foreign malformed/JSON 거부·OS chooser/handoff·hardware back을 확인했으며 최종 소스는 후속 재빌드한다.
- 2026-10-04: 독립 native 검토 I4(형식 오류인 이전 문서 메시지가 현재 파일을 취소)는 RED→GREEN 수정 및 source 재검토 ADDRESSED다. I5(static 초기 script가 다음 문서에도 이전 documentId를 제공)는 초기 script를 compat flag만으로 제한하고 fresh bootstrap을 onLoadEnd에서 제공하도록 수정·독립 재검토 ADDRESSED다. Android의 loading=false SPA history는 같은 문서 ID를 유지하며 generic injection도 현재 웹 문서 ID를 검증한다. 첫 React mount는 late bootstrap을 기다리되 window load를 막지 않는다.
- 2026-10-04: image parser/audit fixture 회귀 `ae0e7bab`는 실제 Expo Metro parser와 exact-selector legacy 경계를 검사한다. leaf patch 후 fresh audit는 High2/그 외0, 미해결은 baseline에도 있던 node-forge/braces다. 예외를 추가하거나 감사 정책을 완화하지 않았다.

- 2026-10-04: native scoped commit `ada95932`, mobile49/49·타입·양 플랫폼 Hermes export·prebuild, 독립 native Critical/Important0. 최종 개발 서명 standalone APK 70,492,020 bytes/SHA256 `7f122105b916b387210aa6e6a287676b93dd43007fbad03f88840e01efcdcb1e`를 Android36 에뮬레이터에서 설치·cold launch했다. fresh bootstrap/reload·SPA·64KiB/OS chooser/handoff·30초 정체·취소·background/network·HTTP503·renderer 종료 재시도·OS Back overlay/root 실제 fixture 검증을 완료했고 격리 프로세스를 정리했다. URL 미설정 안내 APK이며 인증 서비스·실제 저장/HIL/iOS native는 미검증이다.
- 2026-10-04: 제어 `ce9e2c1b` 소유270·연결2·Chromium57/57, durable 원본 요청키/실패 잠금과 좁은 화면 밝기 UX 완료. Settings strict Back ghost overlay, Statistics signed PDF HTTP 원인 유실, 공통 native inset UI 정책5건은 Shell producer 수정 후 consumer/final 전체 검사 관문이다. 디자이너 V01 현장 시간 표시/V02 좁은 alert 버튼은 해당 페이지 writer에 국소 수정·회귀를 배정했다.

- 2026-10-04: 공통 Shell `7d4171d6` ready 소스 독립383/383·정책66/66·Critical/Important0. closed picker ghost overlay와 Web-only FILE_FETCH_FAILED/status·opaque 접근 오류 구분, exact native inset 정책을 보완했다. 소유 bootstrap Chromium3/3 및 타입검사도 통과했다. 설정 V02 좁은 alert 문구/80px 예약·200% 터치 검증과 V03 strict Back 전체 경로6/6, 기존 viewport12/12·placement3/3·unit157/157 완료(최종 독립 검토·scoped commit 대기). 통계는 URL 원인194/7 통과 후 CSV fetch/PDF descriptor 이전 doc scope와 descriptor cancel 전파 Important3건을 독립 재현하여 owner 수정 중이다.

- 2026-10-04: 실제 현재 Web 로그인 consumer를 Android WebView에서 실행하여 late fresh bootstrap→ready→auth/me GET→unauth 로그인과 입력16px을 확인했다. 실제 software IME에서 adjustResize 선언에도 WebView 높이가 줄지 않아 password가 가려지는 Important를 관측했고 native writer에 회귀·국소 대응을 배정했다. 기존 APK/13fingerprint 검증은 이전 native source에 귀속하며 fix 뒤 번들/APK를 재생성·설치해 증거와 사용자 산출물을 교체한다.

- 2026-10-04: 설정 `d85e5f9c` 독립157/157·Critical/Important0, 모니터링 V01 `cd408210` 독립국소9·owner98/14·Critical/Important0. 디자이너 V01/02 표시 수정과 V03 strict Back 해소를 인수했고 V04 통계 날짜 단위를 보완했다. 추가 V05 320px/200% 맵 선택값 압축은 모니터링 소비자 행만 수정·회귀 중이다.
- 2026-10-04: 통계 `d6be2edd` 최종9files sourcefreeze, 독립200/200·Critical/Important/Minor0. CSV/PDF 원본 document capture·문서 교체 abort/recheck 및 descriptor AbortSignal 전파 Important3는 원본 독립 재현3/3 GREEN ADDRESSED. 관련 Chromium9/9와 date-only 시간값·큰 글자·긴 이름 검증, 메뉴 문서 최신화 완료.
- 2026-10-04: native IME `3657661a`는 Android KAV height/default offset0만 보정하고 iOS padding을 유지했다. 실제 WebView bottom=IME top(1517px), password/submit 가시성·두 reopen/hide cycle에서839.24px viewport·scroll0·문서 유지 확인, 독립Critical/Important0. Fresh mobile51/51·타입·양 플랫폼 export 후 standalone APK를 다시 빌드/설치·cold launch했다. 최종70,492,024bytes/SHA256 `0e84661dcb523eafd0ebc59cbe64ad7fd4b807703db36e7463bd62c3b338871a`, 사용자 outputs/mobile 산출물도 교체·hash 일치. 이전7f122… APK는 pre-ime 증거로 보존한다. 기존13source/config/lock fingerprint 동일 및 검증 프로세스 종료/IME 설정0복원 완료.

## 최종 검증과 로컬 반영 — 2026-10-04

- 최종 제품 HEAD `59a80670`에서 canonical root lint/typecheck/test/build 모두 exit0. 테스트는 root149/4skip, Shared443, Automation28, Mobile51, Web2798/3skip, Gateway1409, API2963/827skip, UI policy66/66·위반0이다. 제외834개는 통과에 포함하지 않는다. 검사 전후와 최종 Chromium 후 제품 파일 SHA256 변경0. 기존 Web888.80kB chunk 크기 경고는 남는다.
- 최종 소스의 관련 Chromium9파일118/118, skipped/unexpected/flaky/top-level errors 모두0. 모니터링 touch·제어 복구·공통 bootstrap·설정 back/초안/지도 편집·통계 파일/큰 글자 여정을 단일 worker, retry0, 별도16891 서버에서 검사했다. fixture API를 사용했으며 실제 고객 계정·조명 제어 검증으로 확대하지 않는다. 검사 서버16891/16892 listener 없음 확인.
- `59a80670` 모니터링 V05는 선택/검색 행만 보완했다. 소유99 및 관련 touch18, 독립 최종 소유4파일 SHA 변경0·Critical/Important/Minor0. 디자이너는 V01~V05 및 실제 Android IME 보완을 인수했고 제공 화면/조건 내 남은 확정 시각 지적0이다. 공통 Shell·native·제어·설정·통계 독립 지적도 해결·재검토했고 Critical/Important0이다.
- Android 최종 개발 서명 APK는 70,492,024bytes, SHA256 `0e84661dcb523eafd0ebc59cbe64ad7fd4b807703db36e7463bd62c3b338871a`. 사용자 파일 `/Users/kim-jh/Documents/led 조명 관제 서비스/outputs/mobile/led-control-android-development.apk`와 원본 hash가 일치한다. 실제 Android36 설치·cold launch와 WebView fixture/실제 공개 로그인·IME를 검증했다. iOS prebuild/Hermes export는 완료했지만 full Xcode 부재로 native build/설치는 미실행이다.
- 실제 기본 checkout `/Users/kim-jh/Documents/led-control-service`의 clean `codex/mvp1-cloud-web`를 `1ea3fb6e`→`59a80670`으로 로컬 fast-forward했다. 같은 제품 hash를 확인하고 Node22.20.0/pnpm9.15.0 frozen install exit0, 연결하지 않는 dummy URL로 Prisma client 생성 exit0, canonical root typecheck(workspace prepare 포함) exit0. DB/migration/schema 변경 없음. 실행 중인 기존 서버의 shell/모바일 bootstrap GET200·auth/me401 확인, 서버 재시작 없음. 소스 브랜치·QA checkout과 증거는 보존하며 push하지 않았다. 후속 반영은 이 완료 기록 문서뿐이다.
- Final production audit exit1: Critical0/High2/Moderate0/Low0. 기존 node-forge/braces 미해결 High2이며 보안 예외/정책 완화 없음. 운영 출시 게이트 통과로 표시하지 않는다.

### 실행 안내와 남은 기기 인수

[앱 실행 README](../../../apps/mobile/README.md)를 따라 `apps/mobile/.env`에 공개 웹 주소 `EXPO_PUBLIC_WEB_URL`을 설정한다. 이미 반영한 로컬 checkout에서 `pnpm --filter @led-control/mobile android` 또는 `ios`로 실행한다. Android 개발 localhost5173 연결은 `adb reverse tcp:5173 tcp:5173`가 필요하다. iOS는 full Xcode·CocoaPods가 필요하다. Preview/production 주소는 HTTPS를 사용한다.

제공 standalone APK는 개발 서명이며 서비스 URL이 비어 있어 연결 준비 안내를 표시한다. 실제 서비스 연결은 주소 설정 후 재빌드한다. 회사 앱 ID·운영 HTTPS URL·정식 signing/스토어 제출은 아직 설정/검증하지 않았다. 실제 고객 인증·OS별 파일 저장 결과·큰 고객 CAD·구형/OEM Android·iOS 실기기·VoiceOver/TalkBack·Gateway/조명 HIL은 후속 기기 인수 범위다.

최종 증거는 보존한 checkout의 `.local/mobile-app-collaboration/final-root-gates.json`, `final-mobile-touch-results.json`, `native-build-report.md`, `web-shell-final-review.md`, `web-integration-review.md`, `designer-visual-qa.md`에 있다.
