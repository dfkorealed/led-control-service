# 층별 도면 에디터 설계

작성일: 2026-07-06

## 2026-09-18 CAD 맵 교체와 조명 배치 슬롯 설계

상태: 사용자 설계 승인 완료. 이 절은 CAD 가져오기, 도면 배경, 조명 위치 후보와 실제 조명 배치에 관한 최신 기준이다. 아래의 과거 MVP 기록과 충돌하면 이 절을 우선한다.

### 목표와 제품 경계

- 신규 맵 배경 입력은 DWG/DXF만 허용한다. PNG/JPG 신규 업로드 UI와 API 허용은 제거한다. 이미 저장된 이미지 자산은 과거 맵·revision 조회가 깨지지 않도록 읽기 호환만 유지한다. PDF 신규 업로드 금지와 기존 자산 읽기 호환 정책은 유지한다.
- CAD 전체를 수만 개의 편집 객체로 변환하지 않는다. CAD는 좌표가 정규화된 SVG 배경으로 저장하고, 운영자가 직접 추가한 네모·세모·선·텍스트와 실제 조명만 Konva 편집 객체로 유지한다.
- CAD 조명 심볼에는 BLE 장비 identity가 없으므로 심볼을 실제 `Fixture`로 자동 연결하지 않는다. 검토에서 승인한 심볼은 영속적인 `조명 배치 슬롯`이 되며, 사용자가 등록된 실제 조명을 슬롯에 연결한다.
- 제공 샘플 `2단지지하주차장전등설비합본평면도20260803.dwg` 분석 결과는 model-space entity 26,887개, 현재 지원 기하 26,389개(예상 범위 98.1478%), 규칙 기반 조명 후보 1,302개다. 후보 검출 수는 실제 정답률이나 BLE identity 매핑 정확도를 의미하지 않는다.

### CAD 분석과 맵 영역 결정

1. 서버는 업로드, DWG 변환, DXF 분석, 도면 영역 결정, SVG 렌더링, 조명 후보 검출, 저장 순서로 처리한다.
2. 맵 영역은 단순 최솟값/최댓값으로 결정하지 않는다. 모델 공간의 drawable 밀도와 연결된 주요 기하를 기준으로 주 도면 영역을 구하고, 주 영역에서 비정상적으로 멀리 떨어진 고립 요소는 viewport 계산에서 제외한다.
3. 제외된 요소 개수와 전체 대비 비율을 검토 화면에 표시한다. 원본 파일은 변경하지 않고 보존하므로 이후 분석 규칙을 개선해 다시 가져올 수 있다.
4. SVG와 조명 후보 좌표에는 같은 affine transform을 적용한다. 맵은 원본 종횡비를 유지하면서 제품 viewport 상한 안으로 정규화하고, 검토 화면과 적용 후 첫 진입에서 전체 맵을 한 번 자동 맞춤한다.
5. 확대·축소 후 사용자가 바꾼 viewport는 polling, 후보 선택, 저장이나 background image load로 다시 덮어쓰지 않는다.

### CAD 요소 지원

- 기존 지원 요소인 LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, TEXT, MTEXT, INSERT와 block transform을 유지한다.
- 샘플에서 누락되는 WIPEOUT 397개는 경계 polygon과 배경색 마스크로, SPLINE 84개는 knot/control point 기반 표본 polyline으로 렌더링한다.
- DIMENSION 6개는 참조하는 anonymous dimension block을 우선 렌더링하고, block이 없으면 치수선과 문자 fallback을 사용한다. POINT 2개는 화면 배율에 종속되지 않는 작은 점 기호로 표시한다.
- HATCH 9개는 복잡한 pattern fill 전체를 재현하지 않고 boundary loop를 보존해 단색 또는 경계선으로 표시한다. 이 제한을 가져오기 결과에 명시하며, 맵 구조와 조명 배치 좌표를 잃지 않는 것을 우선한다.
- 지원하지 못한 엔티티 종류와 개수를 job 결과에 기록한다. 조용히 누락하지 않고 검토 화면에서 경고한다.

### 진행률과 새로고침 복구

- 서버 job의 진행 단계는 `대기 0%`, `업로드 확인 1~15%`, `DWG 변환 15~35%`, `DXF 분석 35~60%`, `영역·후보 분석 60~75%`, `SVG 렌더링 75~90%`, `저장 90~99%`, `검토 준비 완료 100%`로 정의한다.
- 긴 변환·분석 단계는 내부 처리량을 기준으로 단조 증가하는 진행률을 갱신한다. 실제 처리량을 알 수 없는 구간은 단계 시작값을 유지하고 완료되기 전에 임의로 100%를 표시하지 않는다.
- Web polling은 job `updatedAt` 변경 여부에 의존하지 않고 terminal 상태까지 고정 간격으로 이어간다. 일시적인 조회 실패는 진행 UI를 버리지 않고 명시적 재시도 상태로 전환한다.
- `review_required`가 되더라도 진행 바를 즉시 제거하지 않는다. `100% 분석 완료`를 표시한 상태에서 후보를 불러오고, 후보 조회가 끝난 뒤 검토 화면으로 전환한다.
- 새로고침하면 active job, rendered asset, viewport, 후보 선택 상태를 서버에서 다시 읽는다. 적용이 완료된 job은 `FloorPlan`과 현재 배치 슬롯을 기준으로 복원하며 과거 local state에 의존하지 않는다.
- SVG load 실패는 빈 화면으로 숨기지 않고 도면 로드 실패 상태와 재시도 버튼을 표시한다.

