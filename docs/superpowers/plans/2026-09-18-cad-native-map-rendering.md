# 공통 맵 요소 통합·편집기 최적화 구현 계획

> **실행 에이전트:** 승인 후 `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans`로 작업 단위별 수행한다. 아래 체크박스는 실제 검증이 끝난 경우에만 완료로 바꾼다.

**목표:** CAD·수동 도형의 생성/수정/삭제/이력을 통합하고 대용량 확대·이동과 편집 화면을 개선한다. 사용자 승인에 따라 기존 맵은 초기화하며 등록 장비·현장 정보는 유지한다.

**구조:** 공통 MapElement 정본을 불변 기본 청크와 변경분으로 저장한다. PixiJS는 정본에서 만든 표시 배치를, Konva는 조명과 제한된 선택 오버레이를 담당한다. 기존 맵 보존 어댑터는 만들지 않으며 신규 문서는 단일 쓰기 경로를 사용한다.

**기술:** 기존 React·Zustand·Konva·PixiJS 8.21.0·Worker, NestJS·Prisma·PostgreSQL·비공개 Object Storage, Zod·Vitest·Jest·Playwright. 새 렌더링 라이브러리 도입은 없다.

**설계:** [공통 맵 요소 설계](../specs/2026-09-18-cad-native-map-rendering-design.md)

## 현재 상태와 승인 경계

- [x] 설계 작성본 사용자 승인: 2026-09-19, “진행해줘”
- [x] 실제 파일·테스트 명령 확인, 아래 U1~U14 계획 작성 및 자체 검토
- [x] 구현 계획 사용자 검토·실행 승인. 기존 맵 초기화 허용, 역할별 서브에이전트로 진행
- [ ] U1~U14 구현·검증·작업 단위별 커밋

2026-09-19 실행 시작. 기존 맵 보존 전환은 제외하고 U5에서 명시적인 맵 초기화로 대체한다. 등록 조명·층·현장·사용자·게이트웨이는 유지한다. 아래 U번호만 새 작업의 정본이다. 하단 Task 1~14는 이전 분리형 구현 이력이다.

## 공통 제약

- 현재 브랜치의 기존 변경을 보존한다. 각 작업은 실패 테스트 → 최소 구현 → 집중 검증 → 메뉴/상태 문서 갱신 → 커밋 순서다.
- 공유 계약·Prisma는 backend 한 담당자만 수정한다. 프론트 소비는 계약 커밋 후 시작한다. 같은 파일을 병렬 수정하지 않는다.
- 사용자 DB 전환은 별도 백업·대상 확인·승인 후 한다. 격리 DB의 migration 검증과 실제 사용자 데이터 적용을 구분한다.
- 공통 요소는 네모·세모·선·텍스트·타원·호·연속선·다각형이다. 일반 도구에서도 생성 가능해야 한다.
- 그룹·레이어·잠금·숨김·삭제를 구분한다. 실제 조명 제거는 확인 후 미배치이며 도형 삭제가 등록 장비를 지우지 않는다.
- 논리 긴 변 기본 16,384·최대 32,768, 짧은 변 최소 1,024·극단적 비율 512, 타일 512를 유지한다. 여백/격자는 설계 §9를 따른다.
- 전체 확장 1,000,000개·선택 영역 500,000개 상한, private asset·크기·해시·권한·lease 검사를 유지한다. 조용한 누락/잘라내기/이미지 대체를 금지한다.
- 모든 새 문서/사용자 문구는 한글. 변경 메뉴는 settings.md와 monitoring.md, 스키마는 database-schema.md, 재발 교훈은 lesson_leared.md에 반영한다.
- root 검증 gate와 공유 빌드는 동시에 실행하지 않는다. 아래 집중 명령은 `pnpm workspace:prepare` 완료 후 순차 실행한다.
- 기존 맵은 U5 초기화 후 재가져오기하며, 휠 확대·드래그 이동·이동 종료 스냅·보조선·읽기 전용 모니터링을 보존한다.
- 증거는 단위/fixture 브라우저/실백엔드/실제 DWG/모바일 실기기로 나눠 기록한다. 하드웨어·AI·PDF·래스터 신규 입력·WebGPU는 범위 밖이다.

## 검토 초점

1. 타일 경계에서 같은 ID의 선 조각이 덮어써지지 않는가: U4/U5에서 긴 선·반복 블록 회귀.
2. 이동/삭제 직후 늦은 타일 응답이 이전 도형을 되살리지 않는가: U9에서 요청 순서 역전 회귀.
3. 저장 성공 응답 유실 뒤 재시도가 중복 리비전을 만들지 않는가: U6에서 requestId 재전송·본문 불일치 회귀.
4. 이미 저장한 삭제를 실행 취소한 뒤 새로고침해도 장비·슬롯과 이력이 일치하는가: U8/U13/U14에서 저장 전후 역명령 회귀.
5. 층·현장·사용자가 바뀐 뒤 이전 캐시/요청/미저장 초안이 노출되지 않는가: U7/U8/U14에서 scope 전환·늦은 응답 회귀.

## 파일 경계 및 공통 인터페이스

새 경로는 아래 작업에서 생성하는 계획이며 아직 존재하지 않는다. 기존 대형 서비스는 orchestration만 수정하고 청크·정본·전환 로직을 별도 파일로 분리한다.

| 경계 | 신규 파일의 책임 | 기존 연결 지점 |
| --- | --- | --- |
| 공통 계약 | packages/shared/src/map-document-contracts.ts, map-document-geometry.ts | schemas.ts, index.ts, package.json, scripts/build.mjs |
| 서버 정본 | apps/api/src/floor-editor/map-document-store.ts, map-document-codec.ts | floor-editor.service.ts, snapshot, asset cleanup |
| 서버 전환 | apps/api/src/floor-editor/map-document-upgrade.ts | floor-editor service, 기존 CAD reader |
| 입력 변환 | apps/api/src/floor-import/map-element-converter.ts | parser, builder, persistence, worker |
| 공통 편집 | apps/web/src/features/floor-editor/map-element-commands.ts, map-element-history.ts | editor-store, diff, drafts, View |
| 공통 표시 | apps/web/src/features/map-scene/MapSceneRenderer.ts, MapSceneCanvas.tsx | 기존 cad-scene renderer/worker, FloorScene |
| 공통 UI | apps/web/src/features/floor-editor/MapElementPropertiesPanel.tsx, EditorToolPalette.tsx | Canvas, View, route, CustomerShell |

### U2에서 고정할 타입

아래 타입명·필드명은 작업 간 계약이다. 숫자는 유한값, 색상은 기존 색상 규칙, text는 65,536자 이하, 점 배열 총합은 요소당 65,536개 이하로 제한한다.

```ts
type Point = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type MapShape =
  | { type: "line"; geometry: { start: Point; end: Point } }
  | { type: "rectangle"; geometry: { origin: Point; width: number; height: number } }
  | { type: "triangle"; geometry: { points: [Point, Point, Point] } }
  | { type: "ellipse"; geometry: { center: Point; radiusX: number; radiusY: number } }
  | { type: "arc"; geometry: {
      center: Point; radius: number; startAngle: number;
      endAngle: number; counterClockwise: boolean;
    } }
  | { type: "polyline"; geometry: { points: Point[] } }
  | { type: "polygon"; geometry: { outer: Point[]; holes: Point[][] } }
  | { type: "text"; geometry: {
      position: Point; text: string; width: number; height: number; fontSize: number;
    } };
type MapElement = MapShape & {
  id: string; groupId: string | null; layerId: string; zIndex: number;
  visible: boolean; locked: boolean;
  transform: { x: number; y: number; scaleX: number; scaleY: number; rotation: number };
  style: { strokeColor: string | null; fillColor: string | null; strokeWidth: number; opacity: number };
  provenance: { importJobId: string; sourceId: string } | null;
};
type MapElementOp =
  | { kind: "add"; element: MapElement }
  | { kind: "update"; element: MapElement }
  | { kind: "delete"; id: string };
type MapGroup = { id: string; parentId: string | null; name: string; locked: boolean; visible: boolean };
type MapLayer = { id: string; name: string; order: number; locked: boolean; visible: boolean };
type MapStructureOp =
  | { kind: "group.put"; group: MapGroup }
  | { kind: "group.delete"; id: string }
  | { kind: "layer.put"; layer: MapLayer }
  | { kind: "layer.delete"; id: string };
type MapOp = MapElementOp | MapStructureOp;
type MapAssetRef = { assetId: string; sha256: string; byteSize: number; decodedByteSize: number };
type MapDocumentRef = {
  formatVersion: 1; generationId: string; revision: number;
  width: number; height: number; gridSize: number; elementCount: number;
  manifest: MapAssetRef;
};
type MapMutation = {
  requestId: string; generationId: string; baseRevision: number;
  leaseToken: string; operations: MapOp[];
};
type MapMutationResult = { document: MapDocumentRef; changedBounds: Bounds[] };
```

회전은 도 단위, 좌표는 논리 단위다. geometry 내부 회전과 transform 회전을 중복 적용하지 않는다. 기존 회전은 어댑터에서 한 번만 변환한다.

## 작업 순서

`U1 (독립 기준선 계측), U2 → U3 → U4 → U5 → U6 → U7 → U8 → U9 → U10 → U11 → U12 → U13 → U14`

