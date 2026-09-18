# CAD 네이티브 맵 Task 4 검증 결과

## 구현 내용

- scene manifest에 누적 LOD 정책(`lodMode: "additive"`)을 명시했다.
- 타일별 `part`, 연속 번호 검증, 셀당 128 part, 전체 12,288 descriptor 제한을 추가했다.
- primitive에 타일 렌더링 영역을 나타내는 `clipBounds`를 추가했다.
- `FloorCadTile.part`, 5개 필드 복합 유일 키와 viewport 조회 인덱스를 DB에 추가했다.
- 기존 데이터가 있는 상태에서도 안전하게 constraint와 index를 교체하는 후속 migration을 구현했다.
- binary codec에 16 MiB 사전 제한, UTF-8 제한, payload/count 용량 검사, 잘못된 UTF-8 및 비정상 숫자 거부, trailing data와 무결성 검사를 추가했다.
- line, polyline, rectangle, triangle, ellipse, arc, text를 native primitive로 변환한다.
- block occurrence transform을 element/group ID에 포함하며 DIMENSION 의미 그룹과 LOD를 보존한다.
- 65,000개 이상의 polyline도 재귀 호출 없이 단순화하고 최대 점 개수에 맞춰 분할한다.
- geometry bounding box 전체가 아니라 실제 선분, 도형 테두리, 채움 영역이 차지하는 셀만 계산한다.
- line/polyline은 타일 경계에서 geometry를 분할하면서 논리 `elementId`를 유지한다.
- 회전된 arc와 bulge의 정확한 극점을 경로에 포함해 bounds와 렌더링 geometry를 일치시킨다.
- 비균일 affine 변환 곡선은 화면 좌표 chord 오차 0.5 이하로 샘플링하고 모든 512 단위 타일 경계와의 해석적 교점을 경로에 보존한다.
- 좌표 정밀도 아래로 납작해진 원은 decode 불가능한 ellipse 대신 선으로 변환한다.
- 단일 타일 16 MiB, scene 전체 512 MiB를 넘기기 전에 변환을 중단한다.
- 동일 tile asset ID와 manifest/tile ID 충돌, 셀당 part 제한, 전체 descriptor 제한을 DB 저장 전에 거부한다.
- 보관 primitive가 50,000 occurrence에 도달하면 큰 타일부터 binary part로 확정해 객체 참조를 해제한다.
- 외부 codec API는 Zod 검증을 유지하고, 정규화된 CAD만 받는 builder 내부 경로는 중복 객체 복제를 피한다.

## 실패 테스트로 확인한 결함

- ellipse byte-size 추정 불일치와 무결성 오류 은폐 문제를 확인했다.
- UTF-16 단독 surrogate, clip cell 불일치, 늦은 용량 거부와 decode 메모리 예약 순서 문제를 확인했다.
- 기존 index를 먼저 제거하는 migration 순서와 0개 primitive row 허용 문제를 확인했다.
- canonical transform ID, 타일 경계 clipping, DIMENSION 의미 정보, arc/bulge 정확 극값과 대형 polyline 처리 문제를 확인했다.
- bounding box 기반 타일 복제로 대각선 하나가 1,024개 타일에 복제되는 문제를 확인했다.
- 전체 출력 용량과 callback 기반 asset ID 중복이 builder에서 거부되지 않는 문제를 확인했다.

## 최종 검증

- Shared CAD contract: 18/18 통과.
- CAD builder/codec/migration 집중 검증: 45개 통과, benchmark 1개는 기본 실행에서 제외.
- 격리된 30만 primitive benchmark: 약 2.2초, builder 추가 최대 RSS 약 440 MiB.
- benchmark 예산: 30초 미만, builder 추가 최대 RSS 512 MiB 미만.
- Shared/API typecheck: 통과.
- Prisma validate: 통과.
- `git diff --check`: 통과.
- 4차 범위 재리뷰: nonuniform arc, bulge, hatch polyline/edge와 native arc/ellipse 모두 타일 누락 0건, 남은 finding 없음.

## 벤치마크 해석

Jest와 이전 테스트의 high-water mark가 측정에 섞이지 않도록 `tsx` child process에서 benchmark를 단독 실행한다. 이번 측정은 builder 실행 전 최대 RSS 약 212 MiB, 실행 후 약 652 MiB였으며 로그에는 기준 RSS, 절대 최대 RSS와 증가량을 모두 남긴다.
