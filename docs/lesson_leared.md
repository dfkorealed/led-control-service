# 프로젝트 오답 노트 (Lessons Learned)

## [날짜 / 태스크명] - 예시
- **발생했던 문제/실수**: 서브 에이전트 리뷰 반영 중 토큰 초과로 끊겼을 때 구문 에러가 방치됨.
- **원인**: 이전 컨텍스트 확인 없이 무작정 코드 빌드부터 실행함.
- **해결 및 예방책**: 재개 시 반드시 린터와 계획서(`writing-plans`)를 먼저 로드할 것.

## 2026-07-03 / 모니터링 화면 실제 연동
- **발생했던 문제/실수**: 모니터링 화면에 층 선택, 조명 상세, 통신 품질, 게이트웨이 상태 UI가 있었지만 일부는 mock 데이터 또는 고정 텍스트에 가까웠고, API 조회도 사용자 조직 범위로 제한되지 않았다.
- **원인**: 화면 구현과 장비/MQTT 계약 구현이 별도 흐름으로 진행되어 `Fixture` 최신 상태, `Gateway` heartbeat, dashboard API, 웹 상세 패널 사이의 연결 검증이 부족했다.
- **해결 및 예방책**: UI 기능을 확정할 때는 항상 `UI 동작 -> API 응답 필드 -> DB 필드 -> MQTT/펌웨어 이벤트` 순서로 미구현 목록을 먼저 작성하고, 서비스 테스트와 화면 테스트를 함께 추가한다.
- **반복 방지 체크**: 인증이 필요한 조회 API는 controller guard, module import, service 조직 필터 테스트를 한 세트로 확인한다.

## 2026-07-05 / 빈 DB 상태 로그인 실패
- **발생했던 문제/실수**: 조명/현장 데이터를 모두 삭제한 뒤 mock 게이트웨이가 과거 fixture ID로 상태 이벤트를 계속 발행했고, API가 존재하지 않는 fixture를 `update`하려다 크래시했다.
- **원인**: 장비 이벤트는 DB 초기화, 장비 교체, mock 데이터 삭제 이후에도 늦게 도착할 수 있는데, MQTT 수신 로직이 대상 row 존재를 전제로 했다. 또한 조직에 `Site`가 0건인 최초 가입 상태를 dashboard API가 처리하지 못했다.
- **해결 및 예방책**: MQTT 상태 반영은 `updateMany`처럼 대상이 없어도 실패하지 않는 방식으로 처리하고, 현장이 없는 조직은 빈 dashboard를 반환한다.
- **반복 방지 체크**: DB를 초기 상태로 만들 때는 mock gateway를 함께 중지하거나, 수신 이벤트가 삭제된 장비 ID를 포함해도 API가 죽지 않는 테스트를 유지한다.

## 2026-07-05 / 조명 등록 전 선행 설정 누락
- **발생했던 문제/실수**: 빈 DB 상태에서 조명 등록을 시작하려 했지만 `Site`, `Floor`, `Gateway`가 없어 등록 세션을 만들 수 없었다.
- **원인**: 조명 등록 UX는 층과 게이트웨이가 이미 있다고 가정했지만, 최초 가입 사용자가 직접 현장과 층을 만드는 온보딩 흐름이 없었다.
- **해결 및 예방책**: 빈 현장 상태에서는 조명 등록 버튼보다 `초기 설치 설정` 마법사를 먼저 보여주고, 현장 생성, 층 일괄 등록, 게이트웨이 수동 등록을 완료한 뒤 조명 검색을 열어준다.
- **반복 방지 체크**: 기능 진입점마다 필요한 선행 데이터가 무엇인지 문서와 empty state에 함께 표시한다.

## 2026-07-06 / 인증 Guard가 있는 신규 API 모듈 부팅 실패
- **발생했던 문제/실수**: `FloorEditorController`에 `SessionAuthGuard`를 적용했지만 `FloorEditorModule`이 `AuthModule`을 import하지 않아 Nest 앱 부팅 시 `AuthService` 의존성 해석이 실패했다.
- **원인**: 서비스 단위 테스트와 타입체크는 통과했지만 실제 Nest module graph 부팅 검증이 빠져 있었다.
- **해결 및 예방책**: `SessionAuthGuard`를 사용하는 신규 module은 `AuthModule`을 imports에 추가한다. API 기능 추가 후에는 관련 서비스 테스트뿐 아니라 로컬 API 서버 부팅 또는 module graph를 검증한다.
- **반복 방지 체크**: `@UseGuards(SessionAuthGuard)`를 추가한 controller가 있으면 같은 module의 `imports`에 `AuthModule`이 있는지 확인한다.

## 2026-07-07 / 도면 에디터 캔버스 이벤트 대상 불일치
- **발생했던 문제/실수**: 에디터 좌측 도구를 선택해도 도면 위 클릭이 내부 `world` 레이어에서 발생하면 도형이 추가되지 않았고, 조명 드래그는 이동량 누적 방식이라 포인터 중심을 정확히 따라오지 않았다.
- **원인**: 테스트가 바깥 캔버스 클릭만 검증했고, 실제 사용자가 클릭하는 배경 이미지/월드 레이어와 조명 드래그 시작점을 충분히 재현하지 못했다.
- **해결 및 예방책**: 도형/조명 객체 클릭은 이벤트 전파를 막고, 빈 도면 영역 클릭은 도구 객체 생성으로 처리한다. 조명 드래그는 누적 delta가 아니라 현재 포인터의 world 좌표를 직접 조명 좌표로 반영한다.
- **반복 방지 체크**: 캔버스 기능 테스트는 바깥 캔버스뿐 아니라 내부 레이어, 배경 이미지, 객체, 조명 각각의 이벤트 전파 경로를 포함한다.