백엔드 계약이 고정되기 전 프론트 변경을 시작하지 않는다. 각 작업 완료 후 리뷰·커밋하며, 성능 계측 U1/U14는 같은 자료와 같은 측정법을 사용한다.

### U1. 재현·성능 기준선 고정

**담당:** web_frontend. **완료물:** 현 기능/성능을 측정하는 재사용 가능한 브라우저 시나리오. 제품 동작 변경 없음.

**파일:** 수정 `apps/web/e2e/cad-provided-artifacts.spec.ts`, `apps/web/e2e/floor-editor-layout.spec.ts`; 생성 `apps/web/src/features/map-scene/map-performance.ts`, `apps/web/src/features/map-scene/map-performance.test.ts`. Vitest가 e2e 디렉터리를 제외하므로 순수 계측 helper와 단위 테스트는 src에 둔다.
**인터페이스:** `summarizeFrameTimes(samples: number[]): { count: number; p95Ms: number | null }`. 표본 없는 경우 0ms 성공이 아니라 null.

- [ ] 실패 테스트 작성: 빈 표본/null, 1~100ms 표본의 nearest-rank p95=95, 비유한 표본 거부.
```ts
expect(summarizeFrameTimes([])).toEqual({ count: 0, p95Ms: null });
expect(summarizeFrameTimes(Array.from({ length: 100 }, (_, i) => i + 1)).p95Ms).toBe(95);
```
- [ ] 실행: `pnpm --filter @led-control/web exec vitest run src/features/map-scene/map-performance.test.ts`. 미구현 함수로 실패 확인.
- [ ] 구현: requestAnimationFrame 간격, 최소 120개 프레임, 정해진 카메라 경로, cold/warm 각 5회, HTTP 요청/전송 바이트·표시 coverage·long task를 기록한다. 기존 artifact 경로 환경변수 사용. 픽셀 일부 표시만 완료로 판단하지 않는다.
계측 구현의 p95는 정렬 후 nearest-rank로 고정한다.
```ts
const ordered = samples.toSorted((a, b) => a - b);
const p95Ms = ordered.length ? ordered[Math.ceil(ordered.length * 0.95) - 1] : null;
```

- [ ] 검증: 위 단위 테스트와 `pnpm --filter @led-control/web exec playwright test e2e/cad-provided-artifacts.spec.ts --project=chromium --workers=1`. 자료 미지정 skip은 측정 완료가 아니다. 임계치를 낮춰 현재 실패를 숨기지 말고 기준선으로 기록한다.
- [ ] .local/cad-native-qa 아래 측정 JSON/스크린샷, settings.md의 개선 필요 항목·상태판 갱신 후 커밋: `test(map): add reproducible editor performance baseline`.

### U2. 공통 요소·명령·geometry 계약

**담당:** backend, 공유 경계 선행. **의존:** 없음. U1 측정과 공유 파일이 없어 독립 실행한다.
**파일:** 생성 `packages/shared/src/map-document-contracts.ts`, `map-document-contracts.test.ts`, `map-document-geometry.ts`, `map-document-geometry.test.ts`; 수정 같은 패키지 `src/index.ts`, `src/schemas.ts`, `package.json`, `scripts/build.mjs`.
**인터페이스:** 위 공통 타입 및 `mapElementSchema`, `mapMutationSchema`, `getMapElementBounds(element: MapElement): Bounds`. geometry 함수는 변환 후 bounds를 계산한다.

- [x] 실패 테스트: 8유형, 음수/0 치수, NaN/Infinity, 중복 ID 명령, 알 수 없는 CAD 전용 type, 잘못된 링·자기 교차, 회전+비균등 확대, 기본 텍스트. 서버가 계산할 bounds를 클라이언트 입력으로 신뢰하지 않는다.
```ts
expect(mapElementSchema.safeParse({ type: "cad" }).success).toBe(false);
expect(mapMutationSchema.safeParse({
  requestId: "r", generationId: "g", baseRevision: -1, leaseToken: "lease", operations: []
}).success).toBe(false);
```
- [x] 실패 확인: `pnpm --filter @led-control/shared exec vitest run src/map-document-contracts.test.ts src/map-document-geometry.test.ts`.
- [x] 구현: strict discriminated union, 요소 ID 최대 512자, 그룹 순환/없는 참조는 문서 단위 검증. add는 미존재, update/delete는 존재 조건. 일반 저장 최대 2,000개 operation·기존 전체 envelope 1 MiB. 요소 자체는 기존 geometry 예산 내 최대 8 MiB 직렬화, 초과 저장은 U6 staged 경로를 사용한다.
geometry 중복 회전을 막기 위한 새 계약은 변환을 한 필드에만 둔다.
```ts
const transformSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  scaleX: z.number().finite().positive().max(100),
  scaleY: z.number().finite().positive().max(100),
  rotation: z.number().finite().min(-360).max(360)
}).strict();
```
반사된 원본은 점 순서/원본 geometry로 정규화하며 negative scale을 사용자 저장으로 허용하지 않는다.

- [x] 검증: 위 테스트 + shared build/typecheck. 새 `./map-document-contracts` 브라우저 ESM export를 실제 import한다. 기존 CAD 형식 버전은 변경하지 않는다.
- [x] 명령 한도·계약 표를 본 문서와 설계에 일치시킨 뒤 커밋: `feat(shared): define common map element contracts`.

### U3. 문서 청크 저장·이력·정리 기반

**담당:** backend. **의존:** U2.
**파일:** 생성 `apps/api/src/floor-editor/map-document-codec.ts`, `map-document-codec.spec.ts`, `map-document-store.ts`, `map-document-store.integration.spec.ts`, `apps/api/prisma/migrations/20260919180000_map_document/migration.sql`; 수정 `apps/api/prisma/schema.prisma`, `apps/api/src/floor-editor/floor-editor-snapshot.ts`, `floor-asset-cleanup.service.ts`. 기존 적용 migration은 수정하지 않는다.
**인터페이스:** `encodeMapChunk(elements: MapElement[]): Uint8Array`, `decodeMapChunk(bytes: Uint8Array): MapElement[]`. Store의 `prepareGeneration(floorId, elements: AsyncIterable<MapElement>): Promise<MapDocumentRef>`는 준비만 하며 활성화하지 않는다.

- [ ] 실패 테스트: 청크 roundtrip, 해시/길이/압축 해제 상한 위반, 준비 중 실패 시 기존 포인터 불변, 보존 리비전이 참조하는 자산 cleanup 제외.
```ts
expect(decodeMapChunk(encodeMapChunk([]))).toEqual([]);
expect(() => decodeMapChunk(new Uint8Array([0, 255, 17]))).toThrow();
```
- [ ] 실패 확인: `pnpm --filter @led-control/api exec jest src/floor-editor/map-document-codec.spec.ts src/floor-editor/map-document-store.integration.spec.ts --runInBand`.
- [ ] 구현: FloorMapDocument(활성 generation), FloorMapGeneration(준비/활성/실패·manifest), FloorMapChunk(자산/범위), FloorMapIndexShard(요소 ID 조회용 분할 인덱스 자산), FloorMapChangeSet(requestId·base/resultRevision·payload hash·자산), FloorMapRevisionAsset(보존 참조), FloorMapStage/Part(준비·요청·만료·해시) 모델. 요소당 DB 행을 만들지 않는다. ID→청크/offset은 SHA-256 ID prefix로 분할한 불변 인덱스 자산에 저장하며 샤드 decoded 8 MiB 초과 시 다음 prefix로 재분할한다. 같은 ID는 같은 샤드에서 중복 검사한다. generation+prefix/요청 ID 유일성, FK·범위 제약을 둔다.
- [ ] 구현: 정본 청크 decoded 8 MiB, 기본 generation decoded 총합 512 MiB 상한. 큰 객체 하나도 상한 초과 시 실패하며 일부만 저장하지 않는다. snapshot 새 버전은 문서 참조를 저장하고 기존 버전 parser는 유지한다. 100 changeset 또는 decoded delta 32 MiB 도달 시 체크포인트를 준비해 CAS 교체한다. 자산 I/O는 transaction 외부, 참조/리비전 활성화는 transaction 내부다.
정본 청크 저장은 기존 asset 원장을 사용하고 locator만 별도 유일 인덱스로 연결한다.
```sql
CREATE UNIQUE INDEX "FloorMapIndexShard_identity_key"
ON "FloorMapIndexShard" ("generationId", "prefix");
CREATE UNIQUE INDEX "FloorMapChangeSet_request_key"
ON "FloorMapChangeSet" ("floorId", "requestId");
```

- [ ] 격리 PostgreSQL 전체 migration→기존 데이터 포함 업그레이드→cleanup 동시성 검증. 사용자 DB는 적용하지 않는다. database-schema.md 갱신 후 커밋: `feat(api): persist versioned common map documents`.

### U4. CAD를 공통 요소로 변환

실행 분할: U4a는 U2 계약을 소비하는 순수 parser/builder/converter를 별도 파일 소유권으로 먼저 구현한다. U4b는 U3 후 persistence/worker와 연결한다. API 전체 빌드·Prisma generation은 U3 담당과 조율하며 U4a는 집중 테스트만 실행한다.

