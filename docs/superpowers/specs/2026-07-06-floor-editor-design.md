# 층별 도면 에디터 설계

작성일: 2026-07-06

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

### 13.7 1,000개 표시 성능

- CAD 배경은 SVG/래스터 한 장으로 표시한다.
- 후보는 기본 이름 label 없이 하나의 Konva batch layer로 렌더링한다.
- 선택/hover된 후보만 상세 정보를 표시한다.
- 확대 수준과 viewport 기준으로 hit testing과 label을 제한한다.

### 13.8 정확도 판정 기준

정확도는 `재현된 유효 조명 위치 / 도면의 실제 유효 조명 심볼` recall과 `유효 조명 후보 / 전체 검출 후보` precision을 별도로 측정한다. 최종 보고값은 두 값의 조화 평균(F1)과 맵 기하 재현율로 제시하며, BLE 장비 identity 연결 정확도로 확대 해석하지 않는다.
