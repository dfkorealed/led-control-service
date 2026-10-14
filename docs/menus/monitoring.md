# 모니터링 메뉴 기능 현황

- 2026-10-14 공통센서준비UI 조회정보: dashboard와 paged조명조회에 현재gateway.assignmentVersion만 추가해 정상등록재확인 요청을 현재배정에 결속한다. map/status/밝기해석·센서자격·권한/schema는 바꾸지 않는다. 해당조회unit36/36과 관련Web/모바일PC mock회귀를 확인했으며 실제적용과 감지시험은 별도다.

## 2026-10-14 선택형 맵 초기화 연동

### 구현 완료

- 서버 초기화는 현재 층의 일반 맵 요소를 비우되 등록된 조명/운영상태/제어 설정을 삭제하지 않는다. 요소만 초기화하면 기존 조명 위치가 남고, 조명 배치도 초기화하면 미배치 상태로 저장된다. CAD 신규 적용은 일반 도형만 만들고 후보 슬롯을 만들지 않는다.

### 미구현

- 설정 웹 연결과 표시·캐시 갱신의 최종 route fixture Chromium/QA를 확인하고 로컬 메인에 반영했다. 실제 고객 맵 초기화·실백엔드 브라우저·장비/HIL 확인은 하지 않았다. 맵과 조명 위치의 변경은 사용자가 설정의 초기화를 실행할 때 발생한다.

### 부족하거나 개선이 필요한 기능

- API/임시PG 증거와 실제 사용자 화면 증거를 구분한다. 미배치 전환은 조명 삭제나 전원 제어가 아니며 기존 등록/모니터링 현황은 유지해야 한다.

### 관련 파일

- `apps/api/src/floor-editor/map-document-reset.service.ts`, 설정 `FloorEditorView`·공통 `FloorScene`, `docs/menus/settings.md`.

### 갱신 규칙

- 설정의 맵 초기화·CAD 정책을 바꾸면 모니터링의 도형/조명 위치·미배치 표시와 캐시 갱신을 함께 검증한다.

## 2026-10-14 센서 UI 시험 준비 연결 복구 관찰

- 구현 완료: 새 승인된 서버 별칭2개 주소 교정/같은 Gateway image 재구성 뒤 MQTT/heartbeat/transport/protocol/mapping 정상과 현재2online/2offline을 확인했다. 등록/assignment/mapping/state·암호화 백업을 보존했다.
- 미구현: 기존시험A(B1-L001)/B(B1-L004)는 현재오프라인이다. 연결 복구를 모든 조명·센서 준비·감지 시험 성공으로 확대하지 않는다.
- 부족하거나 개선이 필요한 기능: 현재 응답 조명은B1-L002/B1-L006이다. 기존A/B의 전원/연결 확인 또는 새 대상의 사용자 선택이 필요하며 임의 등록 변경은 하지 않는다.
- 관련 파일: 기존 조명 상태 조회, `docs/project-status.md`, BIO 운영 활성화 계획. 모니터링 제품 소스 변경0이다.
- 갱신 규칙: 서버 ready·MQTT/USB·조명별online·센서 자격·실제 시험을 구분한다.

## 2026-10-13 공통 맵 로딩

### 구현 완료

- 층 맵 데이터 조회와 native/legacy 맵의 실제 첫 paint까지 공통 loading overlay를 표시한다. 이미지 로드/실패와 배경 없는 도형/빈 맵의 첫 Layer draw도 구분한다. 층 전환/문서 교체는 다시 대기하고 같은 맵의 이동·줌에서는 재표시하지 않는다.
- 접근 가능한 loading host와 absolute overlay를 사용하고 실패는 spinner가 아닌 기존 오류 상태로 전환한다. 조명 상태 조회·수동 갱신·장비 계약은 변경하지 않는다.

### 미구현

- 이번 UI 검증은 실제 장비/HIL·모바일 WebView 실기기 검증을 대체하지 않는다.

### 부족하거나 개선이 필요한 기능

- 별도 브랜치 검증 후 로컬 `codex/mvp1-cloud-web`에 `3b43b988`까지 머지했다. 최종 전체 Web3,701PASS/기존 Control5FAIL/3SKIP와 타입 포함 build/UI0, 총괄 Chromium12/12 및 머지 후 관련378/378·build/UI0을 확인했다. 기존 실패를 전체 GREEN으로 표현하지 않는다.

### 관련 파일

- `apps/web/src/features/monitoring/MonitoringView.tsx`, `features/floor-map/{FloorScene,FloorMapViewport}.tsx`, `features/map-scene/MapSceneCanvas.tsx`, `components/ui/MapLoadingOverlay.tsx` 및 unit/Chromium 회귀.

### 갱신 규칙

- 공통 맵 loading 변경은 설정·제어 문서와 함께 갱신하고 실제 렌더링 완료/전환/실패 검증과 장비 검증 범위를 구분한다.

- 2026-10-13 17:39 KST 직접 UI 시험 준비 후속: 승인된 서버 별칭2개 교정/동일 이미지 Gateway 재구성 뒤 actual fresh health/MQTT/heartbeat/transport/protocol/mapping true·USB owner1/restart0·UI4online/0offline을 확인했다. 등록/assignment/mapping/state·원래 컨테이너/암호화 백업을 보존했다. 현재 A 준비 판정은 서버 PC 시각 지연으로 차단되므로 online을 센서 사용 가능/실제 감지 성공으로 확대하지 않는다.

## 2026-10-13 BIO 이벤트 보정 서비스 반영 후 관찰

- 구현 완료: 최신 지도 작업을 보존한 채 BIO 이벤트 보정만 메인/로컬 API에 반영했다. 정상 기존 로그인 UI와 서버 ready200/5서비스 up을 확인했다. 모니터링 제품 소스/도면/배치는 변경하지 않았다.
- 미구현: 현재 현장 heartbeatFresh=false·조명4대 오프라인이다. 서버 MQTT up을 Gateway online/센서 건강/광학 출력으로 승격하지 않았다.
- 부족하거나 개선이 필요한 기능: 현재 Gateway 연결 확인이 후속이며14:09 보고 캐시와 현재 값 차이를 새 장비 설정 보존으로 해석하지 않는다. 마지막4개 수신/발생은 이번 통합 이전이었다.
- 관련 파일: `docs/menus/control.md`, `docs/project-status.md`, `apps/web/src/features/monitoring/MonitoringView.tsx`.
- 갱신 규칙: 아래14:01–14:09 온라인 기록은 당시 관찰이며 현재 상태와 구분한다. 새로운 장비 명령/움직임 시험은 하지 않았다.

## 2026-10-12 공통 renderer 반복 작업 축소 후속

### 구현 완료

- 기존 공통 맵 요소와 PixiJS/Konva를 유지한다. 동일 camera/viewport 입력은 중복 작업을 생략하고 카메라 변경과 실제 캔버스 크기 변경을 분리한다.
- 검증된 ordered paint 자산을 renderer 수명의 제한된 캐시에 보관해 새 영역/해상도 처리 시 재읽기·검증을 반복하지 않는다. 캐시는 기존 aggregate 메모리 예산을 사용하며 문서 교체·종료에서 해제한다.
- 2026-10-13 승인된 최신 API/Web 기동 후 실제 기존 세션의 모니터링과 맵 편집을 확인했다. 현장 전체 조명4개·배치0·게이트웨이0/1 경고를 정상 조회했고 현재 맵과 조명 등록·배치 구조는 기동 전후 동일하다. 게이트웨이가 연결되지 않은 로컬 앱 모드이며 장비 제어/수동 상태 갱신은 실행하지 않았다.

### 미구현

- 소프트웨어 구현·최종 검증·로컬 작업 브랜치 반영은 완료했다. 실제 대형 DWG/iOS·Android WebView/HIL 검증과 50만 요소 실험은 기존 보류 범위를 유지한다.

### 부족하거나 개선이 필요한 기능

- 이동할 때 화면 프레임을 그리는 것은 필요하다. 줄이는 대상은 도형 재구성·중복 resize/draw·동일 자산 재읽기이며 모든 redraw 제거를 보장하지 않는다. 설정 편집기의 팬 중 Konva hit 비용 축소는 모니터링의 조명 선택 동작을 바꾸지 않는다.
- 합성 10,002개 공통 요소 계측의 개선과 실제 고객 도면·1000개 등록 조명 합성·모바일 WebView 성능 보장은 구분한다.
- F3 집중 227 PASS/기존 opt-in 2 SKIP와 Chromium/WebGL 17/17을 확인했다. 1만 선 포함 10,002개 요소에서 60회 이동은 draw 120→59·resize 60→0이며 density/새 영역의 캐시 자산 재읽기는 16/12→0/0이다. frame p95는 기준 9.9ms·최종 9.4ms, peak는 25,719,627→26,350,981bytes/128MiB budget, dispose 뒤 0bytes다. 작업 횟수 감소와 실제 기기 FPS 보장을 구분한다.
- 위 수치는 기본 CAD pending display 재시도 추가 전 cohort다. 마지막 source freeze 뒤 집중 228 PASS/2 SKIP·fresh 전체 Web 3,663 PASS/동일 기존 제어 5 FAIL/3 SKIP·타입 포함 build exit0·UI 정책 0/0·최종 브라우저 17/17을 확인했다. 총괄 마지막 dense p95는 10.1ms로 기준 9.9ms와 비슷하며 실제 FPS 향상률로 표현하지 않는다. 독립 최종 리뷰는 C0/P2 0이다.
- `92f73077`까지 로컬 작업 브랜치에 반영했고 MAIN 관련 320 PASS/2 SKIP·타입 포함 build exit0, 검증한 Web/API 소스 diff0을 확인했다. 실제 모니터링 재저장·조명 제어·장비/DB/API 변경은 추가하지 않았다.

### 관련 파일

- `apps/web/src/features/map-scene/{MapSceneRenderer,map-raster-backend,map-paint-window}.ts`, `features/cad-scene/CadSceneRenderer.ts`와 직접 unit·WebGL/Chromium 회귀.

### 갱신 규칙

- 공통 renderer 수정은 설정·모니터링 문서에 함께 기록한다. 실제 표시 완료와 document 준비를 구분하고 카메라/세대 실패 복구·dispose 메모리와 픽셀을 같은 검증에 포함한다.

## 2026-10-12 공통 맵 raster 카메라 재사용

### 구현 완료

- 설정 맵 편집과 공유하는 공통 renderer는 이동 중 기존 raster 타일을 재사용하고 화면 밖 타일도 메모리 예산 내 캐시에 유지한다. 이동은 카메라 transform으로 즉시 반영하며 새 가시 영역과 줌 종료 뒤 정밀도는 필요할 때 갱신한다.
- 읽기 전용 맵·선택·등록 조명과 공통 문서 계약은 그대로다. 숨김·삭제·문서 세대 변경과 renderer 종료의 무효화·메모리 회수 경로를 유지한다.

### 미구현

- 승인한 공통 renderer 범위를 사용자 승인으로 로컬 MAIN `codex/mvp1-cloud-web`에 통합했다. 새로운 모니터링 기능·API·장비/HIL 작업이나 원격 배포는 추가하지 않았다.

### 부족하거나 개선이 필요한 기능

- 캐시 재사용은 전체 GPU 프레임 그리기가 사라짐을 뜻하지 않는다. 작은 합성 fixture의 계측을 실제 대형 CAD·iOS/Android WebView 성능 보장으로 확장하지 않는다.
- Chromium 19/19에는 공통 맵 적용·저장·새로고침 뒤 PC/모바일 모니터링 픽셀·조명 합성·줌·이동 검증을 포함한다. WebGL 14/14도 별도로 통과했다. 전체 Web 3,641 PASS/기존 제어 5 FAIL/3 SKIP는 제품 소스 고정 cohort이며 전체 서비스/HIL 완료를 뜻하지 않는다.
- 로컬 MAIN 병합 후 공통 맵 적용·재조회·PC/모바일 표시를 포함한 관련 Chromium 9/9 PASS와 타입 포함 build exit0을 재확인했다. 전체 Web은 3,641 PASS/동일한 기존 제어 5 FAIL/3 SKIP다. [메인 통합 증거](../assets/editor-comments-2026-10-12/root-integration-proof.json)에 원 로그와 소스 보존 결과를 기록한다.

### 관련 파일

- `apps/web/src/features/map-scene/{map-raster-backend,map-raster-grid,MapSceneRenderer}`, `features/cad-scene/CadSceneRenderer`와 직접 unit·WebGL 회귀.
- [검증 manifest·원 로그](../assets/editor-comments-2026-10-12/manifest.json).

### 갱신 규칙

- 공통 renderer 변경은 설정과 모니터링 문서를 함께 갱신하고 실제 장비 검증과 브라우저 성능 계측을 분리한다.

## 2026-10-12 지도 조작·툴바·하단 상세 교정

### 구현 완료

- 지도는 기존 manual-cad opt-in과 pan 정책을 소비한다. PC 중간 버튼/Space 이동과 좌클릭 단일 선택, 모바일 marker 시작 swipe 이동과 tap 선택을 지원하며 영역 선택은 하지 않는다. 공통 viewport 기본값·renderer/camera 수명은 유지한다.
- 순수 snapshot 60초 초과 지연은 기존 알람센터 ‘현재 화면 상태’에만 표시하고 상단 toast/최근 알림을 생성하지 않는다. 새 snapshot으로 복구하면 사라진다. 조회 실패·invalid/future 시각 경고는 기존 transient 안내를 유지하며 서버 현장 장애 알람·읽음/지우기·미읽음 수는 별도 계약이다.
- loading/error/main의 h1은 sr-only로 보존한다. 층 선택·통합 검색/목록·마지막 갱신·새로고침을 한 도구 행으로 배치한다. 좁은 화면은 기존52px icon action과 accessible label, 현장 시간 HH:mm/전체 시각 설명을 사용한다. 시각 미확인 안내도 전체 접근 가능한 설명을 유지한다.
- 조명 상세는 PC·모바일 동일한 지도 내부 하단 약 절반 nonmodal overlay다. 지도 영역은 줄이지 않으며 상세 본문만 스크롤한다. 닫기/Escape·현재 scope의 opener 복귀·선택/필터/삭제 수명과 상세 scroll 기억을 유지한다.
- 기존 페이지 담당의 인수 검증에서 제품 `ac323a3d`와 동일한 소스의 직접 `MonitoringView`/`FloorMap` 2개 suite 127개가 일괄 통과했다. snapshot 60,000/60,001ms·복구·오류/시각 안내, marker gesture/단일 선택, 상세 열기/닫기·scroll/초점 수명을 확인한 소프트웨어 증거이며 실제 화면 geometry 완료를 뜻하지 않는다.

### 미구현

- 서버 snapshot 지연을 영구 incident로 저장하는 새 DTO/producer는 추가하지 않았다. API/DB/장비/배포/HIL 변경은 없다.

### 부족하거나 개선이 필요한 기능

- 직접 컴포넌트/gesture 회귀와 별도로 `2290a877` 실제 UI case1/2에서 1194px PC의 중간 버튼/Space 이동·휠 줌·단일 선택·한 행 툴바·약 절반 상세 및 map rect/camera/renderer 불변·재열기/초점 복귀, 390×600 dark의 툴바/nav 연속44px hit·HH:mm/전체 접근 가능한 시각·상세 끝 도달·native 문서 스크롤0→83과 상세 scroll 복원을 확인했다([영구 결과와 원 증거](../assets/map-workspace-comments-2026-10-12/README.md)). 모바일은 무스크롤 화면 계약이 아니며 PC 상세의 양의 내부 scroll 범위·모바일 상단 복귀·모니터링320px 실제 화면·새 e35 여섯 case 일괄 실행·OS 키보드·live API·HIL·물리 슬라이더 드래그는 이 결과로 완료를 주장하지 않는다.
- 지연 화면 상태에는 읽음/지우기 동작이 없다. 최근 알림이나 서버 incident의 읽음이 현재 지연의 해결을 뜻하지 않는다.

### 관련 파일

- `apps/web/src/features/monitoring/{MonitoringView,FloorMap}.tsx` 및 직접 테스트. 기존 `components/ui/maps/OperationMapPanel.tsx`와 `features/floor-map/FloorMapViewport.tsx`의 계약을 소비하며 공통 제품 API 변경은 없다.

### 갱신 규칙

- 조회 metadata 지연·서버 장비 장애·transient 알림을 구분하고 직접 unit과 실제 geometry/HIL 범위를 합산하지 않는다. 아래 과거 desktop aside/mobile modal·보이는 h1 기록은 당시 구현 이력이며 현재 계약은 이 절을 따른다.

## 2026-10-12 CAD 맵 치수·문자 교정

### 구현 완료

- CAD에서 생성하는 공통 맵 요소의 치수 좌표 중복 이동과 MTEXT 글꼴 서식의 literal 표시를 교정했다. 설정에서 다시 가져와 적용한 정본을 모니터링도 그대로 사용하며 읽기 전용 정책은 유지한다.
- 실제 제공 DWG 두 파일의 공통 정본 적용과 fresh 읽기 전용 reader 재조회를 2/2 검증했다. 첫 파일 219개·두 번째 397개 요소와 한글 텍스트를 보존하며 CAD 가져오기가 실제 조명/mesh node를 생성하지 않는 것을 확인했다.
- 검증된 별도 CAD 브랜치를 UI 결과 위에 정상 로컬 병합 `5e9b640b`로 통합했다. 병합 후 API 타입·빌드 exit0과 기존 Web/Shared 불변을 확인했으며 실제 로그인 브라우저 재적용이나 기존 맵 backfill을 뜻하지 않는다.

### 미구현

- 로그인 브라우저의 기존 현장 재적용은 미실행이며 서비스/DB/저장소 pipeline 검증을 브라우저 검증으로 표현하지 않는다. 모니터링 UI 신규 기능은 추가하지 않는다.

### 부족하거나 개선이 필요한 기능

- 기존 저장 맵에는 자동 backfill을 하지 않는다. 원래 글꼴·다중행 텍스트 및 기존 미지원 SOLID 화살표까지 완전 재현하는 작업은 이번 범위 밖이다.

### 관련 파일

- `apps/api/src/floor-import/{cad-geometry,cad-text-layout,cad-text-decoder,cad-scene-builder,cad-svg-renderer}.ts` 및 직접 회귀 테스트.

### 갱신 규칙

- 가져오기 수정과 기존 데이터 변경을 구분하며 공통 정본 생성 변경은 설정·모니터링 양쪽에 기록한다.

## 2026-10-11 신규 조작 의견 — 현장명 단순화·통합 검색/목록·고정 범례

### 구현 완료

- 고객 공통 헤더의 현재 현장은 site.name만 표시한다. 고객사 접두사를 제거하되 권한 목록/URL scope·truncate/title·집계/action 폭 확보·52px 계정 링크와 기존 모바일 조작 영역은 유지한다.
- PC 층 선택 너비를 기존 utility로 넓히고 모바일 flex 폭을 유지한다. 단일 ‘조명 검색/목록’ 패널에 이름/번호 검색·기존 상태 필터·스크롤 결과 목록을 항상 표시한다. 모바일은 공통 bottom-sheet opt-in을 사용하며 중복 상세 select와 목록 펼침을 제거했다. 결과 클릭은 기존 지도 중심/marker 포커스·pin 경로를 사용하고 미배치/위치 불명은 상세로 연결한다.
- 조명 범례는 데이터 존재 여부와 무관하게 정상/장애/오프라인/상태 확인 대기/조명 정보 확인 전의 renderer 5상태를 항상 표시한다. 기존 토큰과 snapshot-only 정보 대기 식별을 유지한다.

### 미구현

- 실제 화면·통합 타입/UI 정책/빌드·최종 리뷰는 총괄/QA 후속 검증이다. API/DB/서버·운영·실장비/HIL 변경은 없다.

### 부족하거나 개선이 필요한 기능

- 번호 검색은 이름 문자열에 포함된 번호이고 이미 조회한 조명 목록을 대상으로 한다. 전체 서버 검색으로 표현하지 않으며 기존 다음 페이지·부분 오류·집계 확인 시점 차이 안내를 유지한다.
- 이전 short-mobile 하단 메뉴 공간과 desktop 헤더 폭 수리를 유지한다. 새 패널의 실제 모바일 마지막 action/중첩 select 도달과 5범례 footer 높이는 최종 QA 범위다.

### 관련 파일

- `apps/web/src/features/shells/CustomerShell.tsx` 및 직접 테스트. `features/monitoring/{MonitoringView,MonitoringFixtureFinder,FloorMap}.tsx`와 직접 테스트.

### 갱신 규칙

- 공통 현장 정보 변경은 네 메뉴에 같이 기록한다. loaded 목록/서버 집계와 실제 UI/소프트웨어 검증·실장비 증거를 구분한다.

## 2026-10-11 공통 필터·날짜·행 상세 교정

### 구현 완료

- 공통 FilterPanel은 모바일에서 하단 modal sheet, desktop에서 기존 popover를 사용한다. 중첩 달력/select와 닫기 잠금·포커스 복귀 계약을 유지한다.
- 날짜는 실제 달력 아이콘과 square 44px trigger, 안쪽 segment focus를 사용한다. 범위는 한 줄이며 raw draft·검증을 유지한다. DataGrid는 선택적 카드 요약 열과 stable row key에 연결된 인라인 상세를 제공한다.

### 미구현

- 실제 짧은 320/390px 화면·양 테마의 geometry와 최종 통합 검증은 후속 QA 범위다.

### 부족하거나 개선이 필요한 기능

- 날짜 숫자 segment는 텍스트 폭이다. 6개 segment와 달력을 320px 한 줄에 넣기 위해 segment 개별 44px 폭은 적용하지 않으며 전체 입력 높이와 달력/버튼 hit는 유지한다. 단위 테스트는 실제 화면의 겹침·터치 검증을 대신하지 않는다.

### 관련 파일

- apps/web/src/components/ui/{FilterPanel,DataGrid}.tsx, overlays/Popover.tsx, date/{DatePicker,DateRangePicker,date-field}.tsx 및 직접 테스트.

### 갱신 규칙

- 공통 소비 변경 시 네 메뉴 문서를 함께 갱신하고 실제 browser 증거를 단위 검증과 구분한다. API/권한·데이터·작업 수명은 유지한다.

## 2026-10-11 브라우저 의견 반영 — 공통 헤더·표 정렬

- PC 계정 링크는 기존 둥근44px 영역의 연속44px 조작 한계를 보완해 기존52px icon target 크기를 사용한다. 링크 의미/href/focus는 유지하고 모바일 비표시와 계정 기능 본문은 변경하지 않는다. 원형상 실패와 최종 세 폭 실제 조작 검증은 QA 증거로 구분한다.

- 긴 현장명 후속: desktop 헤더는 집계와 action의 내용 폭을 먼저 확보하고 현장명에 남은 폭을 배분해 줄임표가 동작하도록 grid track을 보완했다. 기존1280/760 실제 집계 overflow와 테마 버튼 가림은 원 증거에 보존한다. gap12·모바일 네 동일 폭 행·로고·권한/URL 수명은 유지하며1440/1280/760 실제 비겹침 후속 검증은 QA 보고서로 구분한다.

### 구현 완료

- 현재 customer admin/viewer의 단일 현장 계약에 맞춰 고객 헤더의 현장 선택과 전환 전용 dialog/hook/component를 제거하고, 권한 목록에서 확인한 현재 현장을 일반 텍스트로 표시한다. 현장 목록 권한 확인·dashboard·URL siteId·알람 scope와 로그아웃 dirty guard를 보존한다.
- PC 헤더 네 집계는 내용 폭과 균일한 간격으로 표시하며 모바일 네 동일 폭 셀은 유지한다. DataGrid의 명시 align은 헤더·정렬 버튼·본문·모바일 값에 적용한다. align이 없으면 기존 헤더 center/본문 left/customer compact card right 기본값을 유지한다.

### 미구현

- 이번 단계에서 전체 Web·타입·UI 정책·빌드·브라우저 검증은 실행하지 않았다. 최종 묶음 검증은 총괄 후속 범위다. API/DB 계약·운영·실장비/HIL 변경은 없다.

### 부족하거나 개선이 필요한 기능

- 공통/모니터링 직접 5 suites 190개가 통과했다. 설정 suite 첫 실행의 별도 홈 카드 group 조회 실패는 기본 d8dbfcd1의 정확 동일 테스트에서도 재현되어 이번 변경과 분리한다. 기존 실패를 전체 통과로 숨기지 않는다.
- 새 현장 정보 표시와 PC 집계 간격의 실제 긴 이름/양 테마/viewport 화면 검증은 최종 브라우저 단계에 남아 있다.

### 관련 파일

- `apps/web/src/features/shells/{CustomerShell,CustomerHeaderSummarySlot}.tsx`, `apps/web/src/components/ui/DataGrid.tsx` 및 직접 테스트. 전환 전용 `features/sites/{SiteSwitcher,useGuardedSiteSelection}`와 전용 테스트는 삭제했다.

### 갱신 규칙

- 현장 표시 제거와 서버 권한 조회 제거를 혼동하지 않는다. 공통 헤더·DataGrid 소비 변경 시 네 메뉴 문서를 같이 갱신하고, focused 검증과 최종 화면/전체 검증을 구분한다.

## 2026-10-11 모니터링 지도·제목 교정

- 짧은 모바일 후속: 일반 compact screen 자체도 내용 최소 높이를 유지해 하단 메뉴 safe-space가 ticker 뒤 실제 문서 스크롤 범위에 포함되도록 보완했다. 원390×600 실패는 최대scroll179에서 ticker bottom591/navTop532로59px 가렸던 실제 제품 결함이다. tall 지도 성장/flex1·canvas240/전체보기 수명은 유지한다. 직접 unit은 선언 경계만 검증하며 실제 short case 후속 결과는 최종 검증 보고서로 구분한다.
- 구현 완료: 일반 모바일 지도 행도 남은 viewport 높이를 flex로 채우며 짧은 화면에서는 자연 최소 높이와 문서 스크롤을 유지한다. 공통 canvas 240px 하한·contain:size·renderer·camera는 그대로다. 모니터링 main/loading/error의 ATLAS / OPERATIONS와 지도 패널의 중복 보이는 제목을 제거했고 단일 h1·선택 층 집계의 접근 가능한 scope·층 도면 region은 보존한다.
- 미구현/한계: 578/681×1227 실제 높이·짧은 화면 ticker/도구 접근성의 브라우저 검증은 최종 단계 대기이며 unit 클래스 선언 검증을 실제 layout 증거로 확대하지 않는다.
- 관련 파일: `apps/web/src/features/monitoring/MonitoringView.tsx`와 직접 테스트. 갱신 규칙: mobile/short/desktop 지도 높이와 camera owner 보존을 함께 확인한다.

## 2026-10-10 충실도 교정 최종 확인

### 구현 완료

- 단일 제목/eyebrow·갱신·compact 층 선택, 두 검색/목록 진입의 공유 상태와 실제 opener 복귀, plain 상세·이력·ticker owner를 공통 customer 표현으로 교정했다. 모바일 로고/select, PC·dark 대표 화면과 finder를 확인했다. 감사34행은 [담당 결과](../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/implementation/task-5-report.md)의 처리/보존 mapping을 따른다.
- 최종 타입·UI 정책79/79·UI위반0/0·빌드 exit0 및 code/UI·UX 최종 리뷰를 회수했다. 아래 Task5/eyebrow의 ‘Task11 대기’는 당시 기록이며 [최종 증거](../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/implementation/README.md)가 현재 검증 범위다.

### 미구현

- 전체138 runtime/583/Lab/canonical/HIL·전 브라우저/대비 행렬은 미실행. 실제 장비 refresh나 운영 데이터 쓰기를 이번 교정의 완료로 주장하지 않는다.

### 부족하거나 개선이 필요한 기능

- 캡처의 unknown 집계/ticker 오류는 미제공 fixture 상태다. 정상 집계/범례 있는 footer/정상 ticker 모두의 pixel 증거가 아니며 source/unit 근거와 구분한다. 실제562×844와 원목업562×1229는 같은 높이 검증이 아니다. 기존 큰 번들 경고와 실제 CAD/권한/알람/BIO 한계는 남는다.

### 관련 파일

- 위 Task5·공통 보고서, `apps/web/e2e/atlas-ui-fidelity.spec.ts`, [최종 화면/로그 목록](../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/implementation/README.md).

### 갱신 규칙

- source별 focused 통과와 전체 최종HEAD 일괄 통과를 구분한다. 최초 실패/근사 typography/운영 및 장비 한계를 지우지 않으며 로컬 통합 상태는 계획/상태판에 기록한다.

## 2026-10-10 공통 eyebrow 후속

### 구현 완료

- 공통 PageHeader의 선택적 `eyebrow?: ReactNode`를 소비해 단일 h1 위에 목업 원문의 ATLAS / OPERATIONS를 중립 secondary 색상으로 표시한다. title/ref/ARIA/설명/status/actions를 유지하고 같은 헤더가 main/loading/error 분기를 계속 소유한다. 설정 제목은 단순형을 유지한다.
- 기존 overline11px/bold·8px 내부 gap을 재사용하고 자간은 기존 상속을 유지한다. 목업10/11px·.14/.16em 자간을 위한 신규 token/registry/policy는 추가하지 않으며 실제 pixel 일치는 최종 화면 검증 범위다.

### 미구현

- 실제 responsive/dark 화면 및 통합 type/UI/build 검증은 Task11에 남는다. 전체 Web/E2E/Lab/canonical/HIL은 이 후속에서 실행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 공통 CustomerPresentation/Typography33개와 직접 소비자 focused10개가 통과했다. 소비자396개는 필터 비선택이며 전체 suite 통과로 확대하지 않는다. 하드웨어 상태/통계 값/보고서 결과를 목업 값으로 변경하지 않는다.

### 관련 파일

- `apps/web/src/components/ui/{PageHeader.tsx,CustomerPresentation.test.tsx}`, `features/monitoring/MonitoringView.tsx`, `features/control/ControlView.tsx`, `features/statistics/{StatisticsOverviewPage,analysis/StatisticsAnalysisPage,reports/StatisticsReportsPage}.tsx` 및 직접 제목/진입 focused tests.

### 갱신 규칙

- eyebrow는 공통 PageHeader 표현 slot만 사용하며 별도 header wrapper/제목 owner/query를 복제하지 않는다. 실제 검증 범위·비선택/미실행·pixel 근사를 함께 기록한다.

## 2026-10-10 ATLAS 충실도 교정 — Task 5 메뉴 소비

### 구현 완료

- 본문 공통 고객 PageHeader의 제목과 실제 마지막 갱신·새로고침을 함께 배치한다. 모바일도 지도 위에서 자연 줄바꿈하며 하단 메뉴 안전 여백은 화면이 한 번만 소유한다. 층 선택은 PC에서 불필요한 가용 폭 확장을 없애고 모바일의 유연한 폭은 유지한다.
- `조명 검색·상세`와 별도 `조명 목록` 버튼은 같은 fixture query·검색·상태·목록 owner를 재사용한다. 목록 진입은 기존 목록을 즉시 열고 각 실제 opener를 Popover anchor·닫기/상세 종료 후 반환 대상으로 기억한다. 별도 서버 검색·필터 API나 중복 fixture query를 추가하지 않는다.
- 검색/상태 필드를 선택 selector보다 먼저 놓고 내부 finder 카드 경계를 제거했다. 목록의 실제 상태는 공통 StatusBadge, 선택 상세는 공통 plain SidePanel과 평면 정보 행을 사용한다. 역사 밝기·마지막 관찰·상태 조치·배치 여부와 미조회/미배치 안내는 유지한다.
- 최근 활동은 공통 `최근 활동` 제목·전체 보기 arrow와 실제 상태/outcome badge를 소비한다. 눈에 보이는 시각은 현장 시간의 시·분·초이며 전체 날짜·시각은 화면 읽기용 텍스트와 전체 로그에 남긴다. unknown은 성공으로 표시하지 않는다. 같은 이벤트 내용의 새 배열이나 무관한 렌더는 현재 row/5초 타이머를 초기화하지 않고 실제 내용·scope 변경은 초기화한다.
- retained query 목록은 source/보존 membership이 같을 때 identity를 유지한다. 매 clock wake에서 만료 여부를 계속 판단하고 오류·fetch/paused 동안 기존 활동을 숨기는 계약을 유지한다. 전체 로그는 실제 time/status/content만 공통 DataGrid에 연결하며 50/100/500/1000·날짜 초안·cursor·401/400/410·보존 기간·초점/안전 영역을 유지한다.

### 미구현

- Task5 당시 optional eyebrow는 공통 PageHeader slot이 없어 공통 후속으로 남았으며 위 후속에서 해결했다. Task5 메뉴 작업 자체는 공통 소스나 다른 메뉴를 수정하지 않았다.
- 이번 작업은 집중 단위 검증 범위이며 최종 통합 타입/UI 정책/빌드·fixture 화면 검증은 Task 11에 남는다. 실제 서비스·장비 refresh 클릭, WebView/Gateway/LED HIL은 수행하지 않는다.

### 부족하거나 개선이 필요한 기능

- DOM/타이머 단위 검증은 320/390/562px·양테마 실제 bounds·대비·native scroll/터치 완료 근거가 아니다. 특히 두 opener의 portal 반환·DataGrid 긴 내용·짧은 화면 안전 영역은 최종 fixture 화면 확인이 필요하다.
- 실제 CAD/조명 수/상태와 목업 데이터 차이는 교정 대상이 아니다. 운영 알람 정책·BIO 관찰/건강·오프라인 안전 기준 및 서버/API 한계는 기존 기록을 유지한다.

### 관련 파일

- `apps/web/src/features/monitoring/{MonitoringView,MonitoringFixtureFinder,FixtureDetailPanel,MonitoringLogTicker,MonitoringLogDrawer}.tsx`, `useMonitoringActivity.ts`, `monitoring-activity-presentation.ts`와 직접 관련 시험. pin Popover·지도 renderer/camera·갱신 job·알람센터 API는 기존 구현을 소비한다.

### 갱신 규칙

- 실제 opener/scope/보존·query·갱신 의미와 시각 배치를 구분한다. 후속 공통 eyebrow와 Task 11의 실제 실행 결과를 회수한 뒤에만 해당 검증 완료 상태를 기록한다. 과거 단일 Popover·하단 refresh 설명은 당시 구현 이력으로 보존한다.

## 2026-10-10 공유 지도 chrome (Task 4)

### 구현 완료

- 공유 OperationMapPanel의 title/tools-left·실제 summary-right와 inset16/12를 적용했다. 현재 존재하는 상태의 아이콘/라벨 범례를 FloorMapViewport.footerStart에 전달하여 camera-right와 같은 wrapping static footer bar로 표시한다. 별도 중복 범례 strip은 제거했다.
- viewport/renderer identity·카메라/zoom/fit·선택/gesture·전체보기 owner와 기존44px 및 더 큰52px hit를 유지한다. footerStart 없는 소비자의 기존 footer 및 기본 overlay 배치는 불변이다.