**담당:** backend. **의존:** U3.
**파일:** 생성 `apps/api/src/floor-import/map-element-converter.ts`, `map-element-converter.spec.ts`; 수정 `dxf-document-parser.ts`, `cad-types.ts`, `cad-scene-builder.ts`, `cad-scene-persistence.ts`, `floor-import-worker.service.ts`와 대응 spec.
**인터페이스:** `convertCadMapElements(document: NormalizedCadDocument, options: BuildCadSceneOptions & { importJobId: string; regionBounds: CadBounds }): AsyncIterable<MapElement>`. 기존 cad-types와 builder 옵션을 소비하고 정규화 transform을 한 번만 적용한다. clipped 표시 타일이 아니라 원본 문서에서 geometry를 읽는다.

- [ ] 실패 테스트: 긴 선 타일 경계, 반복 INSERT의 독립 ID, ELLIPSE/ARC, closed polyline, 구멍 있는 HATCH, DIMENSION 그룹, 문자 유니코드, unsupported 통계. 조명 후보 0개도 맵 변환 성공이어야 한다.
```ts
const cases = [
  { source: "ELLIPSE", expected: "ellipse" },
  { source: "ARC", expected: "arc" },
  { source: "closed-polyline-with-hole", expected: "polygon" }
] as const;
// cases 각각에 최소 DXF fixture를 만들어 parser→converter→codec roundtrip의 type/geometry를 비교한다.
```
- [ ] 실패 확인: `pnpm --filter @led-control/api exec jest src/floor-import/map-element-converter.spec.ts src/floor-import/dxf-document-parser.spec.ts --runInBand`.
- [ ] 구현: 타일 자르기/LOD 단순화 전에 정본을 별도 스트리밍 저장한다. 표시 배치는 정본에서 파생한다. 기존 bounded converter/child 격리와 resource 제한을 유지한다. 미지원 입력은 이유·개수와 함께 검토로 넘긴다.
변환기는 원본을 먼저 전달한 후에만 표시 단순화를 허용한다.
```ts
for await (const element of convertCadMapElements(document, options)) {
  await canonicalWriter.append(element);
  await displayWriter.append(element);
}
```
두 writer는 U3 store의 청크 writer와 기존 builder 표시 writer 어댑터이며 실패하면 generation 준비를 중단한다.

- [ ] 위 테스트와 기존 builder/codec/import worker 회귀 실행. 적용은 기존 맵 교체 확인·조명 미배치·후보 비자동등록을 유지한다. generation 활성화는 U6 계약에 연결한다.
- [ ] settings.md 갱신 후 커밋: `feat(cad): convert drawings into common map elements`.

### U5. 기존 맵 초기화 및 신규 문서 전환

**담당:** backend. **의존:** U3/U4. **변경 승인:** 기존 맵을 보존하지 않아도 된다는 사용자 요청 반영.
**파일:** 생성 `apps/api/src/floor-editor/map-document-reset.service.ts`, `map-document-reset.service.spec.ts`, `map-document-reset.integration.spec.ts`; 수정 floor-editor.controller/service/module, floor-import worker의 generation 검사.
**인터페이스:** `MapDocumentResetService.reset(floorId, user, { requestId, baseRevision, leaseToken }): Promise<MapDocumentRef>`, admin 전용 `POST floors/:floorId/editor-reset`.

- [ ] 실패 테스트: 기존 수동/CAD/override/레이어/슬롯/편집 이력 제거, 실제 장비·현장·사용자 유지, 조명 미배치, 잘못된 층/권한/lease/리비전 거부.
```ts
const resetContract = {
  mapObjects: 0, cadScenes: 0, lightSlots: 0, previousMapRevisions: 0,
  keepRegisteredFixtures: true, fixturePlacement: "unplaced",
  keepSiteAndGateway: true, keepEnergyAndCommandHistory: true
};
```
- [ ] 실패 확인: 위 reset spec/integration spec을 Jest --runInBand로 실행. 실제 local DB가 아니라 격리 DB에서 먼저 검증.
- [ ] 구현: 해당 층 row lock→권한/lease/baseRevision 확인→진행 중 import 무효화→슬롯/맵/편집 이력 제거→fixtures 미배치/위치검증 해제→새 빈 generation 활성화. 새 맵 revision은 증가시켜 오래된 쓰기를 거부한다. 초기 맵 크기는 기존 제품의 빈 맵 기본값을 사용한다.
- [ ] 구현: private asset은 참조 확인 후 cleanup ledger에 등록한다. 초기화 migration이나 서버 시작 시 자동 wipe는 금지한다. 로컬 초기화 승인도 이 서비스의 층 범위를 이용한다. 로컬 다운로드 원본은 건드리지 않는다.
- [ ] 검증: 실패 rollback, 응답 유실 재시도 멱등, 늦은 import worker가 다시 apply하지 못함, 다른 층 영향 없음, 이후 신규 문서 저장/복원 정상.
- [ ] database-schema/settings/monitoring 갱신 후 커밋: `feat(api): reset legacy maps without removing registered devices`.

### U6. 공통 저장·대량 변경 API와 원자적 확정

**담당:** backend. **의존:** U5.
**파일:** 생성 `apps/api/src/floor-editor/map-document-mutations.ts`, `map-document-staging.service.ts`와 각각 `.spec.ts`/통합 spec; 수정 `floor-editor.controller.ts`, `floor-editor.service.ts`, `floor-editor.module.ts`, `floor-map.service.ts`, `floor-import.service.ts`, `apps/api/src/api-body-parser.ts`.
**인터페이스:** `MapDocumentMutationService.commit(floorId, user, input: MapMutation): Promise<MapMutationResult>`. 기존 PUT editor-state에 공통 document 변경을 추가하며 기존 fixture/slot/map settings 변경과 같은 transaction으로 확정한다.

- [ ] 실패 테스트: add/update/delete, 그룹 전체 삭제, 잠긴 요소 하나 포함 시 전체 rollback, 장비/슬롯 비삭제, 없는 ID·다른 층·viewer·lease 만료, 동시 저장 409, 응답 유실 재전송.
```ts
const retryContract = [
  { sameRequestId: true, samePayload: true, expected: "original-result-no-new-revision" },
  { sameRequestId: true, samePayload: false, expectedStatus: 409 },
  { sameRequestId: false, staleBaseRevision: true, expectedStatus: 409 }
];
```
- [ ] 실패 확인: 새 mutation/staging spec과 기존 `editor-http.spec.ts`를 Jest --runInBand로 실행.
- [ ] 구현: 구조/요소 연산 순서와 최종 참조·잠금·좌표 검증 후 준비 자산 생성. transaction에서 floor row lock→권한/lease/baseRevision 재검사→changeset와 snapshot→포인터 변경. requestId+hash로 멱등 처리한다. payload 전체가 같은 성공 재전송은 최초 결과를 반환한다.
- [ ] 구현: 대량 변경은 `POST floors/:floorId/editor-stages`, `PUT editor-stages/:stageId/parts/:part`, `POST editor-stages/:stageId/commit` 및 GET 상태. stage는 사용자/층/generation/baseRevision/lease에 결속, decoded part 512 KiB·전체 512 MiB·1,024 parts 상한, 인덱스/해시 불변, 누적 초과 즉시 거부. UTF-8 JSON operation 스트림은 part 경계를 넘어도 증분 복원하며 단일 요소 8 MiB를 지킨다. 미확정 stage는 1시간 비활성 만료 후 정리. 성공 stage의 역명령은 changeset/보존 revision 자산으로 pin하여 history가 참조하는 동안 만료로 지우지 않는다. commit은 서버 준비·검증 후 202 상태 조회를 제공하고 단 한 번 활성화한다. 대량 그룹 삭제도 같은 경로로 쪼개되 부분 활성화하지 않는다.
최종 활성화의 compare-and-set 조건은 다음과 같다. 실제 실행은 동일 transaction의 lease/권한 검사와 changeset 삽입을 포함한다.
```sql
UPDATE "FloorMapDocument"
SET "generationId" = $1, "revision" = $2
WHERE "floorId" = $3 AND "generationId" = $4 AND "revision" = $5;
```
영향 행 0이면 409로 rollback한다. 멱등 request가 이미 성공했는지는 CAS 전에 확인한다.

- [ ] 검증: 누락/중복/순서 역전 part, 취소/정리 경합, 저장 도중 자산 오류, 이후 정상 재시도. 사용자 API에서 우회할 수 있는 legacy CAD 쓰기는 전환된 층에 409를 반환한다. 메뉴/스키마 문서 후 커밋: `feat(api): unify atomic map mutations and staged saves`.

### U7. 조회·원장 캐시와 권한 경계 최적화

**담당:** backend. **의존:** U6.
**파일:** 생성 `apps/api/src/floor-editor/map-document-reader.ts`, `map-document-reader.spec.ts`; 수정 `floor-import.service.ts`, `floor-map.service.ts`, `cad-scene-evidence.service.ts`, 자산 controller의 공통 문서 분기.
**인터페이스:** reader는 `MapDocumentRef`를 소비해 검증 DTO와 ID→원본 요소/viewport→표시 청크를 반환한다. 클라이언트는 정본 참조를 통해서만 asset을 요청한다.

