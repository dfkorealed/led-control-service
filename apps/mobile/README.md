# Android·iOS LED 관제 앱

기존 관제 웹을 Expo SDK 57 / React Native 0.86.3 / React 19.2.3 WebView에서 실행한다. Android 7(API24) 이상, iOS16.4 이상이며 앱 ID는 production에서 `com.ledcontrol.mobile`, development에서 `com.ledcontrol.mobile.development`를 사용한다. 두 ID는 회사의 등록된 상용 ID로 확인된 값이 아니다.

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

## iOS 로컬 서비스 연결

Expo SDK 57은 full Xcode 26.4 이상과 iOS 16.4 이상을 요구한다([Expo SDK 기준](https://docs.expo.dev/versions/v57.0.0/)). Command Line Tools만으로는 iOS 앱을 빌드하거나 Simulator에서 실행할 수 없다. Xcode의 iOS Simulator runtime과 CocoaPods를 먼저 준비한다. CocoaPods는 시스템 Ruby 대신 별도로 설치한 최신 Ruby 사용을 권장한다([설치 안내](https://guides.cocoapods.org/using/getting-started.html)).

각 iOS 실행 터미널에서 `DEVELOPER_DIR`를 설치된 full Xcode 경로로 지정하고 버전을 확인한다. 아래는 `/Applications`에 설치한 경우의 예시이며, 사용자 폴더 등 다른 위치에 설치했다면 실제 경로로 바꾼다. 이 설정은 현재 터미널과 그 자식 프로세스에만 적용한다.

```sh
export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
xcodebuild -version
```

Mac에서 서비스가 실행 중이면 iOS Simulator는 `http://127.0.0.1:5173`로 접근할 수 있다. 아래 개발 연결값은 명령 범위에만 적용하며 앱의 기본 URL을 만들지 않는다. 웹 GET 200과 `/api/auth/me`의 미인증 401을 먼저 확인한다. 기존 서버가 실행 중이라면 재시작할 필요가 없다.

```sh
curl --fail --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:5173/login
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:5173/api/auth/me

# 저장소 루트; Node 22와 준비한 CocoaPods가 PATH에 있어야 한다.
(
  set -e
  export APP_VARIANT=development
  export EXPO_PUBLIC_WEB_URL=http://127.0.0.1:5173
  export EXPO_NO_TYPESCRIPT_SETUP=1
  pnpm --filter @led-control/mobile exec expo prebuild --platform ios --clean --no-install
  # Podfile의 Node 의존성 조회가 앱 경로에서 이루어지도록 cwd를 맞춘다.
  cd apps/mobile/ios
  pod install
)
```

`--platform ios --clean`은 생성된 iOS 폴더만 재생성한다. 기존 Android 생성물은 유지한다. 개발 variant를 바꿀 때 재생성이 필요하다. `Debug` 빌드 설정만 바꾸면 이전 production native 설정이 그대로 남을 수 있다. 개발 생성물은 bundle ID `com.ledcontrol.mobile.development`와 개발 HTTP 허용 설정을 사용한다.

생성된 workspace의 scheme이 `LED`인지 확인한 뒤 서명 계정 없이 Simulator용 Debug 앱을 빌드할 수 있다. 결과 `.app`은 `.local/ios-finalization/DerivedData/Build/Products/Debug-iphonesimulator/LED.app`에 생성되며, Debug 앱은 실행 중인 Metro가 필요하다.

```sh
xcodebuild -list -workspace apps/mobile/ios/LED.xcworkspace
APP_VARIANT=development EXPO_PUBLIC_WEB_URL=http://127.0.0.1:5173 EXPO_NO_TYPESCRIPT_SETUP=1 \
  xcodebuild -workspace apps/mobile/ios/LED.xcworkspace -scheme LED \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .local/ios-finalization/DerivedData CODE_SIGNING_ALLOWED=NO
```

아래 첫 명령은 Metro를 유지하고, 다른 터미널에서 두 번째 명령으로 Simulator에 설치·실행한다. CLI가 같은 프로젝트의 기존 Metro를 재사용하도록 양쪽 명령의 `--port`를 일치시킨다. 이때 `--no-bundler`와 `--port`를 함께 지정하면 CLI가 거부한다. 기존 프로세스와 충돌하면 비어 있는 Metro 포트를 선택한다.

`localhost`가 IPv6 `::1`로 먼저 해석되는 환경에서는 Metro가 IPv6에만 열리고 iOS 앱 로더의 `127.0.0.1` 요청이 실패할 수 있다. 아래 Node DNS 옵션은 해당 실행 프로세스의 localhost 해석을 IPv4 우선으로 맞추며, Metro를 loopback에 유지한다([Node DNS 기준](https://nodejs.org/download/release/v22.18.0/docs/api/dns.html)).

```sh
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" \
APP_VARIANT=development EXPO_PUBLIC_WEB_URL=http://127.0.0.1:5173 EXPO_NO_TYPESCRIPT_SETUP=1 \
  pnpm --filter @led-control/mobile exec expo start --dev-client --localhost --port 8081
# 다른 터미널; 기기 선택 화면에서 iOS Simulator를 선택한다.
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first" \
APP_VARIANT=development EXPO_PUBLIC_WEB_URL=http://127.0.0.1:5173 EXPO_NO_TYPESCRIPT_SETUP=1 \
  pnpm --filter @led-control/mobile exec expo run:ios --configuration Debug --device --no-install --port 8081
```

앱에서 실제 서비스 로그인 화면, 키보드 열기·닫기, 수동 재시도와 앱 복귀를 확인한다. 로그인 화면의 연결 확인은 인증된 계정·조명 제어 검증을 대신하지 않는다. 실제 iPhone의 `127.0.0.1`은 폰 자체이므로 Mac의 주소를 대신하지 않는다. 실제 기기는 신뢰된 개발 HTTPS 주소와 기기 서명이 별도로 필요하다.

Preview/production은 실제 공개 HTTPS 서비스 주소를 명시하고 `APP_VARIANT=production`으로 iOS를 다시 생성한다. 이때 bundle ID는 `com.ledcontrol.mobile`, HTTP 허용은 꺼진다. JS의 private HTTP 허용도 `__DEV__`에 한정되므로 development variant의 Release 앱에 HTTP 주소를 넣어 연결할 수 없다. 운영 URL·회사 signing identity·스토어 제출은 별도 입력과 검증이 필요하다.

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
- 초기 정적 스크립트는 모바일·safe-area 표시와 iOS main frame의 포커스 보정 리스너를 설치한다. 문서 ID와 유효한 환경은 현재 문서의 `onLoadEnd`에서 전달하고 웹은 그 환경까지 첫 mount를 기다린다. 반복 bootstrap은 기존 포커스·제스처 상태를 유지하며, 새 페이지를 열 때 이전 환경을 초기 주입으로 재사용하지 않는다. Android의 로드 완료 상태 SPA history 알림은 동일 문서의 ID와 ready 상태를 유지한다.
- iOS는 키보드 표시, 열린 키보드에서 새 입력 포커스, 뒤늦은 viewport 크기 변경 후 두 animation frame을 기다린 다음 현재 origin·문서·포커스를 재확인한다. 가려진 입력과 focus ring에만 현재 포커스/키보드 열림 시도당 중앙 스크롤을 한 번 적용하고, 이미 충분히 보이거나 보정한 입력은 이동하지 않는다. 사용자 touchmove/wheel/pointerdown, 키보드 숨김, 앱 비활성화, 오류·문서 교체·화면 해제는 대기 보정을 취소한다. 입력 값·selection을 읽거나 포커스·CSS·native inset을 바꾸지 않는다.
- 파싱 실패한 메시지는 raw 문자·UTF-8 크기를 먼저 제한하고 독립적인 envelope의 문서·요청 ID가 현재 파일 소유자와 일치할 때만 실패 처리한다. 오래된 문서/다른 요청/깨진 JSON/과대 메시지는 현재 전송을 취소할 수 없다.
- 새 문서/retry/renderer 종료는 이전 documentId와 callback·부분 파일을 폐기한다. 공유 sheet가 열려 있으면 OS 반환까지 파일 소유권을 유지하고 이전 문서에 늦은 결과를 전달하지 않는다.
- native 메시지 주입은 origin과 현재 웹 문서 ID를 함께 확인한다. 이전 문서에서 대기하던 메시지가 새 문서의 bootstrap 전이나 다른 ID로 도착하면 dispatch하지 않는다.
- 인증 token 복제나 native의 임의 URL 다운로드를 하지 않는다. PDF/CSV는 기존 웹 권한으로 읽은 바이트를 bounded bridge로 전달한다.

## 기기 인수 절차와 검증 한계

자동 테스트의 RN/WebView/네트워크/파일 sink는 mock 또는 메모리 구현이다. JS export와 prebuild 성공은 APK/iOS build·설치·실제 WKWebView/Android WebView 동작을 증명하지 않는다.

iOS는 이 Mac의 iOS26.5 Simulator에서 unsigned Debug 앱 빌드·설치와 실제 서비스 공개 로그인 화면, synthetic 브리지·CSV 흐름을 확인했다. 늦은 viewport 축소의 자동 회귀와 observer 없는 실제 로그인 화면의 ID 최초 포커스 cold start 2회, Next, 별도 cold start의 비밀번호 최초 포커스·재포커스, 사용자 스크롤 유지와 Done 복원을 확인했다. 인증된 메뉴·PDF·구형 iOS·실제 iPhone·조명 연동은 미검증이다.

Android 키보드는 `KeyboardAvoidingView`의 실제 frame/IME 겹침 계산과 manifest `adjustResize`를 함께 사용한다. Android 10(API29) 이하에서는 `adjustResize`일 때 React Native 키보드 이벤트가 발생하지 않을 수 있어 OS의 resize 경로에 의존한다. 현재 Android36 emulator에서 확인한 결과를 구버전 전체·제조사별 키보드·iOS 실행 검증으로 확대하지 않는다. 키보드 숨김 후 viewport 복원과 OS가 이미 resize하는 환경에서 중복 축소 여부도 인수 기준이다.

양 OS 실제 기기에서 다음을 확인한다.

1. 정상 cold start, URL 누락/잘못된 URL, 비행기 모드, DNS 오류, top-frame HTTP503, renderer 종료 후 안내/수동 재시도.
2. 320/390px 세로/가로, notch/home indicator/Android gesture·3-button navigation, OS 큰 글자, 키보드 입력 후 오류/확인·취소 접근.
3. 로그인/쿠키 만료/로그아웃/다른 계정 로그인, 외부 링크 확인·취소·차단, 앱 background/active와 offline/online 복귀.
4. Android Back에서 overlay→dirty draft 확인→route→최상위 종료. 확인 취소는 초안/선택을 유지하고 전송 중 제어가 새 명령으로 재전송되지 않는다.
5. PDF/CSV 공유, 취소, 크기 초과, chunk 중단, 다른 문서로 이동, OS 공유 UI 종료 후 임시 파일 정리. Expo share API는 OS 공유 sheet의 닫힘과 실제 파일 저장 성공을 구분해 알려주지 않는다.
6. 실제 제어/상태 확인/지도 제스처/CAD draft·lease 복구·파일 picker를 서버 권한과 함께 검증한다. 작은 fixture 검증을 실제 대형 CAD/HIL 완료로 확대하지 않는다.