## 2026-07-07 / Konva 에디터 테스트 환경
- **발생했던 문제/실수**: `react-konva` 전환 후 jsdom에는 실제 `canvas.getContext`가 없어 Stage 마운트가 실패했고, 기존 DOM 객체 선택 테스트도 더 이상 유효하지 않았다.
- **원인**: Konva는 실제 canvas context를 전제로 렌더링하며, 도형/조명은 DOM 노드가 아니라 canvas 픽셀로 그려진다.
- **해결 및 예방책**: `apps/web/src/test/setup.ts`에 최소 canvas context mock을 두고, 단위 테스트는 DOM 도형 조회 대신 툴바, 속성 패널, Zustand editor state, 저장 payload를 기준으로 검증한다.
- **반복 방지 체크**: Canvas 기반 라이브러리로 전환할 때는 테스트 setup의 브라우저 API mock과 기존 DOM selector 테스트의 전환 범위를 먼저 점검한다.

## 2026-07-08 / 워크스페이스 스크립트 의존성 해석
- **발생했던 문제/실수**: 루트 `scripts` 디렉터리에 둔 게이트웨이 smoke test가 `pnpm --filter @led-control/gateway exec`로 실행되어도 `mqtt` 패키지를 찾지 못했다.
- **원인**: ESM import의 패키지 해석은 실행 명령의 작업 디렉터리가 아니라 스크립트 파일 위치를 기준으로 상위 `node_modules`를 탐색한다.
- **해결 및 예방책**: 특정 워크스페이스 패키지 의존성을 사용하는 실행 스크립트는 해당 패키지 내부(`apps/gateway/scripts`)에 둔다.
- **반복 방지 체크**: 루트 스크립트에 패키지별 dependency import를 추가할 때는 루트 의존성으로 승격할지, 패키지 내부 스크립트로 둘지 먼저 결정한다.

## 2026-07-08 / ESP-IDF BLE Mesh 모델 옵션 누락
- **발생했던 문제/실수**: ESP32-H2 펌웨어에 Generic OnOff Server와 Light Lightness Server 코드를 추가했지만 링크 단계에서 `esp_ble_mesh_register_generic_server_callback`, `esp_ble_mesh_register_lighting_server_callback` 심볼을 찾지 못했다.
- **원인**: `CONFIG_BLE_MESH=y`와 `CONFIG_BLE_MESH_NODE=y`만으로는 SIG model server 구현이 링크되지 않고, `CONFIG_BLE_MESH_GENERIC_SERVER=y`, `CONFIG_BLE_MESH_LIGHTING_SERVER=y`가 별도로 필요했다.
- **해결 및 예방책**: BLE Mesh model을 추가할 때는 ESP-IDF 예제의 `sdkconfig.defaults`를 같이 확인하고 model별 Kconfig 옵션을 명시한다.
- **반복 방지 체크**: 펌웨어 기능 추가 후에는 반드시 `scripts/esp32-h2-build.sh`로 실제 target build를 돌려 컴파일뿐 아니라 링크까지 확인한다.

## 2026-07-09 / ESP-IDF flash 스크립트 Python 버전 불일치
- **발생했던 문제/실수**: `scripts/esp32-h2-flash.sh /dev/cu.usbmodem1301` 실행 시 Homebrew 기본 `python3` 3.14.6을 잡아 `idf5.5_py3.14_env`를 찾다가 실패했다.
- **원인**: ESP-IDF v5.5.1 설치는 Python 3.12로 진행되어 실제 venv는 `idf5.5_py3.12_env`였지만, flash/build 스크립트가 Python 3.12 PATH를 직접 보정하지 않았다.
- **해결 및 예방책**: `scripts/esp32-h2-build.sh`, `scripts/esp32-h2-flash.sh`에서 `/opt/homebrew/opt/python@3.12/libexec/bin`을 PATH 앞에 자동 추가한다.
- **반복 방지 체크**: ESP-IDF 스크립트 실행 전 로그에서 `Checking "python3" ... Python 3.12.x`와 `idf5.5_py3.12_env` 사용 여부를 확인한다.

## 2026-07-10 / 조명 검색 MQTT 이벤트 생산자 누락
- **발생했던 문제/실수**: 웹에서 조명 검색 세션과 MQTT `provisioning-scan-start` 명령은 생성됐지만, 실제 gateway가 해당 명령을 구독해 `unprovisioned-device-found` 이벤트를 만들지 않아 검색 결과가 0개였다.
- **원인**: API/UI의 등록 세션 구현과 gateway의 BLE Mesh scan/provisioning adapter 구현이 분리되어 있었고, mock gateway도 고정 `MOCK_SITE_ID`만 구독해 실제 DB 현장 ID와 맞지 않았다.
- **해결 및 예방책**: gateway가 `provisioning-scan-start`, `identify-device`, `provision-device`를 구독하고 stub/command adapter를 통해 발견/완료/실패 이벤트를 발행하도록 했다.
- **반복 방지 체크**: MQTT 기반 기능은 command 발행 테스트와 event 생산자 테스트를 같은 작업 범위에 포함하고, 실제 DB의 site/gateway ID와 gateway 환경변수가 일치하는지 확인한다.