- [ ] 실패 테스트: N개 타일 동시 요청에서 동일 원장 decode 1회, 다른 사용자 권한 검사 N회, generation 교체 뒤 이전 응답 폐기, 해시 불일치 실패, 정리된 asset 거부.
```ts
const readContract = {
  concurrentRequests: 20, expectedManifestDecodes: 1,
  expectedAuthorizationChecks: 20, rawManifestRedirectAllowed: false
};
```
- [ ] 실패 확인: `pnpm --filter @led-control/api exec jest src/floor-editor/map-document-reader.spec.ts src/floor-map/cad-scene-evidence.service.spec.ts --runInBand`.
- [ ] 구현: 불변 원장 인덱스 LRU 32 MiB 총합/엔트리 최대 8 MiB, in-flight 병합, 자산 ID+hash+size+generation 키. 실패 Promise 제거. 층/현장 권한은 캐시 밖에서 확인한다. 불변 저장 조건 미충족 시 HEAD 검증을 유지한다.
캐시 identity는 파일 형식 버전이 아니라 검증할 내용 identity다.
```ts
const cacheKey = JSON.stringify([
  floorId, generationId, asset.assetId, asset.sha256, asset.byteSize
]);
```

- [ ] 검증: 실제 builder 산출물→storage reader→HTTP JSON→공유 schema 순서로 테스트하여 manifest 필수 필드가 누락되지 않게 한다. 원시 파일 redirect로 DTO 보완을 우회하지 않는다.
- [ ] baseline 대비 조회 수/바이트를 기록, 커밋: `perf(api): reuse verified map metadata without caching authorization`.

### U8. 공통 초안·실행 취소·저장 상태

실행 분할: U8a는 네 개 신규 commands/history 파일만 먼저 구현·검증한다(U2 의존). U8b는 U6/U7 이후 store/diff/drafts/API와 외부 큰 inverse 참조를 연결한다. U8a만 완료해 전체 U8 또는 사용자 UI 통합 완료로 표시하지 않는다.

**담당:** web_frontend. **의존:** U6/U7.
**파일:** 생성 `map-element-commands.ts`, `map-element-commands.test.ts`, `map-element-history.ts`, `map-element-history.test.ts` (floor-editor 디렉터리); 수정 `editor-types.ts`, `editor-store.ts`, `editor-diff.ts`, `editor-drafts.ts`, `apps/web/src/api/floor-editor.ts`.
**인터페이스:** `applyMapOps(elements: ReadonlyMap<string, MapElement>, operations: MapElementOp[]): { elements: ReadonlyMap<string, MapElement>; inverse: MapElementOp[] }`; `MapElementHistory.execute/undo/redo/adoptSavedBaseline`. 구조 변경도 같은 history entry에 포함한다.

- [ ] 실패 테스트: add→delete→undo, update inverse, 다중 삭제 한 번 undo, 저장 후 undo는 dirty=true, 재저장/새로고침 복원, 실패 저장 초안 보존, 그룹/레이어 변경 이력.
```ts
expect(applyMapOps(new Map(), [])).toEqual({ elements: new Map(), inverse: [] });
expect(() => applyMapOps(new Map(), [{ kind: "delete", id: "missing" }])).toThrow();
```
- [ ] 실패 확인: `pnpm --filter @led-control/web exec vitest run src/features/floor-editor/map-element-commands.test.ts src/features/floor-editor/map-element-history.test.ts`.
- [ ] 구현: immutable 원본 청크와 변경 ID/역명령만 보관한다. history마다 500,000 요소 전체 복제를 하지 않는다. 동기 applyMapOps는 로드된 변경 대상에만 사용하고 전체 정본을 하나의 브라우저 Map으로 materialize하지 않는다. 100개 history entry와 decoded 역명령 32 MiB 예산, 초과 단일 명령은 private staged 자산 참조로 보존하고 사용할 수 없으면 실행 전에 오류를 낸다. undo를 조용히 누락하지 않는다.
- [ ] 구현: fixture/slot/floor settings 기존 이력과 공통 transaction 경계로 묶는다. 층/현장/auth scope로 draft 분리, 오래된 API 응답 무시, 충돌 시 미저장 보존. stale draft는 다른 revision에 자동 덮어쓰지 않는다.
delete의 inverse는 기존 요소 전체를 add로 되돌린다. group/layer operation과 실행 순서를 역순으로 묶는다.
```ts
const before = elements.get(operation.id);
if (!before) throw new Error("map element missing");
inverse.unshift({ kind: "add", element: before });
```
UI에는 원시 Error가 아니라 해당 공통 오류 코드의 한글 안내를 표시한다.

- [ ] 검증: editor-store/diff/drafts/API 기존 회귀 포함. settings.md 갱신 후 커밋: `feat(web): unify map drafts and undo history`.

### U9. 공통 WebGL 렌더러·카메라·부분 갱신

실행 분할: U9a는 URL에 의존하지 않는 표시/정본 provider와 렌더러 코어를 선행 구현한다. 초기 전체 표시는 compact 파생 LOD 데이터를 사용하고 선택 시에만 정본을 조회한다. U9b는 U7/U8 이후 실제 API/화면에 연결한다.

**담당:** web_frontend. **의존:** U8.
**파일:** 생성 `apps/web/src/features/map-scene/MapSceneRenderer.ts`, `MapSceneRenderer.test.ts`, `MapSceneCanvas.tsx`, `MapSceneCanvas.test.tsx`; 기존 `features/cad-scene/CadSceneRenderer.ts`, worker/cache/display 모듈에서 범용 구현 추출, 이전 경로는 legacy 어댑터로 유지.
**인터페이스:** `MapSceneRenderer.setCamera(camera)`, `setDocument(ref: MapDocumentRef)`, `applyChanges(operations: MapOp[], changedBounds: Bounds[])`, `dispose()`. camera는 기존 x/y/zoom/viewport 계약을 재사용한다.

- [ ] 실패 테스트: camera 이동은 fetch Promise 이전 즉시 표시, 동일 바이트 다른 LOD 재사용, 단일 요소 변경은 인접 batch만 갱신, revision 증가에서 renderer 생존, 늦은 응답으로 삭제 도형 부활 금지, context restore.
```ts
const renderContract = {
  cameraMoves: 100, expectedRendererInstances: 1,
  edits: 1, expectedFullRebuilds: 0, resurrectDeletedElements: false
};
```
- [ ] 실패 확인: `pnpm --filter @led-control/web exec vitest run src/features/map-scene/MapSceneRenderer.test.ts src/features/map-scene/MapSceneCanvas.test.tsx`.
- [ ] 구현: 공통 geometry→배치, viewport 공간 인덱스, immutable 바이트 캐시, Worker decode, 한 프레임 입력 병합. document generation+요청 세대 확인 후 결과 적용. 미저장 삭제 mask는 새 타일에도 적용한다.
- [ ] 구현: 원본/decoded/GPU/atlas 메모리를 합산해 기존 플랫폼 예산을 지킨다. hole triangulation은 기존 earcut 사용. 선·호·다각형·텍스트 모두 일반 요소로 hit-test한다. 전체 도형을 React/Konva 노드로 복제하지 않는다.
늦은 응답은 요청 세대가 맞아도 현재 초안 삭제를 다시 적용한다.
```ts
if (responseGeneration !== activeGeneration || requestEpoch !== currentEpoch) return;
const visible = decodedElements.filter(element => !draftDeletedIds.has(element.id));
```
위 필터는 해당 청크만 처리한다. 렌더링 변경은 indexed batch에 반영한다.

- [ ] 검증: 기존 CAD WebGL smoke, U1 시나리오, 일부 픽셀 아닌 전체 가시 타일 coverage 확인. settings/monitoring 문서 후 커밋: `perf(web): render common map elements with incremental batches`.

### U10. 선택·수정·삭제 UI 통합

**담당:** web_frontend. **의존:** U9.
**파일:** 생성 `MapElementPropertiesPanel.tsx`, `MapElementPropertiesPanel.test.tsx`, `MapElementOverlay.tsx`, `MapElementOverlay.test.tsx` (floor-editor); 수정 `FloorEditorView.tsx`, `FloorEditorCanvas.tsx`, `EditorPropertiesPanel.tsx`, `EditorLayersPanel.tsx`, `CadElementPropertiesPanel.tsx`.
**인터페이스:** 패널은 `selection: MapElement[]`, `onChange(ops: MapOp[])`, `onDelete(ids: string[])`를 받으며 HTTP를 직접 호출하지 않는다.

- [ ] 실패 테스트: 출처에 관계없는 동일 패널, 그룹/자식/혼합 다중 선택, 빈 선택 맵 설정, 잠금, 삭제 키가 텍스트 입력 중 도형을 지우지 않음, 실제 조명 미배치 확인.
```ts
const interactions = [
  ["manual-line", "delete", "removed"],
  ["imported-line", "delete", "removed"],
  ["registered-fixture", "delete", "confirmation-before-unplace"],
  ["text-input-focused", "Backspace", "text-only"]
] as const;
```
- [ ] 실패 확인: 신규 panel/overlay와 기존 FloorEditorView 테스트를 Vitest로 실행.
- [ ] 구현: drag/resize/rotate 종료를 공통 명령으로 변환, 포인터 offset 유지, 이동 종료 grid snap·보조선 적용. 그룹 affine 변환은 한 번만 각 원본에 적용한다. 범위를 벗어나는 변환은 오류로 되돌리고 저장 불가능한 중간 상태를 남기지 않는다.
- [ ] 구현: CAD 즉시 저장 mutation/분리 selection과 전용 삭제 UI 제거. legacy adapter가 남는 동안 사용자에게는 일반 요소 패널로 노출한다. 삭제 후 공통 save/undo 상태를 표시한다.
요소 삭제 버튼은 서버 직접 호출이 아니라 공통 초안 operation을 발행한다.
```ts
const operations: MapElementOp[] = ids.map(id => ({ kind: "delete", id }));
onChange(operations);
```

