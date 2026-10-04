# Android·iOS LED 관제 앱

기존 관제 웹을 Expo SDK 57 / React Native 0.86.3 / React 19.2.3 WebView에서 실행한다. Android 7(API24) 이상, iOS16.4 이상이며 앱 ID `com.ledcontrol.mobile`은 개발용 기본값이다. 회사의 등록된 상용 ID로 확인된 값이 아니다.

## 개발 실행

Node22.13 이상과 저장소 pnpm9.15.0을 사용한다. 아래 명령은 저장소 루트 기준이다.

```sh
pnpm install --frozen-lockfile
pnpm workspace:prepare
cp apps/mobile/.env.example apps/mobile/.env
```

`.env`에서 `EXPO_PUBLIC_WEB_URL`을 실제 웹 주소로 설정한다. 서비스 origin만 주면 `/login`으로 진입하고 명시적인 route/query/hash는 유지한다. 실제 폰은 개발 컴퓨터의 LAN IP와 같은 네트워크를 사용한다. Android는 USB 연결 후 `adb reverse tcp:5173 tcp:5173`를 설정하고 `EXPO_PUBLIC_WEB_URL=http://localhost:5173`를 명시하는 방법을 권장한다. localhost는 웹의 secure context를 유지한다. Android emulator는 `http://10.0.2.2:5173`, iOS simulator는 개발 컴퓨터 주소도 사용할 수 있다. LAN/에뮬레이터 HTTP는 브라우저 secure context가 아니므로 기존 웹의 `crypto.randomUUID` 같은 API가 제한될 수 있다. 실제 기기의 LAN 사용은 신뢰할 수 있는 개발 HTTPS 주소를 권장한다. 기본 localhost 주소는 없다. 주소가 없거나 잘못됐으면 앱에서 연결 준비 안내를 표시한다.

개발 HTTP는 `APP_VARIANT=development`로 생성한 개발 앱에서만 허용한다. 운영/preview는 HTTPS를 설정한다. Expo가 `EXPO_PUBLIC_` 값을 JS에 포함하므로 비밀번호·token·API secret을 넣지 않는다. HTTPS 웹의 API 역시 HTTPS 및 기존 쿠키 인증/CORS 설정을 충족해야 한다.

```sh
pnpm --filter @led-control/mobile start
# 다른 터미널: Android SDK/JDK17 이상과 emulator 또는 기기가 필요
pnpm --filter @led-control/mobile android
# macOS full Xcode + iOS SDK/simulator + CocoaPods가 필요
pnpm --filter @led-control/mobile ios
```

Expo Go로 JS 흐름을 볼 때는 `pnpm --filter @led-control/mobile start:go`를 사용할 수 있지만 standalone 앱 transport·권한·native build 검증을 대신하지 않는다. 사용자 지정 development client는 위 native 명령으로 생성한다. dev server 시작이 서비스의 API/DB를 자동 준비하지 않는다.

## 검증·native 생성

```sh
pnpm --filter @led-control/mobile typecheck
pnpm --filter @led-control/mobile test
pnpm --filter @led-control/mobile run config
pnpm --filter @led-control/mobile run export:android
pnpm --filter @led-control/mobile run export:ios
pnpm --filter @led-control/mobile run prebuild
```

`prebuild`는 CNG로 `apps/mobile/android`, `apps/mobile/ios`를 재생성하며 이 폴더는 Git에서 제외한다. 앱 설정/플러그인/lockfile이 정본이다. native 수동 변경은 재생성에서 유실될 수 있어 source config/plugin으로 옮겨야 한다. `--no-install`로 CocoaPods 실행 없이 생성만 검증한다. OS 실행 명령은 해당 native toolchain과 의존성 설치를 추가로 요구한다.

## 로컬 build

```sh
# Android 개발 APK, 생성된 폴더에서; 서명된 스토어 release 아님
cd apps/mobile/android
./gradlew assembleDebug
```

`eas.json`에는 development, preview(APK), simulator(iOS simulator), production profile이 있다. 로컬 EAS command는 고정 CLI24.10.0을 다운로드하여 실행한다. EAS 계정/프로젝트 등록과 profile별 signing은 사용자가 준비한 값이 필요하며 자동 운영 배포나 스토어 제출을 하지 않는다.

```sh
pnpm --filter @led-control/mobile build:android:local
pnpm --filter @led-control/mobile build:ios:local
```

Preview/production을 빌드할 때 `.env`의 개발 HTTP를 그대로 사용하지 말고 공개 HTTPS 값을 명시한다. app config와 runtime은 각각 transport 허용 여부와 URL policy를 검증한다. Web URL 누락은 native bundle 생성 자체를 막지 않고 실행 때 설정 안내를 표시한다.