### 적용 전 확인과 원자적 맵 교체

`선택한 후보와 배경 적용`을 누르면 실제 변경 전에 다음 내용을 포함한 확인 dialog를 표시한다.

```text
새 CAD 도면으로 맵을 교체합니다.
기존 도형은 모두 삭제되고 배치된 조명은 모두 미배치 상태로 변경됩니다.
이 작업을 진행하시겠습니까?
```

- dialog에는 삭제할 수동 요소 수, 미배치로 전환할 실제 조명 수, 생성할 배치 슬롯 수를 함께 표시한다.
- 취소하면 job 검토 상태, 기존 맵과 조명 위치를 그대로 유지한다.
- 확인하면 editor lease와 expected revision을 다시 검증한 뒤 하나의 DB transaction에서 다음 변경을 처리한다.
  1. 기존 `FloorMapObject`를 모두 삭제한다.
  2. 해당 층의 모든 `Fixture`를 `placementStatus=unplaced`, `positionVerifiedAt=null`, `x=0`, `y=0`으로 바꾼다. 장비 등록, Mesh 주소, 그룹, 제어·전력 이력은 유지한다.
  3. 이전 현재 맵의 조명 배치 슬롯을 모두 삭제한다.
  4. 새 `FloorPlan`과 승인 후보 기반 배치 슬롯을 저장한다.
  5. 맵 revision snapshot, 변경 수 요약과 감사 로그를 기록한다.
  6. import job을 completed로 전환한다.
- 어느 단계든 실패하면 transaction 전체를 rollback한다. 배경만 바뀌거나 조명만 미배치되는 부분 적용은 허용하지 않는다.

### 영속 조명 배치 슬롯

완료된 import 후보를 운영 중인 맵의 정규 상태로 직접 사용하지 않고 다음 모델로 분리한다.

```text
FloorLightSlot
- id
- floorId
- sourceImportJobId
- sourceCandidateId
- x
- y
- rotation
- assignedFixtureId: String? (현재 맵 안에서 unique)
- createdAt
- updatedAt
```

- `FloorImportCandidate`는 분석·검토·감사 기록이며 수정하지 않는다. `FloorLightSlot`은 현재 맵의 실제 배치 작업 상태다.
- 미할당 슬롯은 캔버스에 빈 조명 위치로 표시한다. 할당 슬롯은 실제 조명 marker가 대신 표시되며 중복 할당할 수 없다.
- 왼쪽 미배치 목록의 조명을 슬롯으로 drag하면 슬롯이 강조되고 drop 시 슬롯의 정확한 x/y/rotation으로 배치한다. 슬롯 밖 자유 배치는 기존 수동 배치 기능으로 계속 허용하되 슬롯과 연결되지 않은 상태를 명확히 표시한다.
- 배치된 조명을 미배치로 바꾸면 fixture와 슬롯 연결을 같은 저장 transaction에서 해제한다. 실제 장비 등록과 제어 가능 상태는 유지한다.
- 식별 점멸로 실제 조명을 확인한 뒤 선택된 슬롯에 연결할 수 있다. 식별 ACK 자체가 위치 연결을 자동 완료하지 않으며 사용자의 명시적 확정을 요구한다.

### 조회와 렌더링

- 편집기 editor-state는 floor plan, 수동 요소, 실제 fixture와 함께 현재 맵의 슬롯 및 assignment를 반환한다.
- 모니터링은 저장된 CAD SVG, 수동 요소와 배치된 실제 조명을 읽기 전용으로 표시한다. 미할당 슬롯은 설정 편집기에서만 보이고 모니터링에는 표시하지 않는다.
- 1,000개 실제 조명과 최대 2,000개 슬롯을 기준으로 viewport culling, Konva layer 분리와 stable node identity를 유지한다. CAD 기하는 단일 SVG image node로 렌더링한다.
- SVG 응답의 MIME, gzip encoding, 크기, SHA-256과 floor 소유권을 조회 때 검증한다. 브라우저 image decode 실패도 관찰 가능한 오류로 처리한다.

### 렌더링 최적화 계약