- [ ] 검증: 우상단 fixture 제거 버튼/팝업 유지, 도형 삭제 후 슬롯 유지. settings.md 후 커밋: `feat(web): unify map selection properties and deletion`.

### U11. 일반 도구 확장·그룹/레이어 편집

실행 분할: U11a는 공통 요소 생성 함수·그리기 초안·재사용 팔레트의 신규 파일만 선행 구현한다. 기존 View/store/Canvas 연결과 그룹·레이어 화면은 U11b에서 검증한다.

**담당:** web_frontend. **의존:** U10.
**파일:** 생성 `EditorToolPalette.tsx`, `EditorToolPalette.test.tsx`, `map-element-tools.ts`, `map-element-tools.test.ts`; 수정 editor-types/geometry/Canvas/Properties/Layers.
**인터페이스:** `createMapElementFromDrag(type: MapElement["type"], start: Point, end: Point, id: string): MapElement`. polyline/polygon의 연속 점 입력은 별도 현재 그리기 초안이며 확정 전 서버 저장하지 않는다.

- [ ] 실패 테스트: 8유형 생성, 역방향 드래그, 0크기 취소, 원 비율 유지, 호 각도, 열린 선/닫힌 면, polygon 구멍, 텍스트 편집, 일반 그룹 해제/자식 선택, 레이어 삭제의 참조 정합.
```ts
const created = createMapElementFromDrag("ellipse", { x: 10, y: 20 }, { x: 30, y: 40 }, "new-1");
expect(created.type).toBe("ellipse");
expect(created.provenance).toBeNull();
```
- [ ] 실패 확인: 신규 tools/palette 테스트를 Vitest로 실행.
- [ ] 구현: 기존 좌측 드래그앤드롭은 드롭 위치에 기본 요소 생성. 선택 후 canvas 드래그로 크기 지정도 지원한다. polyline/polygon은 점 입력 후 Enter/더블클릭 확정, Escape 취소. hole 추가 모드는 선택 polygon 내부에서 닫힌 링 입력, hole 제거는 속성 목록 명령. 잘못된 링은 확정하지 않는다.
- [ ] 구현: 색상 공통 palette·아이콘·툴팁 재사용. 그룹 순환 금지, 그룹 해제는 자식 geometry 유지, 비어 있지 않은 레이어 삭제는 이동 대상을 선택하거나 명시적 요소 삭제 확인. 모든 변경은 공통 history에 기록한다.
역방향 드래그도 같은 bounds로 정규화한다.
```ts
const origin = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) };
const size = { width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
```
0크기는 확정 전 취소한다. 실수 좌표를 저장 단계에서 불필요하게 정수 반올림하지 않는다.

- [ ] 검증: 생성→속성 변경→삭제→undo→저장 과정을 각 유형에 수행. 커밋: `feat(web): add common shape tools and group editing`.

### U12. 편집 화면 높이·패널 사용성

**담당:** web_frontend. **의존:** U11.
**파일:** 수정 `features/shells/CustomerShell.tsx`, `features/settings/floor-plans/FloorEditorRoute.tsx`, `features/floor-editor/FloorEditorView.tsx`, 기존 공통 UI 컴포넌트 및 `apps/web/e2e/floor-editor-layout.spec.ts`.
**인터페이스:** 편집 route에서만 bounded workbench layout 적용. 다른 페이지 shell의 기본 스크롤 정책은 바꾸지 않는다.

- [x] 실패 테스트: viewport 1440×900/1024×768/390×844/320×740, panel 긴 콘텐츠, browser resize, textarea 포커스, 확대된 맵.
```ts
expect(await page.evaluate(() =>
  document.documentElement.scrollHeight <= window.innerHeight + 1
)).toBe(true);
```
- [x] 실패 확인: 신규 `e2e/map-editor-viewport.spec.ts`와 기존 `e2e/floor-editor-layout.spec.ts` 회귀로 확인. 기존 성능 측정 파일과 파일 소유권을 분리했다.
- [x] 구현: grid rows auto/minmax(0,1fr), 자식 min-h-0, 패널 overflow-auto·canvas overflow-hidden. 고정 상단 도구, 접을 수 있는 측면 패널. 좁은 화면의 도구 패널은 드래그 원본 수명을 유지하는 비모달 방식이며 드래그 중 캔버스 입력을 가리지 않는다. 카드 안에 카드 추가 금지.
편집기 전용 높이 체인은 shell 콘텐츠가 남은 높이를 받도록 연결한다.
```css
.map-editor-workbench { height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; }
.map-editor-panels { min-height: 0; overflow: hidden; }
.map-editor-panel { min-height: 0; overflow: auto; }
```

- [x] 검증: 기존 편집 단위109, viewport 브라우저12 및 기존 모바일2 회귀, Escape·드롭·캔버스 밖 종료 후 복구, 정상 설정 개요 스크롤과 실제 스크린샷 확인. 비모달 도구 패널에는 포커스 trap을 적용하지 않는다. 실제 lostpointercapture 이벤트와 RN 기기는 미검증이다.
- [x] settings.md 및 `482cd959`/`31003434` 커밋, 독립 재검토 PASS.

### U13. 모니터링·캐시·재적용 통합

**담당:** web_frontend + backend 순차. **의존:** U12.
**파일:** 수정 `apps/web/src/features/floor-map/FloorScene.tsx`, `FloorMapViewport.tsx`, `apps/web/src/features/floor-editor/editor-monitoring-cache.ts`, `CadImportPanel.tsx`, `CadImportSceneCanvas.tsx`, `apps/web/e2e/cad-import-journey.spec.ts`, `settings-floor-editor.spec.ts`.
**인터페이스:** 편집/모니터링 모두 같은 MapDocumentRef와 MapSceneRenderer 사용. 모니터링은 편집 명령 진입점을 노출하지 않는다.

- [ ] 실패 테스트: 도형 삭제 저장→모니터링→reload, 임시 변경은 모니터링에 미반영, 저장 후 undo→재저장 반영, 층 전환, 두 번째 CAD 적용, 후보 0개, 선택 후보 슬롯 유지.
```ts
const journeys = [
  "delete-save-monitor-reload",
  "undo-after-save-save-monitor",
  "replace-map-confirm-unplace",
  "switch-floor-ignore-stale-response"
] as const;
```
- [ ] 실패 확인: FloorScene/FloorMapViewport 단위 테스트와 위 E2E를 실행.
- [ ] 구현: query key는 site/floor/generation/revision으로 구분하고 저장 성공만 invalidation한다. 이전 viewport 응답은 새 층에 사용하지 않는다. 가져오기 preview도 공통 요소 renderer를 사용하며 활성 맵과 혼합하지 않는다.
캐시는 현장과 층, generation/revision을 모두 포함한다.
```ts
const queryKey = ["map-document", siteId, floorId, document.generationId, document.revision];
```
로그아웃/현장 전환의 기존 QueryClient scope 수명 정책을 유지한다.

- [ ] 검증: 실제 조명 상태/선택/읽기 전용/10분 갱신 정책 회귀. 재적용은 맵 교체·조명 미배치 확인 후만 실행하며 이전 이력 참조 보존.
- [ ] settings/monitoring 문서 후 커밋: `feat(map): share document rendering across editor and monitoring`.

### U14. 실제 DWG·실백엔드 브라우저 최종 검증

**담당:** QA 검토, 구현 역할이 발견 사항 수정. **의존:** U13.
**파일:** 생성 `apps/web/e2e/map-document-real.spec.ts`; 수정 `e2e/support/real-backend-lab.ts`, `cad-provided-artifacts.spec.ts`, `apps/api/src/floor-import/cad-sample-pipeline.integration.spec.ts`, 기존 상태/메뉴/교훈 문서.
**인터페이스:** 기존 RealBackendLab에 격리 Object Storage와 CAD converter 자산 경로만 추가. UI API intercept 없는 별도 실제 여정과 artifact fixture 여정을 구분한다.

- [ ] 실패/기능 테스트: 실제 두 DWG와 최소 도형 corpus로 가져오기→진행률→검토→적용→8유형 선택/편집/삭제→undo/redo→저장→reload→모니터링. HTTP 200만이 아니라 화면·DB 정본·후보 슬롯을 대조한다.
```ts
page.on("pageerror", error => browserErrors.push(error.message));
page.on("response", response => {
  if (response.url().includes("/api/") && response.status() >= 500) {
    serverFailures.push({ url: response.url(), status: response.status() });
  }
});
// 테스트별 빈 배열 browserErrors/serverFailures를 생성하고 종료 때 두 배열이 비었는지 검사한다.
```
- [ ] 실행: `E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/map-document-real.spec.ts --project=chromium --workers=1`. 자료/infra 부재는 원인과 미검증 상태로 기록하며 fixture로 대체해 완료 표시하지 않는다.
브라우저 실패 수집 배열은 테스트 함수 안에서 선언한다.
```ts
const browserErrors: string[] = [];
const serverFailures: Array<{ url: string; status: number }> = [];
// 이벤트 등록 후 여정을 실행하고 마지막에 판정한다.
expect(browserErrors).toEqual([]);
expect(serverFailures).toEqual([]);
```

