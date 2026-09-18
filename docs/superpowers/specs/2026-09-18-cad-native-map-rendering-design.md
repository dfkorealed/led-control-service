# CAD 네이티브 맵 변환 및 고성능 렌더링 설계

## 1. 목표

DWG/DXF 도면을 단일 배경 SVG로만 표시하지 않고, 사용자가 선택하고 편집할 수 있는 맵 요소로 변환한다. 한 층에 조명 1,000개와 CAD 기본 도형 수십만 개가 있어도 PC 웹과 React Native WebView에서 이동, 확대, 선택이 끊기지 않아야 한다.

## 2. 설계 원칙

- CAD 요소를 `FloorMapObject` 행이나 Konva 노드로 1:1 생성하지 않는다.
- CAD 요소는 의미가 있는 네이티브 primitive로 변환하되 타일 단위 압축 scene asset으로 저장한다.
- 사용자가 직접 만든 도형은 기존 `FloorMapObject`를 유지한다.
- 가져온 CAD 요소 중 사용자가 실제로 수정한 요소만 override로 DB에 저장한다.
- 대량 CAD 장면은 PixiJS WebGL로 렌더링하고, 선택된 CAD 요소와 조명·수동 도형은 Konva 편집 오버레이에서 처리한다.
- HTML/SVG DOM 요소를 대량 생성하지 않는다.
- PC와 모바일 WebView는 동일한 scene format과 렌더링 코드를 사용한다.

## 3. 맵 좌표와 크기

- 실제 화면 canvas 크기와 논리 맵 크기를 분리한다.
- 선택한 CAD 영역은 종횡비를 유지한다.
- 긴 변의 기본 크기는 `8192` logical unit이다.
- 짧은 변은 최소 `1024`, 긴 변은 최대 `16384`로 제한한다.
- 원본 종횡비 때문에 제한을 동시에 만족할 수 없으면 긴 변 16384를 우선하고 짧은 변은 최소 512까지 허용한다.
- 외곽 여백은 긴 변의 2%, 최소 64 logical unit이다.
- gridSize 기본값은 논리 맵 긴 변의 약 1/200에 가장 가까운 5 단위 값으로 정하며 10~100 범위로 제한한다.
- 화면 framebuffer는 viewport 크기로만 생성한다. 16384 크기의 bitmap canvas를 생성하지 않는다.

## 4. CAD 영역 선택

전체 model space의 bounds를 그대로 사용하지 않는다.

1. 블록이 확장된 geometry를 공간적으로 군집화한다.
2. 빈 공간으로 분리된 평면도, 상세도, 표제란, 외부 참조 영역을 별도 region으로 만든다.
3. region별 bounds, primitive 수, 면적, 문자/조명 후보 수와 미리보기를 생성한다.
4. 의미 있는 region이 하나면 자동 선택한다.
5. 여러 region이면 `영역 선택 필요` 검토 단계에서 사용자가 한 층 영역을 선택한다.
6. 선택하지 않은 region은 현재 맵 scene에 포함하지 않는다.

현재 제공된 대형 DWG처럼 멀리 떨어진 여러 도면이 한 model space에 있는 경우에도 선택 영역 하나만 맵 크기로 정규화한다.

## 5. 네이티브 CAD 요소

scene primitive 종류는 다음과 같다.

- `line`: 단일 선분
- `polyline`: 열린/닫힌 다중 선분
- `rectangle`: 직교 폐합 polyline에서 인식한 사각형
- `triangle`: 3개 꼭짓점 폐합 polyline
- `ellipse`: 원과 타원
- `arc`: 원호
- `text`: TEXT/MTEXT의 정규화된 문자열과 bounds

HATCH, DIMENSION, INSERT는 다음과 같이 처리한다.

- HATCH는 외곽/내곽 path를 단순화한 `polyline` 묶음 또는 저배율 전용 fill batch로 변환한다.
- DIMENSION은 선과 text를 하나의 group으로 묶는다.
- INSERT는 occurrence path를 보존한 group으로 확장한다.
- 조명 심볼 INSERT는 CAD scene에도 남기되 `FloorLightSlot` 후보로 별도 추출한다.

각 요소는 `elementId`, `groupId`, `layerName`, `sourceType`, bounds, style, geometry를 갖는다. 반복 블록 안의 같은 handle은 occurrence path와 transform을 포함해 안정적인 고유 ID를 만든다.

## 6. 저장 구조

### FloorImportRegion

- jobId와 안정적인 regionId
- 원본 bounds, primitive/text/light candidate 수
- previewAssetId와 선택 시각
- 같은 job 안에서는 regionId가 유일하며 여러 region 중 하나만 선택할 수 있다.

### FloorCadScene

- floorId, sourceImportJobId, version
- width, height, tileSize=512
- primitiveCount, tileCount
- manifestAssetId
- 선택 region 원본 bounds와 정규화 transform
- 상태와 생성 시각

### FloorCadTile

- sceneId, tileX, tileY, lod
- assetId
- primitiveCount, byteSize
- bounds

타일 본문은 압축 binary scene format으로 object storage에 저장한다. DB에는 geometry 전체를 JSON으로 넣지 않는다.

### FloorCadElementOverride

- sceneId, elementId
- hidden, transform, strokeColor, fillColor, strokeWidth, text
- updatedAt

원본 scene은 불변이며 수정된 요소만 override로 저장한다.

### FloorCadLayerState