## 사용자 흐름과 경계

- 최초 연결/지연/HTTP·네트워크 오류/renderer 종료에 접근 가능한 안내와 수동 재시도를 제공한다. API 오류는 기존 웹 복구 UI가 처리한다. 이미 열린 화면을 주기적 요청으로 가리지 않는다.
- native가 safe-area를 소유하고 Android resize/iOS keyboard avoidance를 제공한다. 웹의 font scaling/pinch를 강제로 비활성화하지 않는다.
- 설정된 origin만 WebView에서 실행한다. 모든 URL을 앱 policy로 검사한 뒤 허용된 외부 HTTPS/tel/mailto는 사용자 확인 후 OS로 보낸다. 임의 scheme, file, data, javascript, 외부 HTTP는 차단한다.
- Android Back은 ready 문서의 overlay/초안/라우터 처리를 기다리고 명시적인 최상위 응답에서만 앱을 종료한다. 응답 누락/지연은 native history 이동으로 우회하지 않는다.
- 초기 정적 스크립트는 모바일·safe-area 표시만 주입한다. 문서 ID와 유효한 환경은 현재 문서의 `onLoadEnd`에서 전달하고 웹은 그 환경까지 첫 mount를 기다린다. 새 페이지를 열 때 이전 환경을 초기 주입으로 재사용하지 않는다. Android의 로드 완료 상태 SPA history 알림은 동일 문서의 ID와 ready 상태를 유지한다.
- 파싱 실패한 메시지는 raw 문자·UTF-8 크기를 먼저 제한하고 독립적인 envelope의 문서·요청 ID가 현재 파일 소유자와 일치할 때만 실패 처리한다. 오래된 문서/다른 요청/깨진 JSON/과대 메시지는 현재 전송을 취소할 수 없다.
- 새 문서/retry/renderer 종료는 이전 documentId와 callback·부분 파일을 폐기한다. 공유 sheet가 열려 있으면 OS 반환까지 파일 소유권을 유지하고 이전 문서에 늦은 결과를 전달하지 않는다.
- native 메시지 주입은 origin과 현재 웹 문서 ID를 함께 확인한다. 이전 문서에서 대기하던 메시지가 새 문서의 bootstrap 전이나 다른 ID로 도착하면 dispatch하지 않는다.
- 인증 token 복제나 native의 임의 URL 다운로드를 하지 않는다. PDF/CSV는 기존 웹 권한으로 읽은 바이트를 bounded bridge로 전달한다.

## 기기 인수 절차와 검증 한계

자동 테스트의 RN/WebView/네트워크/파일 sink는 mock 또는 메모리 구현이다. JS export와 prebuild 성공은 APK/iOS build·설치·실제 WKWebView/Android WebView 동작을 증명하지 않는다.

Android 키보드는 `KeyboardAvoidingView`의 실제 frame/IME 겹침 계산과 manifest `adjustResize`를 함께 사용한다. Android 10(API29) 이하에서는 `adjustResize`일 때 React Native 키보드 이벤트가 발생하지 않을 수 있어 OS의 resize 경로에 의존한다. 현재 Android36 emulator에서 확인한 결과를 구버전 전체·제조사별 키보드·iOS 실행 검증으로 확대하지 않는다. 키보드 숨김 후 viewport 복원과 OS가 이미 resize하는 환경에서 중복 축소 여부도 인수 기준이다.

양 OS 실제 기기에서 다음을 확인한다.

1. 정상 cold start, URL 누락/잘못된 URL, 비행기 모드, DNS 오류, top-frame HTTP503, renderer 종료 후 안내/수동 재시도.
2. 320/390px 세로/가로, notch/home indicator/Android gesture·3-button navigation, OS 큰 글자, 키보드 입력 후 오류/확인·취소 접근.
3. 로그인/쿠키 만료/로그아웃/다른 계정 로그인, 외부 링크 확인·취소·차단, 앱 background/active와 offline/online 복귀.
4. Android Back에서 overlay→dirty draft 확인→route→최상위 종료. 확인 취소는 초안/선택을 유지하고 전송 중 제어가 새 명령으로 재전송되지 않는다.
5. PDF/CSV 공유, 취소, 크기 초과, chunk 중단, 다른 문서로 이동, OS 공유 UI 종료 후 임시 파일 정리. Expo share API는 OS 공유 sheet의 닫힘과 실제 파일 저장 성공을 구분해 알려주지 않는다.
6. 실제 제어/상태 확인/지도 제스처/CAD draft·lease 복구·파일 picker를 서버 권한과 함께 검증한다. 작은 fixture 검증을 실제 대형 CAD/HIL 완료로 확대하지 않는다.