- [ ] 실제 sample runner는 기존 `pnpm test:cad-sample`을 사용한다. CAD_SAMPLE_DWG_PATHS_JSON, converter 경로/argv, RUN_OBJECT_STORAGE_INTEGRATION 환경을 먼저 확인한다. developer watch dist를 삭제하지 않도록 별도 격리 checkout에서 실행하거나 검증된 최신 dist 재사용 옵션을 사용한다. 사용자 원본을 덮어쓰지 않는다.
- [ ] U1과 동일 자료·기기·경로로 cold/warm/300,000도형/1,000조명 측정. 목표 미달이면 해당 U7/U9 작업을 재개한다. 임계값 낮추기, 중앙 일부만 표시하기, 성능 측정을 skip하는 방법으로 통과시키지 않는다.
- [ ] 순차 최종 gate: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, 영향 E2E, `git diff --check`. skip 수·실제 데이터 증거·모바일 실기기 미검증을 구분한다.
- [ ] settings/monitoring/project-status/계획/lesson_leared/database-schema를 실제 상태와 맞추고 독립 전체 변경 리뷰 후 커밋: `test(map): verify common editor against real drawings`.

## 재개·커밋 운영

매 작업 끝에 완료 체크박스, 커밋 SHA, 실행 명령/통과·실패·skip, 남은 위험, 바로 다음 U번호를 project-status와 본 문서에 남긴다. 중단 시 진행 중인 테스트 프로세스와 변경 파일을 기록하고 미검증 작업을 완료로 바꾸지 않는다.

| 작업 | 상태 | 커밋/검증 증거 |
| --- | --- | --- |
| U1 | 계측 하네스 완료·독립 검토 PASS, 기준선 부분 | e30dc20d/861724de, 집중19; 코드 혼합/OOM로 통제 기준선은 U14 재측정 |
| U2 | 완료·독립 검토 PASS | 61ce049e, 집중120/전체336·typecheck/build·ESM/CJS/pack 통과 |
| U3 | 완료·독립 재검토 PASS | 82c9bffc/fd69abe5, PG31x2/cleanup1/API2285통과559제외, 자산회귀76·리뷰62; 승인 로컬 migration95 적용 |
| U12 | 완료·독립 재검토 PASS | 482cd959/31003434, browser12+기존모바일2/unit109 통과, 드롭 가림·취소 hit 보완; 실제 기기 WebView 미검증 |
| U4a | 완료·독립 재검토 PASS | 54abb278, 신규11 RED/GREEN 및 집중118통과1제외; U4b 대기 |
| U8a | 완료·독립 검토 PASS | 22131660, 신규38/집중315/웹1718통과2제외, UI 미연결 |
| U9a | 검토 지적 3건 보완 중 | 586f22e7, 동시 cache 예산/ID namespace/rAF 선택 좌표 수정; 실제provider/UI 미연결 |
| U11a | 완료·독립 검토 PASS | 46376f4f, 집중103/소유파일 typecheck 통과, View/store/Canvas 미연결 |
| U4b, U5 | 구현 중 | 가져오기/Prisma와 reset/controller 파일 소유 분리, 사용자 맵 초기화는 미실행 |
| U6~U7, U8b, U9b~U11b, U13~U14 | 대기 | 앞선 계약·보안 검토 완료 후 연결 |

구현 방식은 **역할별 순차 서브에이전트 진행**을 제안한다. 공유 계약과 데이터 보존은 backend가 먼저, 소비 UI는 web_frontend가 이후 담당하고 QA가 작업 단위 결과를 확인한다. 메인은 공유 계약과 통합·문서 상태를 관리한다. 같은 파일을 다루는 병렬 에이전트는 만들지 않는다. 사용자가 더 낮은 토큰 비용을 우선하면 메인 직접 구현 + 최종 독립 리뷰로 변경할 수 있다.

## 설계 요구사항 대조

| 설계 항목 | 담당 작업 |
| --- | --- |
| 공통 모델·팔레트·타입별 편집 | U2, U10, U11 |
| 원본/타일 분리·CAD 호환·영역 선택 | U3, U4, U13 |
| 기존 맵 초기화·장비 보존·새 이력 | U3, U5, U6 |
| 실제 삭제·공통 undo·원자 저장 | U6, U8, U10 |
| 장비 미배치·슬롯 독립성 | U5, U6, U10, U13 |
| 서버 보안·캐시·부분 렌더링 | U7, U9 |
| 크기·격자·카메라·모바일 대응 UI | U2, U9, U11, U12 |
| 실제 브라우저·원본·성능 검증 | U1, U14 |

---

## 이전 분리형 구현 기록 (Task 1~14)

아래 원래 목표·구조·검증은 이전 구현의 기록이다. 새 공통 요소 작업은 위 U1~U14만 따른다.

# CAD Native Map Rendering Implementation Plan (이전 기록)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DWG/DXF의 한 층 영역을 편집 가능한 네이티브 CAD scene으로 변환하고 PixiJS WebGL과 Konva 오버레이로 PC·모바일 WebView에서 고성능 렌더링한다.

**Architecture:** 서버는 CAD model space를 region으로 분리하고 선택 region을 512 단위 타일과 LOD로 변환해 object storage에 압축 저장한다. 웹은 PixiJS WebGL로 CAD tile batch를 그리고 기존 Konva는 조명, 수동 도형과 현재 선택된 CAD 요소의 편집 오버레이에만 사용한다.

**Tech Stack:** NestJS, TypeScript, PostgreSQL/Prisma, S3-compatible object storage, React, PixiJS v8 WebGL, Konva, Web Worker, Vitest/Jest/Playwright

**Spec:** `docs/superpowers/specs/2026-09-18-cad-native-map-rendering-design.md`

## 현재 실행 상태 (2026-09-19)

### 후속 설계 단계의 이전 기록

- [x] CAD 전용 편집 경로를 일반 요소와 통합하는 방향 대화 승인
- [x] 기존 설계 문서 갱신 및 자체 검토: 삭제 의미, 원본/조각 보존, 이력, 권한, 성능 목표와 UI 경계 명시
- [x] 작성된 설계 문서 사용자 검토·승인 (2026-09-19)
- [x] 상세 구현 계획 작성 (상단 U1~U14)
- [ ] 구현 계획 검토 및 실행 방법 확정
- [ ] 새 계획에 따른 구현과 실제 브라우저 검증

이 문서의 기존 Goal/Architecture와 Task 1~14는 이전 분리형 구현 이력이다. 갱신된 Spec의 공통 모델·통합 삭제·이력·성능 개선이 이미 구현되었다는 뜻이 아니다. 현재는 문서만 변경하며 DB·맵 데이터는 유지한다.

### 기존 분리형 구현 이력

- Task 1~7: 구현·검증·커밋 완료 (`af63a8de`~`f4569975`, renderer `1a408c5b`).
- Task 8~10: 지원 범위의 구현·검증·커밋 완료. `6228e9c2` 영역 선택/API 연동, `39680539` bounded 벡터 렌더링/원본 선택, `0645984e` 편집·모니터링·WebView 통합이다.
- Task 11: 실제 두 DWG의 모든 후보 적용 2/2, 실제 타일 8개 화면, 실제 요소 편집/reload 1개, 모바일 정책 4개 화면 검증을 완료했다. API/Web 빌드와 타입 검사, 전체·집중 회귀 및 문서 갱신을 마쳤다. 실기기 WebView·원본 전체 충실도·양산 컨테이너 성능은 별도 후속 범위다.
- `f124bbf1`: 제외 영역 통계와 이동 요소 source locator migration 및 실제 PostgreSQL 업그레이드 검증 완료.
- Task 11 재현으로 Task 3 재개: 실제 두 DWG의 region OOM/공간 bucket 오류를 bounded 탐지·단일 순회 preview로 보완했고, 197/1,817개 preview 및 집중 99개 테스트를 통과했다. Native/SVG 중첩·작은 viewport fit·canvas context 재사용·늦은 camera 요청도 보정했다. `acf3b482`는 대용량 region/브라우저 계약 보완이다. 로컬 DB backup 후 CAD migration 6개 적용 및 개발 서버 실행은 사용자 승인 범위에서 완료했다.
- 최종 실제 경로 보완: 원본과 표시용 geometry 분리, 정확한 원본 선택, atlas 텍스트 폭과 context-loss 캐시 퇴출을 구현했다. Scene exact-float 저장·CAD FloorPlan 주소·영역 밖 block 원점 좌표를 수정한 `df96a8b6`에서 두 실제 pipeline 적용·재조회가 통과했고 모든 후보 1,308/2개 slot 적용을 추가 검증했다. 기존 래스터 배경으로 대체하지 않는다.

## Global Constraints