- CAD SVG는 URL·asset revision별로 한 번만 decode하고 재사용한다. polling, 후보 선택, fixture 이동은 배경 `HTMLImageElement`를 다시 만들지 않는다. URL이 바뀔 때 이전 load handler를 해제하며 실패 상태도 cache key별로 분리한다.
- Background, grid, CAD slot, map object, fixture, selection/transformer를 서로 다른 Konva Layer로 분리한다. 배경과 grid는 `listening=false`, 정적인 레이어는 필요할 때만 `batchDraw`하고 fixture drag가 배경·전체 슬롯을 다시 그리지 않게 한다.
- fixture와 slot은 현재 viewport에 여백을 더한 사각형 안의 항목만 노드로 만든다. 배열 전체 필터는 pan/zoom 한 프레임마다 반복하지 않고 memoized spatial index 또는 bucket index로 조회한다.
- 배율별 LOD를 적용한다. 저배율에서는 fixture 이름, slot 부가 정보, 세부 stroke를 숨기고 marker만 유지하며, 선택·검색·식별 대상은 배율과 무관하게 표시한다.
- 왼쪽 fixture 목록과 후보 검토 목록은 가상화하거나 고정 window를 사용한다. 1,000~2,000개 항목을 동시에 DOM에 생성하지 않는다.
- pointer move와 pan/zoom의 React/Zustand 갱신은 animation frame당 최대 한 번으로 제한한다. 임시 drag 좌표는 Konva node에 반영하고 사용자 동작 완료 시 store에 한 번 커밋한다.
- 캔버스 크기·zoom·pan·선택 변경으로 무관한 노드의 React key나 callback identity가 바뀌지 않게 한다. 후보/slot/fixture ID를 stable key로 사용한다.
- SVG는 gzip 상태로 전송하고 브라우저에 중복된 base64/data URL 사본을 만들지 않는다. 원본 CAD와 렌더 SVG는 React state나 query cache에 byte buffer로 보관하지 않는다.
- 성능 합격 기준은 Chromium 1440x900, 1,000 fixtures, 2,000 slots, 2,000 map objects에서 warm 편집 준비 p95 3초 이내, pan/zoom 중 프레임 p95 33ms 이하, 단일 drag commit p95 100ms 이하, 저장 요청 p95 3초 이내다. 측정 환경과 cold/warm 조건을 결과에 기록한다.

### API와 계약 변경

- CAD apply 요청은 기존 lease/revision/candidate IDs에 `confirmMapReset: true`를 필수로 추가한다. 누락 또는 false면 서버가 적용을 거부한다.
- apply 응답은 삭제한 객체 수, 미배치 전환 fixture 수, 생성한 슬롯 수를 반환한다.
- editor-state와 atomic editor save 계약에 슬롯 조회 및 `fixtureId ↔ slotId` assignment 변경을 추가한다.
- PNG/JPG는 신규 floor asset upload intent와 직접 upload 양쪽에서 거부한다. CAD source와 rendered SVG 전용 MIME allowlist를 분리한다.
- DB schema 변경 시 `docs/database-schema.md`를 같은 작업에서 갱신한다.

### 검증 기준

- 단위 테스트: 진행 단계 단조 증가, polling terminal 전환, 100% 완료 표시, viewport outlier 제외, 신규 CAD entity parse/render, slot assignment와 중복 방지.
- API 통합 테스트: apply 확인값, lease/revision conflict, 전체 초기화와 slot 생성의 단일 transaction, 강제 실패 rollback, 새로고침 조회, 이미지 신규 업로드 거부.
- 실제 샘플 테스트: 제공 DWG의 주요 도면이 전체 맞춤에서 식별 가능하고 조명 후보 1,302개의 transform이 SVG 심볼 위치와 일치하는지 검증한다.
- 브라우저 테스트: 가져오기 진행률 변화, 완료 전환, 경고 dialog, 적용 후 새로고침, 미배치 목록, 슬롯 drag/drop, 배치 해제, 모니터링 반영을 실제 사용자 흐름으로 검증한다.
- 성능 테스트: 한 층 1,000개 fixture와 2,000개 슬롯에서 편집 진입, pan/zoom, drag와 save가 기존 제품 예산을 넘지 않아야 한다.

## 2026-09-09 최종 구현 범위

상태: 2026-09-10 소프트웨어 구현·단위/실DB/브라우저 검증 완료. 실제 장비 배포·검증은 사용자 요청으로 보류. 아래 내용은 최신 사용자 요청을 반영하며, 하단의 기존 MVP 기록과 충돌하면 이 절을 우선한다. 실행 체크리스트는 `../plans/2026-07-06-floor-editor-implementation.md`의 `2026-09-09 대량 배치 실행 계획`이다. 검증 범위와 보류 항목은 실행 체크리스트에 기록한다.

### 작업 공간과 보류 범위

- 설정의 기존 층별 에디터 경로를 유지하고 PC 마우스/키보드를 주 사용 환경으로 한다. 빈 캔버스, 네모/세모/선/텍스트, 색상, 이동/리사이즈를 기반으로 한 층 1,000개 조명을 편집한다.
- PDF/JPG/PNG 업로드·교체·페이지 선택·자르기·축척 보정, CAD/DWG/DXF 가져오기, AI 도면 해석과 도면에서 조명 심볼 추출은 모두 보류한다. 이번 신규 작업 UI에서 업로드·교체 진입점을 제공하지 않는다.
- 이미 저장된 배경 자산, 원본과 좌표는 삭제하거나 재해석하지 않는다. 기존 배경은 기존 크기/좌표계로 호환 표시한다. 신규 배경 없는 층은 기존 기본 1200x800 논리 좌표계를 사용하며 실측 미터로 표시하지 않는다.
- 빈 캔버스에서 사용자가 지정한 사각형/통로에 격자·선형 배치하는 기능은 포함한다. 이는 기존 파일 도면 분석과 무관하다.
- 실제 좌표 자동 측정, QR/CSV 설치 위치표 가져오기, 카메라 기반 식별은 후속 범위로 둔다. RSSI나 발견 순서를 실제 위치로 해석하지 않는다.

### 배치와 위치 확인 상태