### 미구현

- 실제 mobile/short desktop/footer wrap·dark geometry 최종 확인은 Task11 범위다.

### 부족하거나 개선이 필요한 기능

- 두 공유 map suite와 selector 계약, monitoring 범례/zoom focused 검증이다. 실제 브라우저 시각 일치·CAD 성능·게이트웨이/조명 HIL 완료 증거는 아니다.

### 관련 파일

- `apps/web/src/components/ui/maps/OperationMapPanel.tsx`, `features/floor-map/FloorMapViewport.tsx`, `features/monitoring/FloorMap.tsx`, `features/control/target-selection/SpatialTargetSelector.tsx` 및 관련 focused tests.

### 갱신 규칙

- footer slot opt-in/default 경계·실제 상태·카메라 lifetime·최소 viewport240/사용성 hit와 추후 browser/HIL 한계를 함께 기록한다.

## 2026-10-10 고객 shell·제목·탭 소유 (Task 3)

### 구현 완료

- 고객 desktop header는 현장 선택/실제 네 집계/기존 상태·테마·계정 링크를 한 행으로 배치하며 mobile logo/select 및 집계 둘째 행을 유지한다. shell의 route h1을 본문으로 옮기고 공통 customer 탭·sidebar soft active 및 compact account strip을 연결했다.
- 본문 모니터링 h1과 갱신 도구가 지도 위에 표시된다. 지도 카메라·선택·활동 owner와 고정 내비게이션 여유는 유지한다.

### 미구현

- 메뉴 상세 표현·지도 chrome의 후속 교정과 최종 통합 시각 검증은 남아 있다.

### 부족하거나 개선이 필요한 기능

- shell/summary/control tabs/settings shell targeted 계약 검증이며 실제 320–desktop geometry·dark 대비·실장비 완료 증거는 아니다.

### 관련 파일

- `apps/web/src/features/shells/{CustomerShell,CustomerHeaderSummarySlot,CustomerAccountPanel,SettingsNavigationItem}.tsx`, `settings/{SettingsShell,SettingsSubnavigation,settings-sections}.tsx`, `control/automation/ControlModeTabs.tsx`, `statistics/StatisticsSubnavigation.tsx` 및 메뉴 본문 제목 소비자.

### 갱신 규칙

- 단일 h1·실제 capability/summary0·unknown·라우트와 작업 잠금 계약을 유지하며 최종 browser 확인 및 mock/하드웨어 한계를 별도 기록한다.

## 2026-10-10 공통 고객 표현 기반 (Task 2)

### 구현 완료

- 고객 title/metric·card inset·soft pill navigation의 opt-in API와 단일 NavigationCard를 추가했다. 고객 theme 안 보조 버튼을 중립/transparent 표현으로 바꾸고 compact DataGrid는 label/value 두 열 카드로 표시한다. 필터는 라벨과 양수 count, ticker는 desktop 제목/mobile 접근성 제목, 지도 인라인 집계는 상태 dot과 중립 수치를 사용한다.

### 미구현

- 메뉴별 신규 API 소비·전체 상세 화면 교정은 후속 태스크에서 적용한다.

### 부족하거나 개선이 필요한 기능

- 공통 계약의 focused 검증만 수행했다. 메뉴의 실제 시각 일치·브라우저 geometry·실장비 연동 완료 증거는 아니다.

### 관련 파일

- `apps/web/src/components/ui/{Typography,PageHeader,Card,NavigationCard,UnderlineNavigation,Button,DataGrid,FilterPanel,SidePanel}.tsx`, `operations/{InlineStatusSummary,RecentActivityTicker}.tsx`, `fields/Slider.tsx`.

### 갱신 규칙

- 메뉴별 소비와 검증은 해당 후속 구현에서 갱신하며 기본 variant·실제 데이터/권한/작업 owner·44px hit의 한계를 함께 기록한다.

## 2026-10-09 ATLAS LEAN 마무리