- 2026-09-19 사용자 재확인: CAD는 배경 이미지가 아니라 선택·편집 가능한 맵 요소로 표시한다. 네모·세모·선·텍스트 외에 원·타원·호·연속선을 지원하며, 배치 렌더링은 저장·그리기 최적화일 뿐 요소의 식별자·좌표·편집 가능성을 제거하지 않는다.
- 실제 제공 도면의 전체 보기에서 메모리 예산으로 중앙 일부 타일만 표시되는 회귀가 확인됐다. 확대 수준별 벡터 표현을 보완하고 전체 영역 표시와 확대 후 원본 요소 편집을 검증하기 전에는 완료로 판정하지 않는다. 래스터 배경으로 대체하거나 임의로 요소를 삭제하는 방식은 사용하지 않는다.
- 모든 사용자 문구와 프로젝트 문서는 한글로 작성한다.
- 논리 맵 긴 변 기본값은 16384, 최대값은 32768이고 framebuffer는 viewport 크기로만 생성한다.
- CAD geometry를 `FloorMapObject` DB 행, DOM 또는 Konva/Pixi scene object로 1:1 펼치지 않는다.
- tile 크기는 512이며 WebGL renderer를 운영 기본값으로 사용한다.
- 기존 SVG-only floor는 하위 호환한다.
- TDD로 테스트 실패를 먼저 확인한 뒤 구현한다.
- DB 변경과 설정 메뉴 변경은 `docs/database-schema.md`, `docs/menus/settings.md`, 반복 교훈은 `docs/lesson_leared.md`에 반영한다.

---

### Task 1: 공유 scene 계약과 맵 크기 정책

**Files:**
- Create: `packages/shared/src/cad-scene-contracts.ts`
- Create: `packages/shared/src/cad-scene-contracts.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/cad-import-contracts.ts`

**Interfaces:**
- Produces: `cadSceneManifestSchema`, `cadSceneTileSchema`, `cadRegionSchema`, `normalizeCadMapSize(bounds)`와 import region 선택 계약.

- [x] primitive, tile manifest, region preview와 override DTO의 실패 테스트를 작성한다.
- [x] bounds 16:9, 세로형, 극단형에 대해 16384/1024/32768 정책의 실패 테스트를 작성한다.
- [x] 공유 계약과 크기 정규화 함수를 구현한다.
- [x] shared 테스트와 typecheck를 통과시킨다.
- [x] `feat(cad): define native scene contracts`로 커밋한다.

### Task 2: DB scene 메타데이터와 migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/*_add_floor_cad_scene/migration.sql`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Consumes: Task 1 scene 식별자와 version 정책.
- Produces: `FloorImportRegion`, `FloorCadScene`, `FloorCadTile`, `FloorCadElementOverride`, `FloorCadLayerState` 모델, `cad` floor plan source 및 CAD asset kind와 cascade 관계.

- [x] Prisma 모델 관계와 unique/index를 검증하는 schema 테스트를 먼저 실패시킨다.
- [x] migration의 기존 데이터 무변경 및 cascade 테스트를 실패시킨다.
- [x] schema와 migration을 구현하고 Prisma client를 생성한다.
- [x] migration 테스트와 Prisma validation을 통과시킨다.
- [x] DB 문서를 최신화하고 `feat(cad): persist native floor scenes`로 커밋한다.

### Task 3: CAD region 탐지와 정규화

**Files:**
- Create: `apps/api/src/floor-import/cad-region-detector.ts`
- Create: `apps/api/src/floor-import/cad-region-detector.spec.ts`
- Modify: `apps/api/src/floor-import/cad-viewport.ts`
- Modify: `apps/api/src/floor-import/cad-core-executor.ts`
- Modify: `apps/api/src/floor-import/cad-core-child.ts`

**Interfaces:**
- Produces: `detectCadRegions(document)`, region별 bounds/statistics와 선택 region transform.

- [x] 멀리 떨어진 평면도·표제란·상세도를 분리하는 실패 테스트를 작성한다.
- [x] 반복 block과 다중 entity 군집이 singleton 제거에 묻히지 않는 실패 테스트를 작성한다.
- [x] region detector와 맵 크기 정규화를 구현한다.
- [x] 실제 제공 DWG 변환 결과를 fixture manifest로 검증한다.
- [x] 관련 unit/integration 테스트를 통과시키고 커밋한다(최초 `cd7d1a92`, 실제 원본 보완 `df96a8b6`).

### Task 4: 네이티브 primitive 변환과 tile encoder

**Files:**
- Create: `apps/api/src/floor-import/cad-scene-builder.ts`
- Create: `apps/api/src/floor-import/cad-scene-builder.spec.ts`
- Create: `apps/api/src/floor-import/cad-scene-codec.ts`
- Create: `apps/api/src/floor-import/cad-scene-codec.spec.ts`
- Modify: `apps/api/src/floor-import/cad-geometry.ts`

**Interfaces:**
- Produces: `buildCadScene(document, region, options)`, stable occurrence element ID, 512 tile/LOD binary payload와 manifest.

- [x] LINE/POLYLINE/rectangle/triangle/circle/ellipse/arc/text 변환 실패 테스트를 작성한다.
- [x] block occurrence ID 안정성, simplify/deduplicate와 tile 경계 중복 방지 실패 테스트를 작성한다.
- [x] compact typed-array codec round-trip 실패 테스트를 작성한다.
- [x] builder와 codec을 구현한다.
- [x] 300,000 primitive benchmark fixture에서 memory/time 예산을 기록하고 `feat(cad): build tiled native scenes`로 커밋한다.

**완료 기록 (2026-09-19):** 실제 geometry가 지나는 셀만 순회하고 line/polyline은 타일 경계에서 분할한다. 비균일 변환 곡선의 적응형 오차 샘플링과 정확 극값, additive LOD, 연속 `part`, 16 MiB 단일 tile, 512 MiB scene 전체 출력, 셀당 128 part, 전역 12,288 descriptor와 manifest/tile asset ID 유일성을 강제한다. 격리한 30만 primitive 벤치마크는 약 2.2초, builder 추가 최대 RSS 약 440 MiB로 30초/512 MiB 예산을 통과했다.

### Task 5: worker persistence와 region API

**Files:**
- Modify: `apps/api/src/floor-import/floor-import-worker.service.ts`
- Modify: `apps/api/src/floor-import/floor-import.service.ts`
- Modify: `apps/api/src/floor-import/floor-import.controller.ts`
- Modify: `apps/api/src/storage/object-storage.service.ts`
- Modify: `apps/api/src/floor-import/floor-import.integration.spec.ts`

**Interfaces:**
- Consumes: Task 3 regions, Task 4 scene tiles.
- Produces: region 목록/선택 API, scene manifest/tile private content API, atomic apply와 orphan cleanup.

- [x] 여러 region job이 선택 전 apply되지 않는 통합 실패 테스트를 작성한다.
- [x] tenant/floor 권한, tile hash/size 검증과 범위 밖 tile 요청 실패 테스트를 작성한다.
- [x] storage 업로드 후 DB 활성화 실패 시 cleanup tombstone 테스트를 작성한다.
- [x] API와 worker persistence를 구현한다.
- [x] API unit/integration 테스트를 통과시키고 `feat(cad): publish native scene tiles`로 커밋한다.

### Task 6: override 및 layer 편집 API

**Files:**
- Modify: `packages/shared/src/cad-scene-contracts.ts`
- Modify: `apps/api/src/floor-map/floor-map.controller.ts`
- Modify: `apps/api/src/floor-map/floor-map.service.ts`
- Modify: `apps/api/src/floor-map/floor-map.integration.spec.ts`

**Interfaces:**
- Produces: scene manifest 조회, element override upsert/delete와 layer visible/locked 저장 API.

- [x] lease/revision/권한 및 존재하지 않는 element override 거부 테스트를 작성한다.
- [x] override batch 한도와 원자적 revision 증가 테스트를 작성한다.
- [x] API를 구현하고 editor-state/map snapshot에 scene descriptor를 추가한다.
- [x] 관련 테스트를 통과시키고 `feat(editor): persist cad element edits`로 커밋한다.