- sceneId, layerName
- visible, locked

기존 `FloorMapObject`와 `FloorLightSlot`은 유지한다.

- `FloorPlanSourceType`에는 `cad`를 추가하고 적용된 native scene은 이를 사용한다.
- `FloorAssetKind`에는 `cad_manifest`, `cad_tile`, `cad_region_preview`를 추가해 원본·SVG preview와 수명주기를 구분한다.

## 7. 타일과 LOD

- logical tile 크기는 512이다.
- LOD 0은 주요 구조와 조명 심볼만 포함한다.
- LOD 1은 주차선, 일반 polyline과 주요 text를 포함한다.
- LOD 2는 치수, 해치, 세부 text를 포함한다.
- viewport와 주변 1 tile ring만 요청한다.
- 동일 scene/version/tile은 브라우저 cache와 메모리 LRU에서 재사용한다.
- Web Worker가 압축 해제, binary decode와 CPU 공간 인덱스 생성을 담당한다.
- pan/zoom 도중에는 기존 타일을 유지하고 새 타일이 준비되면 교체한다.

## 8. 렌더링 및 편집

### PixiJS 레이어

- PixiJS v8의 명시적 WebGL renderer를 사용한다.
- tile/layer/style별로 geometry를 batch한다.
- primitive 하나마다 `Graphics` 객체를 만들지 않는다.
- 정지 화면은 지속 ticker 없이 변경 시에만 render한다.
- mobile resolution은 1, desktop은 최대 1.5로 제한한다.
- 화면 밖 타일과 LOD는 GPU 리소스를 해제한다.

### Konva 오버레이

- 조명, 수동 `FloorMapObject`, 선택 영역, guide와 Transformer를 렌더링한다.
- 선택된 CAD group 또는 element만 Pixi batch에서 임시 제외하고 Konva 편집 노드로 승격한다.
- 편집 종료 시 override를 저장하고 Pixi tile을 부분 갱신한다.
- 기본 클릭은 block/group을 선택하고 더블클릭은 내부 element를 선택한다.

### 선택과 hit test

- WebGL 픽셀 색상 기반 hit canvas를 사용하지 않는다.
- tile worker가 만든 spatial index로 pointer 주변 후보를 찾는다.
- 확대 배율을 반영한 화면 8px 이내 후보 중 z-order와 거리로 선택한다.
- 다중 선택은 intersecting bounds를 index에서 질의한다.

## 9. 모바일 WebView

- React Native WebView는 Android에서 hardware layer를 사용한다.
- editor 안의 pan, pinch zoom, select와 drag는 WebView JavaScript 내부에서 처리한다.
- 고빈도 입력을 React Native `postMessage`로 보내지 않는다.
- 모바일 UI는 하단 도구 막대와 bottom sheet를 사용하되 같은 scene renderer를 공유한다.
- context loss, app background 전환과 저메모리 상황에서 tile GPU cache를 비우고 현재 viewport부터 복원한다.

## 10. 적용 흐름

1. CAD 업로드 및 변환
2. parse와 region 탐지
3. region 미리보기 및 선택
4. 선택 region의 native primitive 변환
5. simplify/deduplicate, tile/LOD 생성
6. 조명 후보 탐지
7. preview와 변환 통계 검토
8. 적용 확인 dialog
9. 기존 수동 요소 삭제와 fixture 미배치 전환
10. 새 FloorPlan, FloorCadScene, 타일과 FloorLightSlot을 한 transaction 기준으로 활성화

object storage 업로드는 transaction 전에 완료하되 scene 활성화에 실패한 asset은 cleanup tombstone으로 회수한다.

## 11. 호환성과 실패 처리

- 기존 applied SVG만 있는 층은 기존 배경 렌더링을 유지한다.
- native scene 생성이 실패하면 기존 맵을 변경하지 않는다.
- WebGL 초기화 실패 시 기존 SVG를 읽기 전용 preview로 표시하고 편집 불가 이유를 안내한다.
- scene manifest와 tile에는 version, SHA-256, byte size를 포함하고 응답 시 검증한다.
- 가져오기 처리 한도는 전체 expanded primitive 1,000,000개, 선택 region 500,000개로 둔다. 초과 시 조용히 자르지 않고 실패 또는 region 재선택을 요구한다.

## 12. 성능 합격 기준

제공된 실제 DWG와 합성 fixture 1,000개를 사용한다.

- 선택 region 최대 300,000 primitive에서 편집기 warm 진입 p95 3초 이내
- pan/zoom 프레임 p95 desktop 16.7ms 목표, 33ms 상한
- mobile WebView 프레임 p95 33ms 이내
- 클릭 선택 p95 120ms 이내
- viewport 이동 시 전체 scene 재파싱 없음
- 동일 tile 중복 network 요청 없음
- 맵 전체 fit에서 주요 구조와 조명 위치가 식별 가능
- 저장 후 새로고침해도 scene, overrides, light slots가 동일하게 복원

## 13. 제외 범위

- CAD 작성 도구 수준의 vertex 직접 편집
- 3D DWG, 외부 raster reference와 전체 CAD font 완전 호환
- AI 기반 조명 인식 자동 결정
- 여러 region을 한 층 맵으로 동시에 합성
- WebGPU 운영 활성화

AI detector 연결점은 기존 인터페이스를 유지하되 현재는 rule-based 결과만 운영 상태로 사용한다.