- 고객 공통 UI·라이트/다크·모바일 레이아웃과 모니터링 현장/층 표시·탐색의 ATLAS 적용을 구현했다.
- 후속 개선: `MonitoringLogTicker.tsx:23`의 rows 배열 identity 기반 memo와 `useMonitoringActivity.ts:52`의 렌더마다 새 배열 생성으로 선택·테마 등 무관한 부모 렌더에서 티커 첫 항목·5초 타이머가 초기화된다. 표시 내용 기준 identity 안정화는 후속 작업이며 지금 제품 변경·테스트 추가는 하지 않는다.
- 이번 최종 검증의 실제 범위·결과는 [상태판](../project-status.md#2026-10-09-atlas-lean-최종화)을 따른다. 전체 583개·Lab·canonical은 축소 범위 밖/미실행이며 기존 mock·실장비·BIO·과거 실패 기록은 보존한다.
- 최종화 절차의 상태는 [계획 체크리스트](../superpowers/plans/2026-10-07-atlas-ui-refresh.md)를 정본으로 확인한다.


## 2026-10-09 ATLAS·BIO 고정 업스트림 합성 — 관찰 의미 보존, 최종 검증 전

### 구현 완료

- ATLAS의 실제 모바일 브랜드/compact select·stable 양테마·서버 floor 집계/null0·공통 활동과 upstream BIO의 sanitized 준비 projection/실제 runtime 관찰 경계를 함께 보존했다. 공유 지도 선택 stroke만 reactive palette를 사용하며 원본 CAD 색·camera·renderer identity는 유지한다.
- 합성된 shell/map/기존 BIO 소비를 포함한 지정11 unit288PASS와 Web type/UI/build0(부채0)을 회수했다. 별도 support26은24PASS/기존 opt-in2SKIP로 실제 transport/ACL2를 검증하지 않았다. 생성 output 원복·owned cleanup은 확인했으나 새 전체 브라우저 검증은 아니다.

### 미구현

- 새 통합 source의 전체18/ONE Lab/canonical·독립 whole review와 기본 checkout ff-only 병합은 아직이다. 모니터링 전용 BIO 준비 패널·incident/알림 신규 연동·운영 적용/장비 검증을 추가하지 않는다.

### 부족하거나 개선이 필요한 기능

- candidate/matched/과거 GET/준비 응답을 모니터링 정상·sensor 건강·광학 밝기/전력으로 합성하지 않는다. catalogempty/policyOFF·실제 WebView/RF/광학 HIL 및 양쪽 역사 실패의 한계를 유지하며 옛 LIST/부분 PASS는 새 source 증거가 아니다.

### 관련 파일

- `apps/web/src/features/floor-map/FloorScene.tsx`, `apps/web/src/features/shells/CustomerShell.tsx`, 기존 monitoring adapter/query, `.superpowers/sdd/2026-10-07-atlas-ui-refresh/task-12-upstream-integration-implementation.md`.

### 갱신 규칙

- 서버 현장/층 집계·loaded pin·준비/자격/runtime/광학 증거를 구분한다. 목업과 양쪽 과거 기록의 원문을 보존하며 actual source의 새로운 통합 관문을 회수한 뒤에만 완료 상태를 갱신한다.

## 2026-10-07 고객 공통 키보드 포커스 합성 보완 (Task 11)

### 구현 완료

- 고객 light/dark root의 승인 border-focus 역할을 공통 `shadow-focus`의 고객 전용 compiler supplement에 연결한다. stock shadow·명시 shadow-color·다섯 inset/ring/offset/outer 슬롯과 3px geometry를 보존하고 고객 marker 제거 시 비고객 기본 표현을 복원한다. 선언적 shadow2/root alias를 utility가 동적으로 읽는다고 주장하지 않는다.
- exact base-only PostCSS 구조와 CSS 공백만 허용하는 경계 검증으로 utility1/rule1/declaration1을 제한한다. NBSP/VT·중복·변조·escape·외부 override를 거부하며 canonical734/승인 anchor `fac0d214`·빈 baseline을 유지한다.
- 현재 공통 소스의 compiled 계약85개·기존 공통 소비자341개, fresh Web 타입/UI 정책/빌드가 통과했다. public fixture의 양 팔레트40개 focus 대비·border 보존·합성/default/blur와 원 dark390 현장 선택의 실제 focus8.009:1 도달 경계를 확인했다.

### 미구현

- 전체 Task11 화면 매트릭스·후속 alarm/body/PDF 검증과 브랜치 병합은 완료하지 않았다. 새로운 API·장비 제어 기능을 추가하지 않았다.

### 부족하거나 개선이 필요한 기능

- 원 dark390 testcase는 포커스 관문 뒤 QA 색상 parser가 `oklab(0 0 0 / 0.5)`를 해석하지 못해 1FAIL이다. 공통 포커스의 scoped GREEN을 전체 testcase PASS로 확대하지 않는다. 원1.3116 focus 실패 및 중간82/1·83/1 로그는 보존한다.
- public CSS fixture와 Chromium software 검증이며 forced-colors·실제 OS/native WebView·Gateway/Mesh/조명 HIL 검증을 대체하지 않는다. 목업 이력과 실제 서비스 결과를 구분한다.

### 관련 파일

- `apps/web/src/styles/base.css`, `apps/web/scripts/ui-policy.mjs`, `apps/web/scripts/ui-policy.test.mjs`, `apps/web/scripts/ui-policy-baseline.json`, `apps/web/scripts/customer-theme-contract.test.mjs`, `docs/ui-spacing.md`.

### 갱신 규칙

- compiler recipe·기본 token·고객 경계·명시 색상/ring 합성과 실제 포커스 관문을 함께 검증한다. 원 QA parser 수리·후속 화면·물리 검증은 각각 실제 소스와 결과를 회수한 뒤 별도로 기록한다.


## 2026-10-07 공통 이력 empty/error 읽기 보완 (Task 11)

### 구현 완료

- 공통 `RecentActivityTicker`의 no-row 모바일 문구는 전체 너비의 첫 행을 사용하고 기존 다시 조회·전체 보기는 다음 행으로 자연스럽게 흐른다. 운영 활동이 있는 한 줄 ticker·timestamp/상태·5초 순환과 PC 인라인 흐름은 유지한다. 공통 Button·색/폰트·query/retention·onRetry/onOpen/trigger ref 계약은 바꾸지 않는다.
- 기존 `MonitoringLogTicker`의 true empty/최초 오류/cached 갱신 오류 안내·stale 시각과 재조회, 실제 `MonitoringView` 소비 회귀를 포함한 관련 단위 305개를 확인했다. monitoring adapter/source는 수정하지 않았다.

### 미구현

- 모니터링 native 폭/양 테마 matrix·실제 Backend Lab·물리 모바일/WebView·Gateway/LED HIL은 이번 국소 검증에 포함하지 않는다.

### 부족하거나 개선이 필요한 기능

- 실제 Range/PNG RED→GREEN은 같은 공통 표현을 사용하는 제어의 320×740/light 오류 사례만 측정했다. 모니터링 단위 통과나 flow 선언을 모니터링 native 픽셀/대비/터치 전체 통과로 바꾸지 않는다. 원 오류 상태와 모든 이전 로그/실패 증거는 보존하며 후속 통합 QA는 별개다.

### 관련 파일

- `apps/web/src/components/ui/operations/RecentActivityTicker.tsx`와 대응 시험, 변경하지 않은 `apps/web/src/features/monitoring/{MonitoringLogTicker,MonitoringView}.tsx`/대응 시험, `docs/ui-spacing.md`, `.superpowers/sdd/2026-10-07-atlas-ui-refresh/task-11-ticker-error-report.md`.

### 갱신 규칙

- 공통 이력 표현을 바꿀 때 empty/error/loaded·순환/pause/ref·실제 query/권한·retention 의미와 영향 메뉴를 함께 기록하고 단위/software/native/HIL 증거를 구분한다.

## 2026-10-07 ATLAS 모니터링 페이지 적용 (Task 6)

### 구현 완료

- 모니터링 제목·기존 맵 선택/단일 검색 Popover·서버 갱신 시각/실제 새로고침 동작을 유지하며 공통 `OperationMapPanel` chrome 안에 선택 층 `InlineStatusSummary`를 표시한다. 집계는 서버 `floor.summary`를 사용하며 로딩된 pin 수와 구분하고 `null → —`, 실제 `0 → 0`을 유지한다.
- 초기 공통 `body-sm/body` 소비는 실제 브라우저에서 13/14px로 확인되어 아래 Task 5의 최초 14/16px 완료 주장과 구분한다. 공통 원 소유자의 보완 `a835fde6`가 기존 `body/body-lg` 의미 토큰으로 실제 14/16px를 복구했다. 모바일 마지막 새로고침 행은 기존 하단 navigation safe-space를 소유하여 조작 가림을 방지한다.
- 기존 운영 활동 formatter를 보존 확장한 `monitoringActivityRows` adapter로 실제 online/offline/fault·명령 outcome·refreshStatus를 공통 5초 ticker에 연결한다. hover/focus/문서 hidden 정지·범위/행 변경 초기화와 항상 보이는 전체 보기·오류 재조회를 공통 표현에서 제공한다.
- 기존 pin 선택·테마 전환·전체 보기·카메라 복원, 서버 timestamp/시간대·반복 refresh 잠금/층 취소, 날짜 초안·50/100/500/1000 조회·retention/cursor 복구·권한·safe-area/focus는 변경하지 않는다. Drawer는 이미 공통 LogView/FilterPanel을 사용하므로 표현 source를 다시 수정하지 않고 회귀 검증한다.
- Task 6 I1 보완: 공통 `FloorMapViewport.restoreCamera`는 유효한 명시적 fit/복원 카메라를 독립 snapshot으로 즉시 기록하고 이전 resize 대기를 비운다. legacy revision 변경의 100% fit 직후 frame 이전 resize가 이전 120% 카메라를 되살리던 실제 순서 회귀를 수정했다. 같은 선택 pin·scope·명령 0을 유지한 제어 회귀와 원 clock/100% 기대 및 resize `.02`·native 입력 7개 브라우저 사례를 검증했다.

### 미구현

- 새 API/필터·전역 정렬·장비/DB 계약은 추가하지 않는다. 실제 native WebView·Gateway·LED HIL은 검증하지 않았다.

### 부족하거나 개선이 필요한 기능

- 격리 mock Chromium 및 Web 단위 검증 범위다. 공통 glyph/notice 및 이전 화면 계약의 원 실패를 Task 6 보고서에 분리 보존하며 모든 브라우저가 통과했다고 표시하지 않는다. legacy revision 카메라의 기존 현재 실패·BASE 통과 증거는 I1 보완의 실제 RED/GREEN과 구분해 유지한다. 독립 검수·canonical QA·실제 native/HIL은 별도 관문이다. 알람센터의 해결된 현재 상태와 최근 50개 알림 이력은 별도로 유지한다.
- I1 이후 전체 Web 검사에서 `ApiError` 모듈 경계의 87개 실패·1개 수집 오류/미처리 오류가 남았다. 해당 3파일 focused 224개 통과는 전체 통과 증거가 아니며 원인·카메라 수정과의 인과관계가 미확립이다. 원 로그를 유지하고 Task 11 canonical QA에서 확인한다.

### 관련 파일

- `apps/web/src/features/monitoring/{MonitoringView,MonitoringSummary,FloorMap,MonitoringLogTicker,monitoring-activity-presentation}.tsx` (adapter는 `.ts`), 대응 단위 시험, 기존 Drawer/query/camera 회귀 시험 및 `apps/web/e2e/{monitoring-surface-access,calm-operations-monitoring}.spec.ts`.
- I1 공통 수정: `apps/web/src/features/floor-map/FloorMapViewport.tsx`, 실제 통합 회귀 `apps/web/src/features/monitoring/FloorMap.test.tsx`.

### 갱신 규칙

- 표현 변경은 서버 집계와 loaded pin·null/0·실제 timestamp·검색/상태 필터·선택/카메라·전체 이력 기간/cursor 의미를 함께 검증하고 기존 실패와 실제 장비 미검증을 구분하여 기록한다.

## 2026-10-07 디자인 검토 목업 한 줄 집계 수정

### 구현 완료

- 로컬 ATLAS 목업의 도면 상태는 별도 카드 없이 맵 상단 한 줄로 표시한다. PC 레이블 14px·수치 16px로 기존 한 줄 표시보다 조금 키웠다. 수동 제어도 같은 집계 표현을 사용한다.

### 미구현

- 실제 서비스 적용·API·장비 연동은 하지 않았다. 아래 제품 구현 이력과 구분되는 목업 전용 수정이다.

### 부족하거나 개선이 필요한 기능

- 모바일 320/390px에서는 좁은 폭에 맞춰 집계 글씨와 간격을 조정한다. 실제 휴대폰/HIL은 검증하지 않았다.

### 관련 파일

- `.superpowers/brainstorm/40560-1791327706/content/atlas-operations.css`, `atlas-operations.js`, `atlas-prototype-v2-compact.html` (Git 제외 로컬 목업).

### 갱신 규칙

- 목업 변경과 제품 반영을 구분하며 도면 상태·반응형 배치 변경 시 제어 메뉴 문서도 함께 갱신한다.

## 2026-10-07 공통 작업 표현·지도 테마 repaint (Task 5)

### 구현 완료

- 공통 `InlineStatusSummary`는 라벨 14px·수치 16px의 인라인 표현과 `null → —`, 실제 `0 → 0`을 제공한다. 데이터나 층/현장 집계 query를 소유하지 않는다.
- 공통 `RecentActivityTicker`는 공급된 실제 이력 행의 5초 순환·hover/focus/문서 hidden 정지·items/scope 초기화·타이머 정리를 제공한다. 전체 보기·재조회·trigger ref는 메뉴 adapter에 위임한다.
- `OperationMapPanel`은 제목/상태/도구 chrome만 소유한다. legacy 도면의 선택 chrome은 palette를 구독하며 원본 도형 색과 카메라·common map source 수명을 유지한다.

### 미구현

- 모니터링 페이지의 집계/ticker adapter·전체 이력 popup·마지막 갱신 재배치는 후속 모니터링 task다. 공통 제공만으로 페이지 전환을 완료로 표시하지 않는다.

### 부족하거나 개선이 필요한 기능

- 이번 검증은 단위 및 격리 mock API Chromium 회귀다. 실제 native WebView/Gateway/LED HIL과 모든 화면의 dark 시각 QA는 별도 관문이며 원본 CAD 색을 테마로 바꾸지 않는다.

### 관련 파일

- `apps/web/src/components/ui/operations/{InlineStatusSummary,RecentActivityTicker}.tsx`, `apps/web/src/components/ui/maps/OperationMapPanel.tsx`, `apps/web/src/features/floor-map/{FloorMapViewport,FloorScene}.tsx` 및 대응 단위 시험.

### 갱신 규칙

- menu adapter 소비 시 서버 집계·시간대·cursor/기간/query 의미를 별도로 검증한다. 테마 변경은 source/generation/camera identity에 넣지 않고 저장 도형과 선택을 보존한다.

## 2026-10-07 ATLAS 공통 shell·모바일 브랜드 (Task 4)

### 구현 완료

- 고객 모바일 첫 행에 실제 킨다 mark·현장 선택·알람센터·테마 버튼을 표시한다. dark는 실제 reversed mark를 사용하고 공개/default/landing/concept 브랜드는 그대로다. 현장 선택은 360px 미만 128px, 그 이상 모바일 144px이며 44px 조작 높이·전체 option 이름·기존 선택 callback/ref와 실패/로딩/없음 상태를 보존한다.
- 네 고객 메뉴 헤더의 두 번째 행은 서버 dashboard 현장 집계를 항상 표시한다. 0과 미확인 `—`·로딩·오류를 구분하고 principal/site/route stale guard를 유지한다. 핀에서 현장 집계를 재계산하지 않는다.
- 760–1023px는 80px rail, 넓은 화면은 220px 펼침/80px 접기를 전환한다. 동일 route link·접근성 이름·keyboard tooltip과 eager 계정/로그아웃·full-view·권한 gate 소유권을 유지한다. 고객 primary 버튼은 독립 foreground token을 사용한다.

### 미구현

- 페이지별 ATLAS 재배치, 지도/차트의 새 palette 소비와 실제 native/HIL 검증은 후속 범위다. API·DB·명령 계약·장비는 변경하지 않는다.

### 부족하거나 개선이 필요한 기능

- 이번 근거는 Web 단위·UI 정책·격리 Chromium 회귀이며 물리 모바일/실장비 완료로 확대하지 않는다. 별도 명령 실행/선택 disclosure는 이번 작업에서 바꾸지 않는다.

### 관련 파일

- `apps/web/src/features/shells/{CustomerShell,CustomerHeaderSummarySlot,SettingsNavigationItem}.tsx`, `apps/web/src/components/brand/KindaLogo.tsx`, `apps/web/src/components/ui/{Button.tsx,fields/SelectBox.tsx,utils/cn.ts}`, 대응 테스트 및 `apps/web/e2e/mobile-first-screen.spec.ts`.

### 갱신 규칙

- 고객/비고객 브랜드 경계·양 theme·현장 선택 width와 touch target·0/null 집계·route/query/명령 identity·계정 복구를 함께 검증한다. 별도 task의 페이지 변경과 HIL 한계는 그 실제 증거로 갱신한다.

## 2026-10-07 ATLAS 고객 공통 테마 경계 (Task 3)

### 구현 완료

- 고객 shell 헤더의 공통 44px 아이콘 버튼으로 라이트/다크를 전환한다. 접근 가능한 이름은 다음 동작을 알리고 aria-pressed는 현재 다크 여부를 표시한다. 저장 키 `led-control.customer-theme.v1`는 계정·현장·명령 저장소와 분리하며 기본/잘못된 값/읽기 실패는 light, 쓰기 실패는 현재 탭 테마를 유지한다. 다른 탭의 선호 변경과 삭제/clear도 반영한다.
- 안정된 provider가 고객 화면에서만 root marker를 소유하고 승인된 CSS alias/portal 색을 사용한다. layout 경계에서 computed palette를 발행하며 StrictMode·로그아웃·재진입 cleanup은 자기 marker만 정리하고 다른 owner/native 속성·스타일을 보존한다. 페이지·route·QueryClient·명령·editor identity에 theme를 추가하지 않는다.

### 미구현

- 이 단계는 공통 provider·전환·저장·palette hook만 구현했다. ATLAS 메뉴별 재배치, 모바일 로고/compact 현장 선택, 지도·차트의 hook 구독과 repaint 적용은 후속 소유 task이며 완료로 표시하지 않는다.

### 부족하거나 개선이 필요한 기능

- 테스트는 브라우저 저장소/React 소프트웨어 fixture 검증이다. 실제 native WebView·Gateway·LED HIL을 실행하지 않았으며 전체 페이지의 다크 대비/시각 QA와 독립 통합 검수는 후속 관문이다. CSS 외 palette를 캐시하는 소비자는 hook 연결 전까지 완전한 다크 repaint를 주장하지 않는다.

### 관련 파일

- `apps/web/src/components/ui/theme/{customer-theme.ts,CustomerThemeProvider.tsx,ThemeToggle.tsx,useThemeColors.ts,CustomerThemeProvider.test.tsx}`, `apps/web/src/features/shells/CustomerShell.tsx` 및 대응 테스트.

### 갱신 규칙

- 테마 경계 변경 시 저장 읽기/쓰기 실패·cross-tab clear·root cleanup·열린 portal·draft와 route/query identity 및 추가 명령0 회귀를 함께 확인한다. 공유 palette 소비자의 후속 적용과 실장비 한계는 실제 검증 범위에 맞춰 별도로 기록한다.
## 2026-10-13 실제 Gateway 연결 복구 관찰

- 구현 완료(현장 관찰): 승인된 기존 서버 별칭2개 교정과 동일 이미지 Gateway 재구성 후 MQTT·fresh heartbeat·BIO transport/protocol/mapping·단일 USB 소유를 확인했고 정상 서비스 UI에서 조명4대 온라인/오프라인0으로 표시됐다. assignment/mapping·등록/설정밝기는 보존했다. 모니터링 제품 소스 변경은 없다.
- 미구현: 광학 출력·전력·감지 회로 건강·신규 장애 알림·재부팅 지속성·전체 장비군 검증은 이번 관찰 범위가 아니다.
- 부족하거나 개선이 필요한 기능: A의 센서 `사용 가능`은 현재 준비/독립 링크 판정이다. 다른 조명의 센서 호환이나 현재 광학 밝기를 대신 증명하지 않는다. 개발 서버 주소가 다시 바뀌면 정적 별칭 점검이 필요하다.
- 관련 파일: `apps/gateway/src/index.ts`, `apps/web/src/features/monitoring/MonitoringView.tsx`, `docs/menus/{settings,control}.md`.
- 갱신 규칙: 연결 복구·현재 서버 상태와 초기 센서 준비·이벤트 동작·사용자 광학 관찰을 분리한다. 아래 기록은 당시 단계의 증거다.

## 2026-10-08 등록 조명의 공통 준비 상태 Web 소비 (Task 5)

- 구현 완료(소프트웨어): Web dashboard 타입이 sanitized `bioSensorPreparation`의 `preparationCandidate/status/commandId/profileKey/observedAt/blockedReasons`를 소비한다. 제어의 기존 지도에는 전체 등록 조명을 유지하고 미준비 상태·다중 차단 사유와 관리자 준비 조치를 검사 패널에 연결한다.
- 구현 완료(관찰 경계): 후보나 초기 GET ready로 현재 모니터링 정상·센서 건강·광학 출력·밝기·전력 값을 생성하지 않는다. 정책/준비 작업 뒤 dashboard를 갱신하고 공개 근거 변경 시 늦은 작업 결과를 폐기한다. 기존 실제 telemetry와 null 초기화 경로를 유지하며 감지 센서/실행 조명 문구를 사용한다.
- 미구현: 모니터링 전용 준비 설정 패널·BIO incident/알림 신규 연동, 승인된 실제 장비군 공급과 RF·광학·native WebView 검증은 이번 작업에서 수행하지 않았다.
- 부족하거나 개선이 필요한 기능: 브라우저의 상태는 서버 조회 시점의 관찰이며 원격 binding/catalog 전체 identity는 노출되지 않는다. 현재 귀속·실행 자격 검증은 서버에 있고 센서 모드·링크 GET을 감지 회로 건강으로 해석하지 않는다.
- 관련 파일: `apps/web/src/api/{automation,queries}.ts`, `apps/web/src/features/control/automation/{BioSensorPreparationPanel,BioPulseTelemetryStatus,VehicleEventControlPanel}.tsx`, `apps/web/e2e/control-map-target-selection.spec.ts`.
- 갱신 규칙: 준비 작업 checkpoint·현재 dashboard eligibility·실제 runtime 보고·광학 출력과 실장비 증거를 구분한다.

## 2026-10-08 BIO current 준비 projection (Task 4 API)

- 구현 완료(소프트웨어): 상세 fixture 집합을 한 번의 batched SQL 판정으로 읽어 `bioSensorPreparation:{status,commandId,profileKey,observedAt,blockedReasons,preparationCandidate}`를 제공한다. commandId/profileKey/observedAt는 증거가 없으면 NULL이며 candidate는 confirmed canonical BIO 준비 진입 후보일 뿐 source 권한이 아니다. 일반 응답에는 raw fingerprint/body/native/hash를 내보내지 않는다.
- 구현 완료(판정): 기존 mode GET은 과거 참고 정보로 남기고 sourceEligible은 current 준비·정책·catalog ACK·인증 V2·별도 live freshness가 모두 맞을 때만 true다. 정책 담당자 해제·철회·재배정·identity 교체·만료 시 같은 predicate가 즉시 차단 사유를 반환한다. 과거 준비 observedAt와 120초 최초 TTL을 상시 건강으로 쓰지 않는다.
- 구현 완료(후속 소프트웨어): Web DTO/준비 상태 소비는 위 Task 5, 공통 합성 fixture의 별도 API disposable DB·Gateway fake-transport 통합은 Task 6에서 확인했다. 최종 준비 큐 보완과 별도 수정 검토를 실제 운영 검증과 구분한다.
- 미구현: 단일 프로세스·실제 MQTT/RF E2E, 운영 적용·실제 승인 장비군 공급·실장비 검증.
- 부족하거나 개선이 필요한 기능: `profile_unverified|fingerprint_unverified|mode_unverified|link_unverified|catalog_pending|operating_policy_required|gateway_protocol_unverified|binding_changed|unsupported`만 사유로 제공한다. 관측·전달 ACK·classification·센서 회로 건강·광학 출력은 서로 다른 증거다.
- 관련 파일: `apps/api/src/sites/{sites.service.ts,vehicle-event-source-view.ts}`, `apps/api/src/automation/bio-sensor-eligibility.ts`, `apps/api/test/bio-sensor-catalog-preparation.integration.spec.ts`.
- 갱신 규칙: 새 dashboard 무효화 결과로 이전 ready를 제거하며, candidate/matched를 ready로 표시하지 않는다. 아래 과거 기록은 당시 범위로 보존한다.

## 2026-10-08 등록 BIO discovery 관측 보존 경계 — Task 2A 당시 기록

- 구현 완료(Task 2A 소프트웨어): registration scan의 종류·firmware/build·sensor/infrared/ambient/hardware fingerprint를 nullable 내부 관측으로 보존한다. 기존 현재 session/correlation/attempt/site/gateway·lifecycle·event 원장/sequence 경계를 재사용하며 등록 완료 뒤 보존한다. 일반 polling 응답과 수신 오류 로그에는 raw 관측을 노출하지 않는다.
- 후속 구현: 당시 남았던 Gateway typed publisher·fresh query/live health·UI 준비 projection 소비는 Tasks 3~6에서 구현·소프트웨어 검증했다. 운영 migration·ACL 적용·실장비 검증은 여전히 미수행이다.
- 부족하거나 개선이 필요한 기능: 관측은 현재 통신·센서 건강·readiness를 입증하지 않는다. 신규 null/legacy는 기존 관측을 비우고 늦거나 잘못 귀속된 scan은 저장하지 않는다. 기존 strict scan/terminal wire와 모니터링 상태·classification/SET는 유지한다.
- 관련 파일: `packages/shared/src/bio-discovery-contracts.ts`, `apps/api/src/mqtt/mqtt.service.ts`, `apps/api/src/registration/registration.service.ts`, `apps/api/prisma/schema.prisma`, `apps/api/test/bio-discovery.integration.spec.ts`, `scripts/dev-mqtt-acl.integration.test.mjs`.
- 갱신 규칙: 내부 관측 보존·일회용 PostgreSQL 검증과 실제 Gateway/RF 증거를 구분한다. 기존 발견 관측을 fresh query 또는 독립 qualification으로 승격하지 않는다.

## 2026-10-07 A/B pilot launcher 증거 — 실제 상태 보고 아님

- 구현 완료(시험용 코드): host lifecycle·exact Docker 결과·pilot durable final journal을 보호 evidence에 보존하고 설정/close 불확실과 postflight 실패를 nonzero로 보고한다. CLI timeout만으로 diagnostic 수명을 판단하지 않고 exact no-such-object 오류와 독립 inventory 또는 exact terminal 상태를 확인한다.
- 미구현: 실제 Pi/image/USB/driver/MQTT postflight 실행·브라우저 기록 UI·제품 모니터링/건강 공급자 연동.
- 검토 보완(코드): timeout/취소 CLI를 TERM/KILL로 회수하는 것은 소유한 CLI 프로세스 경계이며 컨테이너 forcekill이 아니다. late create/start·CLI 회수 불확실을 부재로 축약하지 않고 lifetime unknown·보호 lock/evidence를 유지한다. recovery/postflight inspect도 잔여 monotonic 예산을 사용한다.
- 부족하거나 개선이 필요한 기능: 원본 healthy/MQTT/USB/mapping postflight는 서비스 복구 관문이며 PIR 감지 회로 건강이나 시험 알림 의미를 증명하지 않는다. settings 불확실이면 terminal/freeUSB 뒤 서비스 복구는 가능하지만 성공 표시/새 base 재캡처를 위해 lock을 해제하지 않는다.
- 관련 파일: `apps/gateway/scripts/bio-sensor-event-pilot-launcher.ts`, `bio-sensor-event-pilot-launcher-host.ts`, `bio-sensor-event-pilot-launcher.test.ts`.
- 갱신 규칙: fixture와 실제 장비 증거를 분리하고 보호 로그의 원시 identity/body/token을 일반 로그·Git에 내보내지 않는다.

## 2026-10-06 A/B 시험용 센서 알림 연동 — 모니터링 상태 승격 없음

- 구현 완료(시험 스크립트): 기존 단일 CRC BIO client의 시험 후보 구독을 B 적용/유지/원복에 연결한다. raw body/native identity/원복 원장은 opt-in 보호 파일에만 보관하고 일반 출력은 고정 redacted 상태 코드다.
- 미구현: 이번 pilot의 실장비·광학 검증, 브라우저 기록 UI·MQTT 공급자/대시보드 연동. 제품 지원/건강 표시는 변경하지 않았다.
- 검토 보완(코드): 원복 불확실·fsync/닫기 실패를 성공 종료로 표시하지 않고 pending/실패 결과를 남긴다. session 생성이나 transport 닫기 실패도 보호 원장 닫기를 건너뛰지 않는다.
- 부족하거나 개선이 필요한 기능: exact A GET은 node-link와 sensor mode 설정만 확인한다. PIR 회로 건강·감지 능력·motion/clear를 증명하지 않으며 alive 후보/다른 node·network·generation·unknown body·replay/짧은 중복으로 B 쓰기/hold를 갱신하지 않는다.
- 관련 파일: `apps/gateway/scripts/bio-sensor-event-pilot.ts`, `bio-sensor-event-pilot-runtime.ts`, `bio-sensor-event-pilot.test.ts`.
- 갱신 규칙: 보호된 시험 증거와 제품 telemetry를 구분한다. 실제 장비 검증 전에는 코드 검증만 완료로 기록한다.

## 2026-10-06 기존 BIO 등록 현재 재검증 — 소프트웨어 완료·운영 미적용

- 구현 완료(Task 2 소프트웨어): 현재 commission/requester·binding을 재검증하는 최소 작업 상태 GET과 독립 operation 보관을 추가했다. dashboard/telemetry/운영 데이터 변경은 없다.
- 구현 완료(Task 3 소프트웨어): 세 설정 mode의 동일 시간 경계를 적용한 결과 수용·immutable 감사 보관·내구 ACK와 shutdown drain을 추가했다. stale/unknown/만료 결과는 observedMode를 공개하지 않으며 Fixture 출력·센서 qualification·heartbeat를 갱신하지 않는다. 생산 DB 시계 attestor가 없으면 query/proof를 거부한다.
- 구현 완료(Task 4 소프트웨어): 현재 장치 proof의 명시적 수복 완료 시각과 감사 연결을 보관한다. 후보 status 수복과 별도 BIO/OFF 분류에서도 Fixture 출력·이름/좌표·그룹·기존 센서 qualification·heartbeat를 보존한다. 감사 실패와 등록/scan 경합은 DB 원자성 검증으로 확인했으며 모니터링 정상·실장비 성공 근거로 사용하지 않는다.
- 계약 완료(Shared만): registration 전용 query/result/전체 hash ACK `e902a393`, 관련38PASS·독립 검토 승인. 상태 조회·readiness·실장비 확인으로 승격하지 않는다.
- 관련 조회 파일: `apps/api/src/registration/bio-registration-revalidation.service.ts`, `registration.controller.ts`.
- 구현 완료(Task 5 Gateway 소프트웨어): 기존 단일 adapter의 query만 사용하는 별도 handler/journal/result/전체 hash ACK와 runtime/ACL 계약을 추가했다. 재시작은 새 GET 없이 unknown으로 처리하고 최초 terminal을 재전송한다. rename 뒤 fsync 불확실 재수신은 원장 내구 barrier 성공 전 receipt를 거부한다. 관련 집중 검증·독립 수정 재검토를 통과했으며 실제 broker matrix는 opt-in1SKIP다.
- 검증 완료(Task 6 소프트웨어): API 요청→Gateway GET-only→immutable 결과/정확 ACK→명시 apply→별도 A/B 분류, ACK 유실·재시작·구 Gateway 무응답을 연결했다. 최종 신규 일회용 DB108/108·직접 API5/5·API/Gatewaytypecheck/build0, 독립 통합 및 전체 요청 최종 검토 Approved·새C0/I0/M0·기존 pnpm 경고M1을 확인했다. 가짜 USB/MQTT 경계이며 실제 RF/TLS/broker 성공은 아니다.
- 미구현: 실제 B 현재 조회·감사 수복·운영 적용과 실제 감지 profile/독립 건강 공급. 현재 운영 데이터·조명은 변경하지 않았다.
- 부족하거나 개선이 필요한 기능: 새 mode GET은 현재 identity/address의 설정 관찰이며 광학 출력·전력·센서 건강이 아니다. 이를 heartbeat·readiness·모니터링 정상 상태로 승격하지 않는 설계다.
- 관련 파일: `docs/superpowers/specs/2026-10-06-bio-registration-revalidation-design.md`, `docs/superpowers/plans/2026-10-06-bio-registration-revalidation.md`, `docs/superpowers/plans/2026-09-30-bio-sensor-pulse-event-control.md`.
- 갱신 규칙: 등록 수복·BIO/OFF 분류·실제 감지/건강·대시보드 표시의 완료 조건을 분리한다.

## 2026-10-02 재검색과 등록 상태 보존

- 구현 완료(소프트웨어·독립 검토): 완료된 등록을 재검색 수신이 미등록 상태로 낮추지 않도록 보완했다. Consumer120pass/기존opt-in1skip·타입 검사와 독립 검토 지적0을 확인했다. 검색 메타데이터 갱신을 센서 건강이나 조명 출력 증거로 해석하지 않는다.
- 확인 완료(현재 설정, 미배포): 17:51:17 KST 별도 격리 A GET-only로 raw140/force-off를 확인했고 driver 복귀·USB 소유0·원본 정지와 mapping/assignment/descriptor 불변을 확인했다. 원본 서비스의 현재 healthy를 확인한 것이 아니며 dashboard projection에 결과를 쓰지 않았다. B GET·모든 SET0, 기존 복원 pending1 유지다.
- 미구현: 실제 랩 배포·과거 B 기록 수복·기존 A/B BIO 적용과 실제 독립 센서 건강 공급.
- 부족하거나 개선이 필요한 기능: 현재 Pi Gateway는 정지 상태이고 공개 intermediate CRL이 만료됐다. 과거 healthy/heartbeat와 오늘 오전 A GET을 현재 연결·밝기 확인으로 재사용하지 않는다. 원본 복원 보류 기록은 유지한다.
- 관련 파일: `apps/api/src/mqtt/mqtt.service.ts`, `mqtt.service.spec.ts`, `docs/superpowers/plans/2026-09-30-bio-sensor-pulse-event-control.md`.
- 갱신 규칙: 등록 완료, 최신 연결 확인, 설정 조회와 실제 광학 관찰을 분리해 갱신한다.

## 2026-10-02 BIO 상태 보고 전달 계약

- 구현 완료(Shared 소프트웨어·독립 검토): BIO V2 report의 배정 버전 포함 전달 envelope와 exact 귀속 ACK 계약을 추가했다. 기존 V1 보고·표시는 변경하지 않았다.
- 구현 완료(Gateway 수신·독립 검토): candidate와 검증된 pulse 출구를 분리하고 연결·decoder·mapping·독립 권한 변경/종료에 따라 권한을 철회한다. 실제 관찰 건강이나 지원 상태를 새로 생성하지 않는다.
- 구현 완료(API 소프트웨어·독립 검토): current 인증·배정/정확 node 근거로 BIO qualification·ledger·V2 수용 ACK를 같은 거래에 저장하고 과거/변조/재배정 보고를 상태 근거로 승격하지 않는다.
- 구현 완료(Gateway 실행 연결 소프트웨어·독립 검토): 실제 source→scheduler 소비와 권한 철회·정지/종료·만료 복원을 연결한다. 규칙 교체 실패/rollback은 이미 기록된 적용·복원 결과와 불확실 원장을 지우지 않는다. 제품 OFF이므로 실제 센서 건강·광학 관찰의 새 증거를 만든 작업은 아니다.
- 구현 완료(신규 등록 소프트웨어·독립 검토): 신뢰된 V2 완료의 새 BIO node는 검증 전 OFF로 분류한다. 기존 node·밝기·qualification/legacy는 유지하고 등록 완료를 live health로 표시하지 않는다.
- 구현 완료(Gateway OFF 전달 소프트웨어·독립 검토): 현재 인증 명령의 canonical ID와 confirmed mapping을 대조해 OFF/null 보고만 전송하고 exact V2 ACK를 저장한다. 교체/만료/재시작/정지 뒤 과거 보고 전송은 막고 pending 원본은 유지한다. 실제 센서 사용 가능·건강 상태를 새로 승인하지 않는다.
- 구현 완료(센서 모드 확인 소프트웨어·독립 검토): Fixture/canonical node ID가 다른 실제 command 경로도 exact native/hash/주소·fresh mapping/discovery로 GET한다. GET 뒤 연결 대상이 바뀌면 긍정 결과도 거부하며 모드 조회는 밝기 쓰기를 하지 않는다. 모의 통신 검증으로 현재 광학/건강 상태를 승인하지 않는다.
- 구현 완료(기존 등록 분류 보완 소프트웨어·독립 검토): 현재 등록 완료와 소유·배정이 일치하는 오분류의 BIO/OFF 전환 API를 추가했다. 밝기·전원·ID·그룹·이력을 유지하고 이미 BIO인 ready/degraded 상태를 초기화하지 않는다. DB30/30·등록115/115·타입/빌드·독립 검토 지적0을 확인했으며 실제 A/B 데이터는 변경하지 않았다. 검증 대기는 실제 감지 지원·건강·사용 가능 상태를 뜻하지 않는다.
- 미구현: 독립 qualification/건강 provider·사용 가능 상태 발행·실제 운영 적용과 broker/HIL 검증.
- 부족하거나 개선이 필요한 기능: 보고 수용 ACK는 live health·LED 광학 출력·이벤트 동작 성공을 의미하지 않는다. 현재 제품 gate/profile은 OFF다.
- 관련 파일: `packages/shared/src/automation-contracts.ts`, `automation-contracts.test.ts`.
- 관련 Gateway 파일: `apps/gateway/src/bio/bio-sensor-pulse-source.ts`, `bio-dongle-client.ts`, `bio-device-mapping-store.ts`, `apps/gateway/src/adapters/adapter-factory.ts`.
- 관련 실행 연결: `apps/gateway/src/automation/bio-product-pulse-controller.ts`, `bio-pulse-scheduler.ts`, `schedule-runtime.ts`, `apps/gateway/src/index.ts`.
- 관련 보고 연결: `apps/gateway/src/bio/bio-capability-delivery.ts`, `apps/gateway/src/mesh/vehicle-sensor-capability.ts`, `apps/gateway/src/commands/bio-sensor-mode-handler.ts`.
- 관련 센서 모드 어댑터: `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`, `bio-usb-dongle-adapter.test.ts`.
- 관련 API 파일: `apps/api/src/automation/vehicle-sensor-capability.service.ts`, `automation-mqtt-consumer.service.ts`, `bio-capability-delivery.integration.spec.ts`.
- 관련 등록 파일: `apps/api/src/mqtt/provisioning-device-terminal.service.ts`, `new-bio-registration.integration.spec.ts`.
- 관련 기존 분류 보완: `apps/api/src/registration/bio-classification-reconciliation.service.ts`, 대응 unit/integration 테스트, `registration.controller.ts`, `registration.module.ts`, `docs/database-schema.md`.
- 갱신 규칙: 보고 계약, 저장된 관찰 상태, 실제 하드웨어 검증을 별도로 기록한다.

## 2026-10-01 BIO telemetry 소프트웨어 전달 경계

- 구현 완료: 지연 수신된 첫 펄스도 snapshot 생성 당시 source node와 현재 연결을 비교해 교체 센서의 관측으로 잘못 표시하지 않는다. 이미 저장된 exact 기록은 같은 현장 재배정 뒤에도 현재 인증 근거 아래 ACK만 재발행하고 projection은 변경하지 않는다. snapshot binding은 기대 구성 근거이며 광학/센서 송신 증명은 아니다.
- 구현 완료: Gateway 합성 시험의 펄스·연장·장애·복구·B 설정 적용/복원 결과를 strict V2 outbox로 전달한다. 설정 결과에 `verification=configuration_readback`, `configuredHighBrightnessPercent`, `bioMode`를 쓰며 raw body·native UUID·임의 오류 문자열은 허용하지 않는다. 장애/복구 이력을 합치지 않고 파일 재시작·재전송의 순서·identity·해시를 보존한다.
- 구현 완료: API는 현재 claim·유효 MQTT 인증서·배정·V2 선언·저장된 snapshot topic/hash/source/target를 검증한 V2 이력과 별도 projection을 한 거래로 저장한다. DB commit 뒤 exact V2 assignment/event/sequence/hash ACK를 발행하며 실제 Gateway 파일 기록 삭제를 일회용 DB·in-process transport로 검증한다. 알려진 과거 설정/sequence와 출처가 정확한 시계 오류는 감사 격리+ACK만 하고 현재 상태를 바꾸지 않는다.
- 구현 완료: 상세 dashboard의 `bioPulseTelemetry`는 최신 펄스·명시적 장애 시작·복원 대기·구성 read-back을 실제 저장 기록에서만 읽는다. 현재 배정/설정과 맞지 않는 이력은 숨기고 미관측은 NULL이다. `0x0c`, 침묵, 새 펄스나 단순 경과 시간으로 건강/clear/복원 성공을 만들지 않는다.
- 구현 완료: 제어 화면은 이 nullable projection만 소비해 마지막 펄스·건강·장애 시작·복원 대기/사유·설정 read-back을 현장 시간대의 과거 보고로 표시한다. 센서의 전체 규칙/occurrence 집계로 명시하며 교체 후 NULL 응답은 이전 값을 즉시 제거한다. 미관측 필드는 계속 미확인이다.
- 미구현: 실제 broker/mTLS/장비 검증, 모니터링 BIO incident·알림, 이력 보존·대규모 조회 부하 검증은 별도다.
- 부족하거나 개선이 필요한 기능: 설정 read-back을 현재 LED 광학 출력·전력/에너지 또는 A 자율 밝기로 투영하지 않는다. 제품 capability·allowlist는 OFF이고 실제 MQTT·Pi/RF/HIL 결과는 이번 통합 시험에 포함되지 않는다.
- 관련 파일: `packages/shared/src/bio-pulse-telemetry-contracts.ts`, `apps/api/src/automation/bio-pulse-telemetry.ts`, `apps/api/src/sites/bio-pulse-telemetry-view.ts`, `apps/api/test/bio-pulse-telemetry.integration.spec.ts`, `apps/gateway/src/automation/automation-telemetry-handoff.ts`, `automation-telemetry-outbox.ts`, `software-bio-pulse-integration.test.ts`.
- 갱신 규칙: Gateway 영속 전달, API 영속 수신, 화면 조회와 실제 광학 관찰을 별도 근거로 기록한다.

## 2026-10-01 BIO 관찰 증거와 제어 준비 상태 구분

- 구현 완료: 상세 dashboard Fixture에 서버 소유 `vehicleEventSource`를 제공해 BIO protocol, 유효 readiness와 capability 관찰 증거, 차단 사유, 활성 A의 대상 보호를 제어 화면에서 소비한다. BIO 제품 OFF 동안 stored ready 보고를 사용 가능으로 승격하지 않는다.
- 구현 완료: 최신 sensor-mode 작업은 현재 할당·물리 identity·주소·Fixture와 일치하는 GET 결과의 과거 확인 시점만 표시한다. 이 값은 실시간 밝기·에너지·자율 광학 출력 또는 현재 source readiness의 증거가 아니다.
- 구현 완료: 제어 화면의 로컬 GET 결과는 dashboard 최신 증거를 덮어쓰지 않는다. GET 후 서버 projection을 다시 조회하고, 새 작업이나 identity 무효화는 이전 확인 표시를 제거한다. 서버 갱신 실패 시 확인 중/재조회 안내를 유지하며 이전 verified를 임시 현재 증거로 복원하지 않는다.
- 구현 완료: 제어 화면의 지속 운영 안내가 서버 runtime projection을 표시한다. 대상별 설정 확인은 설정 밝기·mode로 표시하며 현재 밝기·전력·에너지와 분리한다. 성공한 설정 GET이나 건강 회복 보고도 서버의 복원 대기를 지우지 않고, 준비 상태나 제품 지원을 승격하지 않는다.
- 미구현: 모니터링 incident/알림의 BIO 전용 실시간 연동. 임의 시각이나 광학 복원 완료는 만들지 않는다.
- 부족하거나 개선이 필요한 기능: 화면 검증은 synthetic 응답으로 진행했다. 독립 센서 건강, A 자체 밝기 및 B 적용·복원 광학 HIL은 미완료이고 제품 gate·allowlist는 OFF다.
- 관련 파일: `apps/api/src/sites/vehicle-event-source-view.ts`, `apps/api/src/sites/sites.service.ts`, `apps/web/src/api/queries.ts`, `apps/web/src/features/control/automation/{VehicleEventControlPanel,BioPulseTelemetryStatus}.tsx`, `apps/web/e2e/control-map-target-selection.spec.ts`.
- 갱신 규칙: 관찰 보고·과거 mode GET·현재 준비·실제 LED 출력을 서로 대체하지 않는다. runtime projection이 구현되면 실제 영속 증거와 화면 문서를 함께 갱신한다.
## 2026-10-06 단일 조명 검색 Popover·헤더 집계 보완

### 구현 완료

- 맵 선택 바로 오른쪽의 `조명 검색·상세` 버튼에서 공통 React Aria Popover를 연다. 기존 별도 맵 상태 필터와 `표시 상태` 설명은 제거하고, 검색·전체/정상/점검 필요/오프라인/미배치 필터·목록·선택 조명 상세 진입을 이 창에 모았다. 상태 선택은 목록을 열고 선택을 비우며, 0개 결과에서 이전 상세를 표시하지 않는다.
- 검색과 상태는 부모에서 소유하여 닫기·재열기에도 유지한다. Popover 안의 상태 초기화는 검색·카메라를 보존한다. 실제 조명을 선택하기 전에는 상세를 열지 않으며, 배치 조명 목록 선택의 지도 이동과 미배치 조명의 기존 상세 흐름을 유지한다.
- 공통 Popover의 가용 높이와 내부 세로 스크롤을 사용한다. Escape·바깥 클릭·닫기 후 원 버튼에 초점을 반환하고 중첩 Select의 Escape는 Select만 닫는다. 좁은 화면과 확대 시 도구는 줄바꿈할 수 있다.
- 현장 전체 헤더는 글자 축소 없이 제목/집계의 줄 높이·상하 여백·줄바꿈을 보완한다. 실제 0과 미확인 `—`·로딩·오류 및 계정/현장 범위 검사를 그대로 유지한다.
- 최종 정책 보완: 미승인 `leading-normal` 대신 기존 `card-title`(20px/28px)·`body`(14px/22px)의 의미 토큰 행간을 사용한다. 상하 패딩·줄바꿈·글자 크기는 유지하며 한 가지 행간 비율을 강제하는 시험 대신 실제 글자 Range가 자기 줄 상자·헤더 경계 안에 들어가는지 검증한다. CSS 200% 확대 검사는 기존 긴 현장명·한글·숫자·`대` 경계와 가로 넘침 조건을 유지한다.
- 통합 완료: 최신 모바일 첫 도면 배치·접힌 전체 집계·20px 맵 수치를 보존한 최종 제품 `1c600eda`에서 전체 Web3258PASS·기존3SKIP, 타입/빌드/UI정책0·관련33브라우저33PASS와 코드/UI 검수 차단0을 확인하고 로컬 기본 브랜치에 병합했다. 기존 localhost에서 Popover/집계를 실제 확인했으며 장비 제어는 하지 않았다.

### 미구현

- API·DB·장비·운영 서비스 재시작과 실제 native WebView/HIL은 포함하지 않는다.

### 부족하거나 개선이 필요한 기능

- Web 단위·격리 Chromium 회귀와 localhost UI 확인이 이 작업의 증거다. CSS `zoom: 2`의 헤더 검사는 실제 브라우저 페이지 확대나 물리 모바일 검증과 구분한다. 기존 문서의 이전 Task 5 상태 필터 진입점 설명은 당시 구현 이력이며 현재 UX는 이 항목을 따른다.

### 관련 파일

- `apps/web/src/features/monitoring/{MonitoringView,MonitoringSummary,MonitoringFixtureFinder}.tsx`와 대응 테스트.
- `apps/web/src/features/shells/CustomerHeaderSummarySlot.tsx`, 대응 테스트, `apps/web/e2e/monitoring-surface-access.spec.ts`.

### 갱신 규칙

- 검색·필터·선택·초점·가용 높이·헤더 집계 변경 시 이 항목과 회귀를 함께 갱신한다. 소프트웨어/운영 적용/HIL 증거를 구분한다.
## 2026-10-06 모바일 도면 우선 배치 (Task 2)

### 구현 완료

- 760px 미만에서 맵 선택과 그 오른쪽 `조명 검색·상세` Popover → 선택 맵 이름·핵심 상태 → 실제 도면을 우선한다. 선택 맵 수치(기존 card-title 20px), 상태 이름과 집계 준비 중/null 의미를 유지한다. 수동 새로고침은 도면 뒤 도구로 접근하며 desktop 도구/카메라/전체보기·상세 drawer는 유지한다.

### 미구현

- 실제 native WebView·장비/HIL의 첫 도면 가시성 보장은 별도 검증이다.

### 부족하거나 개선이 필요한 기능

- 320×568/390×844/430×932 정상 100% 첫 진입 기준은 실제 도면을 렌더하는 interactive viewport의 헤더·clip·하단 메뉴 제외 가시 높이 120/240/240px이다. CAD 원본 비율과 camera fit 때문에 도면 이미지 자체가 이 높이를 채우거나 현장 전체를 항상 표시한다는 의미는 아니다. 긴 이름·오류·큰 글자는 자연 스크롤로 확인한다.

### 관련 파일

- `apps/web/src/features/monitoring/MonitoringView.tsx`, `MonitoringSummary.tsx`
- `apps/web/e2e/mobile-first-screen.spec.ts`, `monitoring-navigation-confidence.spec.ts`

### 갱신 규칙

- 첫 도면 배치·접힘·선택/카메라·복구 수명을 변경하면 해당 동작과 한계를 같은 작업에서 갱신한다.



## 2026-10-06 공통 모바일 헤더·최근 알림 (Task 1)

### 구현 완료

- 760px 미만 헤더는 기존 현장 선택·알람센터를 한 행에 표시한다. 중복 메뉴 제목은 화면 읽기용으로 유지하고 모니터링 현장 전체 집계는 명시적으로 펼쳐 확인한다. 기존 현장 변경 가드·최소 44px 조작·계정/로그아웃 controller와 설정 eager 접근을 유지한다.
- 모바일 toast는 화면 읽기 알림만 유지한다. 공통 provider가 독립적으로 만료시켜 desktop으로 전환해도 지난 toast를 다시 표시하지 않는다. desktop toast와 서버 현장 알람 저장·지우기는 기존 계약을 유지한다.
- 같은 알람센터의 최근 알림은 세션 메모리에 최대 50개를 보관한다. 상태 fingerprint 변경/새 작업은 미읽음이며 같은 polling은 추가하지 않는다. 최근 읽음과 toast 만료는 장애 해결·명령 실행·서버 알람 읽음/지우기와 분리한다.
- 모바일 배지는 서버 현장 알람 미읽음과 최근 알림 미읽음 합계이며 고유 장애 수가 아니다. 서버 수가 불명인 경우 `?`를 유지한다. 계정/허가된 현장 변경 시 provider의 scope 저장소·타이머·callback만 분리한다. 소비자와 계정 버튼 DOM은 유지해 초기 현장 조회 중 열린 로그아웃 확인의 취소/실패 포커스를 보존한다. 전체보기에서도 동일 센터를 여는 독립 행 버튼이 접근 가능하다.

### 미구현

- 최근 알림은 새 문서·로그아웃·다른 기기로 동기화하지 않는다. 별도 서버 API/DB/저장소와 실제 장비 HIL은 추가하지 않는다.

### 부족하거나 개선이 필요한 기능

- 브라우저 HTTP fixture 검증과 세션 단위 검증이며 실제 native 장비/HIL 완료를 의미하지 않는다. 큰 글자·긴 내용은 자연 스크롤을 허용한다.

### 관련 파일

- `apps/web/src/features/shells/CustomerShell.tsx`, `CustomerHeaderSummarySlot.tsx`
- `apps/web/src/components/ui/session-status/{SessionStatusProvider,SessionStatusCenter,ToastRegion}.tsx`
- `apps/web/e2e/mobile-first-screen.spec.ts`

### 갱신 규칙

- 공통 헤더·알림 의미와 세션 수명 변경 시 네 메뉴 문서를 함께 갱신한다.

## 2026-10-05 맵 공간·공통 조회 필터 보완 (추가 운영 UI Task 5)

### 구현 완료

- 현장 전체 집계는 Task 4의 Shell 헤더가 소유하고 본문의 중복 현장 요약만 제거한다. 맵 이름·전체/정상/점검/오프라인 수치·현재 표시 상태는 본문에 남기고 상태 조회는 공통 FilterPanel Popover로 옮긴다. 기존 목록 열기와 onSelect·null/집계 준비 중 표현을 유지하며 조명을 자동 선택하지 않는다. 현장·맵 기본 선택과 기존 조명 검색 입력은 Popover 밖에 유지한다.
- 전체 로그의 기간과 50/100/500/1000 항목 수 선택을 공통 Popover에 배치한다. 기본 50·기간 null·최근 3개월·종료일 포함·opaque cursor·범위별 조회는 유지한다. Popover 닫기/재열기는 부모 소유 부분 날짜와 현재 페이지를 보존하며 부분·역전 날짜는 요청하지 않는다. 초기화는 기간과 크기/페이지를 기본값으로 되돌리고, 방문한 페이지의 cursor400만 첫 페이지로 복구한다. 기존 로그 검색 계약은 없어 가짜 검색이나 API 필드를 추가하지 않는다.
- 공통 Dialog는 내부 ref를 안정화해 중첩 필터의 날짜 입력·부모 재렌더·외부 object/callback ref 교체 시 초점을 유지하고 외부 ref 교체/닫힘 정리를 보존한다. 초기 초점·pending·Back·safe-area 정책은 변경하지 않는다.
- 상태 초기화는 일반 상태 선택과 별도 callback을 사용해 기존 검색 입력을 보존한다. 검색 창을 닫은 뒤 초기화해도 자동 재열기·조명 선택·카메라 초기화·제어 요청은 없으며 명시적으로 다시 열면 입력을 유지한다.
- 고객 Shell의 알림은 sticky 헤더 뒤·본문 앞의 단일 자연 높이 영역에서 표시해 지도 조작부를 덮지 않는다. 알림이 없으면 영역을 만들지 않고 긴/복수 알림은 필요한 높이만 예약한다. 모니터링 전체 보기에서도 기존 지도 최소 240px와 일반 문서 스크롤을 유지한다. 공통 ToastRegion의 기본 overlay 배치와 메시지·revision·만료·닫기·aria 정책은 그대로다.
- 격리 Chromium에서 320/390/768/1023/1024/1287/1440px의 상태 필터·기존 검색·44px 조작·가로 넘침 0, 휠/키보드 끝 로그·실제 소프트웨어 터치 pinch/swipe·고유 임시 프로필의 브라우저 200% 확대, 카메라의 1023↔1024/전체 보기 복귀, 늦은 이전 층 로그의 격리를 직접 검증한다. 제어 POST는 0이다.

### 미구현

- 실제 모바일 native WebView·물리 LED/Gateway HIL·운영 DB·DDL·배포 및 브랜치 최종 통합 검수는 이 작업의 완료 범위가 아니다.

### 부족하거나 개선이 필요한 기능

- 원래 두 조명의 1287×1226/390×320/1440×600 bounds에서 footer·범례는 맵/frame 안에 있었고 짧은 화면은 문서 스크롤로 접근됐다. 확대 surface의 부분 표시는 정상 카메라 동작이므로 재현되지 않은 잘림에 대한 높이/CSS 수정은 하지 않았다.
- 오래된 fixture 시각의 지연 알림이 390×320 footer hit를 가린 원 실패와 닫기 후의 기존 결과를 보존한다. 후속 flow 배치는 닫기/자연 만료 전 설명이 줄바꿈되는 실제 지연 알림 및 기존 경고 2개의 bounds·hit·최소 지도 높이·일반 스크롤/전체 보기/카메라 복귀를 격리 Chromium에서 직접 검사한다. 작은 화면의 알림과 footer가 항상 동시에 viewport 안에 있다는 뜻은 아니다. 임의의 초장문 알림과 최종 loading/error 상태 조합·headed 200%·native/HIL 통합 검수는 Task 9의 별도 관문이다.

### 관련 파일

- `apps/web/src/features/monitoring/{MonitoringView,MonitoringSummary,MonitoringLogDrawer}.tsx`와 인접 시험, `apps/web/e2e/monitoring-surface-access.spec.ts`.
- 공통 좁은 보완: `apps/web/src/components/ui/overlays/{DialogBase.tsx,overlays.test.tsx}`. 기존 FloorMap/viewport/camera와 조회 hook/API는 변경하지 않는다.
- 알림 배치 보완: `apps/web/src/components/ui/session-status/{ToastRegion.tsx,session-status.test.tsx}`, `apps/web/src/features/shells/{CustomerShell.tsx,CustomerShell.monitoring.test.tsx}`. provider·상태 producer·계정 탈출·명령 owner는 변경하지 않는다.

### 갱신 규칙

- 원 실패와 source/timestamp별 실제 bounds·scroll·입력·ref 정리·초점·카메라·cursor/기간·scope 격리·POST0을 함께 보존한다. mock/실제 운영/native/HIL 증거와 알림 표시/닫힘 상태를 구분하며 중첩 입력의 초점·draft 단언을 약화하지 않는다.

## 2026-10-05 현장 헤더·개인 알람 숨김 웹 소비 (추가 운영 UI Task 4)

- 구현 완료: Shell의 기존 authorized dashboard query로 `현장 전체`와 현장 이름·전체/온라인/장애/오프라인 집계를 헤더에 표시한다. 계정·현장·모니터링 경로를 검사하고 이전 현장의 값은 거부한다. 미확인/null·로딩·오류를 0으로 만들지 않는다. 본문의 중복 현장 요약 제거는 Task 5에서 소비한다.
- 구현 완료: 알람센터는 actor/site/personal/조회 조건별 목록과 개인 미읽음 배지를 사용한다. 개별 지우기는 빈 PUT, 전체 지우기는 UUID만 담은 POST이며 페이지·필터 밖을 포함하는 선택 현장 범위를 확인 안내에 표시한다. 실패/미확정은 목록·배지를 보존하고 성공 뒤 이전 GET를 취소해 첫 페이지·정본 수치를 재조회한다. 실제 가시 행의 독립 읽음 정책과 현재 화면의 안전 경고는 유지한다.
- 구현 완료: 전체 요청마다 독립 브라우저 저장 항목을 POST 전에 검증·기록한다. 계정·현장·UUID·version만 저장하며 token/대상 ID를 넣지 않는다. 새로고침/재열기·복수 탭의 미확정 요청은 각각 명시적 결과 확인/동일키 재시도로 복구하며 자동 POST·새키 대체는 없다. 저장 실패는 POST 전에 중지하고 완료 확인된 키만 삭제한다.
- 구현 완료: 영문 hex가 있는 대문자/혼합 UUID 복구도 서버의 정규화된 현장·요청 UUID와 검증 후 같은 identity로 비교한다. 전송과 저장 키의 원래 표기는 보존하며 완료한 정확한 항목만 제거한다. 다른 요청·계정·현장과 별도 대소문자 표기의 저장 항목을 함께 삭제하지 않는다.
- 미구현: 사용자 DB migration·현재 서버 적용·실장비·native WebView·실제 두 세션/최종 전체 UI 관문은 Task 9/10의 별도 범위다. 알람 push 동기화와 요청 원장의 TTL은 추가하지 않았다.
- 부족하거나 개선이 필요한 기능: 단위 및 격리 mock Chromium 증거는 실제 MVCC snapshot이나 운영 적용 증거가 아니다. 브라우저 저장소가 손상되거나 차단되면 전체 지우기는 안내와 함께 중지한다. 독립 검토·최종 통합 관문은 총괄이 판정한다.
- 관련 파일: `apps/web/src/features/shells/{CustomerShell,CustomerHeaderSummarySlot}.tsx`, `apps/web/src/api/monitoring-incidents.ts`, `apps/web/src/components/ui/session-status/{useMonitoringIncidents,monitoring-dismissal-request}.ts`, `SessionStatusCenter.tsx`와 직접 테스트, `apps/web/e2e/{ui-overlays,app-shell-recovery,calm-operations-shell}.spec.ts`.
- 갱신 규칙: 개인 숨김·읽음·운용 상태를 구분하고 strict 서버 shape·scope 전환·실패 목록 보존·durable 저장 실패 POST0·복수키/같은키 복구·정본 첫 페이지/배지 재조회 및 mock/실제/운영 증거를 함께 기록한다.

## 2026-10-04 주석 수정 최종 소프트웨어 검증

- 구현 완료: 공통 필터/시각/로그와 실제 상태 범례·원형 조명·반응형 지도·명시 선택 상세를 구현했다. 계정별 알람 확인은 실제 R1–R6/R7 UI/HTTP/SQL 두 사례PASS로, 모니터링 로그는 M1 완료 하위 단계 및 M2/M3 실제 여정으로 확인했다. 50/100/500/1000·기간·층 변경·opaque cursor·부분 보관일·실제410 안내/최신 기록 복구를 검증했다.
- 구현 완료(로컬 반영): 기본 개발 `codex/mvp1-cloud-web`에099로 fast-forward했고 알람 읽음 테이블 하나와 main Prisma Client6.19.3을 반영했다. 새 API와 기존 웹의 재개·TLS live200·monitoring200·비인증 proxy401을 확인했다. 원 빈 watcher는 정지 보존하고 새 API는 별도 소유 세션으로 유지한다.
- 미구현: 실장비/HIL·native WebView·전체 서비스 성능 검증은 이번 작업에 포함하지 않는다. 10:06:37 UTC startup readiness 단일 관측은503/MQTT down·다른 네 의존성up이며 이후 재측정·지속성·원인은 미확인이다. 실제 계정 로그인·장비 연결 복구는 수행하지 않았다.
- 부족하거나 개선이 필요한 기능: 기존 실패와 검증 제외를 보존하며 새6사례 전체PASS로 합산하지 않는다. year0/BCE 표시·compact DOM 결합·과거 skewed timestamp 등 기존 한계는 남긴다.
- 관련 파일: [22행 구현·검증 계획](../superpowers/plans/2026-10-01-operations-ui-comments.md), `apps/web/src/features/monitoring/MonitoringView.tsx`, `MonitoringLogDrawer.tsx`, `apps/api/src/monitoring-incidents`, `apps/api/src/prisma/utc-timestamp-sql.ts`.
- 갱신 규칙: 실제 DB/소프트웨어/운영 적용/HIL 결과와 적용 전후 상태를 구분한다. 사용자 확인과 장애 해제는 별개로 유지하며 조회·화면 밖 항목을 확인 처리하지 않는다.

## 2026-10-04 짧은 PC 화면 상세 읽기 영역 보완 (Task 9 최종 통합)

### 구현 완료

- 기존 tablet 경계(1024px)부터 지도·상세 grid는 자연 최소 콘텐츠 높이를 유지한다. 상세 aside는 선호 높이 0과 행 전체의 최소 높이를 사용해 긴 상세 내용 자체가 행 크기를 결정하지 않도록 하고, 지도 쪽의 기존 240px 최소 viewport·도구·ticker가 결정한 행을 채운다. 짧은 화면은 페이지 스크롤로 접근하며 충분한 높이에서는 남는 공간만큼 지도가 계속 자란다. 새 고정 pixel 높이·breakpoint·공통 overlay 변경은 없다.
- 원래 두 조명의 1024×480 fixture에서 실제 상세 읽기 영역 349px/콘텐츠450px/범위101px을 확인했다. 일반 페이지 gutter 휠로 남은 chrome을 노출한 뒤 내부 wheel80·native Tab/Home/PageDown/End가 문서 위치를 유지하고, 마지막 의미 행의 라벨과 값 전체를 보인다. 1023↔1024↔1023↔1025에서 현재 범위에 맞춘 nonzero 복원·같은 선택·카메라·현재 surface 초점 및 닫기 후 원래 marker 반환을 검증한다.

### 미구현

- 실제 Android/iOS WebView·운영 DB·장비 HIL·배포 및 전체 브랜치 최종 검수는 이 소비자 보완의 완료 범위가 아니다.

### 부족하거나 개선이 필요한 기능

- 이전 35/37px 읽기 영역·잘린 마지막 값 실패와, 단순 grid 최소 높이만 적용해 범위가 0이 된 중간 실패는 보존한다. 435px 전체 aside와 sticky header가 동시에 480px 안에 모두 들어온다는 주장은 하지 않는다. 실제 읽기 영역과 최종 라벨·값의 clip/hit, native input 안정성을 판정하며 Chromium 소프트웨어 증거를 실기기 승인으로 확대하지 않는다.

### 관련 파일

- `apps/web/src/features/monitoring/MonitoringView.tsx`, `apps/web/e2e/monitoring-surface-access.spec.ts`. 기존 FixtureDetailPanel·공통 DetailSheet·지도/복원/초점 로직은 재사용하며 수정하지 않는다.

### 갱신 규칙

- 자연 높이와 실제 스크롤 범위·원래 마지막 라벨/값 전체·문서 안정성·native 휠/Tab/키보드·nonzero breakpoint 복원·카메라·원래 초점·명령 POST0을 함께 검증한다. 공통 정책이나 읽기 단언을 완화해 통과시키지 않는다.

## 2026-10-03 상세 native 스크롤·로그 안전 영역 보완 (Task 9)

### 구현 완료

- 조명 상세의 내부 SidePanel은 이 소비자에서만 `overflow-visible`·`overscroll-auto`를 사용한다. 실제 PC/하단 시트의 바깥 본문이 유일한 스크롤·위치 복원 소유자이며, 스크롤 범위가 없는 내부 패널이 휠 전달을 차단하지 않는다. 공통 SidePanel 기본값·MonitoringView 복원/초점 로직·지도 카메라는 변경하지 않는다.
- 전체 로그는 공통 Drawer의 `safeArea`를 선택적으로 사용해 상·하단 inset을 한 곳에서만 적용한다. compact 너비에서 이 호출부의 기존 spacing 토큰과 PaginationBar class 슬롯으로 간격을 줄이고 페이지 크기·이전/다음·실제 건수를 한 줄로 배치해 필터와 목록의 읽기 영역을 확보한다. 기간·보관 안내·상태·cursor·50/100/500/1000건·조회 중 초점 계약과 공통 기본값은 유지한다.

### 미구현

- 실제 모바일 장치/native WebView·운영 DB·실장비 HIL·배포는 이번 표적 보완에서 수행하지 않았다. 전체22건/실제 두 DB UI 세션/최종 통합 검수와 메인 병합은 별도 관문이다.

### 부족하거나 개선이 필요한 기능

- 검증은 격리 API fixture·Chromium의 실제 mouse wheel/Tab/Home/PageDown/End 및 CDP env top24/bottom34 소프트웨어 증거다. 원1024×480 상세에서 native wheel80·끝 정보 접근·nonzero 1023↔1024↔1025 복원/카메라/선택/초점, 원390×320 로그에서 필터56px·본문50px/44px 조작·끝50/1000·기간 양쪽 입력/reset·pager/닫기/zero-env 복원을 표적 회귀로 유지한다. 양수 inset을 실제 장치 검증으로 확대하지 않는다.

### 관련 파일

- `apps/web/src/features/monitoring/{FixtureDetailPanel,MonitoringLogDrawer}.tsx`, 두 직접 테스트, `apps/web/e2e/monitoring-surface-access.spec.ts`.

### 갱신 규칙

- 안쪽/바깥 실제 스크롤 범위와 전파 차단·키보드 대상·최종 항목·유효 초점/카메라를 함께 검증한다. 안전 영역의 단일 소유·compact 최소44px 읽기/조작 영역·실제 기간/cursor/페이지 크기와 pending/error의 진실성을 같은 변경에서 유지하며, 실패나 모의/실제 장치 증거를 구분한다.

## 2026-10-02 운영 밀집 마커 판정 보완 (Task 9)

### 구현 완료

- 모니터링의 48×48px 운영 버튼은 현재 DOM 경계에서 중심이 가장 가까운 조명 ID를 선택한다. 겹친 정상/장애 이웃의 DOM 순서와 선택·hover·focus 우선순위가 실제 클릭 대상을 바꾸지 않는다. 기존 20px 원형 점·저장 좌표·지도 camera 계약을 유지한다.
- ordinary/touch-capable mouse와 소프트웨어 터치에서 center±18world의 원래 5개 중심과 48px 여백 선택을 확인했다. 선택한 ID의 실제 버튼을 팝오버 anchor로 전달하며, 조명 정보 제목·위치와 Escape 뒤 해당 버튼으로의 포커스 복원을 확인했다. 키보드는 포커스된 정확한 ID를 사용한다.
- 이동 8px 이상·두 번째 포인터·취소·capture 손실·blur·Escape·층/snapshot 변경·unmount는 진행 중 마커 선택을 취소한다. 확대·이동 뒤에는 현재 좌표를 다시 읽으며 overlay 뒤의 조명과 물리 ghost click은 활성화하지 않는다. 읽기 전용 지도와 기존 이동·확대 계약을 유지한다.

### 미구현

- 실제 모바일 WebView 물리 터치 및 Gateway·LED RF HIL 검증.

### 부족하거나 개선이 필요한 기능

- route fixture와 Chromium 소프트웨어 터치 결과이며 실제 현장 장비·도면·native safe-area 검증을 의미하지 않는다. 장비 명령 POST는 0건이다.
- 중심이 완전히 같은 조명은 거리로 구분할 수 없어 ID 순서로 안정적으로 선택한다. 기존 조명 목록에서 개별 대상을 선택할 수 있다.

### 관련 파일

- `apps/web/src/features/floor-map/FloorScene.tsx`, `marker-hit.ts` 및 대응 테스트.
- 기존 소비자 `apps/web/src/features/monitoring/FloorMap.tsx`와 `FixturePinPopover.tsx`의 계약을 사용한다.
- `apps/web/e2e/operational-marker-control-height.spec.ts`, `e2e/support/operational-map-fixture.ts`.

### 갱신 규칙

- 공통 운영 마커가 바뀌면 제어 문서도 함께 갱신한다. 선택 ID·anchor·키보드·취소 및 route fixture/HIL 한계를 함께 기록한다.

## 2026-10-02 자동 PC 상세 제거 초점 보완 (Task 5 보완2)

- 구현 완료: 성공한 자동 재조회에서 선택 조명이 장애·검색·배치 조건을 벗어나거나 삭제되어 PC 상세가 사라질 때, 상세 안에 있던 초점만 같은 계정·현장·층의 연결된 유효 원래 버튼 또는 모니터링 검색 도구로 스크롤 이동 없이 반환한다. 상세 밖으로 옮긴 초점은 유지하며 범위 변경·화면 종료 뒤의 지연 반환은 예약하지 않는다.
- 구현 완료: 선택·내부 pin의 원자 해제, 다른 조명으로 대체하지 않기, saved-pin 조회 중 상태, 모바일 공통 DetailSheet의 기존 반환, 지도 카메라·페이지 스크롤을 보존한다. 수동 닫기와 하드웨어 호출 계약은 변경하지 않는다.
- 미구현: 실제 운영 DB·두 계정/기기·native 확대·양수 safe-area·실장비와 최종 Task9 통합 검증은 후속 관문이다.
- 부족하거나 개선이 필요한 기능: 격리 fixture·단위·Chromium 검증이며 독립 재검토는 별도다. 기존 편집기1000개/8초 실패와 공통 알람 Drawer 물리 보완은 이번 좁은 수정 범위 밖이다.
- 관련 파일: `apps/web/src/features/monitoring/MonitoringView.tsx`, 직접 테스트, `apps/web/e2e/operations-ui-comments.spec.ts`의 보완2 사례.
- 갱신 규칙: finder portal 정착 뒤 실제 자동 GET으로 상세 내부 초점·의도적 외부 초점·모바일 반환을 구분하고, 범위 변경과 카메라·스크롤·GET-only 안전 검증을 같은 기능 변경에서 유지한다.

## 2026-10-02 모니터링 선택·로그 상태 검토 보완 (Task 5 보완1)

- 구현 완료: 성공적으로 확인한 runtime 조명이 기존 장애·검색·배치 조건에서 제외되면 선택 ID·상세·내부 pin을 함께 해제하고 다른 조명을 대입하지 않는다. 저장 pin만 먼저 받은 상태, runtime 부분 수신·진행 중·실패는 확인된 조건 이탈과 구분하여 원래 ID와 정보 확인 중 상태를 보존한다.
- 구현 완료: 계정·현장·층·열림 조건이 바뀔 때 로그 cursor stack 자체를 폐기한다. 첫 새 조건 요청부터 첫 페이지를 사용하며 A2→B1→A1 및 닫기→재열기에서 이전 페이지가 되살아나지 않는다. 크기·기간·410 복구와 이전 범위 응답 격리도 유지한다.
- 구현 완료: 로그 페이지 조작은 조회 중에도 같은 controls를 유지·비활성화한다. 현재 건수를 모르는 pending/error에는 공통 PaginationBar의 nullable cursor count로 이전 건수나 가짜0을 표시하지 않는다. 실제 numeric0은 정상 빈 결과로 유지하며 기존 total 방식과 기본·사용자 지정 크기 계약은 변경하지 않는다.
- 구현 완료: 비활성화로 native focus가 이탈하면 보이는 페이지 조작 영역에 임시 focus를 유지한다. 성공 뒤 유효한 원래 control, 마지막 페이지·오류에는 같은 영역의 활성 control로 복귀한다. 기간·본문·닫기로 사용자가 이동하면 복귀 권한을 폐기하고, background 재조회·닫힌 drawer·옛 범위는 다른 focus를 가져오지 않는다. SelectBox popup의 반환 순서와 Tab·ShiftTab·Escape를 보존한다.
- 미구현: 실제 운영 DB·두 계정/기기·native 확대·양수 safe-area·실장비 검증과 최종 통합은 후속 Task9 관문이다.
- 부족하거나 개선이 필요한 기능: 이번 보완은 격리 API fixture·단위·Chromium 증거이며 독립 재검토 승인과 공통 알람 Drawer 물리 보완은 별도다. 기존 편집기1000개/8초 실패는 기준·skip 변경 없이 분리하여 보고한다.
- 관련 파일: `apps/web/src/features/monitoring/{MonitoringView,MonitoringLogDrawer}.tsx`와 직접 테스트, `apps/web/src/components/ui/PaginationBar.tsx`와 직접 테스트, `apps/web/e2e/operations-ui-comments.spec.ts`.
- 갱신 규칙: 확인된 조건 이탈과 saved-pin 미수신, scope 왕복과 첫 요청, stable controls와 실제 native focus·명시적 이동·오류·늦은 응답을 구분하여 같은 기능 변경에서 검증·갱신한다.

## 2026-10-02 지도·명시 선택·상세·전체 로그 (Task 5)

- 구현 완료: 지도에 실제 표시되는 정상·장애·오프라인·상태 확인 대기·정보 확인 전 상태만 아이콘과 문구로 범례에 표시한다. 고정 이동 안내와 지도 표시 대수만 제거하며 KPI·검색 결과·로그 실제 개수는 유지한다. 시각 중심은 20px 원형, 실제 monitoring hit는 48×48 CSS px이고 상태 테두리/아이콘과 별도 선택 외곽선·키보드 초점으로 색상 외 구분을 제공한다. 기존 밝기 단계·CAD·휠·키보드·touch·Gateway/권한 제약은 유지한다.
- 구현 완료: 선택 ID는 처음 `null`이며 검색 열기·조회 도착·0건 필터가 임의 조명을 선택하지 않는다. 명시 pin 선택은 필터 초기화와 같은 갱신에서 ID를 유지한다. 외부 검색/KPI·층·현장·계정 변경과 확인된 삭제는 선택을 해제하고 다른 조명으로 대체하지 않는다. 저장 pin이 runtime보다 먼저 도착하면 그 ID/이름과 불러오는 중 상태를 유지한다.
- 구현 완료: 검색과 상세의 열림은 독립이다. 명시 상세 확장은 1024px 이상 비모달 aside, 그 미만 공통 DetailSheet에서 같은 조명 정보를 표시하며 팝오버를 중복 노출하지 않는다. 지도 viewport는 유지하고 상세 닫기는 연결된 원래 marker 또는 toolbar로 초점을 돌려준다. PC 닫기도 기존 52px 토큰으로 실제 연속 44px 클릭 영역을 확보한다. 모니터링 전용 유한 flex 높이는 남은 공간을 지도로 배분하며 조작 footer를 제외한 실제 지도 viewport 최소 240px와 짧은 화면의 접근 가능한 page scroll을 보존한다. zoom/full-view 조작은 모니터링에서만 별도 footer 공간을 사용해 오른쪽 아래 48px pin 클릭을 가리지 않는다. 다른 메뉴의 viewport overlay와 문서 스크롤 정책은 변경하지 않는다.
- 구현 완료: 전체 로그는 공통 FilterPanel·LogView·PaginationBar를 소비하고 기본50/100/500/1000건, 종료일 포함 paired 기간 및 전체 보관 기간, unknown-total cursor 이동을 제공한다. 계정·현장·층·크기·기간별 query scope와 cursor 초기화를 분리하며 이전 범위의 늦은 응답은 새 화면에 섞이지 않는다. loading/error/410에는 이전 행이나 가짜0건 성공을 표시하지 않고 재시도/최신 기록 복구를 제공한다. 최근 ticker는 기존 소량5건 호출을 유지한다.
- 구현 완료: 실제 서버 시각은 공통 formatter의 `yyyy-MM-dd HH:mm:ss`/Gregorian/h23를 사용하며 자정은 `00:00:00`, 잘못된 값은 `—`다. 현장 시간대와 ISO 원본 정밀도·freshness/retention 의미는 그대로 유지한다.
- 미구현: 운영 DB migration·실장비·native WebView·실제 브라우저 두 세션·운영 배포 검증은 이번 변경에 포함하지 않는다.
- 부족하거나 개선이 필요한 기능: 검증은 격리 route fixture와 scoped 자동 회귀이며 완료된 실장비 증거가 아니다. 공통 알람 Drawer/safe-area의 독립 검수 보완과 최종 통합/디자이너 검수는 총괄이 이어서 수행한다. 기존 설정 편집기1000대/8초 성능 실패는 별도로 유지하며 제한을 늘리거나 skip하지 않는다.
- 관련 파일: `apps/web/src/features/monitoring/{MonitoringView,FloorMap,FixtureDetailPanel,MonitoringLogDrawer,monitoring-time,useMonitoringActivity,fixture-status-presentation}`, `apps/web/src/features/floor-map/{FloorScene,FloorMapViewport}`, 모니터링 전용 display 분기의 `apps/web/src/features/shells/CustomerShell.tsx`, 관련 단위·monitoring E2E 및 `operations-ui-comments.spec.ts`.
- 갱신 규칙: 이전 날짜의 네모 marker/자동 선택/5건 drawer 설명은 당시 증거이며 현재 계약은 이 Task5 항목을 우선한다. 선택·필터·삭제·runtime 순서·breakpoint 카메라/scroll/focus·실제 footer/marker bounds·로그 기간/크기/cursor/stale/error 회귀와 이 문서를 같은 기능 변경에서 유지한다.

## 2026-10-02 영속 알람센터 웹 소비 (Task 4)

- 구현 완료: CustomerShell의 인증 계정·접근 가능한 선택 현장을 기준으로 기존 incident GET/개인 읽음 PUT를 소비한다. `알람센터` 배지는 서버의 현장 전체 `unreadCount`만 사용하며, 닫힌 센터는 `limit=1`, 열린 목록은 25건과 서버 cursor를 사용한다. 기존 `incidents[]`·`activeCount`·운영 상태·시각 정밀도를 검증하고 잘못된 응답을 0건으로 표시하지 않는다.
- 구현 완료: 열린 센터·활성 문서에서 IntersectionObserver가 실제 가시성을 확인한 행만 빈 body PUT로 읽음을 저장한다. 닫힘·화면 밖·미조회 다음 페이지·숨김/비활성 문서는 읽음 요청이 없고, 스크롤과 중복 관찰은 계정·현장·ID별 in-flight 중복 방지로 보호한다. 실패한 행은 미읽음/배지를 유지하며 가시 행의 재시도를 제공한다. 성공 후 목록·배지는 정본 GET로 갱신하고 로컬 수치를 차감하지 않는다.
- 구현 완료: 장애 목록과 `현재 화면 상태`를 별도 영역으로 제공한다. 기존 연결 안내·조회 실패·명령 진행·toast·retry/action은 유지하며 DB 미읽음 수에 합산하지 않는다. 개인 읽음은 operational acknowledge/assign/resolve나 장치 명령을 수행하지 않고, 읽은 미해결 장애도 목록에 남는다. 최초 GET 실패는 확인 불가, 마지막 성공 후 실패는 마지막 수치와 갱신 실패로 구분한다.
- 구현 완료: 계정·현장 query key와 요청 수명·취소를 분리해 이전 범위의 늦은 응답이 새 범위를 바꾸지 않게 한다. 30초 polling과 문서 복귀/포커스의 정본 조회로 다른 기기의 읽음 상태를 동기화하고, 해당 ID의 읽음을 서버가 확인하면 이전 저장 실패도 해제한다. StrictMode 재설정·동일 incident polling·새 세션의 서버 receipt 재조회 회귀를 유지한다.
- 구현 완료: 닫힌 요약과 열린 목록의 정본 수치는 완료 시각이 아닌 QueryClient 수명의 요청 시작 순서로 선택한다. 열기·닫기 전환은 이전 모드의 실행 중 GET를 취소하고, 개인 읽음 PUT 성공 뒤 두 모드의 이전 GET를 취소한 다음 정본을 재조회한다. 늦은 pre-read 응답이 읽음 후 수치를 되돌리지 않으며, 후속 서버 수치의 정상 증가·다른 기기의 읽음에 따른 감소·실패 시 마지막 수치와 stale 표기를 보존한다. 같은 캐시를 재사용하는 remount에서도 요청 순서를 초기화하지 않는다.
- 구현 완료: 알람센터만 유한 높이의 독립 본문 스크롤과 선택형 `safeArea`를 사용한다. 상단 제목·닫기와 하단 닫기는 목록의 처음/스크롤/끝에서도 보이며, top/bottom inset은 공통 opt-in wrapper 한 곳에서만 반영한다. 기존 modal/drawer/sheet 기본 스크롤·포커스·여백과 셸 navigation inset은 변경하지 않는다. 긴 한글/공백 없는 영문·짧은 높이·loading/empty/조회·읽음 실패·실제 브라우저 200%·CDP top24/bottom34에서 유한 positive body, 닫기44px/경계, 마지막 행·더보기·키보드/복귀를 집중 회귀로 검증한다. CDP/env·fixture 결과는 실제 모바일 장치 인증이 아니다.
- 미구현: 사용자/운영 DB migration·배포·실장비 HIL은 실행하지 않았다. 실제 두 브라우저 세션과 동일 계정의 DB 영속성 검증, 전체 뷰포트 물리 검수는 Task 9에 남아 있으며 mock 서버 receipt 재조회나 Chromium 결과로 대체하지 않는다.
- 부족하거나 개선이 필요한 기능: Task 4 집중 단위 및 격리 Chromium은 소프트웨어 증거다. 독립 코드 리뷰·후속 메뉴 회귀와 최종 통합 관문은 총괄이 이어서 확인한다. 알람 push 기반 실시간 동기화는 추가하지 않았다.
- 관련 파일: `apps/web/src/api/monitoring-incidents.ts`, `apps/web/src/components/ui/session-status/{useMonitoringIncidents.ts,SessionStatusCenter.tsx,SessionStatusProvider.tsx}`, `apps/web/src/components/ui/{ModalDialog.tsx,overlays/DialogBase.tsx}`, `apps/web/src/styles/base.css`, `apps/web/src/features/shells/CustomerShell.tsx`, 관련 API·hook·session·shell·overlay 테스트, `apps/web/e2e/operations-ui-comments.spec.ts`.
- 갱신 규칙: durable 미읽음 수와 transient 상태, 개인 열람과 장애 처리, 실제 DB·software fixture·실장비 증거를 구분한다. closed/open/hidden/offscreen·PUT 실패·canonical count·mode/읽음 갱신 요청 역전·계정/현장 late response·transient 상태 유지/제거·키보드/스크롤 회귀를 같은 변경에서 유지한다.

## 2026-10-05 개인 알람 숨김 Backend (추가 운영 UI Task 3)

- 구현 완료: strict 빈 body의 개별 dismiss PUT와 UUID 요청키만 받는 dismiss-all POST를 추가했다. 인증 계정·선택 현장에만 적용하고 읽기 전용 viewer도 허용한다. 기존 읽음과 같은 advisory/Site/User/멤버십 잠금·재인가를 사용하며 읽음 기록·장애 상태/revision·현장 전체 activeCount는 변경하지 않는다.
- 구현 완료: 전체 숨김은 페이지·목록 필터 밖의 모든 미숨김 ID를 한 SQL snapshot으로 pending 원장에 먼저 commit한다. 이것이 최초 수락 경계다. 별도 transaction에서 재인가 후 숨김 효과와 실제 신규 insert 수/완료 시각을 함께 commit한다. 실패·권한 철회·늦게 commit한 과거 시각 알람·동일 키 동시 요청에도 저장 집합을 넓히지 않는다. 삭제/겹친 대상은 실제 삽입 수에서 제외하며 완료 재시도 응답은 고정한다.
- 구현 완료: GET의 기본 all은 기존 운용 목록과 미읽음 의미를 유지하고, personal만 개인 숨김을 목록/미읽음 수에서 제외한다. 행에 `isDismissed,dismissedAt`을 반환하며 cursor v2는 actor/site/view/filter에 바인딩한다. v1은 all에서만 소비한다. 같은 ID 갱신은 계속 숨김이며 새 ID 재발은 미읽음이다.
- 미구현: 사용자 DB migration/서버 반영은 최종 검수 뒤 Task 10이며 이 Backend 작업에서 수행하지 않았다. 웹 알람센터의 개인 숨김 소비는 위 Task 4 항목에서 구현하며 Backend/웹의 별도 검증 경계를 유지한다.
- 부족하거나 개선이 필요한 기능: 요청 원장과 frozen ID 배열은 부모 수명까지 보관하므로 계속 증가한다. 독립 TTL·worker/lease·자동 청소는 제공하지 않는다. 검증은 자기 소유 빈 임시 PostgreSQL과 API 자동 테스트이며 운영 배포/native/HIL 증거가 아니다. 독립 검토와 최종 전체 통합 관문은 별도로 남는다.
- 관련 파일: `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261004100000_monitoring_incident_dismissals/migration.sql`, `apps/api/src/monitoring-incidents/{monitoring-incident-dismissal.service.ts,monitoring-incident-personal-access.ts,monitoring-incidents.dto.ts,monitoring-incidents.service.ts,monitoring-incidents.controller.ts,monitoring-incidents.module.ts}` 및 인접 단위/실제 PostgreSQL 테스트, `docs/database-schema.md`.
- 갱신 규칙: 개인 숨김·개인 읽음·운용 상태를 구분하고 durable 예약 전/후 실패, 권한 철회, 동일 키 재시도, 페이지/필터 밖 범위, UTC/Seoul/New_York, cascade와 count CHECK를 같은 작업에서 검증한다. 사용자 DB 적용 여부를 임시 DB 결과와 분리한다.

## 2026-10-02 계정별 영속 알람 읽음 API (Task 2)

- 시각 경계 보완(2026-10-04): incident raw SQL의 cursor·관측·자동 회복·revision Date 바인딩과 freshness의 heartbeat/fixture cutoff를 UTC timestamp로 명시적으로 정규화한다. 저장 column·active-first/id tie 정렬·index·GREATEST·revision +1ms·권한 잠금·최초 개인 읽음은 유지하며 운영 DB/role/session TimeZone이나 기존 데이터를 변경하지 않는다.
- 검증 범위: 자기 소유 임시 PostgreSQL/Prisma6.19.3에서 UTC·Asia/Seoul·America/New_York 겨울/여름 session을 직접 확인하고 tied cursor·관측/역행/회복·receipt 격리·고정 제어 freshness와 activity/idempotence를 회귀 검증한다. 운영 DB 적용·과거 비정상 timestamp 복구·실장비/HIL은 별도 관문이며 임시 DB 결과로 완료를 주장하지 않는다.

- 구현 완료: 기존 incident GET의 `incidents[]`에 현재 계정의 `isRead`·`readAt|null`과 현장 전체 `unreadCount`를 추가했다. 해결된 미읽음도 집계하고 상태/유형/커서/현재 페이지와 독립이다. 기존 정렬·커서·`activeCount`는 보존하며 GET는 receipt를 쓰지 않는다.
- 구현 완료: `PUT /sites/:siteId/monitoring-incidents/:incidentId/read`는 서버 인증 actor의 개인 읽음을 기록하고 최초 DB UTC `readAt`을 중복·동시 PUT에도 유지한다. read-only viewer도 허용하고 활성 계정·멤버십·현장 소속을 같은 transaction에서 잠금 후 재검증한다. actor/시각/revision body 지정은 400이며 operational acknowledge/resolve와 incident revision을 변경하지 않는다.
- 구현 완료: receipt는 incident/User 삭제 cascade이며 별도 TTL이나 incident 3개월 purge는 없다. 같은 ID polling은 읽음 유지, 회복 후 재발의 새 ID는 새 미읽음이다. 실제 자기 소유 임시 PostgreSQL에서 전체 migration과 계정 격리·권한/삭제 경쟁·cascade, Task 1 날짜·1,000행 커서를 확인했다. 사용자 DB 적용·장비/HIL 증거는 아니다.
- 미구현: 운영 DB migration·배포와 최종 실제 두 세션 검증은 별도 관문이다. 웹 알람센터·배지 정본 조회·실제 보이는 항목 PUT 소비는 위 Task 4에 구현했으며 닫힌 센터/화면 밖 항목이나 transient 상태를 읽음/DB 알람 수에 포함하지 않는다.
- 부족하거나 개선이 필요한 기능: 독립 검토와 최종 전체 회귀, 사용자/운영 migration·배포는 별도 관문이다. UI는 PUT 성공 ID만 반영하고 GET 재검증으로 두 기기 숫자를 동기화해야 하며 낙관 차감은 하지 않는다. HTTP 테스트는 실제 session DB guard를 사용하되 무관한 Redis login/MFA 초기화만 대체했다.
- 관련 파일: `apps/api/prisma/schema.prisma`, `20261001100000_monitoring_incident_read_receipts/migration.sql`, `apps/api/src/monitoring-incidents/monitoring-incidents.{dto,controller,service}.ts`, 관련 단위·통합 테스트, `docs/database-schema.md`.
- 갱신 규칙: 개인 읽음과 운영 확인/해결, producer와 웹 소비, 실제 임시 DB와 운영 적용 증거를 구분한다. filter 독립 unread·첫 시각·계정/현장 격리·revocation/cascade·실제 visible 성공 PUT 회귀를 함께 유지한다.

## 2026-10-02 운영 로그 기간·1,000건 API (Task 1)

- 구현 완료: 현장·선택 층 `monitoring-activity` 조회에 paired `fromDate`/`toDate`(`YYYY-MM-DD`)와 1–1,000건 상한을 추가했다. API 기본 5건은 유지한다. 현장에 저장된 시간대로 종료일을 포함하는 `[start,end)`를 계산하고, 같은 읽기 transaction의 중앙 DB `generatedAt`·3 calendar months `retainedFrom`과 교차한다. 빈 교집합은 기록 0건이며 다른 기간으로 확장하지 않는다.
- 구현 완료: 응답은 사용자·현장·층·날짜 조건·실효 조회 크기의 canonical SHA-256 scope와 원본 recordedAt/id를 담은 v2 cursor를 발급한다. 조건 변경/잘못된 cursor는 400, 같은 scope의 보존 만료는 기존 410이다. 기존 v1은 날짜 조건 없이 기존 상한 50 이하에서만 수용하고 다음 cursor는 v2다. `items`·`nextCursor`·ISO 메타데이터와 안전한 필드 allowlist는 유지한다.
- 구현 완료(웹 후속 Task5): 전체 로그의 50/100/500/1000 선택·기간 입력·unknown-total cursor UI를 소비한다. 최근 활동 띠의 소량5건 조회는 그대로다.
- 부족하거나 개선이 필요한 기능: 이번 API 단위 회귀와 전체 소프트웨어 검증은 실제 사용자 DB·장비 또는 운영 적용 증거가 아니다. 일회용 PostgreSQL opt-in 통합과 독립 검토는 별도 관문으로 기록한다. 명령/incident 보존 및 기존 활동 삭제 worker를 변경하지 않는다.
- 관련 파일: `apps/api/src/retention/log-date-range.ts`, `apps/api/src/monitoring-activity/monitoring-activity.{controller,service}.ts`, 관련 단위·통합 테스트.
- 갱신 규칙: producer 지원과 웹 소비 적용을 구분하고 paired 날짜 검증·현장 시간대/DST·DB 시각·scope/조회 크기 cursor·동일 시각 ID 순서·legacy 호환 및 opt-in 실행 여부를 함께 유지한다.
- 날짜 경계 보완: 현장 시간대에서 실제로 존재하지 않는 시작일·종료일을 선택하면 400으로 거부한다. 유효한 종료일 다음 날짜만 시간대 전환으로 사라진 경우에는 다음 실제 날짜 시작을 종료 경계로 사용하며, 보존 범위 밖의 유효한 기간은 그대로 빈 교집합이다. Pacific/Apia 역사 경계는 단위 테스트 증거이며 실제 DB 검증은 후속이다.
## 2026-10-04 큰 글자의 맵 선택 가용 폭 보완

### 구현 완료

- compact 화면에서 맵 선택과 검색·상세 버튼을 세로로 배치해 선택값이 버튼과 폭을 경쟁하지 않도록 한다. `맵 선택` 라벨은 선택값 옆에 유지하고 검색·상세 버튼은 다음 줄 오른쪽에 둔다. 큰 화면의 기존 수평 배치와 공통 SelectBox·글자 크기·확대 동작은 변경하지 않는다.
- 320/390px·웹 root 글자100/200%에서 `B2` 및 `B1 · 동측 지하주차장`의 전체 글자 영역과 펼침 표식의 버튼 내부 표시·서로 겹치지 않음을 검사한다. 선택/검색/새로고침 도구의 실제 clip·occlusion을 반영한 연속44×44px 접근 영역, 층 변경 후 해당 층 조회·조명 검색·현재 선택/URL 유지·명령 POST0 회귀를 추가한다.

### 미구현

- 실제 Android/iOS WebView의 OS 큰 글자·VoiceOver/TalkBack·고객별 모든 층명 검증은 이번 격리 Chromium 표시/조작 회귀와 별개다.

### 부족하거나 개선이 필요한 기능

- 기존 시각 문제는 320px200%에서 선택 버튼 폭26px과 값·표식의 버튼 경계 이탈로 재현했다. 후속 회귀는 웹 글자 확대와 현실적 긴 층명 조건을 검사하며 전체 서비스 큰 글자 UX·실기기 접근성·HIL 승인을 대신하지 않는다. 전체 브랜치 검증은 총괄이 수행한다.

### 관련 파일

- `apps/web/src/features/monitoring/MonitoringView.tsx`, `MonitoringView.test.tsx`, `apps/web/e2e/mobile-monitoring-touch.spec.ts`, 기존 `apps/web/e2e/support/layout-assertions.ts`(재사용만).

### 갱신 규칙

- 좁은 폭/큰 글자에서 전체 선택값·펼침 표식·도구 접근 영역을 함께 검증한다. label 연결·현장/층 identity·검색/URL·조회 전용 의미를 보존하고, 공통 필드나 폰트 시스템 변경은 별도 소유 역할에 배정한다.

## 2026-10-04 갱신 시각의 현장 시간 표시 보완

### 구현 완료

- `마지막 갱신`의 정상·지연 snapshot 시각은 최종 통합에서 조명 상세와 같은 현장 `timeZone` 공통 포맷터의 날짜·초 단위 시각을 표시하고 `(현장 시간)`으로 의미를 명시한다. 서버 원본 ISO는 `<time dateTime>`에 보존한다. React Query 수신 시각이나 장비 마지막 관측 시각으로 바꾸지 않는다.
- 좁은 화면과 큰 글자에서는 갱신 시각만 자연스럽게 줄바꿈한다. 가장 오래된 fixture page 기반 freshness 및 60,000/60,001ms 경계, 미래·invalid·pending 안내, 조회·수동 장치 확인·제어 계약은 유지한다.
- 서울의 다음 날짜/LA의 이전 날짜 경계 단위 회귀와 320/390px·실제 caption 12/24px Chromium 표시 회귀를 추가한다. 기존 상세·로그·마커·핀치·이동 터치 회귀도 유지한다.

### 미구현

- 실제 Android/iOS WebView의 OS 글자 확대·시간대 설정·물리 조명 HIL 검증은 이번 소프트웨어 표시 보완의 완료 범위가 아니다.

### 부족하거나 개선이 필요한 기능

- 200% 검사는 웹 root 글자 크기 변경으로 caption 24px을 확인한 격리 Chromium fixture 결과다. 전체 메뉴의 큰 글자 UX나 네이티브 접근성 설정을 승인하는 근거로 확대하지 않는다. 전체 브랜치 통합·출시 검토는 총괄 관문으로 유지한다.

### 관련 파일

- `apps/web/src/features/monitoring/MonitoringView.tsx`, `MonitoringView.test.tsx`, 기존 `monitoring-time.ts`·테스트, `apps/web/e2e/mobile-monitoring-touch.spec.ts`.

### 갱신 규칙

- 화면용 현장 시각과 기계용 원본 ISO를 분리해서 검증하고, 날짜 경계·freshness·예외 메타데이터·조회 전용 의미를 함께 보존한다. 기본 글자/큰 글자·fixture/실기기 검증을 구분한다.

## 2026-10-04 모바일 상세 터치 스크롤 보완

### 구현 완료

- 조명 검색·상세 드로어를 터치로 스크롤할 때, 높이 제한이 없는 내부 조명 패널이 입력 전달을 막지 않도록 해당 SidePanel 소비자에서만 `overflow-visible`·`overscroll-auto`를 적용한다. 바깥 드로어가 스크롤을 소유하며 공통 SidePanel/Dialog 기본값과 지도·장치 확인 계약은 유지한다.
- 320/390px 터치 회귀는 실제 Chromium touch 입력으로 상세 마지막 지도 배치, 로그 마지막5건과 서버 cursor 이전/다음, 마커 탭·핀치·지도 이동을 확인한다. 모니터링에서 장비 제어 요청은 만들지 않는다.

### 미구현

- Android/iOS 실기기 설치·네이티브 safe-area/키보드/OS Back·GPU 성능 및 물리 조명 HIL은 이 소비자 보완의 완료 범위가 아니다. 공통 앱 복귀·native Back 연결은 모바일/웹 셸 담당의 별도 선행 작업이다.

### 부족하거나 개선이 필요한 기능

- 터치 회귀는 격리 API fixture와 Chromium 소프트웨어 증거다. 실제 WKWebView/Android WebView 및 장비 상태 확인 결과로 확대하지 않는다. 초기 공통 React18/19 타입 혼재는 의존성 담당이 정리했으며, 이후 웹 전체 타입 검사는 검사 당시 다른 담당의 공통 모바일 helper·설정 입력 구현 항목에 막혔다. 모니터링에서 cast/skipLibCheck로 감추지 않고 전체 브랜치 타입·통합 검증은 총괄의 별도 관문으로 유지한다.

### 관련 파일

- `apps/web/src/features/monitoring/FixtureDetailPanel.tsx`, `apps/web/e2e/mobile-monitoring-touch.spec.ts` 및 기존 MonitoringView/MonitoringLogDrawer/FloorMapViewport 직접 테스트.

### 갱신 규칙

- 상세 안팎의 실제 스크롤 범위·최종 정보 hit·터치 기본 동작을 함께 검증한다. 로그 cursor/마커 선택/장치 상태 의미를 보존하고, 공통 컴포넌트 변경은 소유 역할에 순차 배정한다. 소프트웨어·실기기·HIL 결과와 의존성/수집 오류를 각각 구분해 기록한다.

## 2026-10-02 맵 선택 전체 삭제의 읽기 전용 소비

- 구현 완료: 설정 맵의 전체 삭제는 도형을 삭제하고 선택 조명을 미배치·위치 미확인으로 전환하며 슬롯 assignment를 해제한다. 기존 원자 저장 응답과 cache 갱신을 통해 모니터링은 저장된 도형·배치만 읽고 조명 장비 자체 및 전체 등록 수는 유지한다. 모니터링에 편집/장비 삭제 UI를 추가하지 않았다.
- 미구현: 실제 장비·고객 DB·native WebView에서의 검증은 이번 Web fixture 검증과 별개다.
- 부족하거나 개선이 필요한 기능: 신규 혼합 삭제/슬롯 해제는 HTTP fixture 저장·reload로 검사했으며 실제 backend 원자성 보증은 기존 서버 계약과 별도 통합 QA를 따른다. 미배치 조명 수와 전체 등록 수를 같은 지표로 해석하지 않는다.
- 관련 파일: `apps/web/src/features/floor-editor/use-map-editor.ts`, `apps/web/src/features/floor-editor/FloorEditorView.tsx`, `apps/web/e2e/support/settings-api.ts`, `apps/web/e2e/map-editor-bounded-extension.spec.ts`.
- 갱신 규칙: 설정 배치·슬롯·저장 계약이 변경되면 모니터링의 읽기 전용 재조회와 수 집계 의미를 함께 확인한다.

## 2026-09-27 종료 명령의 연결 활동 사본 정리

- 구현 완료: 내부 명령 상세 정리 helper는 성공한 후보에 연결된 raw 및 알려진 keyed command activity source를 같은 거래에서 제거한다. 늦게 생성된 활동의 별도 recordedAt 때문에 만료 명령 연결 사본이 남지 않도록 한다. 이후 단계가 실패하면 활동도 rollback한다.
- 미구현: 내용 정리 worker의 기본 timer 연결·운영 활성화. 일반 활동 이력의 기존 중앙 DB 3개월 조회/정리 경계는 유지한다.
- 부족하거나 개선이 필요한 기능: keyed source 검증 키가 없으면 보수적으로 후보를 보류하며 운영 적용 전 과거 keyring 보존을 확인해야 한다.
- 관련 파일: `apps/api/src/retention/command-detail-redaction.ts`, `apps/api/src/retention/command-detail-redaction.integration.spec.ts`.
- 갱신 규칙: helper 구현을 운영 정리 완료로 기록하지 않으며 제어/모니터링 사본 제거와 rollback 검증을 함께 유지한다.

## 2026-09-27 현장·층 대시보드 집계 계약

- 구현 완료: `GET /sites/:siteId/dashboard`는 활성 층의 전체 등록 조명을 동일 현장 정책·응답 시각으로 한 번씩 분류해 현장 `offlineFixtures`와 층별 `summary`를 반환한다. `includeFixtures=false`여도 집계는 유지하고 조명 상세는 제외한다. 층의 `mapRevision`과 `mapConfigured`는 현재 공통 맵 revision의 작은 집계값을 현장당 한 번 조회해 반환하며 전체 변경 snapshot이나 맵 blob을 응답에 싣지 않는다.
- 미구현: 이 API 계약 변경만으로 실제 장비 상태 수신, 고객 DB 적용, 운영 배포가 검증되지는 않는다.
- 부족하거나 개선이 필요한 기능: 현재 revision snapshot이 없거나 revision 값과 불일치하면 맵 상태를 거짓으로 표시하지 않고 dashboard 조회를 실패시킨다. 공통 문서의 `elementCount`에는 표시 여부가 없어 모든 요소가 숨김이어도 true일 수 있다. 표시 가능한 요소만 구분하려면 별도 메타데이터 계약이 필요하다. 층별 등록 수는 지도에 배치된 핀 수와 다르다.
- 관련 파일: `apps/api/src/sites/sites.service.ts`, `apps/api/src/sites/sites.service.spec.ts`, `apps/api/src/sites/sites-dashboard.integration.spec.ts`, `apps/web/src/api/queries.ts`.
- 갱신 규칙: 대시보드 상태 분류나 맵 판정 조건을 바꾸면 활성 층 합계, 상세 제외 경로, 실제 DB 회귀와 Web 소비 계약을 함께 갱신한다.

## 2026-09-27 운영 활동 3개월 보존 코드 통합

- 구현 완료: 인증된 현장·층 활동 조회 API는 `read` 권한·층 소속을 확인한 뒤 중앙 DB UTC 시각에서 3 calendar months를 역산한 `retainedFrom` 이후의 기록만 반환한다. `generatedAt`·cursor 만료 `410`·행 필터도 같은 짧은 DB 읽기 transaction의 시각을 사용하고 DB 시각 조회 실패를 API 시계로 대체하지 않는다. 5건 기본 cursor 페이지는 사용자·현장·층에 묶인다. 검증된 조명 상태·밝기·Health 전이, 실제 오프라인·복구 전이, 수동 상태 확인의 종료 결과를 원본 전이와 같은 transaction에 기록한다. 명령의 MQTT ACK·timeout·outbox terminal 경로도 실제 outcome CAS가 승리한 경우에만 영향 층마다 결과 활동을 같은 transaction에 기록한다. `unknown`과 이후 상태 확인으로 확정된 `applied`는 별도 행이며 pending·전송 자체는 활동으로 기록하지 않는다. Prisma 활동 producer는 DB UTC `recordedAt` 기본값을 사용한다. 보존 worker는 각 삭제 SQL의 DB 시각 cutoff보다 오래된 활동만 sweep당 최대 1,000행 물리 삭제하며 정확한 경계 행은 보존한다.
- 미구현: 기존 기록의 소급 backfill과 고객 DB migration·운영 배포는 수행하지 않았다. Command 원본 purge·복구 POST는 별도 안전 게이트 전까지 활성화하지 않는다.
- 부족하거나 개선이 필요한 기능: sweep이 밀리면 만료 행이 DB에 잠시 남을 수 있으나 조회 API는 즉시 숨긴다. 시간당 처리량은 현재 단일 worker 기준 최대 60,000행이며 여러 인스턴스의 `SKIP LOCKED` 경쟁과 실제 유입량을 고려해 backlog를 관찰해야 한다. 조명 freshness의 운영 상태 갱신과 활동 기록은 현장 단위 잠금·원자성을 유지하는 집합 처리로 6,001대 격리 PostgreSQL 회귀를 통과했지만, 이는 실제 현장의 지속 처리량이나 대규모 장애 incident 조정 시간을 보증하지 않는다. Command 원본 물리 삭제는 보호 cutover·복구 검증 전까지 계속 OFF다.
- 부족하거나 개선이 필요한 기능: 기존 활동의 raw Command source key 재키잉은 `MONITORING_ACTIVITY_KEYED_COMMAND_SOURCE_ENABLED=1`일 때만 물리 보존 sweep 뒤 각 후보 SQL의 중앙 DB UTC cutoff 이상인 legacy 활동 행을 회당 최대 100개 선택해 수행한다. 정확한 UTC 3 calendar-month 경계 행은 포함하고 만료 backlog는 별도 1,000행 물리 sweep이 처리한다. 원래 `recordedAt`을 유지하지만 keyed 중복 상대행의 시각 갱신과 raw 행 삭제가 가능하므로 100은 총 DB 변경 행 수 상한이 아니다. 기본값은 OFF이고 HMAC 키가 없으면 해당 재키잉 단계가 실패해 raw key를 임의 변환하지 않는다. 일회용 PostgreSQL에서 반복 수렴·UTC 월 경계·동시 keyed 생산자 중복 방지를 검증했지만 운영 키 배포·구형 생산자 drain·Command 원본 purge/이력 cutoff/복구 POST는 아직 활성화하지 않았다.
- 부족하거나 개선이 필요한 기능: 과거 Prisma client가 API 프로세스 시각을 명시 삽입한 활동 행은 진짜 DB 기록시각을 복원할 출처가 없어 소급 변경하지 않는다. 새 순방향 기본값 migration은 기존 행 rewrite 없이 UTC default를 재확립하지만 적용 시 짧은 DDL lock이 필요하며 고객 DB에 적용하지 않았다. DB primary 시계 연속성·failover 건전성 attestation, 운영 규모 backlog와 실장비 HIL은 별도 출시 검증이다.
- 관련 파일: `apps/api/src/monitoring-activity/monitoring-activity.service.ts`, `monitoring-activity.controller.ts`, `command-outcome-activity.ts`, `command-activity-source-backfill.ts`, `apps/api/src/{energy,fixtures,monitoring-refresh}/`, `apps/api/src/{mqtt,commands}/`, `apps/api/src/retention/data-retention.service.ts`, `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260927120000_monitoring_activity_db_clock_default/migration.sql`.
- 갱신 규칙: 신규 producer나 보존 조건을 바꿀 때 실제 고객 응답·물리 삭제 테스트와 운영 적용 여부를 함께 기록한다.

## 2026-09-27 Command 보관 선행 구조 통합

- 구현 완료: 보호된 일회용 Command purge는 활동의 raw Command source key를 site/outcome HMAC으로 재키잉하고 기존 층·기록시각을 보존한다. `MonitoringActivity` 모델·shared 계약·projection helper가 제한 worker의 선행 의존으로 포함된다.
- 미구현: Command outcome 활동 생산자와 무관하게 운영 purge·복구 POST는 비활성이다. 실제 DB migration/cutover는 별도 운영 작업이다.
- 부족하거나 개선이 필요한 기능: raw 활동·수동 원본 복사본을 검증하지 못하면 Command 삭제를 미루며 Gateway zero counter는 실제 조명 상태 관측이나 RF 완료 증거가 아니다.
- 관련 파일: `apps/api/src/monitoring-activity/command-outcome-activity.ts`, `monitoring-activity.projection.ts`, `packages/shared/src/monitoring-activity-contracts.ts`, `apps/api/src/commands/command-retention-worker.ts`.
- 갱신 규칙: 활동 조회/UI 구현 상태와 원본 삭제 안전 검증을 구분하고 실제 운영 반영 여부를 함께 기록한다.

기준일: 2026-09-30

## 2026-09-30 모니터링 화면 정리·휠 줌

- 구현 완료: 현장·선택 맵의 네 상태 집계는 이름과 수치만 표시하고 보조 문구를 제거한다. 0개 상태 KPI 또는 0건 검색 결과에서는 다른 조명의 선택기·상세 및 빈 상세 패널을 보여주지 않는다. 상태별 빈 목록과 `전체 조명 보기`를 제공한다. 미완료 페이지 조회에서는 확정적인 빈 상태를 표시하지 않는다.
- 구현 완료: `맵 선택` 바로 오른쪽에 `조명 검색·상세`를 놓고 새로고침은 오른쪽 끝에 둔다. `지도 전체 보기`를 지도 우하단 `[−][배율][+][전체 보기]` 조작 그룹의 마지막으로 옮기고 중복 `지도 화면 맞춤`을 모니터링에서만 없앤다. 배율 버튼은 가운데 100%로 복원하며 설정·제어 지도 조작은 유지한다.
- 구현 완료: 조명 팝오버의 닫기 아이콘을 없앤다. 같은 핀·바깥 클릭·Escape로 닫고 핀에 초점을 돌려주며 카메라를 흔들지 않는다. 작은 화면에서 목록으로 핀을 찾거나 팝오버 상세에서 돌아오면 해당 지도·핀을 고정 하단 내비게이션 위로 드러낸다. 상세에서 다른 조명을 선택하면 원래 핀 정보가 다시 열리지 않는다. 최근 운영 로그 ticker의 보관 정책 보조 행만 제거하고 전체 로그 drawer의 보관 안내는 유지한다.
- 구현 완료: 모니터링 지도 안의 일반 세로 휠 및 Ctrl/Cmd+휠은 포인터 아래 지도 지점을 기준으로 확대·축소한다. 휠 기본 상하좌우 이동은 막고 수평 전용 트랙패드 입력은 줌 없이 무시한다. 드래그·방향키 이동, 터치 핀치는 유지하며 데스크톱 안내를 `드래그로 이동 · 휠로 확대/축소`로 바꾼다. 공통 뷰포트의 변경은 모니터링 opt-in으로 설정·제어의 일반 휠 동작에는 영향을 주지 않는다.
- 미구현: 실제 조명·Gateway HIL, 운영 DB·배포는 이 UI 작업 범위가 아니다.
- 부족하거나 개선이 필요한 기능: KPI 집계와 fixture 목록은 서로 다른 조회 시각일 수 있어 불일치 안내를 유지한다. 모니터링 변경 관련 Chromium 85건은 통과했으며 별도 설정 편집기 1,000대의 8초 준비 성능 검사는 기존과 같이 실패한다. 모바일 320/390px 터치·overflow·핀/내비 분리를 브라우저로 확인했지만 실제 장비 결과와 동일시하지 않는다.
- 관련 파일: `apps/web/src/features/monitoring/{MonitoringView,MonitoringSummary,MonitoringFixtureFinder,FloorMap,FixturePinPopover,MonitoringLogTicker}.tsx`, `apps/web/src/features/floor-map/FloorMapViewport.tsx`, `apps/web/e2e/{monitoring-navigation-confidence,calm-operations-monitoring}.spec.ts`.
- 갱신 규칙: 지도 입력·집계·상세 표시·로그 정책이 바뀌면 이 문서와 브라우저 회귀를 함께 갱신한다.

## 2026-09-30 탐색·시야 개선 검증 상태

- 구현 완료: 별도 `codex/monitoring-navigation-confidence`에서 KPI 필터·지도 위치 찾기, 간단 조명 정보, 아이콘 전용 전체 보기와 범위별 카메라 기억을 구현했다. 상태 확인 결과 UI 및 모든 기술 정보 표시는 제외하고 기존 수동 장치 확인·최근 활동은 유지한다.
- 구현 완료: 사용자는 설정 편집기 성능 실패를 별도 후속으로 남기고 메인 작업 브랜치에 병합하도록 지시했다. `codex/mvp1-cloud-web` 로컬 fast-forward와 병합 체크아웃의 root lint/typecheck/test/build exit0을 확인했다. 기존 설계 초안4개는 삭제하지 않고 `superseded monitoring design draft before integration` scoped stash로 보존했다.
- 미구현: 설정 편집기 성능 원인 해결 및 실제 현장/HIL·DB migration·배포·push는 이번 작업에 포함하지 않는다.
- 부족하거나 개선이 필요한 기능: Node22/pnpm9.15의 root lint/typecheck/test/build는 exit0이다. Web 2,626 passed/3 skipped, API 2,963 passed/827 skipped, Gateway 1,409 passed 및 UI 정책 65/65·위반0/0이다. 최종 Chromium은82 passed/1 failed(exit1)이며 새 탐색·시야8건은 모두 통과했다. 1,000대 설정 편집기의8초 준비 성능 검사 실패는 미해결이다. 기존 CustomerShell 코드로 비교해도 약22초로 재현됐지만 전체 기준 브랜치 성능이나 원인 해결을 증명한 것은 아니다. 성능 한도를 완화하거나 실패를 통과로 취급하지 않는다.
- 관련 파일: 아래 `관련 파일`의 지도·모니터링·공통 UI와 `apps/web/e2e/monitoring-1000.spec.ts`, `docs/superpowers/plans/2026-09-29-monitoring-navigation-and-confidence.md`.
- 갱신 규칙: software fixture와 실제 장비 결과, 독립 코드 리뷰와 작성자 자기 검토를 구분한다. 사용자의 새 서브에이전트 금지에 따라 코드 검토는 작성자가 수행했고 기존 UI/UX 디자이너 세션이 구현 화면4종을 시각 검토했다.

## 2026-09-25 Final Atlas 적용 진행 상태

- 현장 전체와 선택 층의 조명 KPI를 별도 영역으로 분리했다. 등록 수와 상태별 수치는 dashboard의 현장·층 집계만 사용하며 조명 페이지 일부나 지도 핀 수로 역산하지 않는다. 오래된 로컬 테스트 DTO처럼 새 집계 필드가 없는 경우 `집계 준비 중`으로 표시하고 `0`으로 꾸미지 않는다. 실제 API는 `offlineFixtures`, 층별 `summary`, `mapRevision`, `mapConfigured`를 반환한다. `지도 표시 N대`는 선택 층 저장 map snapshot의 배치 수만 사용하고 숨김 도형·미배치 조명은 세지 않는다. 옛 지도에서 runtime-only 핀이 함께 보이거나 배치 필드가 누락되면 정확한 총수를 증명할 수 없으므로 비수치 `지도 배치 정보 확인 불가`로 표시한다.
- 현장·층 KPI를 각각 하나의 가로 strip으로 묶고, 데스크톱에서 검색·상세 상시 보조열을 `조명 검색·상세` 읽기 전용 드로어로 옮겨 지도가 본문 가용 폭의 95% 이상을 차지하도록 했다. 모바일에서도 같은 44px 이상 진입 버튼으로 검색·미배치 선택·상세를 열 수 있고 390/320px 지도 높이 340/300px, 문서 가로 overflow 0을 유지한다. 저장된 지도 카메라, pan/zoom, 실제 새로고침, 핀 팝오버와 권한별 설정 링크는 그대로 둔다. 드로어는 닫기/Escape로 닫히고 진입 버튼에 초점이 복귀한다.
- 지도 핀은 이름만 native 툴팁에 표시하고 접근성 이름에는 기존 상태·밝기를 유지한다. 클릭하면 공통 읽기 전용 팝오버에서 실제 마지막 관측 밝기·시각·권장 조치를 보여 준다. 2026-09-29 변경으로 좌표와 기술 정보 표시는 제거했다. 미관측 밝기·없는 저장 좌표를 만들어내지 않으며, 저장 핀의 runtime 행이 아직 로드되지 않았을 때 다른 조명의 게이트웨이·RSSI를 상세에 표시하지 않는다. Escape 닫기·핀 초점 복귀와 지도 포커스 방향키 이동을 제공한다. 320px Chromium 핀 가장자리·가로 overflow 테스트와 focused Vitest/타입/UI 정책 검사를 통과했다.
- 웹은 선택 현장·층의 실제 `GET /sites/:siteId/floors/:floorId/monitoring-activity` 응답을 사용자별 query cache로 조회한다. 최근 활동 띠는 서버에서 받은 항목만 3초 간격으로 회전하고 긴 문구에도 `전체 보기`를 우측 끝에 둔다. 등록 조명 0대라도 실제 기록이 있으면 서랍을 열 수 있으며, 범례와 로그는 최소 18px 띄운다. 서랍은 서버 cursor로 5건씩 이동하고 `410` 만료에는 이전 행을 재사용하지 않고 명시적인 `최신 기록 보기`를 제공한다. 실제 0건, 최초 조회 실패, 마지막 성공 뒤 갱신 실패를 서로 다르게 표시한다.
- 운영 활동 범위는 중앙 DB 시각의 `retainedFrom`을 정본으로 하는 최근 UTC 3 calendar months다. 브라우저가 90일로 환산하거나 아틀라스 가상 로그를 생성하지 않는다. 명령 원본이 3개월 뒤 물리 삭제되어도 표시 가능한 안전한 활동 snapshot만 사용하고, 만료된 명령 상세 링크·재전송 UI를 제공하지 않는다. API 조회·조명/refresh/확정된 Command 결과 생산자·활동 보존 sweep은 코드에 통합됐으며, 고객 DB migration·과거 기록 backfill·실장비 HIL은 아직 수행하지 않았다.

## 2026-09-24 공통 맵 타일 요청 보완

- 읽기 전용 모니터링 지도가 설정 편집기와 공유하는 ordered raster renderer에서 검증된 원본 tile의 인증 scope별 제한 LRU를 사용한다. 팬·줌·셀 교체 때 같은 tile의 HTTP 재요청을 줄이며 기존 셀의 완료 전 교체 금지, 캐시 32/128MiB 통합 메모리 제한과 권한 범위를 유지한다. 공유 renderer의 독립 Chromium fixture는 4개 tile의 50→4건, 30초 유휴 추가 0건 및 픽셀/context 복원을 통과했다. 실제 현장 모니터링의 HTTP 전후 수치와 모바일 WebView 체감은 별도 검증 대상이다.

## 2026-09-20 맵 표시 성능 반영

- 2026-09-21 후속: readOnly/source 객체가 갱신되어도 같은 인증 map scope에서는 Canvas/Pixi renderer를 유지한다. 공통 지도 pinch는 live DOM camera로 반영하고 pointer 종료에 한 번만 외부 zoom 상태를 전달한다.
- CAD raster 재생성 중에는 마지막 완성 cell을 계속 표시하고, 새 cell의 decode/paint/메모리 예약이 끝난 뒤에만 교체한다. 따라서 느린 타일 조회나 취소가 모니터링 지도에 빈 영역을 만들지 않는다.
- 모니터링에서 사용하는 공통 맵 renderer의 카메라 이동 경로를 최적화했다. 이동/줌 중에는 기존 ordered raster 셀을 재사용하고 정지 후에만 화면 phase에 맞춰 다시 렌더링한다.
- 설정 맵과 모니터링 읽기 전용 맵의 MapSceneCanvas imperative camera 계약을 유지하므로, CAD 요소와 일반 요소의 표시 데이터는 변경하지 않는다.
- 셀 메모리와 debounced 요청은 renderer 종료 시 정리되며 stale 렌더가 종료 후 셀을 되살리지 않는다. 모니터링 기능 범위와 읽기 전용 권한은 변경하지 않았다.
- 웹 전체 회귀 2,130개(3 skipped), 타입 검사, production build를 통과했다. 루트 전체 테스트·빌드도 종료 코드 0으로 통과했다. 50만 요소·실제 RN 성능은 기존 보류 범위다.

## 현재 전환 상태

- 2026-09-24 상태 안내 전환: 아래 P1 Task 3의 `persistent stale banner`/toolbar 오류 표시는 현재 구현에서 공통 세션 상태 센터와 화면을 밀지 않는 토스트로 대체한다. 캐시된 조명·지도 실패, 선택 층 snapshot의 60초 초과·미래·잘못된 시각, 수동 장치 확인 실패와 부분 갱신 실패를 현장·층별 상태로 등록하고 재시도를 제공한다. 같은 상태의 단순 재렌더는 토스트를 재발행하지 않으며 성공하거나 층/현장을 바꾸면 해당 상태를 해제한다. 최초 dashboard/조명/지도 데이터가 없어 운영 화면을 만들 수 없는 오류에는 본문 `FeedbackState`와 재시도를 유지한다. 현황 metadata의 캐시 갱신 실패는 중복 등록하지 않고 CustomerShell 상태 소스를 사용한다. 실제 장치 HIL은 별도 사용자 검증 대상이다.

- 2026-09-19 후속 root 전체 자동 테스트6,547개 및 빌드 통과, 실패0·기존 opt-in636개 제외. 모니터링의 실제 표시 E2E는 아래 `6325ef16` 증거와 구분하며, 이번 검증을 새로운 실장비/50만 요소 성능 검증으로 취급하지 않는다.

- 격리 실제 백엔드의 일반 도형 및 가져온 DXF 텍스트 저장/삭제/복구 결과를 모니터링 픽셀로 확인했다. 최종 `6325ef16` 여정도1 PASS이며 pageerror0/5xx0, 저장·재조회·조명 ID 보존과 격리 리소스 정리를 확인했다. `6325ef16` 인접 셀 삭제 잔상 보완은 독립 재검토를 통과했다. 읽기 전용 모니터링은 편집기와 같은 공통 렌더러를 사용한다. 약50만 요소의 두 번째 원본 및 합성500k 최종 검증은 사용자 요청으로 보류하며 해당 규모의 전체 지원·성능을 검증 완료로 표시하지 않는다.

- 공통 맵 전환 U13의 모니터링 연결을 `45c51198`에 구현했다. 저장된 MapDocumentRef만 공통 읽기 전용 Canvas로 표시하며 미저장 초안은 전달하지 않는다. 새 generation은 화면 맞춤을 다시 하고, 이전 revision의 지연 응답은 최신 저장 캐시를 덮어쓰지 못한다. 집중66·Chromium fixture2·타입 검사 통과 및 실제 admin Chrome의 B1 사각형 저장→모니터링 표시를 확인했다. 승인된 기존 맵 초기화는 실행 완료했다. U13 후보 미리보기 경쟁 보완도 `217083d2` 독립 재검토를 통과했으며 실제 대용량 DWG 최종 여정은 아직 남아 있다. 아래 native CAD 검증 기록은 전환 전 경로의 이력이다.

## 확정 구현 범위

- 조명 검색 결과에서 여러 장치를 선택한 뒤 일괄 또는 개별 정보를 설정할 수 있게 한다. 일괄 설정 이름은 층별 prefix와 서버가 원자 예약한 순번으로 자동 생성한다.
- ESP32-H2 firmware device UUID의 자사 namespace를 검증해 자사 제품만 검색 결과와 provisioning session에 반영한다.
- 설정 에디터의 수동 도형·조명은 기존 오버레이로, 네이티브 CAD는 공통 Pixi WebGL 타일 renderer로 읽기 전용 표시한다. 기존 SVG-only 맵의 읽기 호환은 유지한다.
- 2026-09-19 manifest HTTP 응답에서 저장 원장의 크기·SHA256 누락을 수정했다. 검증된 JSON을 같은 출처의 API가 반환하고 타일은 기존 비공개 다운로드를 유지한다. 실제 admin Chrome·실제 API/저장소의 B1 리비전 17에서 모니터링 도면 표시와 편집기 왕복을 확인했다. fixture 브라우저 결과와 달리 이번 확인은 현재 저장된 사용자 맵을 읽은 결과이며 조명 제어나 배치 저장은 실행하지 않았다.
- 도면 배경은 DB에 공개 URL을 저장하지 않고 인증된 `/api/floors/{floorId}/assets/{assetId}/content` 경로로 조회한다. API는 현장 read 권한을 확인한 뒤 300초 signed GET으로 연결하며 pending·타 현장·삭제 자산은 표시하지 않는다.
- 장비 상태는 BLE Mesh Health Current의 현재 fault만 수집하고 통신 품질 평가는 확장하지 않는다.

상세 계약은 `docs/superpowers/specs/2026-08-19-monitoring-control-focused-completion-design.md`를 따른다.

## 명시적 보류 범위

- WebSocket/SSE push
- RSSI, hop count, 명령 성공률 기반 통신 품질 고도화
- 장애 escalation/SLA 등급, 외부 ticket 연결과 production notification 전송. 장애 이력·담당자·조치 workflow 자체는 P1에서 구현했다.
- 통신 음영 heatmap, 차량 감지, 이벤트 타임라인, gateway coverage와 빠른 제어
- 자동 HIL 판정. 실제 하드웨어 검증은 수동으로 수행한다.

## 구현 완료

- 2026-10-04: 공통 iOS WebView 셸이 가려진 텍스트 입력의 포커스 테두리까지 확인하여 현재 포커스/키보드 열림 시도당 중앙으로 한 번 스크롤한다. 뒤늦은 viewport 크기 변경도 아직 보정하지 않은 입력만 다시 확인하며, 이미 충분히 보이거나 보정한 입력은 이동하지 않는다. 사용자 스크롤 제스처, 키보드 숨김, 앱 비활성화, 오류와 문서 교체 시 대기 중인 보정을 취소한다. Android와 메뉴 업무 로직은 변경하지 않는다.

- 2026-09-29 탐색 개선 구현: 선택 층 KPI는 접근 가능한 상태 필터 버튼으로 연결하고 현장 KPI는 읽기 전용 집계를 유지한다. 목록 필터와 지도 강조는 서버 DTO 상태 기준이며 배치 위치는 설정 snapshot을 우선한다. 추가 페이지 실패 시 자동 재요청을 멈추고 부분 조회 안내·수동 재시도를 제공한다. 모든 페이지 조회가 끝난 뒤 등록 수와 집계가 다르면 확인 시점 차이를 안내하며 검색 결과 수나 부분 페이지 수로 KPI를 덮어쓰지 않는다.
- 조명 핀/상세는 상태·확인된 밝기·마지막 확인 시각·권장 조치·배치 여부만 제공한다. 기술 정보와 상태 확인 결과 별도 UI는 제공하지 않으며 기존 수동 장치 확인·실패 안내는 유지한다. 미조회 핀은 확인 전으로 표시한다.
- 전체 보기는 아이콘 전용이며 공통 지도 인스턴스를 유지한다. 닫기 시 지도 높이를 바꾸지 않고 연결된 마커에 preventScroll 초점을 복귀한다. 사용자·현장·층·맵 generation/크기별 카메라 기억은 30일·사용자당50개·300ms 지연 저장이며 저장소 실패 시 현재 세션 메모리만 사용한다. 브라우저 통합 검증은 진행 중이며 실장비 검증을 뜻하지 않는다.

- 2026-09-24 모니터링 상세의 오프라인·상태 수신 지연 조명은 현재 밝기처럼 표시하지 않고 `최근 확인 밝기`와 현장 시간대 기준 마지막 확인 시각을 함께 표시한다. 최초 상태 수신 전에는 밝기를 `확인 전`으로 표시하며 BIO 센서 설정 밝기를 실제 출력값으로 대체하지 않는다. Health 장애의 원인·권장 조치는 고객 언어로 안내하고 숫자 fault code 등 기술 세부는 모니터링에 표시하지 않는다(2026-09-29 후속 변경). 선택 층의 KPI는 320px 2×2, 390px 1×4를 목표로 압축하고, 공통 검색 필드와 상태별 목록에서 이름/번호 조각 검색·미배치 조명 선택을 지원한다. 미배치는 지도 마커로 만들지 않으며 관리자만 설정 배치 링크를 본다. 기존 층 fixture 페이지를 연속 조회하므로 다음 페이지가 남아 있으면 검색 0건을 최종 결과로 단정하지 않는다. 관련 focused Vitest는 통과했으며 4개 폭 Chromium과 실제 WebView/HIL은 총괄의 별도 직렬 검증을 기다린다.

- 네이티브 CAD는 원본을 보존한 표시용 벡터 batch로 전체 영역을 렌더링한다. 실제 두 도면의 모든 803/875개 tile을 PC·390px에서 확인했고 WebView foreground 정책의 32 MiB 예산에서도 누락 없이 표시했다. Context loss 복귀 시 이전 화면 캐시를 퇴출 가능 상태로 전환하며, 원거리 편집 요소와 저장 revision을 다시 반영한다. 실서버 pipeline 검증과 브라우저 API fixture 검증의 범위는 CAD 검증 보고서에 구분한다.

- 2026-09-19 네이티브 CAD는 viewport 크기 canvas와 카메라 좌표를 공유하고, 이동한 요소는 저장된 원본 타일 locator로 복원한다. 상태/manifest/tile을 strict 검증하며 응답 stream과 renderer의 합산 메모리 예산을 제한한다. 최초 camera 전달, SVG 중복 배경, WebView background/resume 및 revision 재시작 때 폐기된 context 재사용을 보정했다. 오류는 재시도 가능한 안내로 표시한다. 실제 모바일 기기 성능은 별도 검증 대상이다.
- 설정에서 조명을 배치한 직후 runtime DTO가 아직 미배치여도 최신 map snapshot에 조명이 있으면 잘못된 `배치된 조명이 없습니다` 배너를 표시하지 않는다. 모니터링 장비 상태의 10분 갱신 정책은 변경하지 않는다.

- 2026-09-18 읽기 전용 맵 DTO는 `FloorLightSlot` 자체를 노출하지 않고, CAD 배경·저장 도형과 `placed`인 모든 조명 layout을 반환한다. slot 배정 조명은 slot x/y와 fixture size를, 자유 배치·legacy/non-CAD 조명은 fixture 자체 x/y/size를 사용한다. `FloorScene`과 저장 직후 monitoring cache도 같은 합집합·좌표 우선순위를 적용하며 `unplaced` 조명만 지도 marker에서 제외한다. API/Web focused 회귀와 실제 PostgreSQL revision 복구 테스트를 통과했으며 현장 도면 시각 HIL은 포함하지 않는다.
- 2026-09-18 Task 9 Chromium 전체 여정에서 기존 배치 조명을 CAD 적용으로 미배치 전환하고, 두 신규 slot의 fixture/slot ID assignment를 PUT payload 그대로 저장한 뒤 reload 영속성을 확인했다. 모니터링 runtime에는 의도적으로 오래된 미배치 좌표를 주고 revision 3 map snapshot에는 CAD plan과 slot 좌표 fixture 2개를 제공해 snapshot이 authoritative함을 marker pixel 중심으로 검증했으며, rendered asset은 실제 `1200 × 800` 이미지 decode를 확인했다. 브라우저는 deterministic mock API를 사용했고 실제 converter/worker/PostgreSQL/MinIO/API sample pipeline은 clean-build 통합 테스트로 별도 검증했다. 실행 중인 real browser backend lab가 없어 두 경계를 하나의 실제 네트워크 여정으로 연결한 검증은 남아 있다.

- 2026-09-17 공통 `FloorMapViewport`의 pinch는 시작 시 지도 좌표를 현재 두 손가락 중점에 맞춰 확대와 평행 이동을 함께 반영한다. 실제 지도 bounds와 눌림 상태를 사용하는 synthetic Chromium 회귀는 pan/select/area 모두에서 비대칭 pinch, 두 손가락 이동과 한 손가락 해제 후 jump 방지를 확인한다. `FloorScene` coarse marker는 48px hit target의 반지름만큼 가장자리 중심을 보정해 도면 경계에서 터치 영역이 잘리지 않도록 했다. 모니터링의 단일 선택 및 20px 시각 dot 계약은 유지하며 실제 iOS/Android WebView와 Gateway/조명 HIL은 별도 검증이다.

- 2026-09-17 모니터링은 공통 `FloorMapViewport`를 사용하고, 기존 읽기 전용 `FloorScene`에 명시적인 `single` selection adapter를 전달한다. 따라서 marker와 `상세 조명 선택`의 단일 선택·상세 패널 동기화 의미는 바뀌지 않았다. viewport는 wheel 확대, pointer pan과 모든 interaction mode의 두 손가락 pinch를 제공한다. pointer capture로 지도 밖 이동도 추적하지만 marker button은 단일 pointer gesture를 시작하지 않아 native marker click을 보존한다. marker는 시각 20px dot과 별도 44px coarse hit target을 유지한다.

- 2026-09-17 지도 viewport의 fit·pan·Ctrl/Cmd+wheel 배율·zoom control을 재사용 가능한 `FloorMapViewport`로 분리했다. 모니터링은 기존 읽기 전용 `FloorScene`, marker 단일 선택, 범례와 안내를 어댑터로 유지한다. 모바일의 pan/select/area 상호작용은 모두 두 touch pointer의 중점에 고정한 pinch zoom을 제공하며, pinch는 진행 중인 pan/영역 선택을 취소하고 남은 touch가 갑자기 이동하지 않도록 one-pointer gesture로 이어지지 않는다. 확대 지도 overflow는 viewport 내부에만 두고 0.1~4 배율과 층 변경 시 100% 화면 맞춤을 유지한다. `FloorMapViewport`·gesture·모니터링 집중 Vitest 21개와 인접 모니터링/scene 61개, web typecheck를 통과했다. 이는 jsdom의 포인터 회귀 검증이며 실제 모바일 WebView gesture 및 현장 도면 시각 QA는 후속 확인이 필요하다.

- 2026-09-16 Tailwind Task 12에서 공통 primitive와 모니터링 화면의 legacy class/CSS adapter를 제거하고 의미 토큰·utility 및 `data-*` 테스트 계약으로 수렴했다. 정책 baseline은 빈 violation map을 사용하며 1440/1024/390/320px 가로 overflow 계약을 canonical 회귀에 포함한다. Fresh Web **1,224/1,224**, UI policy **53/53**, 전체 Chromium 직렬 **257 passed·5 환경 의존 skip·실패 0**을 통과했다. 자동 Chromium·mock API 기반 소프트웨어 증거이며 실제 iOS/Android WebView, 현장 도면, Raspberry Pi/BlueZ/ESP32-H2 HIL은 실행하지 않았다.

- 2026-09-16 공통 셸·인증 UI 이전에서 모니터링 진입 셸의 내비게이션, 현장 배지, 로딩·복구 상태와 로그아웃을 Tailwind 의미 토큰 및 공통 `Heading`/`Text`/`FeedbackState`/`ConfirmDialog`로 통합했다. 저장하지 않은 맵 편집 내용이 있으면 `window.confirm` 대신 접근 가능한 `alertdialog`에서 취소 시 원래 로그아웃 버튼으로 초점을 복원하고, 승인 후에만 draft와 session을 정리한다. 관련 Vitest 157개와 320/390/1024/1440px Chromium 셸·인증·복구 시나리오 19개로 검증했으며, 이는 mock API 기반 browser 회귀로 Raspberry Pi·Gateway·ESP32-H2·조명 실장비 HIL 완료를 뜻하지 않는다.
- 설정이 소유하는 조명 검색·등록과 맵 편집 화면을 공통 React Aria/Tailwind UI로 이전하면서 기존 등록 상태·payload와 모니터링 캐시 동기화 계약을 유지했다. 이미 등록된 장비는 등록 가능 목록에서 분리하고 새 장비만 선택·제출하며, 저장한 네모·세모·선·텍스트와 조명 위치는 모니터링의 읽기 전용 `FloorScene`에 즉시 반영한다. Konva의 정적 렌더링 색상은 `themeColor` 의미 토큰을 사용하고 저장 좌표·viewport·배율만 runtime geometry 예외로 유지한다. 이 범위는 deterministic Vitest/Chromium 회귀이며 Raspberry Pi·ESP32-H2·LED 실장비 HIL 완료를 뜻하지 않는다.
- 설정의 BIO 등록이 주소 예약 뒤 실패한 경우에도 같은 세션의 node ID·UUID·주소가 모두 일치하면 주소를 다시 쓰지 않는 reconciliation으로 재등록할 수 있다. 완료 terminal이 `Fixture`를 생성한 뒤 기존 모니터링 empty state와 floor fixture query 무효화가 그대로 동작한다. 자동 테스트는 복구 계약만 검증했으며 실패 장치가 실제 모니터링 지도에 나타나는 HIL은 별도 확인이 필요하다.
- 모니터링 화면을 공통 Tailwind 디자인 시스템으로 이전했다. 맵·조명 선택은 공통 `SelectBox`, 새로고침·지도 배율 제어와 공간 조명 마커는 공통 `Button`/`IconButton`, 로딩·오류·빈 상태는 `FeedbackState`, 요약은 `MetricCard`, 상세 상태는 `StatusBadge`, 제목·본문은 `Heading`/`Text`를 사용한다. 저장 도형과 조명 위치는 기존 공통 `FloorScene` 렌더러를 유지하고, 조명 밝기와 빛 번짐은 `fixture-brightness-1..10`·`fixture-marker` 의미 토큰으로 표시한다. 지도 및 마커의 저장 좌표·측정 viewport·줌 배율처럼 실행 중 계산되는 값만 inline geometry 예외로 남긴다.

- BIO direct-USB Gateway의 상태 판정은 transport 연결, protocol 준비, durable mapping 유효성, MQTT 연결, heartbeat freshness가 모두 참일 때만 healthy다. 외부 health 응답에는 adapter 종류와 boolean 상태만 포함하고 USB 경로·descriptor·장치 UUID·raw protocol payload·인증정보는 노출하지 않는다. BIO sensor cloud source는 지원하지 않으므로 빈 목록을 반환하고 configure/send는 명시적으로 실패한다. 전용 배포는 exact-one USB 장치와 숫자 GID를 host/container 양쪽에서 재검증하며 BIO 프로세스에 D-Bus/HCI/BlueZ를 제공하지 않는다.

- P1 Task 1 서버 계약: `GET/PATCH /sites/:siteId/monitoring-policy`는 read/manage capability와 `expectedUpdatedAt`을 적용해 gateway 만료 `30~900`초(기본 90), fixture stale `60~3600`초(기본 1,200)를 저장한다. 변경 충돌은 `409 MONITORING_POLICY_CONFLICT`다. 기존 장비 제어·등록의 90초 안전성 기준은 별도로 유지한다.
- `MonitoringIncident`는 네 유형(`gateway_offline`, `fixture_stale`, `fixture_fault`, `command_failed`)의 발생·확인·담당·해결을 저장한다. Task 2의 30초 freshness sweep은 조건을 자동 수집해 active incident를 생성·갱신하고 조건 회복 시 `automatic_recovery`로 자동 해결한다. 목록 API는 활성 우선 최신순, 현장·필터에 바인딩된 cursor와 최대 100건 limit, 대상·사용자 요약을 제공한다. 관리자는 open 확인, active 담당 지정/해제, 복구 확인 뒤 메모와 수동 해결을 수행한다. 장애 지속은 `409 INCIDENT_STILL_ACTIVE`, 이전 revision은 `409 INCIDENT_CONFLICT`이며 모든 성공 변경은 같은 transaction의 감사 로그로 남긴다.
- 2026-09-13부터 사용자용 모니터링 SidePanel은 탭 없이 선택 조명의 상태·밝기·장비 정보만 표시한다. `인시던트 {활성 건수}`, 인시던트 이력·필터·조치와 `판정 기준` UI를 제거했으며, 모니터링 route는 인시던트·현장 사용자 API를 요청하지 않는다. 서버의 자동 장애 판정, 이력 저장과 관리 API는 내부 운영 기반으로 유지한다.
- P1 Task 5의 cached dashboard/fixture/map 복구 계약은 유지한다. background 부분 실패에도 기존 KPI·도면·선택 층/조명·지도 배율을 보존하고, 더 최신 성공 응답에서 해당 source 경고만 해제한다. 정지한 browser clock의 60,000ms fresh/60,001ms stale 경계와 네 장애 원인의 selector·marker·badge·상세 원인·권장 조치 일관성도 유지한다.
- 수동 해결의 현재 장애 판정은 `Site → Gateway → Fixture → Incident` 순서 잠금 아래 다시 읽는다. Gateway는 heartbeat 변경을 막으면서 상태 수집의 FK 검사를 허용하는 `FOR NO KEY UPDATE`를 사용한다. fixture stale 판단에 영향을 주는 연결 Gateway heartbeat도 해결 commit까지 고정하며, 잠금 대기 중 소유 Gateway가 바뀌면 `409 INCIDENT_TARGET_CHANGED`로 재조회를 요구한다.
- Gateway heartbeat와 조명 상태 수신은 원장과 compact watermark를 같은 transaction에 저장한다. 원장 삭제 후에도 최신 조명 상태의 exact duplicate와 payload 충돌을 구분하고 낮은 sequence로 snapshot/적산이 되돌아가지 않는다. 임시 PostgreSQL 검증이며 실장비 결과는 아니다.
- 플랫폼 Task 4 최종 소프트웨어 검증은 root lint/typecheck/build exit 0, root script 58/58·Shared 203·Automation 28·Mobile 1·Web 64 files 712/712·API 120 suites 1,138 통과/289 환경 의존 제외·Gateway 64 files 608/608(총 2,748 통과/289 제외)다. 전체 Chromium은 194개 중 189 통과/5 opt-in 제외(188개 mock/브라우저 회귀 + 실제 disposable automation journey 1개), main 319.19 kB/gzip 99.21 kB다. Production 계약 18/18, 전체 audit의 MQTT 설정 2/2·Gateway container 24/24·required MQTT 2/2와 새 smoke `led-production-smoke-a9dac54a523c9484dbc4b9eade7b9d5e`의 당시 브랜치 빈 DB 57/57 migrations, TLS/mTLS·CRL·장애 복구·exact cleanup을 통과했다. Dependency 820개 중 기존 승인 예외 High 2/Moderate 1, unexpected 0이며 무취약 판정이 아니다. 운영 배포·사용자 DB·실제 외부 Vault/MQTT/Object Storage·native WebView·HIL·외부 관측 연결은 미검증이다. [운영 runbook](../runbooks/production-api-web-deployment.md)에 절차와 한계를 기록했다. 최종 독립 검토는 Critical/Important/Minor 0, PASS로 승인됐다.

- 플랫폼 Task 3에서 공통 앱 셸 복구를 구현했다. 초기 인증 401은 기존 로그인, 403과 그 밖의 비일시 오류는 권한·재로그인 안내로 분기한다. 브라우저가 부팅부터 offline이면 요청 없이 서비스 복구 화면을 표시하고 online 복귀 시 인증을 재개한다. 네트워크·전송 timeout·5xx는 자동 최대 2회 재시도하고 실패하면 `다시 시도`로 연결을 복구한다. `AppRoot`의 boundary는 App 자체의 hook/render와 Router/lazy shell 실패를 단일 main·alert·포커스 heading으로 표시한다. 인증 실패·재로그인·principal 전환 시 새 QueryClient를 먼저 활성화해 늦은 이전 mutation callback을 폐기된 client에 격리한다. 재로그인은 앱 active-command namespace와 tenant/auth 캐시·초안을 정리하고 최대 5초 logout 종료 뒤 로그인으로 수렴한다. 무관한 저장값과 최초 정상 부팅의 제어 복구 기록은 유지하며 원시 오류/응답/stack은 표시하지 않는다. Task 3 Web 64 files·712/712 unit, 관련 auth/shell Chromium 23/23(신규 복구 10개 포함), typecheck/build와 main `319.19 kB`/gzip `99.21 kB` bundle audit를 통과했다.

- Route 기능 코드 SHA `34261b6`에서 로그인·최초 비밀번호 변경은 초기 main에 유지하고 고객/운영자 shell과 모니터링 화면을 dynamic chunk로 분리했다. 역할 shell 전체 화면과 shell 내부 route는 공통 `RouteLoadingState`의 `role="status"`·`aria-live="polite"` 로딩 상태를 사용한다. 별도 Web route bundle 작업 당시 Task 4 Web 검증은 60 files·686/686 unit, 2,437 modules production build와 main `314.83 kB`/gzip `97.58 kB`(예산 `1,070.00 kB`/`325.00 kB`)를 통과했고, 14개 계획 route chunk와 main의 Konva·Recharts 격리를 audit으로 확인했다. 같은 별도 작업 당시 Task 3 Chromium 64/64는 1440/1024/760/390/320px에서 모니터링을 포함한 대표 route 전환을, disposable RealBackendLab 2/2는 실제 API/DB 기반 고객 여정을 검증했다.
- 공통 고객 셸 상단은 현재 메뉴 제목과 실제 현장명 배지만 표시한다. 기존 층명 기반 `B2 주차장` 표기와 동작 없는 Gateway 정상·오프라인·미등록 상태 배지는 제거하되 설정의 `Gateway 상태` 상세 카드는 유지한다. 로그아웃 위치와 인증·dirty editor 확인 로직은 유지하고, 고객·운영자 셸의 로그아웃은 공통 `IconTooltipButton`으로 아이콘만 표시한다. `로그아웃` 도움말은 hover와 키보드 focus에서 열리고 도움말 위로 포인터를 옮겨도 유지되며 `Escape`로 닫힌다. 모바일 버튼은 52px 실제 터치 영역을 사용한다.
- 현장 일반 유저의 `read`와 `control` capability는 모두 모니터링 메뉴와 해당 현장 dashboard 조회를 허용한다. 신규 일반 유저는 임시 비밀번호로 최초 로그인한 뒤 전용 강제 변경 화면을 완료해야 모니터링으로 진입한다. mock Chromium은 read/control/admin의 주 메뉴 exact 범위와 강제 변경 전 보호 API `403`을 검증한다. 격리 PostgreSQL/API Chromium은 실제 `403 PASSWORD_CHANGE_REQUIRED`, 변경 후 read 메뉴, `/settings/users` 직접 접근 차단, 비활성 세션의 다음 보호 요청 `401`과 재로그인 거절을 검증했다. Gateway나 ESP32-H2를 사용한 검증은 아니다.

- 설정에서 실행하는 테스트 데이터 도구가 `VITE_TEST_DATA_TOOLS_ENABLED=true`일 때만 `POST/DELETE /test-data/sites/:siteId`를 사용해 층별 marker Gateway 1개와 MeshNode/Fixture 200개씩을 생성·삭제한다. 생성은 idempotent하며 `led-control-test-data/v1/`과 `[TEST DATA] Fixture `를 도구 전용 예약 namespace로 사용한다. 삭제는 Gateway·MeshNode·Fixture marker chain이 모두 일치하는 테스트 데이터만 대상으로 하므로 실제 장비 데이터는 보존된다. 예상하지 않은 종속 데이터가 marker 장비 또는 조명에 연결돼 있으면 삭제는 `409`로 전체 거부된다. 의존성 조회 전에 검증된 fixture ID를 정렬 잠금해 동시에 수집된 분석 이력도 보존하며, 생성·재실행은 공통 energy 서비스의 bulk 처리로 누락 identity/current dimension을 보충하고 동일 이력을 중복 생성하지 않는다. 생성 직후 recent online이더라도 실제 heartbeat가 없으면 freshness 정책으로 offline 전환될 수 있다. 이 데이터는 실장비/MQTT 시뮬레이션이 아니며 DB schema/migration 변경도 없다.

- 신규 등록은 지도 공간과 무관하게 미배치로 생성한다. 목록/개수/제어/전력 집계에서는 유지하고 지도 마커만 제외한다. 등록 조명은 있으나 배치가 없을 때 `배치된 조명이 없습니다`와 설정 편집 진입을 제공하며, 등록 0개 안내와 구분한다. 기존 조명 좌표는 migration으로 보존한다. 두 층 실제 API/DB 브라우저 E2E에서 저장 전/후 및 배치 해제 후 마커 분리를 검증했다.

- 실장비 검색 완료 이벤트와 Gateway application ACK를 API의 직접 MQTT publish 성공 여부에 결합하지 않는다. API는 검색 terminal 상태·중복 방지 원장·ACK용 `MqttOutbox`를 같은 DB transaction에 저장한 뒤 broker PUBACK을 반환하고, 별도 outbox worker가 연결 복구 후 ACK를 재전송한다. 따라서 ACK 전송 중 일시적인 MQTT 연결 종료가 persistent session을 막아 이후 provisioning 명령까지 `Connection closed`로 실패시키지 않는다. 같은 terminal event 재전달은 기존 ACK outbox를 재활성화하며 payload identity 충돌은 fail-closed 한다.
- 2026-09-03 Raspberry Pi/ESP32-H2 HIL에서 자사 UUID 한 건 검색, `0x0100` provisioning, `B2-L002` Fixture 생성, B2층 `0xC000` Mesh group subscription version 2 적용과 application ACK 발행을 확인했다. 등록 완료 직후 첫 `fixture-state` publication 전에는 `offline`을 `상태 확인 대기`로 표현하는 기존 계약을 유지한다.
- BIO 장치는 표준 BLE Mesh 장치와 달리 등록 뒤 자발적인 `fixture-state`를 발행하지 않는다. Gateway는 confirmed UUID/native UUID/address mapping만 10분마다 한 번 scan한 뒤 high-brightness GET과 control-mode GET을 직렬로 수행하고, 둘 다 같은 장치로 검증된 경우에만 `fixture-presence`를 발행한다. 이 polling은 GET만 사용하며 주소·밝기·모드를 바꾸지 않는다. read-only capability 확인 뒤에는 `BioDongleClient` 원본 객체를 그대로 호출해 `this`에 결속된 scan cache와 USB operation queue를 보존한다. 메서드 참조를 임시 객체에 복사해 실제 GET 전에 TypeError가 나던 receiver 분리 회귀는 전용 테스트로 차단한다. API는 presence 수신 시각을 freshness 근거로 쓰되 실제 `fixture-state`와 분리해 저장한다. 센서 모드의 실제 밝기와 전원 여부는 여전히 알 수 없으므로 설정값을 순간 출력으로 표시하지 않으며, `brightness=0`, `powerOn=null`은 첫 수동 제어 read-back 전 실제 소등을 뜻하지 않는다. 일반 BLE Mesh의 `provisioning_waiting_state` 계약은 변경하지 않는다.
- BIO의 첫 수동 제어는 polling에서 읽은 sensor용 high-brightness 설정을 현재 출력으로 재사용하지 않는다. Gateway가 실제 SET과 두 GET read-back을 검증한 뒤에만 force mode의 밝기·전원 상태를 자동화 기준과 `fixture-state`로 저장하므로, 등록 직후 모니터링 값이 비어 있어도 제어는 시작할 수 있고 실패한 명령이 가짜 현재 밝기를 만들지 않는다.
- 2026-09-02 무장비 회귀 점검에서 등록 API도 Web과 동일하게 `scanStatus=completed`, non-null correlation ID와 attempt의 exact match를 강제한다. 따라서 이전 검색 시도나 identity가 없는 legacy 발견 행을 요청에 직접 넣어도 provisioning 대상으로 수락하지 않는다.
- 조명 목록의 최초 로딩·층 전환 로딩·최초 오류를 빈 조명 0개 상태와 분리한다. 기존 데이터가 있는 갱신 실패는 지도와 KPI를 유지하면서 오류 및 재시도를 표시하고, 지도 snapshot 로딩도 `등록된 층 없음`과 구분한다. 상단의 운영 현황 제목과 자동 갱신 설명은 제거하고 `맵 선택` 문구 옆 SelectBox와 우측 끝 수동 새로고침을 제공한다.
- P1 Task 3 Web은 dashboard, 선택 층 fixture page, map snapshot을 10분 polling·10분 staleTime·focus refetch·2회 retry로 조회한다. map snapshot이 수동 또는 background 갱신에서 최종 실패하면 해당 query만 30초 뒤 자동 복구를 시도하고, 성공하면 정상 10분 주기로 복귀한다. dashboard와 fixture page의 polling 주기는 이 복구 정책의 영향을 받지 않는다. cached dashboard/fixture/map의 background 실패는 현재 지도·층/조명 선택을 지우지 않고 persistent stale banner와 재시도로 표시한다. 지도 실패 표시는 실패 당시 같은 층의 `dataUpdatedAt`을 기준선으로 저장해 cached observer 상태 변화에는 유지하고, 더 최신 성공 응답에서 지도 경고와 지도 source의 toolbar 오류만 자동 해제한다. 다른 층의 실패 상태는 현재 층 경고에 섞지 않는다. 현장에 층이 없으면 floor fixture/map query는 비활성 상태이므로 해당 loading/error/stale 안내를 만들지 않는다. 선택 층의 모든 fixture page `generatedAt` 중 가장 오래된 유효 시각이 60초를 초과하면 stale이며, 경계 60초는 정상이다. `마지막 갱신`은 React Query 수신 시각이 아니라 해당 서버 시각을 현장 시간대로 표시하고 원본 ISO를 `time.dateTime`에 보존한다. 미래/잘못된 snapshot은 기존 `시간 차이 확인` 또는 안전 경고로 표시한다. `provisioning_waiting_state`, gateway offline, fixture stale, command failed, Health fault/fault, online, generic offline은 공통 presenter를 통해 selector, marker 접근성 이름, badge, 상세 원인·권장 조치에서 같은 문구를 사용한다.
- Dashboard 요약은 저장된 fixture status뿐 아니라 최신 Health Current fault를 합성한 최종 상태로 정상·장애 수를 계산한다. `includeFixtures=false` 요약도 같은 규칙을 사용하며, 주기적 freshness DB 갱신 실패는 정제된 오류 코드만 기록하고 다음 주기를 계속 실행한다.
- 조명 등록 진행 표시는 session·scan·node 상태를 하나의 순서 상태 머신으로 파생한다. active workflow는 오류가 없는 동안 정확히 한 단계만 `aria-current="step"`이고, 선행 단계는 완료, scan/장비 등록 실패는 실제 발생 단계의 오류로 표현한다. `completed`는 전체 완료, `cancelled`는 도달 단계 이후를 pending으로 유지해 current가 없고, session-level `failed`는 도달한 실제 단계가 error가 되어 terminal session을 진행 중으로 오인하지 않는다. 서버의 `errorMessage`, 개별 등록 검증 오류와 `scanFailureMessage`는 API 값 자체를 바꾸지 않고 공통 표시 경계에서 `Gateway ACK timeout` 같은 transport 원문을 `게이트웨이 장비 응답 시간 초과`처럼 한국어로 바꾼다.
- 390px·320px commissioning 회귀는 버튼뿐 아니라 setup/Gateway claim/조명 등록의 enabled input·select·checkbox/radio associated label을 실제 clipping·occlusion을 고려한 연속 44×44px reachable area로 검증한다. 등록 직후 기본 일괄 form의 다섯 input을 먼저 검사하고, 개별 설정으로 전환한 뒤 개별 input을 다시 검사한다. 등록 form input과 select는 최소 44px이고, 18px checkbox/radio 시각 크기는 유지하되 label hit 영역을 44px 이상 제공한다.
- 1440×900, 1024×768, 390×844, 320×740 Chromium route fixture에서 지도·상세 패널 배치와 document-level horizontal overflow를 검증한다. `맵 선택` 문구와 SelectBox의 수평 정렬, 새로고침 버튼의 우측 끝 정렬, 지도 오버레이 순서와 compact marker 상태 배지 위치도 같은 네 viewport에서 실제 픽셀로 검증한다. 1440×900 데스크톱은 문서 세로 스크롤 없이 뷰포트 안에 운영 화면을 고정하고, 상세 내용만 패널 안에서 세로 스크롤되는 계약을 추가로 검증한다. `2400×600`, `600×2400`처럼 가로·세로 비율이 극단적인 도면도 지도 영역의 가로·세로 경계 안에서 원본 비율을 유지한다. 760px 이하의 공통 helper는 root 아래 interactive element 중 disabled/hidden, `.sr-only`/`aria-hidden`, `display`/`visibility`/`opacity`로 숨긴 조상을 제외하고 현재 viewport 및 실제 overflow clip과 교차하는 effective target을 검사한다. usable intersection을 1 CSS px 이하 cell로 나누고 각 cell 중앙 hit sample이 target 또는 그 descendant인 연속 44×44px 후보가 하나 이상일 때만 통과하며, 부분·완전 occlusion은 정상 peer가 있어도 실패한다. checkbox/radio는 모든 associated label과 input fallback 중 이 조건을 만족하는 후보를 사용한다. viewport-fixed target은 transform/filter/perspective 등 fixed containing block을 만드는 조상이 있을 때만 ancestor overflow clip을 적용한다. 이 계약으로 새로고침, 맵·현장·등록 대상 select, 등록 방식 radio label, 로그아웃과 주 메뉴를 검증한다. 특히 390px와 320px에서 enabled `조명 검색 시작`·검색 실패 재시도의 actual bounding box가 44px 이상인지, 390px에서 pending setup·Gateway claim·조명 등록·reconciliation의 enabled primary/secondary action이 44px 이상인지를 route fixture로 고정한다. 밀집 도면 marker는 선택·hover·focus에서도 20px, 모서리 3px 네모 시각 크기를 유지해 hit overlap을 최소화하며 helper에서 명시적으로 제외한다. 대신 모든 조명을 노출하는 `상세 조명 선택` select가 44px 대체 선택 경로를 제공하고 marker/selector/상세 상태를 같은 selection state로 동기화한다. 이 검증은 deterministic API fixture 기반이며 실제 Raspberry Pi/ESP32-H2 HIL 증거는 아니다.
- 운영 화면 상단은 현장 집계의 읽기 전용 `MetricCard`와 선택 층의 필터용 `MetricButton`으로 `전체 조명`, `정상`, `점검 필요`, `오프라인`을 구분해 표시한다. 오프라인은 등록 직후 첫 상태를 기다리는 `provisioning_waiting_state`를 포함하며 점검 필요 오른쪽에 배치한다. 평균 밝기와 별도 빠른 상태 영역은 제거해 지도 높이를 확보했다. 각 KPI strip의 네 viewport 가로 overflow를 자동 검증한다.
- KPI 다음에는 `층 도면`, `선택 조명 상세` 순서를 유지한다. 데스크톱 지도는 남은 뷰포트 높이를 모두 사용하고 현재 viewport에 맞춘 100%를 기준으로 10% 단위 확대·축소를 제공한다. 모니터링 전용 일반 휠과 `Ctrl`/`Cmd`+휠은 브라우저 기본 동작을 취소하는 non-passive listener로 포인터 중심 zoom만 수행하며, 휠 패닝은 제공하지 않는다. 빈 지도 드래그·키보드 방향키로 이동하고 100% 버튼으로 중앙 복원한다. marker 선택은 그대로 유지한다. 확대된 원본 비율 지도는 전용 viewport 안에서만 overflow되고 모바일 zoom control은 48px touch target을 제공한다.
- 선택 조명 상세는 도면보다 좁은 고정 범위 패널에 배치하고 현재 밝기와 장비 사실만 표시하며 별도 점검 큐는 제공하지 않는다. 패널과 하위 grid item은 축소 가능한 너비를 사용하고 긴 장비·게이트웨이 이름을 패널 안에서 줄바꿈해 document-level 가로 스크롤을 만들지 않는다. 정상·장애·오프라인·첫 상태 확인 대기는 선택 상세의 `StatusBadge`와 지도 범례에서 icon + visible text로 구분한다. 모든 marker는 모서리 3px의 20px 네모로 표시하고 내부에 이름·밝기 문자와 bar를 렌더링하지 않으며, 정확한 정보는 기존 `title`/`aria-label`과 우측 상세 패널에 유지한다. online marker는 `0~9`, `10~19`, …, `80~89`, `90~100`% 밝기를 10단계로 분류하고 범위 밖은 clamp한다. 각 단계는 brown/orange 없이 cool slate/gray에서 neutral light, lemon/bright ivory로 이어지는 정적 fill·glow를 사용하며 단계가 높아질수록 실제 렌더링 밝기와 glow가 증가한다. fault는 red/double 테두리를 제거하고 같은 밝기 단계의 일반 border/fill/glow와 우상단 red 8px 배지만 사용한다. offline과 `provisioning_waiting_state`는 저장 밝기와 무관하게 무발광 dashed/dotted 상태 스타일을 유지한다. 도면 좌측 상단의 층/`실시간 조명 배치` 라벨은 제거하고, 상태 범례는 지도와 함께 스크롤되지 않는 비상호작용 overlay로 이동 안내 바로 위에 고정해 아래 marker·drag·wheel 입력을 가로채지 않는다. 모바일에서는 기존 공간 절약 정책에 따라 이동 안내를 숨기고 범례만 유지하되 줌 컨트롤과 겹치지 않도록 상단 간격을 확보한다. marker별 상태 문구나 SVG를 1,000개까지 반복 렌더링하지 않으며 기존 한국어 접근성 이름과 선택 상태는 유지한다.
- 모니터링은 등록 조명 유무와 무관하게 Gateway claim, 조명 등록 패널·버튼·dialog 및 인시던트 이력·조치·판정 기준 UI를 렌더링하지 않는다. 등록 0개인 admin에게는 설정의 admin 전용 `/settings/registration` 이동 경로를 제공하고 viewer에게는 관리자가 설정에서 등록해야 한다고 안내한다. Gateway claim, active registration session 복구와 조명 등록 workflow는 설정 메뉴만 소유한다.
- Task 8에서 pending assigned admin이 `/monitoring`, `/control`, `/statistics`, 설정 하위 직접 URL로 들어오면 CustomerShell이 조회한 dashboard의 selected/default `siteId`를 유지해 `/settings?siteId=...`로 replace한다. `/settings`에서는 배정된 고객사·현장명을 읽기 전용으로 표시하고 주소·단가·층만 입력하는 최초 설치 화면을 제공한다.
- CustomerShell은 admin dashboard의 `installationStatus`가 확인되기 전에는 customer child route를 mount하지 않는다. 확인 중에는 설치 상태 loading UI를, 최초 조회 실패에는 retry UI를 표시하며 성공 setup 응답은 actual site key와 `['dashboard', 'default']` cache에 함께 반영해 실패한 background refetch가 있어도 installed guard 상태를 유지한다.
- 설치 완료 후 등록 조명이 0개인 모니터링은 admin에게 설정의 조명 등록 페이지 링크만 제공한다. viewer는 읽기 전용 안내만 보며 claim, 등록, setup mutation UI를 볼 수 없다. operator는 customer shell을 mount하지 않는다.
- `GET /sites`는 assigned active customer `admin`의 정확히 한 현장과 유효한 `SiteMembership`을 가진 customer `viewer` 현장만 반환한다. service-provider `operator`의 고객 현장 목록은 빈 배열이다.
- `GET /sites/default/dashboard`는 접근 가능한 첫 현장을 반환하고, 접근 가능한 현장이 없을 때도 빈 dashboard shape를 유지한다.
- `GET /sites/:siteId/dashboard`, 층별 fixture 조회와 기본 에너지 추정은 `AuthenticatedUser + SiteAccessService`로 현장 read 권한을 확인한다. 다른 admin 현장, 미배정 viewer와 operator 고객 현장은 `404`로 숨긴다.
- dashboard `site`는 `customerName`, nullable `address`/`tariffKwhRate`, `timeZone`, 그리고 주소·단가·층 존재 여부에서 계산한 `pending|installed` 설치 상태를 함께 반환한다.
- assigned admin은 pending Site의 최초 주소·단가·시간대·층을 API로 완료할 수 있으며, 설치가 끝난 뒤 자기 현장의 Gateway claim과 조명 검색·등록 commissioning API를 호출할 수 있다. `POST /gateways/claim`은 정규화한 serial별 transaction advisory lock 아래 Site row 재검증, rolling failure count, terminal audit와 inventory claim을 한 decision boundary에서 처리한다. 병렬 invalid 요청은 최대 5회의 claim-code 검증만 수행하고 invalid·unavailable·already-consumed·rate-limited·success를 모두 commit한 뒤 정제된 응답을 반환하며, 다른 serial은 전역 잠금을 공유하지 않는다.
- registration session 생성은 body `siteId`, 조회·재검색·identify·개별/일괄 등록·완료는 저장된 session `siteId`의 `commission` capability를 검사한다. mutation은 Site 권한을 transaction 안에서 다시 확인하고 등록 domain의 `Floor -> Gateway -> Session -> Node -> Outbox` 잠금 순서를 지켜 재배정·비활성화된 stale admin과 식별/등록 lifecycle 경합을 차단한다. 조회는 read-only 권한 검사와 일관된 polling snapshot을 사용한다. 기존 durable scan outbox, allocator와 provisioning 상태 전이는 그대로 유지한다.
- `GET /registration-sessions/active?siteId=...`는 현장 commission 권한을 검사하고 active 세션을 최신순으로 반환한다. 웹은 페이지 재진입과 새로고침 시 가장 최근 세션의 층, 게이트웨이, 검색 attempt와 발견 노드를 자동 복구하며 여러 세션이 있으면 사용자가 전환할 수 있다. active 조회가 끝나거나 실패 복구되기 전에는 새 검색을 시작하지 않는다.
- 조명 수와 관계없이 모니터링 화면에는 `조명 등록` 버튼이나 등록 dialog를 제공하지 않는다. 진행 중 session의 복구·완료·취소와 추가 검색은 설정의 `/settings/registration`에서만 수행한다.
- 로컬 실행에는 검색 결과 생성기가 없으며 Raspberry Pi/ESP32-H2가 꺼져 있으면 검색 결과 0개를 유지한다.
- ESP32-H2 unprovisioned UUID는 `DFKLED`, format version, 제품군, 모델, 하드웨어 revision과 6바이트 장치 식별자로 구성한다. Raspberry Pi Gateway는 shared parser로 현재 format의 자사 UUID만 scan 결과에 포함하고 타사 장치는 구조화 로그만 남긴다.
- 등록용 자동 이름 순번은 층별 `Floor.nextFixtureSequence`, Mesh unicast 주소는 게이트웨이별 `Gateway.nextMeshUnicastAddress`에서 소유 행 잠금 후 연속 범위로 원자 예약한다. 삭제되거나 건너뛴 값은 재사용하지 않으며 Mesh 주소는 `0x0001~0x7fff`만 허용한다.
- `POST /registration-sessions/:sessionId/nodes/register-batch`는 일괄·개별 설정을 하나의 요청으로 받고, session/node 행 잠금과 Task 5 allocator를 같은 transaction에서 사용한다. 유효한 node는 `accepted`, 존재하지 않거나 이미 처리 중인 node는 `validation_failed`로 분리해 성공한 등록을 유지한다.
- 일괄 이름은 서버가 prefix, 시작 번호, 자릿수와 예약 순번으로 생성한다. 자동 좌표는 도면 크기 또는 `1200x800` 기본 canvas 안의 기존 fixture와 겹치지 않는 행 우선 grid cell을 사용하며 이름·전력·좌표·marker 크기를 provisioning 전에 저장한다.
- 조명 등록 패널은 검색된 등록 가능 node의 개별/전체 checkbox 선택과 `일괄 설정`·`개별 설정` 전환을 지원한다. 일괄 설정은 선택 층 이름을 기본 prefix로 사용하고, 개별 설정은 이름·정격 전력·marker 크기를 입력한다. 등록 단계의 좌표 입력은 제거했으며, 위치는 등록 후 설정의 해당 층 에디터에서 배치한다.
- 일괄·개별 등록 요청에서 서버가 수락한 node만 선택 해제하고, `validation_failed`는 오류와 선택을 유지한다. 물리 provisioning 중인 node는 재등록할 수 없으며 이후 `failed` 또는 `reconcile_required`로 확인되면 검토 대상으로 다시 선택해 node 행에 원인을 표시한다.
- API는 선택 node의 `provisioning` 상태, Mesh 주소, pending Fixture 정보와 strict v2 `provision-device` outbox를 한 transaction에 저장한다. HTTP `accepted`는 MQTT 연결과 무관하게 이 durable 기록이 commit됐음을 뜻한다. worker는 `SKIP LOCKED` lease, 10초 publish timeout, 최대 10회/15분 bounded backoff로 QoS 1 발행하고 PUBACK 뒤 `publishedAt`을 기록한다. 한계 초과는 주소와 pending 정보를 보존한 채 node를 `reconcile_required`로 전환한다. Gateway는 command를 RF 전에 `0600` atomic journal에 저장하고 exact duplicate를 FIFO에 다시 넣지 않으며, terminal도 atomic 저장 뒤 exact application ACK 전까지 재발행한다. accepted-only restart는 RF를 반복하지 않고 적용 여부 확인 불가 terminal로 수렴한다.
- `reconcile_required` 노드는 `상태 다시 확인`으로 늦게 도착한 provisioning 완료를 먼저 조회한다. 여전히 불확실하면 관리자가 장비가 미등록 또는 초기화 상태임을 확인한 뒤 `POST /registration-sessions/:sessionId/nodes/:nodeId/exclude`로 현재 세션에서만 제외할 수 있다. 이 동작은 Mesh 주소와 pending 정보를 감사 증거로 보존하며 재프로비저닝 명령을 발행하지 않는다.
- 이전 scan attempt에 남은 `provisioning/reconcile_required`도 현재 후보와 함께 복구 화면에 표시해 숨은 상태로 세션을 차단하지 않는다. 상태 재조회가 실패하면 오류를 표시하고 제외 동작을 잠근다. 여러 active 세션 중 하나를 종료하면 다음 세션을 즉시 복구한다.
- provisioning 완료 MQTT 처리는 `Session -> Node` 행 잠금 뒤 active session과 `provisioning/reconcile_required` 상태를 재검증한다. 제외·취소가 먼저 commit되면 늦은 완료 이벤트는 fixture를 만들지 않고, MQTT 완료가 먼저 commit되면 뒤따른 제외·취소가 상태 재검증에서 거부되어 명시적 운영 결정과 장비 이벤트가 경합해도 상태가 뒤집히지 않는다.
- 등록 검색은 세션별 `pending/scanning/completed/failed` lifecycle, correlation ID와 attempt를 사용한다. 신규 검색과 retry는 `pending` session과 scan-start durable outbox를 같은 transaction에서 만들며 publisher가 lease 아래 `pending -> scanning` 전이 후 발행한다. 0건은 `completed`이며, 완료/실패/발견 이벤트는 session 행 잠금과 `ProcessedGatewayEvent` 원장 transaction 안에서 site, gateway, correlation, attempt, eventId, sequence가 현재 scan과 모두 일치할 때만 반영한다. 검증된 발견 이벤트의 correlation ID와 attempt는 `DiscoveredMeshNode` create/update 양쪽에 저장한다. 이전 시도에서 제외되어 `failed`가 된 동일 장치를 다음 attempt에서 실제로 재발견하면 상태를 `discovered`로 복원하고 최신 scan identity와 측정값으로 덮어쓴다. 늦은 발견, 중복·낮은 sequence, 이전 시도 이벤트는 무시한다.
- Gateway는 shared DFKLED UUID parser를 통과한 장치만 `scan-found` v2 topic으로 발행한다. `(sessionId, scanCorrelationId, scanAttempt)`별 0600 atomic journal은 running duplicate가 scanner를 다시 시작하지 않게 하고, terminal은 원래 eventId/sequence를 가진 동일 event로 재발행한다. restart에서 남은 running record는 새 scan 대신 정제된 failed terminal로 수렴하며, 손상·권한 오류 journal은 fail-closed 한다. application ACK를 받지 못한 terminal과 running은 retention·capacity eviction에서 제외하고, 이 보호 record 때문에 1,000개 한도를 채우면 새 scan을 fail-closed 한다. ACK를 받은 delivered terminal만 24시간 보존한다.
- `POST /registration-sessions/:sessionId/scan/retry`는 terminal scan이며 `provisioning` 또는 `reconcile_required` 노드가 없을 때만 재시작한다. gateway별 `status=active`인 `pending/scanning` partial unique 제약으로 같은 gateway의 동시 검색을 막고, 신규·retry 충돌 모두 `gateway_scan_in_progress`를 반환한다. publisher MQTT timeout은 기본 10초로 30초 lease보다 짧으며 process crash는 lease 만료 뒤 같은 attempt를 재시도한다. timeout/reject는 backoff를 증가시키고 최대 3회 또는 5분 실패는 사용자용 고정 메시지와 함께 `failed`로 복구한다.
- API provisioning scan/device command outbox worker는 initial·interval batch의 transient DB 실패를 scheduler 경계에서 격리하고 worker별 single-flight로 실행한다. Mesh group sync도 single-flight로 실행하며 종료가 시작되면 다음 record/group publish를 시작하지 않는다. `MqttShutdownCoordinator`가 command, scan, provisioning device, automation outbox worker와 `MeshGroupSyncWorker`를 멱등 drain하고, inbound MQTT listener를 분리한 뒤 진행 중 handler와 ACK publish를 모두 기다린 다음에만 `MqttService.close()`를 호출한다. Mesh subscription sync, provisioning terminal ACK와 mesh resync ACK는 PUBACK 무응답 시 10초에 packet ID를 취소해 active drain을 끝내며 timeout rejection은 payload·topic·오류 상세를 노출하지 않는 최상위 오류 경계에서 격리한다. MQTT close는 graceful `end` callback을 await하고 5초 timeout에 force close callback을 추가 1초간 기다려 영구 hang 없이 Nest module 종료를 마친다.
- scanning 또는 pending scan, 진행 중 `identifying`, 미해결 `provisioning/reconcile_required`, 등록 성공 조명 0개는 registration session 완료를 거부한다. 성공 조명이 없고 미해결 노드도 없는 terminal session은 `POST /registration-sessions/:sessionId/cancel`로 `cancelled` 종료한다. provisioning 전 BIO identify는 commission 권한·활성 session·Gateway와 현재 scan 후보를 transaction에서 다시 확인한 뒤 durable outbox로 접수하며, 표준 BlueZ adapter는 미지원 terminal을 반환한다.
- 웹 등록 패널은 `completed` 0건에서 검색 결과 없음과 `다시 검색`을, `failed`에서 API가 제공한 정제된 실패 메시지와 `다시 검색`을 표시한다. 발견 BIO 조명의 `식별`은 고정 force-on 뒤 sensor mode 복원을 확인하는 비동기 동작이며 주소/Fixture/mapping 생성과 분리된다. 소프트웨어 경합 회귀를 검증했으며 실제 BIO HIL 재검증은 후속이다.
- 등록 세션 polling은 `pending/scanning` 또는 identifying/provisioning node가 있을 때 1.5초 간격으로 수행한다. 식별 mutation의 operation ID와 서버 node의 `identifyOperationId`/`identifyOperationStartedAt`/`updatedAt`를 보존·대조하여 이전 요청 terminal이 새 retry의 polling을 끝내지 못하게 한다. timeout 뒤 등록이 진행된 이전 식별 terminal은 ledger/ACK만 기록하고 등록 상태는 변경하지 않는다. terminal scan과 `reconcile_required`에서는 진행 operation이 없으면 자동 polling을 중지하고 사용자가 상태를 다시 확인한다. 다시 검색 요청을 시작하는 즉시 이전 후보, 선택, 제출 상태와 개별 초안을 비우고 POST 응답은 relation이 없는 상태 전이 응답으로 취급한 뒤 canonical session GET으로 수렴한다.
- 등록 후보는 현재 scan이 `completed`이고 node의 `scanCorrelationId`와 `scanAttempt`가 session의 현재 identity와 모두 exact match일 때만 노출하고 등록할 수 있다. 서로 다른 API/Gateway wall-clock의 `scanStartedAt`과 `discoveredAt`은 attempt 판정에 사용하지 않으며, identity가 `null`인 legacy row와 이전 attempt relation은 fail-closed로 숨긴다.
- provisioning 완료를 session polling으로 관측하면 현재 층 `floor-fixtures`, `floor-map`과 해당 `registration-session`을 갱신해 등록 화면을 유지한다. 사용자가 `등록 세션 완료`를 누른 뒤 현 화면 `dashboard`와 기본/현장별 dashboard cache를 갱신해 운영 화면으로 전환한다. 새 fixture는 첫 실제 상태 전까지 기존 API 계약대로 `상태 확인 대기`로 표시한다.
- 등록 batch transaction은 실제 provisioning publish 전에 해당 층의 `MeshControlGroup`을 선확보해 group address 소진이나 gateway/site 불일치를 미리 실패시킨다.
- 조명 등록 패널은 gateway scan/provisioning MQTT 흐름과 연결되어, 등록 완료 이벤트 후 dashboard polling으로 새 fixture를 표시할 수 있다. 이 시점의 fixture는 `offline + provisioning_waiting_state`이며 실제 offline과 구분해 `상태 확인 대기`로 표시한다.
- provisioning 완료 transaction은 생성 또는 재사용한 `MeshNode`/`Fixture`를 같은 transaction 안에서 floor control group과 기존 `FixtureGroup` membership의 control group member에 연결한다. 이때 fixture group 대상은 요청 payload가 아니라 DB의 `GroupFixture` 관계를 권위 데이터로 조회한다.
- 이미 다른 층에 매핑된 기존 fixture가 같은 device UUID로 다시 발견되면 자동 이동하지 않고 provisioning 완료를 `failed`로 종료해 현장 매핑 충돌을 드러낸다.
- 상단 `맵 선택` SelectBox로 지하/지상 층을 전환하며 문구와 SelectBox를 한 줄에 배치한다.
- 층별 2D 맵에 도면 이미지와 조명 위치를 표시한다.
- 조명 점은 선택/hover/focus에서도 시각 크기가 변하지 않는 20px 원형이며 실제 monitoring hit는 48×48px이다. 상태 테두리·비색상 아이콘과 별도 선택/초점 outline으로 상태와 선택을 구분한다. online은 기존 10개 밝기 단계별 정적 fill/glow와 실제 computed 스타일의 단조 증가·같은 단계 동일함을 유지한다.
- 조명 점의 접근성 라벨과 tooltip은 한국어 상태명(정상/오프라인/장애)을 사용하고, `provisioning_waiting_state`는 `상태 확인 대기`로 별도 표시한다.
- 선택 조명 상세 패널은 확인된 밝기·마지막 확인·고객용 상태 설명·권장 조치·배치 여부만 표시한다. 좌표·정격 전력·게이트웨이·RSSI·hop count·명령 성공률·숫자 Health 코드 등 기술 정보는 제거했다.
- 선택 층 기준 전체 조명 수, 온라인 수, 점검 필요 수와 상태 확인 대기를 포함한 오프라인 수를 상단 KPI로 표시한다.
- 지도 마커 또는 모바일 `상세 조명 선택` SelectBox로 개별 조명을 선택하며 두 입력과 상세 패널의 선택 상태를 동기화한다. 읽기 전용 Konva object 입력 상태는 HTML marker 버튼까지 비활성화하지 않도록 DOM 속성을 분리한다.
- 층 탭은 좁은 화면에서 가로 스크롤되고, 모바일 하단 내비게이션 CSS는 `env(safe-area-inset-bottom)` 여백 계약을 적용한다. 현재 Chromium route fixture는 non-zero safe-area inset을 에뮬레이션하지 않으므로 실제 WebView inset 실측을 주장하지 않는다.
- MQTT `fixture-state` 이벤트는 API가 packet 수신을 시작한 `receivedAt`을 한 번 고정하고, 장비 `occurredAt`이 그 시각보다 기본 5분(`300,000ms`, 정확한 경계 포함)을 넘게 미래가 아닐 때만 fixture 최신 상태 snapshot을 갱신한다. 수락 시 `lastSeenAt`은 서버 수신 시각, `lastStateOccurredAt`은 장비 발생 시각으로 분리 저장한다. 장비 발생 시각은 energy 순서·cursor/checkpoint에 쓰고, 모니터링 freshness에는 쓰지 않는다.
- provisioning 완료 MQTT event는 밝기, online/fault, lastSeenAt을 추정하지 않는다. 첫 실제 `fixture-state` event가 들어올 때만 이 snapshot을 확정한다.
- MQTT `gateway-heartbeat` 이벤트도 같은 5분 미래 경계를 통과한 경우에만 gateway online/offline 상태 판단에 반영한다. `lastHeartbeatAt`은 서버 수신 시각, `lastHeartbeatOccurredAt`은 장비 발생 시각이다.
- dashboard metadata와 선택 층 fixture snapshot은 React Query로 10분마다 polling한다. 브라우저 focus만으로 다시 조회하지 않는다.
- 모니터링 상단 우측 끝의 `새로고침`은 선택한 활성 맵의 등록 조명을 실제 Gateway 읽기 경로로 확인한다. read 권한 사용자(admin/viewer)가 `POST /sites/:siteId/floors/:floorId/monitoring-refreshes`에 UUID `clientRequestId`만 보내며, 서버가 대상과 Gateway를 snapshot한다. 최대 1,000개·Gateway batch 64개, 동일 요청/active 층 요청 재사용, 완료 후 30초 cooldown과 30초 deadline을 적용한다. 등록 조명 0개는 HTTP 데이터만 다시 조회한다.
- 처리 중 버튼은 `장치 상태 확인 중`으로 바뀌고 비활성화된다. GET 상태를 500ms 간격으로 조회하고 terminal/오류 뒤 dashboard·선택 층 fixture 전체 페이지·map을 다시 읽는다. 첫 pass 실패만 250ms 뒤 한 번 재조회하며 두 번의 검증된 `not_found/read_timeout/read_failed`만 즉시 오프라인으로 반영한다. Gateway/MQTT 전체 실패와 deadline 미확인 결과는 개별 offline으로 만들지 않는다. 자동 10분 조회·기본 20분 stale 안전망은 유지한다.
- 수동 확인은 BIO brightness GET→mode GET 또는 BlueZ 읽기 경로만 사용하고 기존 transport queue로 직렬화한다. 밝기·전원·sensor mode·주소·group membership·에너지 checkpoint를 변경하지 않는다. BIO sensor의 설정 밝기를 실제 출력으로 추정하지 않는다. 성공 presence와 두 번 실패 terminal, batch 완료는 durable journal/outbox와 application ACK로 수렴한다.
- BlueZ `Node1.Send`의 D-Bus `TIMEOUT/ETIMEDOUT`은 Gateway 전송 실패로 처리해 개별 조명을 오프라인으로 만들지 않는다. 두 GET 전송 성공 뒤 실제 응답 대기 시간 초과만 `read_timeout`으로 재확인한다.
- batch 완료는 모든 조명 결과의 API application ACK를 Gateway 저널에 먼저 영속화한 뒤 발행한다. 선행 완료 패킷은 API가 MQTT PUBACK만 보내 다음 결과를 받을 수 있게 하고 완료 application ACK는 보류한다. Gateway v3 저널은 command 수락 시 고정 폭 handoff/결과 ACK 진행 공간을 예약해 파일 상한에서도 ACK 저장 크기가 늘지 않으며, 완료 ACK는 축소 저장한다. 저장 실패 시 outbox 삭제를 하지 않는다. v1/v2는 atomic 변환하며 v1의 미완료 ACK 기록은 같은 event ID로 재전송하고 v2 결과 ACK는 보존한다. 순서가 바뀐 새 batch는 수락하고 같은 sequence/identity의 다른 payload는 거부한다. 만료 전에는 중복 기록을 보존하며, 만료 후 완료 ACK를 받은 기록과 결과 없는 실패 기록은 atomic 정리한다. 미ACK 결과는 10,000건·32 MiB 상한 안에서 계속 보존한다. 재발행 drain은 배치별 index로 진행을 조회하고 16배치마다 이벤트 루프에 양보하여 전체 결과 반복 복제로 MQTT ACK 처리가 막히지 않게 한다.
- terminal 요청의 7일 보존기간 후에는 API가 요청과 batch 모두 없음을 DB에서 확인한 correlated 결과에만 폐기 ACK를 반환한다. state/presence/unreachable은 기존 `state-ingested`의 `duplicate`, 완료는 전용 ACK를 사용하며 조명·밝기·전력·freshness·tenant 데이터는 쓰지 않는다. 한쪽 기록이 남아 있거나 소유 관계/identity가 다르면 거부하고 DB 오류에는 ACK하지 않는다. Gateway가 새 정상 상태를 계속 전송할 수 있게 하는 폐기 계약이며, 삭제된 요청이 과거에 유효했다는 인증은 아니다.
- 완료 application ACK의 `acks/fixture-presence-check-completed` 읽기는 운영 ACL과 개발 allowlist 모두 인증서 CN에 결속된 자기 Gateway에만 허용한다. Gateway가 이 ACK를 발행하거나 다른 Gateway의 ACK를 읽을 권한은 없다. 기존 ACL의 site `+` 구조는 유지되며 site와 Gateway의 실제 소속·topic/payload identity는 API가 검증한다. 따라서 같은 Gateway ID의 site 구분까지 broker ACL 단독으로 보장한다고 해석하지 않는다.
- 완료 시 별도 성공 toast 없이 KPI·마커·상세를 함께 갱신한다. partial은 `일부 조명의 상태를 확인하지 못했습니다.`, failed는 `장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.`, expired/timeout은 `장치 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.`를 표시한다. 확인된 상태와 기존 성공 데이터를 보존하며 source별 조회 오류는 독립적으로 관리한다. 맵·현장 변경과 unmount는 polling을 취소하고 늦은 응답이 새 화면을 덮지 못하게 한다.
- 기본 dashboard는 fixture 본문을 제외한 현장/층/gateway metadata와 DB aggregate summary만 반환한다. 제어 화면만 `includeFixtures=true`를 명시한다.
- 모니터링 fixture snapshot은 `GET /sites/:siteId/floors/:floorId/fixtures`에서 현장 read 권한을 검증한 뒤 최대 200개씩 ID cursor로 조회하며, 선택 층의 다음 페이지를 연속 병합한다. 존재하지 않는 층과 접근할 수 없는 층은 같은 `floor not found` 404 응답으로 처리한다.
- `Fixture(floorId, id)` 복합 인덱스로 OFFSET 없이 대규모 fixture를 순회한다.
- Playwright deterministic route fixture는 Chromium에서 수동 새로고침과 마지막 갱신 시각 변경, 10분 자동 갱신 경계, 5페이지로 나뉜 조명 1,000개의 마지막 페이지 상태 반영, 저장된 지도 객체의 실제 Konva canvas pixel 렌더링을 검증한다. 이 fixture는 브라우저와 API 계약 회귀용이며 실제 Raspberry Pi/ESP32-H2 하드웨어 E2E 증거가 아니다.
- `pnpm benchmark:fixtures`는 `API_BENCH_SITE_ID`, `API_BENCH_FLOOR_ID`, 실제 인증 cookie로 현장 범위 fixture API를 기본 100회 측정해 p95가 1초를 넘으면 실패한다. site/floor ID는 URL encoding하며 스크립트 계약은 `node --test scripts/benchmark-fixture-api.test.mjs`로 검증한다.
- 모니터링의 층 도면은 모든 역할에 읽기 전용으로 표시한다. 편집 버튼, editor state 조회와 editor 분기는 제공하지 않으며, 도면 변경과 version 복구는 설정 메뉴가 소유한다.
- `GET /sites/:siteId/floors/:floorId/map-snapshot`은 현장 read 권한을 확인한 뒤 지도 revision, 선택적 도면 배경, visible 도형과 `placed` fixture layout을 반환하되 내부 CAD slot은 노출하지 않는다. snapshot fixture의 membership·이름·좌표는 지도 정본이며 cursor API에서는 밝기·연결·장애 같은 동적 상태만 결합하므로 stale runtime의 `unplaced`가 저장된 marker를 숨기지 않는다. snapshot에 없는 legacy runtime fixture만 자체 배치 상태와 좌표를 따르며, 배경이 없으면 `1200x800` 기본 canvas를 사용한다.
- 층 지도 snapshot은 도형을 `zIndex`, 생성 시각 순으로 고정해 반환한다. 존재하지 않거나 접근할 수 없는 층은 같은 `floor not found` 404 응답으로 처리한다.
- 웹은 `useFloorMapSnapshot`으로 선택 층의 저장된 배경과 도형을 10분마다 조회하고, 설정 에디터와 공통 `FloorMapObjectNode` geometry를 사용해 Konva scene에 읽기 전용으로 합성한다. 조명 marker는 같은 좌표계의 접근 가능한 HTML 버튼으로 표시한다.
- 설정 맵의 atomic save 또는 revision 복구가 성공하면 응답의 `mapRevision`, 배경·맵 크기·도형을 동일 현장/층의 `floor-map` 캐시에 즉시 기록하고, 조명 이름·위치·크기·정격 전력·배치 상태는 기존 `floor-fixtures` 페이지의 밝기·장애·Gateway 운영 상태를 보존한 채 병합한다. 이후 scoped query invalidation과 서버 재조회도 유지하므로 설정에서 모니터링으로 이동할 때 이전 10분 캐시를 먼저 표시하지 않는다.
- 네모·세모·선·텍스트는 맵 편집 저장 성공 뒤 공통 `FloorScene`/`FloorMapObjectNode`를 통해 읽기 전용 모니터링 Konva scene에 같은 좌표와 색상으로 표시한다. `.floor-scene-canvas`, `.konvajs-content`, canvas는 모두 floor map 콘텐츠 높이를 채우므로 0px 합성 높이로 저장 도형이 사라지지 않는다. 브라우저 회귀는 접근성용 숨김 데이터 존재만 확인하지 않고 네 종류를 한 번에 저장한 뒤 최종 합성 높이와 사각형·삼각형·선·텍스트의 hand-derived RGB 픽셀을 검사한다.
- 모니터링 수동 새로고침은 dashboard metadata, 현재 층 fixture 페이지와 현재 층 map snapshot 세 요청을 함께 갱신하며 일부 실패 시 기존 성공 데이터를 유지한다.
- 지도 snapshot의 최초 조회가 실패하면 기본 빈 canvas를 만들지 않고 오류와 `지도 다시 시도`를 표시한다. 이전 성공 snapshot이 있는 갱신 실패는 현재 지도를 유지한 채 실패 표기와 재시도만 추가하며, 수동 갱신 실패 상태는 해당 floor ID에 귀속되어 다른 층으로 전환할 때 누수되지 않는다.
- deterministic Playwright route fixture는 0건 완료, relation 없는 retry 응답, canonical GET의 `pending -> scanning -> completed` 진행과 terminal polling 중지, 실패 메시지, 명시적 다시 검색, 등록 조명이 존재하는 상태의 active 세션 자동 복구와 최초 지도 오류 복구를 Chromium에서 검증한다. route fixture는 실제 API/DB 또는 하드웨어 검증을 대체하지 않는다.
- Task 9 격리 실백엔드 Chromium E2E는 operator의 현장/admin 발급과 customer route 차단 뒤 assigned admin이 pending setup, Gateway claim, 0건 검색·재검색, 자사 node 2개 등록과 모니터링 진입을 수행하는 새 계약을 검증했다. test support의 software MQTT publisher는 production API, 인증, claim, registration과 state-ingested ACK를 통과하고 shared `parseDfkDeviceUuid` 정본으로 invalid/타사 UUID 1개를 제외한다. 다만 실제 `apps/gateway`의 BlueZ scan/RF, production Gateway certificate principal·bootstrap·broker ACL 배포, Raspberry Pi/ESP32-H2 HIL 증거는 아니다.
- gateway scoped v2 fixture state와 heartbeat는 topic/payload/DB의 site·gateway 관계가 모두 일치할 때만 반영한다.
- v2 상태 이벤트는 영속 `eventId`와 gateway sequence를 사용하며 QoS 1 중복과 낮은 sequence 역전을 폐기한다. 같은 identity의 canonical payload가 같으면 이미 commit한 결과를 재응답하고, payload가 다르면 fail-closed 한다.
- 업그레이드 이전 `payloadHash=null` fixture-state/heartbeat 원장은 topic/DB 소유권을 검증하고 소유 행을 잠근 뒤 exact gateway·fixture·sequence·eventType·occurredAt을 확인한다. 첫 인증 재전송의 hash를 `eventId AND payloadHash IS NULL` 조건부 갱신으로 확정하며, 경합 시 재조회한 hash가 같은 경우만 기존 terminal 결과를 반환한다. migration-default `accepted` fixture event의 `duplicate` ACK는 Gateway의 정확한 pending head를 해제하고 다음 저장 event를 실제 publisher가 발행하게 한다. snapshot·energy·freshness는 다시 반영하지 않는다.
- 모든 production 상태 producer는 `0700` 전용 디렉터리의 `0600` atomic durable outbox에 먼저 기록한다. 별도 manifest가 최초 생성과 운영 중 파일 소실을 구분하며 missing/corrupt/unsafe permission은 `state_outbox_missing`, `state_outbox_corrupt`, `state_outbox_permissions` health로 시작을 차단한다. 최대 `100,000건/100MiB` 용량을 예약할 수 없으면 command·scan·identify·provision RF 작업 전에 공통 gate가 fail-closed하고 `state_outbox_capacity`를 sticky 상태로 남긴다.
- 자발 Mesh publication은 한 이벤트 용량을 미리 예약한 동안에만 listener를 연다. 이벤트를 durable 저장한 뒤 다음 예약이 실패하면 listener를 닫고, application ACK로 용량이 회복되면 재구독한 뒤 강제 상태 resync를 수행한다.
- Gateway는 QoS 1 PUBACK 이후에도 exact `state-ingested` application ACK를 받기 전에는 상태 이벤트를 삭제하지 않으며 reconnect/restart 후 재전송한다. API는 이벤트 원장, 최신 Fixture 상태, 에너지 cursor/checkpoint와 일별 집계를 같은 DB transaction으로 commit한 뒤에만 `ingested`, `duplicate`, `stale_sequence`, `reverse_time`, `stale_checkpoint` ACK를 발행한다. 5분을 1ms라도 넘는 future fixture-state/heartbeat는 `ProcessedGatewayEvent`에 `rejected_future_timestamp` terminal 결과만 durable commit하며 snapshot·energy·gateway freshness를 갱신하지 않는다. fixture-state는 exact terminal ACK 뒤 outbox head를 제거해 같은 Gateway의 다음 event가 진행할 수 있다.
- gateway는 재시작 후에도 event sequence를 파일 권한 `0600`으로 이어간다. 시작 시에는 journal 추정 상태를 재발행하지 않고, 확인된 node의 AppKey/model bind/60초 publication 응답을 다시 확인·보정한 뒤 Generic OnOff, Lightness, Health 실제 상태를 조회한다.
- Gateway provisioning scan journal은 `(sessionId, scanCorrelationId, scanAttempt)` 논리 실행을 `0600` atomic file에 보존한다. process restart 시 남은 `running`은 새 물리 scan 없이 정제된 `scan-failed` terminal로 먼저 수렴한다. MQTT가 runtime listener보다 먼저 연결된 경우도 command/application ACK subscription 준비 뒤 connect recovery를 정확히 한 번 실행한다. recovery terminal publish는 기본 10초 timeout을 적용하고 connection 안의 동시 drain을 single-flight로 직렬화한다. 연결 뒤 새 terminal은 durable 저장 직후 최초 publish 결과를 기다리기 전에 scheduler를 깨우며, ACK가 없으면 1초부터 최대 30초까지 exponential bounded backoff로 같은 event를 재발행한다. idle journal은 polling하지 않는다. MQTT close는 예약 timer와 active publish를 취소하고 reconnect는 새 connection generation에서 즉시 drain을 재시작한다.
- broker PUBACK만으로 terminal을 delivered 처리하지 않는다. API는 exact terminal의 `ProcessedGatewayEvent` 생성과 `ProvisioningSession` terminal 변경 transaction이 commit된 뒤 strict `acks/provisioning/scan-terminal-ingested` ACK를 발행하고, transaction 실패 뒤 동일 event 재전달 또는 commit 뒤 ACK publish 실패에 따른 duplicate에도 commit 원장과 terminal snapshot을 확인해 ACK를 재발행한다. Gateway는 ACK의 `eventId`, `sequence`, `sessionId`, `scanCorrelationId`, `scanAttempt`가 journal terminal과 모두 일치할 때만 `deliveredAt`을 기록하고 retry timer를 정리한다. API offline, transaction 실패, ACK publish 실패에서는 journal을 유지한다. Gateway certificate의 ACK write 권한은 실제 producer topic인 `acks/acceptance`, `acks/device-status`로 제한하며 `acks/state-ingested`, `acks/provisioning/scan-terminal-ingested`는 read-only다.
- startup resync는 4개 node 제한 queue와 busy 재시도를 사용한다. 구성 성공 뒤 같은 generation의 OnOff/Lightness pair가 오면 8초 resync `observed`로 집계하고, Health Current 미관측은 `healthPending`으로 별도 집계한다. Automation terminal commit recovery의 durable pending fixture snapshot은 restart에도 복원되고 targeted queue에 seed된다. Queue는 최대 4,096개를 coalesce하고 64개씩 조회하며, 각 targeted/full pass 뒤 실제 관측으로 해제되지 않은 source ID를 회전된 capacity window로 다시 채운다. 따라서 선두 영구 offline fixture의 fence는 유지되지만 capacity 밖 정상 fixture도 starvation 없이 관측 기회를 얻는다. Full error와 `timedOut`/`failed` report도 250ms~30초 capped backoff rerun을 예약한다. Pending transition/fence는 실제 OnOff/Lightness 관측이 durable state에 반영될 때까지 남고, shutdown은 retry timer와 현재 signal을 취소한 뒤 5초 안에 drain한다. `meshResync` health field와 구조화 log는 lighting pair가 전혀 없거나 전송이 모두 실패한 경우에만 unhealthy를 유지하며, 이후 heartbeat만으로 이를 healthy로 덮지 않는다. 늦은 Health Current publication은 pending을 회복한다. reconnect가 겹쳐도 하나의 resync만 수행하며, 응답이 없는 경우에는 offline 이벤트를 만들지 않는다.
- BlueZ model status는 부분 관측으로 취급한다. Generic OnOff, Lightness, Health Current 실제 관측이 같은 generation의 65초 coherence window 안에 모두 모일 때만 fixture-state snapshot을 발행한다. 새 resync와 단일 model update는 새 generation을 시작하므로 Health-only, 역순, 누락 또는 stale counterpart가 밝기 `0`, power-off, online 상태로 DB를 오염시키지 않는다.
- BlueZ 자발 status는 확인된 primary unicast address가 fixture mapping과 일치할 때만 처리한다. Health Current Fault(`0x04`)만 operational fault로 반영하며, Current를 실제 관측하기 전에는 online/fault snapshot을 확정하지 않는다. Registered Fault(`0x05`)와 no-fault byte `0x00`는 장애 상태를 만들지 않는다. gateway는 assignment의 site/gateway 범위를 payload에 주입해 MQTT v2 fixture-state로 발행하고, unknown address는 폐기한다.
- gateway는 Health Current의 숫자 fault code와 실제 관측 시각을 MQTT v2 `health` 객체로 전달한다. API는 `0x00` 제거, 중복 제거와 정렬 후 `Fixture.healthFaultCodes`, `Fixture.healthLastSeenAt` 최신 snapshot에 저장하며 Health가 없는 명령 결과 이벤트는 기존 snapshot을 지우지 않는다.
- 층별 fixture API와 dashboard는 Health snapshot을 `{ faultCodes, observedAt }` 또는 `null`로 반환한다. fault가 하나라도 있으면 조명 상태와 제어 가능 여부를 장애로 취급하고, 모니터링 상세 패널은 `정상`, `장애 (fault code)`, `확인 대기`와 Health 수신 시각을 표시한다.
- ESP32-H2의 application-driven Sensor Status는 shared publication buffer가 아니라 pinned ESP-IDF v5.5.1의 repository-patched server-send 경로를 사용한다. Payload/context를 API thread에서 all-or-nothing snapshot하므로 allocation/envelope/queue-post 실패는 handler 실행 없이 동기 오류가 되고, queue 수락 후에는 기존 BTC handler가 두 snapshot을 한 번 해제한다. 연속 current/recovery Status는 호출별 snapshot을 보존하며 Gateway가 설정한 NetKey/AppKey, publication address, TTL, credential, SZMIC를 사용한다. Stack period/retransmit가 `0`이 아니면 firmware readiness가 fail-closed하므로 잘못된 Config에서 상태 전송을 시도하지 않는다.
- 모니터링 응답과 incident 판정은 Site별 `gatewayOfflineAfterSeconds`(기본 90초), `fixtureStaleAfterSeconds`(기본 1,200초)를 사용한다. 정확한 threshold 경계는 fresh, 1ms 초과는 offline/stale이다. `reportedStatus/reportedStatusReason`에 마지막 수락 장비 보고를 보존하고, `Gateway.lastHeartbeatAt`과 `Fixture.lastSeenAt` 서버 수신 시각으로 표시 상태를 계산한다. 기존 `status/statusReason`은 Commands·Identify가 사용하는 고정 90초/1,200초 운영 freshness로 유지한다.
- `provisioning_waiting_state` fixture는 freshness 변경에서 제외한다. Gateway offline이 우선하며, Gateway가 복구됐지만 조명 수신이 오래되면 이미 offline인 조명도 즉시 `gateway_offline → fixture_stale`로 전환한다. `fixture_stale`은 현재 online Gateway에 매핑된 조명에만 적용한다.
- dashboard와 층별 fixture page는 서버 `generatedAt`을 응답마다 한 번 고정한다. dashboard는 `monitoringPolicy:{gatewayOfflineAfterSeconds,fixtureStaleAfterSeconds}`도 반환하며 현장 없는 기본 응답은 90/1,200초 정책을 포함한다. 모든 표시용 Gateway `connectionStatus`는 현장 정책을 사용한다. `controllable/controlBlockReason`과 등록·식별·제어 안전성의 90초 기준은 유지한다.
- API freshness sweep은 외부 장치 polling이 아닌 30초 내부 worker다. 실행 중 다음 tick을 건너뛰며, 20분 exactly는 fresh이고 마지막 성공 수신 뒤 20분 + 1ms부터 stale로 판정한다. 현장별 transaction은 획득 대기 2초/실행 5초로 제한하며, 실패한 현장만 rollback하고 식별자·원문 없는 정제 오류를 기록한 뒤 다음 tick에서 재시도한다. `Site → Gateway → Fixture → Incident` 순서로 잠그고 고정 운영 상태 변경과 Site 정책 incident reconcile을 같은 transaction에서 commit한다. Gateway `FOR NO KEY UPDATE`는 heartbeat 변경을 직렬화하면서 상태 수집의 Gateway FK key-share를 허용한다.
- Gateway당 `gateway_offline` 하나, online Gateway 소속의 오래된 조명에 `fixture_stale`, Health Current fault에 `fixture_fault`, 마지막 수락 보고 사유에 `command_failed` 이력을 생성한다. command 실패는 Gateway/Fixture freshness 만료와 독립적으로 유지되고, 이후 실제 fixture-state 보고가 다른 사유로 수락될 때 해소된다. 계속 관측되면 `lastObservedAt`만 전진시키고 확인·담당·사용자 수정 revision은 유지한다. 조건 해소는 `automatic_recovery`로 해결하고 `activeKey`를 null로 바꾸며, 재발은 새 occurrence로 기록한다. Site 잠금과 unique active key가 중복 활성 이력을 차단한다.
- 30초 Site 정책으로 모니터링이 offline을 표시해도 제어·식별의 고정 90초 안전성 경계는 바뀌지 않는다. 반대로 300초 Site 정책은 고정 운영 상태가 offline이 된 뒤에도 마지막 보고 online을 300초 경계까지 표시할 수 있다. 모니터링 상태와 `controllable/controlBlockReason`은 서로 다른 정책의 결과다.
- dashboard fixture 응답에 소유 gateway ID/이름/연결 상태와 `controllable`, `controlBlockReason`을 포함한다.
- Gateway startup resync는 command 이력을 상태로 재발행하지 않고, 확인된 fixture마다 실제 Mesh status 응답을 새 sequence로 반영한다.
- Gateway MQTT runtime은 MQTT close에서 heartbeat timer를 즉시 정리해 disconnected 상태의 healthy 기록과 offline heartbeat 적재를 막고, reconnect마다 하나의 timer만 다시 시작한다. persistent session 재접속(`sessionPresent=true`)에는 command topic을 다시 구독하지 않는다. 모든 command/provisioning topic handler 오류는 MQTT event loop 밖으로 새지 않도록 오류 경계에서 health 오류로 기록하며, SIGTERM/SIGINT 종료 시 timer, client listener와 MQTT client를 정리한다.
- MQTT certificate rotation은 old client quiesce와 identity pointer commit 뒤 candidate를 runtime current client로 지정한 다음 broker에 연결한다. CONNACK 전 실패만 old identity/client로 rollback하고, CONNACK 뒤 subscription 실패는 candidate authoritative 상태에서 fail-closed 해 old session command replay를 막는다. dimming·scan·identify·provision handler는 각 MQTT message source client로 결과를 발행한다. pointer write/fsync와 restore가 모두 실패하면 candidate generation을 보존하고 runtime을 fail-closed 한다. appliance health는 D-Bus owner, 실제 `Node1` interface introspection, HCI powered bit, mapping JSON parse, 마지막 heartbeat publish freshness를 실제 probe해 기록하며 future heartbeat와 잘못된 heartbeat interval은 unhealthy로 처리한다.

## 미구현

- 맵 통합 실행이 승인되었고 기존 맵은 보존하지 않는다. 초기화 이후 등록 조명은 유지하되 맵에서는 미배치로 표시한다. 도형 초기화를 장비 삭제로 해석하지 않으며 공통 렌더러 연결은 U13에서 진행한다.

- 설정 편집기와 같은 공통 정본·렌더러로 수정·삭제 결과를 표시하는 U13 경로는 연결 및 독립 검토를 완료했고, 격리 실제 백엔드 DXF 여정에서 저장·삭제·복구 후 모니터링 픽셀을 확인했다. 읽기 전용과 실제 조명 정보는 유지한다. 다만 고밀도 도면의 순서 페이지 스트리밍 및 전체 통합 검증은 [구현 계획](../superpowers/plans/2026-09-18-cad-native-map-rendering.md)의 U9c/U14 진행 항목으로 남긴다.

- 첫 sweep 전 과거 장애 backfill은 하지 않는다.

- WebSocket/SSE 기반 push 실시간 업데이트
- 층별/구역별 통신 음영 heatmap
- 장애 escalation/SLA 등급과 외부 알림 연결
- 차량 감지 이벤트 표시
- 이벤트 타임라인
- 게이트웨이별 커버리지 표시
- 여러 게이트웨이가 같은 층을 담당할 때의 경로/coverage 시각화
- 조명 등록 중 provisioning 진행률 표시
- 모니터링 화면 내 빠른 밝기 제어

## 부족하거나 개선이 필요한 기능

- 2026-10-04 iOS 검증 경계: 공개 로그인 화면과 synthetic WebView 브리지·CSV 동작만 검증했다. 포커스 보정의 정식 셸 연결과 늦은 viewport 축소는 자동 회귀를 통과했다. 이 Mac의 iOS26.5 Simulator에서 observer 없이 실제 로그인 화면의 ID 최초 포커스 cold start 2회, Next, 별도 cold start의 비밀번호 최초 포커스·재포커스, 사용자 스크롤 유지와 Done 복원을 확인했다. 인증된 해당 메뉴, PDF, 구형 iOS와 실장비 조명 연동은 미검증이다.

- 실제 Dashboard API 응답과 계약 테스트에는 현장 `offlineFixtures`, 층별 `summary`, `mapRevision`, `mapConfigured`가 필수다. 다만 Web의 `Dashboard` TypeScript 타입은 제어·셸·설치 화면 등의 기존 typed 테스트 fixture가 이 필드를 아직 빠뜨려 일시적으로 optional이다. 런타임 응답에서 층별 집계나 현장 오프라인 집계가 누락되면 모니터링은 `0`을 만들지 않고 `집계 준비 중`으로 표시한다. 해당 fixture를 전수 이관한 뒤 Web 타입도 required로 승격해야 한다.
- Final Atlas 모니터링 웹은 shared response schema, API cursor/`retainedFrom`, 조회 오류와 `410`을 소비한다. 모니터링·공통 지도·App/셸 focused Vitest 232개와 Chromium route fixture 42개(1440·1378·1024·390·320px 포함)는 통과했지만, 브라우저 fixture 기록을 실제 현장에 이미 보존된 활동이라고 해석하지 않는다. 고객 DB에 신규 migration을 적용한 뒤 생산자·3개월 물리 삭제 sweep·권한·현장 시간대 표시를 운영 환경에서 통합 점검해야 한다. 과거 3개월 기록의 소급 backfill은 제공하지 않는다.
- 수동 장치 확인의 물리 BIO USB 동글·조명 2대 연결 증거가 없어 이번 작업의 HIL은 미수행이다. 후속 현장 절차는 두 대 online → 한 대 실제 전원 차단 → 새로고침 → `정상 1 / 오프라인 1` → 전원 복구 → 새로고침 → `정상 2 / 오프라인 0`이며 Gateway 버전/API revision·가린 장비 identity·시각·결과를 기록해야 한다. 자동 unit/Chromium route fixture와 lab 발행 terminal은 실제 two-pass RF/USB 검증을 증명하지 않는다.
- 실제 API/PostgreSQL/Redis/MQTT transport 회귀는 `E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/real-backend-lab-support.spec.ts --project=chromium`으로 opt-in한다. PostgreSQL 도구·Redis·Mosquitto·OpenSSL과 API/Web build가 필요하며 미설정 시 해당 transport 시나리오는 명시적으로 skip한다. 환경이 준비돼 실행한 실패는 skip 또는 HIL 성공으로 바꾸지 않는다.
- 2026-09-18 Task 7 검증: retention 단위 6개·disposable PostgreSQL 42개, 기존 조회 fixture 보정 33개, monitoring Chromium 32개, lab 지원 17개(transport opt-in 1개 제외; ACK payload 계약·식별자 음성 회귀 포함), 실제 Docker Mosquitto persistence/운영·개발 ACL 3개가 통과했다. 정식 lint/typecheck/build와 opt-in lab 기동은 기존 CAD `confirmMapReset` 누락에 막히며 root test는 기존 CI cgroup 기대값 불일치로 실패한다. 이를 우회하지 않는 정식 명령은 실패 상태로 남긴다. 별도 일회성 진단에서 Web 타입 검사만 Vite build로 대체한 lab transport 1개는 실제 API POST/GET·MQTT application ACK·`정상 1 / 오프라인 1`·동일 결과 재전송 멱등성·새 presence의 `정상 2 / 오프라인 0` 복구를 통과했다. 진단 우회 코드는 제거했고, 이 결과를 정식 build 통과나 물리 장비 HIL로 확대하지 않는다.

- 모바일 두 손가락 확대·축소, marker hit 및 pointer-capture 경로는 Web PointerEvent와 synthetic Chromium으로 검증했다. 실제 iOS/Android WebView의 safe area, gesture arbitration, native click 전달과 장시간 현장 사용성은 실기기 확인이 필요하며, 이는 BLE/Mesh·firmware·물리 조명 HIL 검증이 아니다.

- 공통 디자인 시스템 이전은 deterministic Vitest와 Chromium route fixture를 기준으로 검증한다. 실제 현장 도면의 수동 시각 QA와 Raspberry Pi/ESP32-H2/LED 연결 HIL 결과는 포함하지 않는다.

- 자동으로 저장되는 인시던트 이력과 현장별 판정 기준을 사용자 화면에서 관리하는 UI는 제공하지 않는다. 필요해질 경우 일반 사용자 모니터링과 분리된 내부 운영자 화면으로 별도 설계해야 한다.
- 원장 정리 worker는 생성 후 7일보다 오래된 heartbeat와 30일보다 오래된 fixture state를 최신 Gateway/Fixture snapshot·watermark 및 fixture energy cursor가 해당 기록을 포괄할 때만 삭제한다. superseded capability는 365일 정책이며 전체 이벤트는 sweep당 합산 최대 10,000개다. cutoff와 같은 시각, scope/hash가 없는 legacy 원장, 삭제된 fixture·누락된 cursor 등 안전 조건을 증명할 수 없는 기록은 보존한다. watermark는 stream별 최신 identity만 유지하므로 임의 과거 ID의 exact dedupe는 raw 원장이 남아 있는 기간에 의존한다. 세부 조건은 [DB 보존 문서](../database-schema.md#운영-데이터-보존과-복구-범위)를 따르며 사용자/운영 DB migration 적용과 실장비 replay HIL은 아직 실행하지 않았다.
- 플랫폼 운영 배포 절차는 [API·Web runbook](../runbooks/production-api-web-deployment.md)을 따른다. 단일 호스트 Compose, 외부 Vault·공개 MQTT/Object Storage 연결, 장비 mTLS 공개 SAN, CRL 갱신 후 수동 broker SIGHUP, API 교체 후 nginx upstream 재해석·재시작이 운영 조건이다. Process-local 지표만 제공하며 외부 metrics/dashboard/alert/log shipping은 구성하지 않았다. 운영 배포·사용자 DB 적용·실장비 HIL과 native WebView·수동 시각 QA는 이번 자동 검증에 포함하지 않는다.

- 1440/390/320px 결과는 Chromium 자동 브라우저 software 증거다. 실제 iOS/Android native WebView, 수동 in-app 시각 QA, WebView safe-area 실측 또는 Raspberry Pi/ESP32-H2 HIL을 수행한 결과가 아니다. Lazy chunk 실패의 복구 UI는 플랫폼 Task 3에서 구현했으며, prefetch/offline cache는 후속 범위다. Task 3 오류 주입은 Vite에서 실제 앱 셸의 동적 import 요청을 차단한 deterministic Chromium 결과이며, 운영 CDN/container 배포나 실제 backend 장애·HIL 검증을 의미하지 않는다.
- 카메라 기억은 동일 브라우저 사용자·현장·층에만 적용하며 여러 기기 간 동기화는 제공하지 않는다. 인증 범위를 확인하지 못하면 영속 저장하지 않는다. 실제 native WebView와 장비 HIL은 별도 검증이다.
- 저장 도형 표시 회귀는 deterministic route fixture Chromium에서 검증한다. mock snapshot과 브라우저 합성 결과를 확인하는 범위이며 실제 Gateway, Raspberry Pi, ESP32-H2 또는 현장 도면의 HIL 검증은 아니다.
- 테스트 데이터는 설정 개요의 설치 완료 assigned `admin` 전용 개발·검증 도구이며, 기본 off 상태이고 API도 비활성화 시 404를 반환한다. 따라서 표시되는 online 상태는 일시적 recent online일 수 있고 freshness 재집계 뒤 offline이 될 수 있으며, 실제 Gateway·Mesh·MQTT 상태나 HIL 검증 증거로 해석할 수 없다.
- 개별 `provision-device`의 API DB transaction -> MQTT PUBACK과 Gateway RF 전 durable accept, terminal atomic 저장, exact `device-terminal-ingested` ACK 전 bounded replay는 software로 구현됐다. 다만 이 ACK를 생성하는 API terminal ingest/ACK outbox는 Task 3 범위여서 현재 production 통합에서는 device terminal이 계속 pending replay로 남는다. API/Gateway 프로세스 전원 차단 전체 구간의 자동 수렴과 실제 broker/Raspberry Pi/ESP32-H2 재시작 HIL은 Task 3 이후 검증해야 한다.
- pending redirect와 admin commissioning은 React/Vitest 회귀와 Task 9 격리 실백엔드 Chromium E2E로 검증했다. Calm Operations 모바일 390px/320px의 화면 계층·overflow·touch target은 route fixture로 검증했지만, 실제 WebView safe-area와 재설치는 별도이며 Raspberry Pi/ESP32-H2 HIL은 아직 실행하지 않았다.
- 모니터링 화면과 Gateway BIO full-resync는 모두 10분 polling 정책이다. publication 반영 직후 확인이 필요하면 수동 새로고침을 사용할 수 있으며 push는 제공하지 않는다. 10분 주기 사이에는 최대 20분 동안 마지막 성공 presence를 fresh로 표시할 수 있다.
- durable state outbox의 파일 권한·용량 차단과 application ACK 재전송은 자동 테스트로 검증했지만, 실제 broker/API 재시작과 Raspberry Pi 전원 차단을 포함한 HIL은 아직 실행하지 않았다.
- Health 수신 경로는 최신 Current snapshot을 보존하며, fault 발생·해제 이력은 다음 freshness sweep에서 자동 반영한다. Health 관측 이력 전체를 별도로 저장하는 범위는 아니다.
- 조명 provisioning 진행 상태는 session polling으로 반영하고, 사용자가 등록 세션을 완료할 때 dashboard query를 갱신한다. WebSocket/SSE push는 명시적으로 보류한다.
- incident는 수집 event와 동시에 생성되지 않고 다음 30초 sweep에서 수렴한다. 고정 운영 상태 변경과 reconcile 사이의 commit 간격은 없지만, 현장 간에는 개별 transaction이며 sweep 실행 시간·잠금 대기·실패 시 반영이 늦어질 수 있다. sweep은 잠금 후 시각을 다시 샘플링한다. 모니터링은 마지막 장비 보고를 Site 정책으로 다시 계산하므로 heartbeat 복구 후 보고 시각이 아직 fresh이면 표시 상태도 복구한다.
- `20260912110000_fixture_reported_state` migration은 기존 운영 상태/사유를 reported 컬럼으로 보수적으로 복사한다. 과거 sweep이 이미 덮어쓴 실제 보고는 복원할 수 없으며 다음 수락 fixture-state부터 보존된다. migration 뒤 모든 상태 수집 API를 새 버전으로 교체해야 보고 필드가 계속 갱신된다. 구버전 API와 장기 혼용하는 배포는 지원하지 않으며 사용자 DB에는 이번 migration을 적용하지 않았다.
- dashboard와 fixture page의 `generatedAt`은 각 응답의 판정 기준 시각이며 여러 SQL 조회·페이지를 하나의 DB snapshot으로 묶는 보장은 없다. 대규모 현장의 전체 대상 row 잠금 비용과 장기 부하는 별도 운영 검증이 필요하다.
- 5분 future gate, durable terminal rejection, 서버 수신 시각 freshness, 에너지 발생 시각 순서는 Shared/API/Gateway의 mock·software 자동 회귀와 disposable PostgreSQL migration DB에서 검증하는 범위다. 실제 broker, Raspberry Pi, BlueZ Mesh, ESP32-H2/LED를 연결한 HIL이나 사용자 DB migration은 이 작업에서 수행하지 않았다.
- legacy null hash는 원본 payload와 같다는 증거가 없으므로 첫 인증 replay가 hash를 확정한다는 한계가 있다. 이후에는 exact hash만 허용하며, 새 future rejection에는 처음부터 hash가 있다. migration과 replay 보완은 과거 `Fixture.lastSeenAt`/`Gateway.lastHeartbeatAt` 및 energy 값을 재작성하지 않는다. 새 정상 event 수락 시 freshness가 서버 수신 시각으로 바뀌며, 과거 energy 오염의 소급 정정은 별도 범위다.
- `lastSeenAt` 상대 시간은 클라이언트 현재 시간 기준이므로 서버 기준 freshness와 완전히 일치하지 않을 수 있다.
- RSSI, hop count, 명령 성공률, Health 원시 코드, Gateway·정격 전력·좌표는 일반 사용자 모니터링 정보에서 표시하지 않는다. 내부 상태 수신·판정 계약을 삭제한 것은 아니다.
- 1,000개 marker 조회/렌더링 기준은 자동 검증한다. 현재 이름/번호 검색은 브라우저가 이어 받아온 현재 층 fixture 페이지에 적용되며 서버 전체 검색 API는 없다. 더 큰 현장에는 공간 클러스터링과 서버 검색이 추가로 필요하다.
- 자사 UUID 검색, batch 등록, 실제 Health Current 수집을 포함한 Raspberry Pi/ESP32-H2 실장비 HIL은 아직 실행하지 않았다. 자동 route fixture 통과를 검색·등록·상태 수집의 실기 완료로 간주하지 않는다.
- Sensor server-send breaker는 actual patched source allocator fault harness와 fullclean target compile로 검증했다. 실제 device heap pressure, BTC queue saturation과 Sensor Status RF 전달은 HIL에서 확인해야 하며 software allocation test를 실장비 완료로 간주하지 않는다.
- 현재 선택 로직은 명시 선택 ID 또는 `null`만 사용한다. 자동 첫 장애/첫 조명 선택은 제거했으며 새 데이터와 저장 pin/runtime 도착 순서가 임의로 선택을 바꾸지 않는다.
- 등록 패널은 `pending/scanning` 또는 provisioning 중에만 1.5초 registration session polling으로 결과를 반영한다. `reconcile_required`의 서버 상태 재조회, 명시적 제외와 세션 취소는 구현했지만 장비가 실제로 provisioned 되었는지 Gateway/BlueZ에 질의하고 자동 정리하는 기능은 없다. 현장 관리자가 장비를 확인·초기화하지 않은 채 제외하면 안 되며 이 절차는 Raspberry Pi/ESP32-H2 HIL로 검증해야 한다.
- scan lifecycle 자동 테스트는 mock MQTT와 scanner adapter를 사용한다. 실제 host Mosquitto mTLS negative ACL integration에서 Gateway CN certificate의 `acks/state-ingested`, `acks/provisioning/scan-terminal-ingested` publish 거부를 확인했다. 2026-09-18 Task 7에서는 Docker broker persistence 재시작과 운영·개발 ACL 검증 3/3을 통과해 과거 Docker daemon 부재로 인한 skip 상태를 갱신했다. 이는 소프트웨어 broker 검증이며 실제 Raspberry Pi BlueZ adapter의 scan timeout, broker/Pi/API 재시작을 가로지르는 terminal application ACK 재전달, ESP32-H2 자사 UUID 필터와 terminal event 전달은 HIL에서 별도로 확인해야 한다.

## 관련 파일

- `apps/mobile/src/ios-focus-visibility.ts`, `apps/mobile/src/ios-focus-visibility.test.ts`, `apps/mobile/src/WebShell.tsx`, `apps/mobile/src/WebShell.ios-focus.test.tsx`, `apps/mobile/README.md`: 공통 iOS 입력 가시성 보정과 회귀·실행 안내.

- `apps/web/src/features/floor-map/{map-camera,fixture-map-position}.ts`
- `apps/web/src/features/monitoring/{FixtureDetailPanel,FixtureStatusBadge}.tsx`
- `apps/web/src/features/monitoring/{monitoring-fixture-filter,monitoring-camera-storage,useMonitoringCameraMemory}.ts`
- `apps/web/src/components/ui/{MetricButton,MetricContent}.tsx`, `workspace-focus/WorkspaceFocusProvider.tsx`
- `apps/web/e2e/monitoring-navigation-confidence.spec.ts`

- `apps/web/src/features/monitoring/MonitoringSummary.tsx`
- `apps/web/src/features/monitoring/FloorMap.tsx`
- `apps/web/src/features/monitoring/FixturePinPopover.tsx`
- `apps/web/src/features/monitoring/monitoring-time.ts`
- `apps/web/src/features/monitoring/useMonitoringActivity.ts`
- `apps/web/src/features/monitoring/monitoring-activity-presentation.ts`
- `apps/web/src/features/monitoring/MonitoringLogTicker.tsx`
- `apps/web/src/features/monitoring/MonitoringLogDrawer.tsx`
- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/floor-map/FloorScene.tsx`
- `apps/web/src/features/floor-map/FloorMapViewport.tsx`
- `apps/web/src/api/queries.ts`
- `apps/api/src/monitoring-refresh/`
- `apps/api/src/monitoring-activity/`
- `apps/api/src/retention/data-retention.service.ts`
- `apps/api/prisma/migrations/20260918100000_monitoring_manual_refresh/migration.sql`
- `apps/gateway/src/commands/fixture-presence-check-handler.ts`
- `apps/gateway/src/state/monitoring-refresh-journal.ts`
- `apps/web/src/api/monitoring-refresh.ts`
- `apps/web/e2e/real-backend-lab-support.spec.ts`
- `apps/gateway/docker/mqtt-persistence.integration.mjs`

- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- `apps/web/src/components/ui/session-status/SessionStatusProvider.tsx`, `apps/web/src/components/ui/session-status/SessionStatusCenter.tsx`, `apps/web/src/components/ui/session-status/ToastRegion.tsx`
- `apps/web/src/features/monitoring/MonitoringFixtureFinder.tsx`, `apps/web/src/features/monitoring/MonitoringFixtureFinder.test.tsx`
- `apps/web/src/features/monitoring/fixture-brightness-presentation.ts`, `apps/web/src/features/monitoring/fixture-brightness-presentation.test.ts`
- `apps/web/src/features/monitoring/fixture-status-presentation.ts`, `apps/web/src/features/monitoring/fixture-status-presentation.test.ts`
- `apps/web/src/App.test.tsx`
- `apps/web/e2e/calm-operations-monitoring.spec.ts`
- `apps/web/src/features/shells/CustomerShell.monitoring.test.tsx`
- `apps/api/src/monitoring-incidents`
- `apps/api/src/registration/registration.service.ts`
- `apps/api/src/mqtt/provisioning-device-terminal.service.ts`
- `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`
- `apps/api/prisma/migrations/20260912100000_monitoring_policy_incidents/migration.sql`
- `apps/api/src/retention/gateway-event-watermark.ts`, `apps/api/src/retention/gateway-event-watermark.integration.spec.ts`
- `apps/api/src/retention/data-retention.service.ts`, `apps/api/src/retention/data-retention.integration.spec.ts`
- [API·Web 운영 배포와 장애 대응](../runbooks/production-api-web-deployment.md)

- `apps/web/src/components/ui/AppRecoveryState.tsx`
- `apps/web/src/components/ui/AppErrorBoundary.tsx`
- `apps/web/src/AppRoot.tsx`
- `apps/web/src/App.recovery.test.tsx`
- `apps/web/e2e/app-shell-recovery.spec.ts`

- `apps/web/src/App.tsx`
- `apps/web/src/components/ui/RouteLoadingState.tsx`
- `apps/web/src/features/shells/CustomerShell.tsx`
- `apps/web/scripts/audit-schedule-bundle.mjs`
- `apps/web/e2e/site-user-management.spec.ts`
- `apps/web/e2e/site-user-management-real.spec.ts`
- `apps/api/src/site-users`

- `apps/web/src/features/transport-copy.ts`
- `apps/web/src/features/transport-copy.test.ts`
- `apps/web/src/components/ui/MetricCard.tsx`
- `apps/web/src/components/ui/PageHeader.tsx`
- `apps/web/src/components/ui/StatusBadge.tsx`
- `apps/web/src/components/ui/FeedbackState.tsx`
- `apps/web/src/components/ui/SidePanel.tsx`
- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/api/src/test-data/test-data.controller.ts`
- `apps/api/src/test-data/test-data.service.ts`
- `apps/api/src/test-data/test-data.controller.spec.ts`
- `apps/api/src/test-data/test-data.service.spec.ts`
- `apps/web/src/features/settings/TestDataToolsPanel.tsx`
- `apps/web/src/api/test-data.ts`
- `apps/web/src/features/monitoring/FloorMap.tsx`
- `apps/web/src/features/monitoring/FloorMap.test.tsx`
- `apps/web/src/features/floor-map/FloorMapViewport.tsx`
- `apps/web/src/features/floor-map/FloorMapViewport.test.tsx`
- `apps/web/src/features/floor-map/map-gestures.ts`
- `apps/web/src/features/floor-map/map-gestures.test.ts`
- `apps/web/src/features/floor-map/FloorScene.tsx`
- `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- `apps/web/src/features/floor-editor/editor-monitoring-cache.ts`
- `apps/web/src/features/registration/RegistrationPanel.tsx`
- `apps/web/src/features/registration/RegistrationPanel.test.tsx`
- `apps/web/src/features/registration/FixtureBatchForm.tsx`
- `apps/web/src/features/registration/FixtureIndividualForm.tsx`
- `apps/web/src/api/registration.ts`
- `apps/web/e2e/monitoring-control-flow.spec.ts`
- `apps/web/e2e/calm-operations-monitoring.spec.ts`
- `apps/web/e2e/layout-assertions.spec.ts`
- `apps/web/e2e/support/layout-assertions.ts`
- `apps/web/e2e/support/settings-api.ts`
- `apps/web/e2e/settings-floor-editor.spec.ts`
- `apps/web/playwright.config.ts`
- `apps/web/src/api/queries.ts`
- `apps/api/src/sites/sites.controller.ts`
- `apps/api/src/sites/sites.service.ts`
- `apps/api/src/access/site-access.service.ts`
- `apps/api/src/fixtures/fixtures.service.ts`
- `apps/api/src/fixtures/fixture-health.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/legacy-gateway-event-replay.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `apps/api/src/mqtt/mqtt.module.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.service.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.spec.ts`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260826170000_add_discovered_node_scan_identity/migration.sql`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.ts`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.spec.ts`
- `apps/api/src/mqtt/provisioning-device-outbox-publisher.service.ts`
- `apps/api/src/mqtt/provisioning-device-outbox-publisher.service.spec.ts`
- `apps/api/prisma/migrations/20260905090000_add_provisioning_device_outbox/migration.sql`
- `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.spec.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `packages/shared/src/gateway-contracts.ts`
- `packages/shared/src/gateway-contracts.test.ts`
- `packages/shared/src/schemas.test.ts`
- `apps/api/src/registration/registration-allocation.service.ts`
- `apps/api/src/registration/registration.service.ts`
- `apps/api/src/registration/registration.controller.ts`
- `scripts/benchmark-fixture-api.mjs`
- `scripts/benchmark-fixture-api.test.mjs`
- `apps/api/src/floor-map/floor-map.service.ts`
- `apps/api/src/floor-map/floor-map.controller.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/topic-scope.ts`
- `apps/api/src/fixtures/fixture-freshness.service.ts`
- `apps/api/src/fixtures/fixture-freshness.service.spec.ts`
- `apps/api/prisma/migrations/20260912110000_fixture_reported_state/migration.sql`
- `apps/api/src/monitoring-incidents/monitoring-control-boundary.integration.spec.ts`
- `apps/api/src/energy/fixture-state-ingestion.service.ts`
- `apps/api/src/energy/fixture-state-ingestion.service.spec.ts`
- `apps/api/src/energy/fixture-state-ingestion.integration.spec.ts`
- `apps/api/src/mqtt/mqtt-v2-state.spec.ts`
- `apps/api/prisma/migrations/20260912090000_gateway_event_received_time/migration.sql`
- `apps/gateway/src/state/state-event-outbox.test.ts`
- `apps/gateway/src/state/event-sequence-store.ts`
- `apps/gateway/src/state/provisioning-scan-journal.ts`
- `apps/gateway/src/state/provisioning-device-journal.ts`
- `apps/gateway/src/state/provisioning-device-journal.test.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `apps/gateway/src/gateway.ts`
- `apps/gateway/src/mesh/bluez-model-codec.ts`
- `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- `apps/gateway/docker/mqtt-persistence.integration.mjs`
- `apps/gateway/src/runtime/serial-task-queue.ts`
- `apps/gateway/src/identity/certificate-rotation.ts`
- `apps/gateway/src/health/appliance-health.ts`
- `apps/gateway/docker/healthcheck.sh`
- `apps/esp32-h2-firmware/patches/esp-idf-v5.5.1-server-send-ownership.patch`
- `apps/esp32-h2-firmware/patches/esp-idf-v5.5.1-server-send-ownership.conf`
- `apps/esp32-h2-firmware/test/native/test_esp_idf_server_send_boundary.sh`
- `apps/esp32-h2-firmware/test/native/test_esp32_h2_idf_patch_gate.sh`
- `scripts/esp32-h2-idf-patch.sh`
- `scripts/esp32-h2-build.sh`
- `scripts/esp32-h2-artifact-audit.sh`
- `infra/mosquitto.acl.example`
- `scripts/dev-runtime.mjs`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/product-identity.ts`
- `packages/shared/src/mqtt.ts`

## 갱신 규칙

모니터링 메뉴의 UI, API, DB, MQTT, 실제 gateway, 펌웨어 계약이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.

## 2026-09-27 열린 운영 로그 보관 경계 (Task 5)

- 구현 완료: 전체 로그 drawer는 cursor 410의 최신 기록 복구와 최근 3개월 안내를 유지한다. 재조회 실패 때 이전 활동을 계속 표시하지 않으며 ticker도 실패한 캐시의 활동 내용을 숨긴다. 열린 활동의 달력 3개월 경계에서는 내용이 숨겨지고 API를 다시 조회하며 포커스·재연결도 재검증한다.
- 미구현: 운영 DB 활성화·과거 데이터 backfill·실제 현장 HIL은 이 Web 변경에 포함하지 않는다.
- 부족하거나 개선이 필요한 기능: 응답의 DB UTC `generatedAt`/`retainedFrom`과 요청 시작 단조 시계를 사용한다. 왕복 시간을 보수적으로 포함하여 조금 일찍 숨길 수 있으며, 시각 메타데이터 누락·오류는 숨김으로 처리한다. ticker는 조회 계층이 검증한 행만 표시하며 로컬 벽시계로 재판정하지 않는다. 실제 API↔Web 프록시 검증은 별도 통합 관문에 기록한다.
- 관련 파일: `apps/web/src/api/detail-retention.ts`, `apps/web/src/features/monitoring/{useMonitoringActivity,MonitoringLogDrawer,MonitoringLogTicker}`와 해당 테스트.
- 갱신 규칙: cursor 오류·재검증·활동 보관 정책이 바뀌면 제어 메뉴 문서와 이 항목을 함께 갱신한다.
- 검토 보완: 공통 보관 시계는 평년·윤년 2월 말의 비단조 cutoff를 날짜별로 검사한다. 3개월 뒤 월말의 첫 제외 시점을 마지막 날까지 미루지 않는다.

## 2026-10-07 고객 공통 테마 전환 조작 영역 (Task9 handoff)

- 구현 완료: 고객 공통 헤더의 테마 전환은 승인52px frame과 shrink 방지를 사용해 둥근 모서리 안에서도 연속44px 조작 영역을 제공한다. 실제320/390 Chromium 양 테마에서 헤더 로고·현장 선택·알람과 겹침/가로 넘침 없이 확인했고 테마 전환으로 추가 API 쓰기0을 유지한다.
- 미구현·한계: 실제 모바일 장비/HIL 및 전체 Task9 통합 완료를 뜻하지 않는다. 일반 Button/IconButton·공개/인증/운영자 기본 크기와 토큰은 변경하지 않았다.
- 관련 파일: `apps/web/src/components/ui/theme/ThemeToggle.tsx`, `CustomerThemeProvider.test.tsx`, `apps/web/e2e/support/layout-assertions.ts`, `apps/web/e2e/statistics-flow.spec.ts`.
- 갱신 규칙: 공통 헤더의 frame·조작 영역 변경 시 영향받는 네 메뉴의 검증 범위와 실제 장비 한계를 함께 갱신한다.

## 2026-10-07 공통 Grid 정렬 헤더 조작 영역 보완

- 구현 완료: 공통 DataGrid의 표 정렬 헤더만 기존 `rounded-none`을 사용한다. 내용 너비·44px 높이의 버튼에서 둥근 모서리가 연속44px hit 영역을 깎지 않도록 한 국소 예외이며 일반 Button/IconButton·카드 방향 버튼·토큰은 유지한다.
- 미구현: 서버 전체 정렬·새 API·실제 장비 기능을 추가하지 않는다. 정렬은 전달된 현재 목록 범위다.
- 부족하거나 개선이 필요한 기능: 단위 소비 회귀와 격리1023px Chromium은 소프트웨어 fixture 검증이며 전체 반응형 행렬·native200%·실제 모바일/HIL 완료를 뜻하지 않는다. 실제 hit 결과는 같은 작업 보고서에 기록한다.
- 관련 파일: `apps/web/src/components/ui/DataGrid.tsx`, `DataGrid.test.tsx`, `docs/ui-spacing.md`.
- 갱신 규칙: 헤더 radius·높이·너비 변경 시 실제 연속44px hit 및 표/카드·키보드·현재 목록 안정 정렬·행 작업과 API 쓰기0을 함께 회귀 검증한다.