### Task 7: PixiJS WebGL CAD renderer

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/features/cad-scene/CadSceneRenderer.ts`
- Create: `apps/web/src/features/cad-scene/cad-scene-camera.ts`
- Create: `apps/web/src/features/cad-scene/cad-scene-tile-cache.ts`
- Create: `apps/web/src/features/cad-scene/cad-scene-worker.ts`
- Create: `apps/web/src/features/cad-scene/cad-scene-renderer.test.ts`

**Interfaces:**
- Consumes: scene manifest/tile codec.
- Produces: `CadSceneRenderer.mount(canvas)`, `setCamera`, `pick`, `setSelectionExclusion`, `destroy`.

- [x] visible tile 계산, LOD 전환, request dedupe와 LRU eviction 실패 테스트를 작성한다.
- [x] renderer가 primitive별 Pixi display object를 생성하지 않는 구조 테스트를 작성한다.
- [x] PixiJS를 설치하고 명시적 WebGL renderer와 batch geometry를 구현한다.
- [x] context loss/recovery와 resolution cap을 구현한다.
- [x] renderer unit/benchmark 테스트를 통과시키고 `feat(web): render cad scenes with webgl`로 커밋한다.

### Task 8: FloorEditor 하이브리드 통합

**Files:**
- Create: `apps/web/src/features/floor-editor/CadSceneCanvas.tsx`
- Create: `apps/web/src/features/floor-editor/CadElementOverlay.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Modify: `apps/web/src/features/floor-editor/editor-store.ts`
- Modify: `apps/web/src/features/floor-editor/editor-types.ts`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`

**Interfaces:**
- Consumes: Task 7 renderer, Task 6 override API.
- Produces: synchronized camera, 그룹은 click/요소는 double-click, 그룹 없는 단독 요소는 single-click 선택, Konva promote/edit/demote 흐름.

- [x] Pixi와 Konva pan/zoom 좌표가 일치하는 실패 테스트를 작성한다.
- [x] CAD group 선택, double-click element 선택과 override 저장 실패 테스트를 작성한다.
- [x] CAD canvas를 Konva 아래에 합성하고 pointer controller를 통합한다.
- [x] 선택 element를 Konva overlay로 승격해 이동·크기·회전·색상·숨김 편집을 구현한다.
- [x] editor 테스트를 통과시키고 커밋한다(`0645984e`).

### Task 9: region 선택 및 가져오기 UI

**Files:**
- Modify: `apps/web/src/features/floor-editor/CadImportPanel.tsx`
- Modify: `apps/web/src/features/floor-editor/CadImportPanel.test.tsx`
- Modify: `apps/web/src/api/queries.ts`

**Interfaces:**
- Consumes: Task 5 region/scene API.
- Produces: region preview 선택, 변환 통계, 맵 초기화 확인과 적용 흐름.

- [x] 단일 region 자동선택과 다중 region 필수선택 UI 실패 테스트를 작성한다.
- [x] primitive/slot/제외 요소 수와 새 맵 크기 표시 테스트를 작성한다.
- [x] UI를 구현하고 진행률이 region/scene 단계에서도 단조 증가하도록 연결한다.
- [x] UI 테스트를 통과시키고 커밋한다(`6228e9c2`).

### Task 10: 모니터링 및 모바일 WebView 대응

**Files:**
- Modify: `apps/web/src/features/floor-map/FloorScene.tsx`
- Modify: `apps/web/src/features/floor-map/FloorMapViewport.tsx`
- Modify: `apps/web/src/features/floor-map/FloorScene.test.tsx`
- Modify: React Native WebView shell files located during implementation

**Interfaces:**
- Produces: 모니터링 read-only CAD scene, 모바일 hardware layer/gesture/resolution 정책.

- [x] 모니터링이 applied scene을 read-only로 표시하는 실패 테스트를 작성한다.
- [x] WebView에서 고빈도 camera event가 native bridge로 전송되지 않는 테스트를 작성한다.
- [x] read-only renderer와 모바일 gesture adapter를 구현한다.
- [x] Web build와 Mobile typecheck/자동 테스트를 통과시키고 커밋한다(`0645984e`). 실제 iOS/Android 바이너리 빌드·기기 WebView GPU 성능은 이 소프트웨어 검증으로 대체하지 않는다.

### Task 11: 실제 DWG 검증, 문서와 회귀 점검

**Files:**
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/lesson_leared.md`
- Create: `docs/test-results/cad-native-map-2026-09-18.md`

**Interfaces:**
- Consumes: 전체 구현.
- Produces: 실제 도면 정확도와 성능 측정 결과.

- [x] 제공된 두 DWG를 실제 pipeline으로 변환한다.
- [x] region bounds, native primitive 수, 조명 후보 수와 변환 불가 요소 비율을 기록한다.
- [x] 1,000 fixture를 합성해 desktop 및 mobile viewport benchmark를 실행한다.
- [x] API/web/shared 전체 테스트, lint/typecheck/build를 실행한다(환경 의존 제외와 후속 집중 회귀 범위는 검증 보고서/상태판에 구분).
- [x] Playwright에서 업로드→region 선택→적용→선택/편집→새로고침→모니터링 흐름을 검증한다(합성 API/geometry 기반 Chromium, 실제 원본 pipeline과 별도).
- [x] 메뉴/교훈/테스트 결과 문서를 최신화하고 `docs(cad): record native map verification`으로 커밋한다.

### Task 12: 실제 웹 가져오기 실패 복구

- [x] 실제 실패 작업의 상태·단계·시도 횟수 확인(35%, parse, 3회).
- [x] 업로드된 원본과 실제 서버의 기본 설정을 대조한다. 새 프로세스는 1,817개 영역을 정상 반환하지만 실행 중인 API 메모리에는 과거 100개 상한이 남아 있음을 확인했다.
- [x] 실패 화면을 안전한 단계별 안내로 보완했다(`2fa9f1a3`). Web 전체 1,605개 통과/2개 opt-in 제외, 타입 검사와 집중 63개 회귀 통과.
- [x] DXF 직접 분석과 안전한 진단 분류를 추가했다(`8c15226a`). 최종 API 전체 2,163 통과/524 환경 제외/실패 0, parser/region 집중 회귀, PostgreSQL 23개 통과. 기존 자원·손상 입력 검증을 유지한다.
- [x] 최신 기본 converter/core에서 실제 두 DWG 변환·분석 2/2 통과 및 재시작된 API 메모리/디스크 코드 일치를 확인했다. 5173 응답 200, 비로그인 auth 응답 401을 확인했다.
- [ ] 실제 사용자 로그인 후 재업로드→영역 선택→적용 브라우저 검증: 내장 브라우저 로그인 대기. 이전 route fixture 결과로 대체하지 않는다. 기존 실패 이력·맵 데이터는 수정하지 않았다.
- [x] 설정 메뉴·교훈·상태판·검증 보고서를 갱신했다. 코드 작업은 위 두 커밋으로 분리했고 문서도 별도 작업 단위로 기록한다.

### Task 13: 기존 맵 교체 실패 및 후보 미리보기 확대

- [x] 실서버 기록 확인: 같은 층 첫 apply 200, 두 번째 apply 500(125ms), 두 번째 작업은 review_required 유지.
- [x] 실제 기존 맵·후보·scene 상태 대조: 동일 selected region의 두 번째 적용에서 형식 version 2를 쓰려다 SQL23514 `FloorCadScene_dimensions_check`가 실패함을 실제 PostgreSQL RED 회귀로 확인했다.
- [x] 형식 버전 보존 수정과 native→native 교체·rollback·적용 후 재조회 회귀 완료. 실제 PostgreSQL 포함 집중 56/56, API 전체 2,163 통과/527 제외/실패 0, 타입 검사 통과. DB migration/사용자 데이터 재작성 없음.
- [x] 기존 중앙 편집 화면의 후보 검토를 선택 영역 native scene 좌표로 수정하고 자동 맞춤·확대/축소·이동·후보 선택을 검증한다. 이전 맵·배치 숨김, 실패 안내/재시도, 층/영역 전환·renderer 해제를 포함한다.
- [x] 실제 PostgreSQL 집중 56개, Web 전체 1,614 통과/2 제외, Chromium route fixture 여정 2개, 타입 검사와 API/Web 빌드를 확인하고 메뉴 문서·교훈·진행 상태에 검증 범위를 구분해 기록한다.
- [ ] 별도 큰 미리보기 팝업: 사용자 설계 답변 대기. 현재 중앙 편집 화면의 큰 검토와 별개이며 팝업을 구현했다고 표시하지 않는다.
- [ ] 실제 사용자 계정의 적용→새로고침 브라우저 검증: 내장 브라우저 로그인 대기. 사용자 DB의 맵·배치를 임의 적용/초기화하지 않았다.

### Task 14: 실제 적용 후 CAD 표시 실패

- [x] 실서버 적용 200과 표시 실패를 구분하고 manifest 302 이후 tile 요청이 없는 증거 확인.
- [x] 실제 Chrome의 ZodError 2건을 원시 manifest의 byteSize/sha256 누락과 대조했다. 서버 내부 원장 보완은 정상이나 302 원시파일 응답이 이를 우회했다. 현재 875개 타일의 존재·크기·digest·codec 검증은 모두 통과했다.
- [x] 원시 builder 파일→실제 storage reader→HTTP 응답 회귀에서 200 기대/302 수신 RED 후 manifest만 검증된 JSON으로 수정했다. 필수 schema와 타일302/권한/무결성/응답 상한은 유지한다.
- [x] 실제 admin Chrome의 B1 리비전 17 도면 표시·새로고침·확대·드래그·모니터링 왕복을 확인했다. 집중 92/92, API 전체 2,163 통과/527 환경 제외, 타입 검사·빌드·독립 리뷰와 메뉴/교훈/결과 문서를 정리했다. 사용자 맵 데이터 재적용/초기화는 하지 않았다.

### 유지할 후속 한계

- 원본 DXF `ELLIPSE` 등 미지원 entity 파싱, 사람 기준 원본 재현 정확도·조명 후보 precision/recall은 별도 작업이다. Native `ellipse` 모델 지원과 입력 parser 지원을 혼동하지 않는다.
- 큰 도면 최초 전체 표시 약 10~13초를 줄일 추가 전송량 최적화, 실제 iOS/Android 기기의 GPU 성능, Linux 양산 컨테이너 실측은 이번 완료 판정에 포함하지 않는다.
- 실제 하드웨어 자동 등록은 하지 않는다. CAD 후보는 미배정 위치이고, 등록한 실제 조명을 사용자가 연결하는 정책을 유지한다.