- 등록 여부와 지도 배치는 별개다. 구현 데이터는 `Fixture.placementStatus: unplaced | placed`, `Fixture.positionVerifiedAt: DateTime?`이며, 공유 계약과 migration은 실행 Task 1에서 검증했으며 사용자 DB 적용은 후속이다.
- 신규 등록은 `unplaced`, 확인 시각 없음으로 시작한다. 기존 필수 숫자 x/y는 호환성을 위해 유지하지만 미배치 상태에서는 위치로 사용하지 않는다. 등록 과정의 격자 공간 부족 때문에 provisioning을 거부하지 않도록 변경한다.
- 기존 조명은 좌표 유실 없이 `placed`로 이전하고 확인 시각은 비워 둔다. 기존 좌표가 실제 위치인지는 추정하지 않는다. 저장된 이전 버전도 배치 상태가 없으면 같은 규칙으로 읽는다.
- UI 상태는 `미배치`, `배치됨 · 위치 미확인`, `배치됨 · 위치 확인`이다. 드롭/자동 배치는 `placed`가 되지만 실물 위치 확인을 자동 완료하지 않는다. 좌표를 변경하거나 배치를 해제하면 이전 위치 확인은 무효화한다. 이름·크기만 변경하면 확인을 유지한다.
- `unplaced`이면 확인 시각은 반드시 없음이다. 서버가 조명/현장/층 권한과 좌표 범위를 검증하고 확인 시각을 부여한다. 장비 명령 ACK는 사용자 위치 확인을 대신하지 않는다.

### 드래그 배치와 배치 해제

1. 왼쪽 `전체 / 배치 / 미배치` 목록에서 미배치 조명을 도면으로 끌어 놓으면 포인터 위치에 조명 중심을 배치한다. 줌, 팬, 컨테이너 위치와 스크롤을 좌표 변환에 반영한다.
2. 드래그 중 미리보기만 표시하고 정상 drop 때 한 번만 초안을 변경한다. 캔버스 밖 drop, Escape, 읽기 전용, 편집권 만료에서는 변경하지 않는다. 같은 fixture ID를 중복 생성하지 않는다.
3. 단일 배치 조명을 클릭하면 조명 우상단에 작은 휴지통 아이콘을 표시한다. 툴팁과 접근성 이름은 `배치 해제`다. 시각 크기와 별개로 충분한 클릭 영역을 확보하며, 줌에 따라 버튼이 너무 작아지지 않게 화면 좌표 오버레이로 배치한다.
4. 버튼은 리사이즈 핸들과 겹치지 않게 바깥쪽에 두며, 캔버스 가장자리에서는 안쪽으로 이동한다. 버튼 클릭이 조명 드래그나 선택 해제로 전파되지 않게 한다.
5. 확인 팝업 제목은 `이 조명을 도면에서 제거할까요?`, 본문은 `{조명명}이 미배치 목록으로 이동합니다. 장비 등록, 제어와 사용 기록은 유지됩니다.`, 버튼은 `취소 / 배치 해제`로 한다. Enter 기본 동작, Escape와 포커스 복귀를 검증한다.
6. 취소하면 모든 상태를 유지한다. 확인하면 로컬 초안에서만 `unplaced`로 변경해 왼쪽 목록에 돌려놓고 선택·위치 확인 표시를 해제한다. 최종 저장 때 DB에 반영하며 Undo로 직전 좌표에 복원할 수 있다.
7. 재배치는 같은 조명을 다시 드롭한다. Mesh 재등록, 장비 초기화, 조명 레코드 삭제, 그룹 해제나 MQTT 명령을 발생시키지 않는다. 조명 복제 기능은 제공하지 않는다.
8. 이번 범위의 배치 해제는 단일 조명 버튼이다. 다중 선택은 이동·정렬·속성·배치에 사용하고 일괄 배치 해제는 추가하지 않는다.

### 대량 편집과 위치 확인

- 목록 검색, 배치 여부 필터, 목록 가상화, 검색 조명으로 화면 이동, 박스/Shift 다중 선택, 일괄 이동, 행/열 정렬·균등 분배, 스냅과 키보드 미세 이동을 제공한다.
- 격자/선형 배치는 선택된 실제 fixture ID만 이동한다. 행/열·방향·간격을 미리보기하고 한 번에 적용한다. 배치 영역은 편집 보조 영역이며 제어 그룹/스케줄/이벤트 대상을 변경하지 않는다.
- 일괄 이름/표시 크기/정격 전력은 혼합값과 변경 대상을 표시한다. 이름은 결과 미리보기를 거치고, 정격 전력 변경은 기존 에너지 정산 경계를 유지한다.
- Undo/Redo는 하나의 사용자 동작을 한 단위로 처리한다. 저장은 편집기를 유지하고 기존 lease/revision/충돌 검사를 재사용한다. 실패 시 초안을 유지하며 로컬 복구 초안은 사용자/현장/층/revision으로 격리하고 계정 로그아웃 시 정리한다.
- 레이어 표시·잠금, 도면 맞춤·선택 맞춤, 포인터 중심 휠 줌, 팬과 미니맵을 제공한다. 축소 상태에서는 이름을 줄이고 선택/검색 결과를 강조한다.
- `조명 위치 확인`은 등록된 조명을 한 번에 하나씩 짧게 식별 점멸하고 사용자가 위치를 클릭한 후 `위치 확인`을 명시적으로 완료하는 작업이다. 다음 조명, 재확인, 중지, 건너뛰기와 미응답 표시를 제공한다.
- 웹/API/MQTT/Gateway/ESP32-H2에 등록 후 식별 명령을 연결한다. 기존 Gateway의 100% 밝기 설정을 완료 기능으로 재사용하지 않는다. Health Attention 기반 시작/중지, 장비 측 자동 만료, 늦은 명령 만료, 중복/연속 식별, 다른 사용자 요청과 편집권 상실을 처리한다.
- 점멸 중에도 정상 수동/스케줄/이벤트의 목표 밝기는 추적한다. 종료하면 과거 밝기를 무조건 덮어쓰지 않고 최신 정상 제어 목표로 복귀한다. 식별을 지도 좌표 측정 또는 위치 확인 완료로 응답하지 않는다.

