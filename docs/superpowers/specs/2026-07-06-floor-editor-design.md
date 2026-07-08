# 층별 도면 에디터 설계

작성일: 2026-07-06

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