### 다른 메뉴와 검증

- 모니터링은 배치된 조명만 지도 마커로 표시한다. 미배치 조명은 목록과 개수에 남기고 조회·제어를 허용한다. 등록 조명이 있는데 모두 미배치인 경우 `등록된 조명 없음` 안내를 표시하지 않는다.
- 제어/스케줄/이벤트/그룹과 통계 집계는 배치 상태로 대상을 제외하지 않는다. map revision 저장·복구는 배치/위치 확인 상태를 포함하고 장비 등록 생명주기에는 관여하지 않는다.
- Konva 레이어/구독 분리, 안정적인 노드 참조, 화면 크기 Stage, 이름 표시 축소와 변경 ID 추적을 적용한다. 서버는 명시적 요청 크기 한도와 대량 저장/복구 예산, 좌표 묶음 갱신을 사용한다.
- 실제 HTTP/PostgreSQL과 브라우저에서 1,000개 드롭·다중 이동·저장·재조회·복구 및 배치 해제 후 제어/통계 유지 등을 검증한다. 하드웨어 점멸과 정상 밝기 복귀는 Raspberry Pi/ESP32-H2/LED 실기 증거로 별도 확인한다.

## 1. 목표

모니터링 페이지 안에 전체 화면 편집 모드를 추가해 각 층의 도면, 도형, 텍스트, LED 조명 위치와 기본 정보를 수정할 수 있게 한다.

도면 배경은 필수가 아니다. 사용자는 PDF, JPG, PNG 도면을 배경으로 올릴 수도 있고, 배경 없이 에디터 도형, 텍스트, 색상, 조명 객체만으로 층 구성을 표현할 수도 있다.

장기적으로는 AI가 업로드된 도면을 읽고 벽, 기둥, 주차 구역, 램프, 조명 후보 위치를 에디터 객체로 변환할 수 있어야 한다.

## 2. 제품 방향

에디터는 CAD 제작 도구가 아니라 `도면 위 관제 객체 편집기`로 설계한다.

즉, 사용자가 모든 주차장 구조를 처음부터 그리게 하는 것이 기본 목표가 아니다. 기존 도면이 있으면 배경으로 사용하고, 도면이 없거나 보완이 필요하면 도형과 텍스트로 운영에 필요한 정보만 덧그린다.

모니터링 페이지에서 `에디터` 버튼을 누르면 읽기 화면이 전체 화면 편집 workspace로 전환된다.

```text
모니터링 읽기 모드
→ 에디터 버튼
→ 전체 화면 편집 모드
→ 저장 또는 취소
→ 모니터링 읽기 모드 복귀
```

## 3. MVP별 범위

### 3.1 MVP 1: 수동 도면 에디터

MVP 1은 사용자가 직접 층별 편집을 수행하는 단계다.

포함 기능:

- 모니터링 페이지에 `에디터` 버튼 추가
- 현재 선택 층 기준 전체 화면 편집 모드 진입
- 층 선택 유지
- 도면 배경 선택 등록
  - 배경 없음 허용
  - JPG/PNG 원본 이미지 사용
  - PDF는 첫 페이지만 이미지로 렌더링해서 사용
- 줌인, 줌아웃, 팬
- 네모, 세모, 선, 텍스트 도구를 좌측 툴바에서 도면으로 드래그 앤 드롭해 기본 크기로 추가
- 좌측 도구 선택 후 도면 위를 드래그해 크기를 지정하는 생성 방식도 보조로 지원
- 단순 클릭 생성은 사용자가 의도하지 않은 객체 생성을 막기 위해 사용하지 않음
- 생성된 도형과 텍스트의 단일 선택, 드래그 이동, Konva Transformer 모서리/변 핸들 리사이즈
- LED 조명의 단일 선택, 드래그 이동, Konva Transformer 리사이즈
- 도형의 선 색상, 채움 색상, 선 두께, 텍스트 수정
- LED 조명 객체 표시
- 조명 단일 선택
- 조명 단일 드래그 이동
- 조명 이름, 정격 W, 좌표 수정
- 저장, 취소
- 저장 후 dashboard 다시 조회

MVP 1 제외 기능:

- 조명 여러 개 일괄 이동
- 객체 복사/붙여넣기
- CAD/DWG/DXF import
- PDF 다중 페이지 선택
- AI 도면 해석
- RF heatmap
- undo/redo 전체 이력
- 도형 고급 boolean 편집

### 3.2 MVP 2: 대량 편집과 자동 배치 보조

MVP 2는 현장 조명 수가 많을 때 편집 시간을 줄이는 단계다.

포함 기능:

- 드래그 박스 다중 선택
- 여러 조명 일괄 이동
- 여러 도형 일괄 이동
- 구역 기반 조명 자동 배치
  - 사각형 또는 다각형 구역 지정
  - 조명 개수 또는 행/열 입력
  - 균등 격자 배치
  - 사용자가 후속 보정
- grid/snap 옵션
- 도형/조명 잠금
- 변경 이력 요약
- 저장 전 변경 개수 표시

### 3.3 MVP 3: AI 도면 해석과 CAD 연동

MVP 3는 업로드된 도면을 분석해 에디터 객체로 변환하는 단계다.

포함 기능:

- PDF/이미지 도면에서 구조 요소 후보 탐지
  - 벽
  - 기둥
  - 주차 구획
  - 램프
  - 출입구
  - 조명 심볼 후보
- AI 인식 결과를 에디터 객체로 변환
  - 선, 네모, 텍스트, 조명 후보
- 사용자가 후보를 승인/삭제/수정
- DXF/CAD 파일의 조명 block 또는 layer 좌표 추출
- AI 자동 배치 결과와 실제 BLE Mesh 등록 결과 매칭
- 통신 품질 RSSI/hop 지표를 도면 위 heatmap으로 표시

MVP 3에서도 AI 결과는 바로 확정하지 않는다. 항상 사람이 확인하고 저장하는 semi-auto workflow로 둔다.

## 4. 에디터 UI 구조

A안, 즉 `모니터링 안의 전체 화면 편집 모드`로 구현한다.

```text
┌────────────────────────────────────────────────────┐
│ 상단 바: 층 선택 / 저장 / 취소 / 확대 / 축소       │
├──────────┬─────────────────────────────┬───────────┤
│ 좌측 툴바 │ 중앙 캔버스                  │ 우측 속성 │
│ 선택     │ 도면 배경                    │ 선택 객체 │
│ 손       │ 도형 레이어                  │ 이름      │
│ LED      │ 조명 레이어                  │ 색상      │
│ 네모     │ 선택 레이어                  │ 좌표      │
│ 세모     │                             │ 정격 W    │
│ 선       │                             │           │
│ 텍스트   │                             │           │
└──────────┴─────────────────────────────┴───────────┘
```

## 5. 레이어 모델

캔버스는 다음 레이어로 분리한다.

1. Background Layer
   - 선택적 도면 배경
   - PDF/JPG/PNG 렌더링 이미지
   - 배경이 없으면 흰색 또는 grid 배경

2. Drawing Layer
   - 네모
   - 세모
   - 선
   - 텍스트
   - 색상 영역

3. Fixture Layer
   - LED 조명
   - 상태 색상
   - 선택 시 이름/밝기 표시

4. Selection Layer
   - 선택 outline
   - transform handle
   - MVP 2의 다중 선택 박스

## 6. 기술 선택

MVP 1의 현재 구현은 `react-konva`와 `konva` 기반 Canvas 에디터를 사용한다.

현재 구현 이유:

- Canvas 기반이라 1000개 조명 렌더링에 DOM 방식보다 유리하다.
- 네모, 선, 텍스트, 드래그, 선택, transform 구현을 Konva 노드와 Transformer로 일관되게 처리할 수 있다.
- 조명도 도형과 같은 Transformer 리사이즈 흐름을 사용할 수 있다.
- 편집기와 읽기 전용 `FloorMap`을 분리해 기존 모니터링 화면의 안정성을 유지할 수 있다.

PDF 첫 페이지 렌더링은 `pdfjs-dist`를 사용한다.

상태 관리는 기존 프로젝트의 `zustand`를 사용한다.

## 7. 데이터 모델

### 7.1 기존 모델 활용

`Fixture`는 조명 위치와 기본 정보를 계속 담당한다.

- `Fixture.x`
- `Fixture.y`
- `Fixture.name`
- `Fixture.ratedWatt`

`FloorPlan`은 배경 도면을 담당한다.

- `FloorPlan.imageUrl`
- `FloorPlan.width`
- `FloorPlan.height`
- `FloorPlan.version`

### 7.2 FloorPlan 확장

도면 원본과 렌더링 결과를 구분하기 위해 다음 필드를 추가한다.

```text
sourceType: none | image | pdf
originalFileUrl: String?
renderedImageUrl: String?
```

배경 없음 상태는 `FloorPlan`이 없거나 `sourceType = none`인 상태로 표현한다.

### 7.3 새 모델: FloorMapObject

도형과 텍스트는 `Fixture`와 분리한다.

```text
FloorMapObject
- id
- floorId
- type: rectangle | triangle | line | text
- x
- y
- width
- height
- rotation
- points
- text
- strokeColor
- fillColor
- strokeWidth
- fontSize
- zIndex
- locked
- visible
- createdAt
- updatedAt
```

`points`는 선과 삼각형처럼 점 배열이 필요한 객체에 사용한다. PostgreSQL에서는 `Json`으로 저장한다.

## 8. API 설계

### 8.1 Editor State 조회

```text
GET /floors/:floorId/editor-state
```

반환:

```ts
interface FloorEditorState {
  floor: {
    id: string;
    siteId: string;
    name: string;
    level: number;
  };
  floorPlan: {
    id: string;
    sourceType: "none" | "image" | "pdf";
    imageUrl: string | null;
    originalFileUrl: string | null;
    renderedImageUrl: string | null;
    width: number;
    height: number;
    version: number;
  } | null;
  fixtures: Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    ratedWatt: number;
    status: "online" | "offline" | "fault";
    brightness: number;
  }>;
  objects: FloorMapObjectDto[];
}
```

### 8.2 도면 배경 저장

```text
PATCH /floors/:floorId/floor-plan
```

입력:

```ts
interface UpdateFloorPlanRequest {
  sourceType: "none" | "image" | "pdf";
  imageUrl?: string;
  originalFileUrl?: string;
  renderedImageUrl?: string;
  width: number;
  height: number;
}
```

MVP 1에서는 실제 파일 업로드 저장소를 복잡하게 만들지 않고, API가 받을 수 있는 file upload endpoint와 정적 파일 저장 디렉터리를 제공한다.

### 8.3 조명 수정

```text
PATCH /fixtures/:fixtureId
```

입력:

```ts
interface UpdateFixtureRequest {
  name?: string;
  ratedWatt?: number;
  x?: number;
  y?: number;
}
```

### 8.4 도형 저장

```text
POST /floor-map-objects
PATCH /floor-map-objects/:objectId
DELETE /floor-map-objects/:objectId
```

MVP 1에서는 생성, 수정, 삭제를 모두 제공한다. 사용자가 삭제 기능을 조명에는 원하지 않았지만, 도형은 실수로 만든 객체를 제거할 수 있어야 에디터 사용성이 성립한다.

## 9. 저장 정책

편집 중에는 DB에 즉시 저장하지 않는다.

```text
편집 모드 진입
→ editor-state 조회
→ local draft 생성
→ 사용자 편집
→ 변경분 표시
→ 저장 클릭
→ 변경된 항목만 API 전송
→ dashboard invalidate
→ 읽기 모드 복귀
```

취소를 누르면 local draft를 버린다.

저장 전에는 다음 경고를 표시한다.

```text
저장되지 않은 변경 12개
```

## 10. 성능 정책

- 편집 모드는 Canvas 기반으로 렌더링한다.
- 줌 레벨이 낮을 때는 조명 이름을 숨긴다.
- 선택된 조명만 상세 label과 transform handle을 표시한다.
- 드래그 중에는 서버 요청을 보내지 않는다.
- 저장 시 변경된 fixture/object만 전송한다.
- 조명 1000개 기준으로 zoom/pan/drag가 끊기지 않는 것을 성능 기준으로 둔다.

## 11. 문서 갱신 대상

에디터 구현 시 다음 문서를 함께 갱신한다.

- `docs/menus/monitoring.md`
- `docs/database-schema.md`
- `docs/superpowers/specs/2026-07-01-led-lighting-control-service-design.md`

## 12. 확정 결정

- 에디터 UI는 A안, 모니터링 내부 전체 화면 편집 모드로 구현한다.
- MVP 1에 도형까지 포함한다.
- 도면 배경은 선택 사항이다.
- 배경이 없어도 도형, 텍스트, LED 조명으로 층 구성을 표현할 수 있어야 한다.
- AI 도면 해석은 MVP 3 범위로 둔다.

## 13. DWG/DXF 자동 맵 구성 확장 (2026-09-16)

### 13.1 범위

- 신규 자동 가져오기는 `DWG`, `DXF`만 지원한다. PDF 자동 해석은 지원하지 않는다.
- JPG/PNG 수동 배경 등록과 기존 PDF 읽기 호환은 유지하되 신규 PDF 업로드는 제공하지 않는다.
- CAD 선·폴리라인·원·호·문자 등은 하나의 렌더 배경으로 변환해 표시한다. 수만 개 CAD entity를 `FloorMapObject`로 만들지 않는다.
- CAD의 조명 심볼은 `조명 위치 후보`로 저장하고 맵 편집기에 표시한다.
- 후보는 실제 BLE Mesh 조명이 아니므로 `Fixture`, `MeshNode`를 생성하거나 자동 등록·자동 바인딩하지 않는다.
- 등록된 실제 조명과 후보의 연결 및 식별은 기존 조명 배치/식별 흐름에서 사용자가 수행한다.

### 13.2 처리 흐름

```text
관리자 DWG/DXF 업로드
→ private object storage 원본 보관
→ PostgreSQL job/lease worker가 변환기 실행
→ 정규화된 CAD 문서 생성
→ 규칙 기반 조명 심볼 분류
→ 단일 SVG 배경과 위치 후보 생성
→ 관리자 검토
→ editor lease·map revision을 확인하고 맵에 적용
```

API 요청 프로세스에서 큰 CAD를 직접 파싱하지 않는다. 작업 상태는 `queued → processing → review_required → applying → completed` 또는 `failed/cancelled`로 영속화하고, worker 재시작 후에도 lease 만료 작업을 재개한다.

### 13.3 변환기 경계

- 제품 코드는 특정 CAD SDK에 결합하지 않는 `CadConverter` 인터페이스를 사용한다.
- 양산 기본 어댑터는 상용 배포·DWG 호환성이 명확한 ODA 계열 변환기를 사용한다.
- 개발 환경에서는 명시적으로 설정한 CLI 어댑터를 사용할 수 있다. 실행 파일 경로와 argv를 분리하고 shell 문자열을 실행하지 않는다.
- LibreDWG는 샘플 분석과 개발 검증에만 사용한다. GPL 배포 검토 없이 양산 이미지에 포함하지 않는다.
- 변환 시간, 출력 크기, entity 수, 좌표 범위에 상한을 두고 초과하면 fail-close한다.
- 양산 변환기는 API와 자격 증명·UID·PID namespace·network·memory cgroup을 분리한 sidecar에서 실행한다. 공유 spool readiness는 digest와 instance별 만료 heartbeat를 함께 검증하며, 취소 시 terminal 응답 또는 제한 시간까지 directory 소유권을 sidecar에 유지한다.
- 양산 API 임시 공간은 source 50 MiB, DXF 256 MiB, raw SVG 128 MiB, gzip SVG 8 MiB와 filesystem overhead 64 MiB를 동시에 수용하는 512 MiB로 고정하고, worker는 렌더 전에 200 MiB 가용 공간을 예약한다.

### 13.4 조명 후보 검출

규칙 기반 검출은 다음 증거를 함께 사용한다.

1. 레이어 이름: `조명`, `전등`, `LIGHT`, `LAMP`, `LED` 등의 현장 프로필 패턴
2. 블록 이름과 INSERT 반복 빈도
3. 블록 속성 및 주변 문자
4. 동일 블록의 반복 배치와 비정상 단일 장식 심볼 제외

좌표와 회전은 항상 CAD parser 결과를 사용한다. AI가 좌표를 생성하게 하지 않는다.

### 13.5 AI 확장점

초기 배포의 AI provider는 `disabled`다. `LightingSymbolDetector` 계약은 규칙 기반과 AI 보조 구현이 같은 입력·출력을 사용하게 분리한다.

```ts
interface LightingSymbolDetector {
  detect(document: NormalizedCadDocument): Promise<DetectedLightingSymbol[]>;
}
```

향후 AI 구현은 규칙으로 판정하지 못한 레이어·블록의 의미만 분류하며, 원본 CAD 전체와 고객 정보의 외부 전송은 별도 보안·비용 승인을 통과한 뒤 활성화한다. AI 결과에도 provider, model, confidence, 입력 digest를 기록해 재현 가능하게 한다.

### 13.6 데이터 및 적용 정책

- `FloorImportJob`: 원본/렌더 자산, 상태, 단계, 진행률, parser·detector 버전, lease, 오류를 저장한다.
- `FloorImportCandidate`: source entity, layer/block, 정규화 좌표, 회전, 신뢰도, 검출 방법과 검토 상태를 저장한다.
- 한 층에는 동시에 하나의 활성 import job만 허용한다.
- 적용은 기존 편집기 lease와 예상 revision을 필수로 받고, 렌더 배경 연결·후보 적용·revision·audit을 한 transaction에서 처리한다.
- 적용한 accepted 후보는 현재 렌더 배경과 map revision에 결속된 읽기 전용 오버레이로 재조회한다. 새로고침 뒤에도 실제 등록 조명의 배치·식별 기준점으로 사용할 수 있지만 `Fixture`, `MeshNode`, `FloorMapObject`로 자동 승격하지 않는다.
- 가져오기 재실행은 기존 실제 조명 좌표와 수동 도형을 임의로 삭제하거나 덮어쓰지 않는다.
- CAD 원본 단위는 맵 픽셀로 직접 저장하지 않는다. 렌더러는 원본 종횡비를 유지하면서 도형을 최대 `2400 × 1600` 논리 좌표 안에 배치하고, 양 축에 40px 이상 여백과 최소 800px 맵 변을 확보한다.
- SVG 도형과 조명 후보는 동일한 scale·translation·Y축 반전 행렬을 사용한다. 따라서 정규화 이후에도 후보 중심은 원본 심볼 위치와 일치해야 한다.
- 정규화 도입 전에 적용된 CAD 자산은 자동 변환하지 않는다. 원본을 다시 가져오고 적용해야 새 좌표 계약을 사용한다.

### 13.7 1,000개 표시 성능

- CAD 배경은 SVG/래스터 한 장으로 표시한다.
- SVG의 width, height와 viewBox도 정규화된 맵 크기를 사용해 브라우저가 수천만 픽셀 크기의 이미지를 디코딩하지 않게 한다.
- 후보는 기본 이름 label 없이 하나의 Konva batch layer로 렌더링한다.
- 선택/hover된 후보만 상세 정보를 표시한다.
- 확대 수준과 viewport 기준으로 hit testing과 label을 제한한다.
- 검토 배경 또는 적용된 CAD overlay가 처음 표시될 때 현재 편집 영역에 전체 맵을 한 번 맞춘다. 이후 사용자가 수행한 확대·축소와 이동은 같은 자산이 표시되는 동안 자동 맞춤이 덮어쓰지 않는다.

### 13.8 정확도 판정 기준

정확도는 `재현된 유효 조명 위치 / 도면의 실제 유효 조명 심볼` recall과 `유효 조명 후보 / 전체 검출 후보` precision을 별도로 측정한다. 최종 보고값은 두 값의 조화 평균(F1)과 맵 기하 재현율로 제시하며, BLE 장비 identity 연결 정확도로 확대 해석하지 않는다.
