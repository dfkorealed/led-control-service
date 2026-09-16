# Task 19.2 CAD 코어 구현 보고서

## 상태

- Task 19.2 변환·정규화·렌더·검출 코어 구현 완료
- LibreDWG 또는 특정 CAD SDK에 제품 코드를 결합하지 않음
- 외부 dependency 추가 없음
- 공유 `docs/project-status.md`, plan/spec 변경 및 chart/research/output 산출물 미수정·미스테이징

## 구현 범위

### 변환기 경계

- `CadConverter` 인터페이스로 worker와 실제 변환기를 분리했다.
- `ArgvCadConverter`는 절대 실행 파일 경로와 `{input}`, `{output}` placeholder가 포함된 argv 배열만 받는다.
- `shell: false`로 실행하고 shell 실행 파일, shell metacharacter, NUL/개행, placeholder 누락·중복을 시작 전에 거부한다.
- 입력과 출력은 서로 다른 절대 경로의 regular file이어야 한다.
- wall-clock timeout, stdout/stderr byte 상한, 결과 파일 byte 상한, abort signal, symlink 결과 거부를 fail-close로 처리한다.

### ASCII DXF 정규화

- 외부 parser 없이 bounded group-code reader를 구현했다. 입력 전체 크기를 먼저 제한하므로 parser dependency의 숨은 메모리 사용량에 의존하지 않는다.
- `LINE`, `LWPOLYLINE`, `POLYLINE`/`VERTEX`, `CIRCLE`, `ARC`, `TEXT`, `MTEXT`, `INSERT`, `BLOCKS`를 정규화한다.
- entity ID, layer, block name, 3D point, rotation, scale, block base point를 명시적 타입으로 보존한다.
- INSERT를 실제 affine transform으로 펼쳐 bounds를 계산한다. block 순환 참조, 없는 block 참조, 재귀 깊이와 expansion entity 수를 닫는다.
- 기본 상한은 입력 16 MiB, raw/expanded entity 100,000개, 절대 좌표 1,000,000, 정규화 JSON 32 MiB, 처리 시간 5초다.
- 원시 좌표뿐 아니라 block transform 적용 후 bounds도 좌표 상한을 다시 검사한다.

### SVG renderer

- 정규화 문서 하나를 외부 resource가 없는 단일 SVG로 만든다.
- 실제 펼친 geometry에서 bounds를 재계산하고 `viewBox="0 0 width height"`로 viewport 원점을 정규화한다.
- INSERT block을 affine transform으로 펼치며 최대 100,000개 render entity, block depth 16, SVG 8 MiB를 기본 상한으로 둔다.
- text, layer, insert layer, block name, source entity ID를 XML escape한다.
- XML 1.0 금지 control과 고립 UTF-16 surrogate는 replacement character로 바꾼다.
- `href`, `src`, image, foreignObject, CSS import 같은 외부 I/O 경로를 생성하지 않는다.

### 조명 심볼 검출

- `LightingSymbolDetector`와 `DetectedLightingSymbol` 계약을 규칙/향후 AI가 함께 사용한다.
- 기본 규칙은 layer token, block token, 동일 block 반복 빈도가 모두 교차하는 INSERT만 후보로 반환한다.
- 현장별 layer/block token, 최소 반복 수, confidence, 최대 후보 수를 profile로 바꿀 수 있다.
- 후보 위치와 회전은 정규화 INSERT 값만 복사하며 새 좌표를 추론하지 않는다.
- `DisabledAiLightingSymbolDetector`는 provider dependency 없이 항상 빈 배열을 반환한다.

## TDD 증거

1. 5개 spec을 먼저 작성하고 새 모듈 부재로 RED를 확인했다.
2. 최소 구현 뒤 type discriminator 오류를 재현하고 공용 geometry type guard를 수정했다.
3. MTEXT 공백 보존, INSERT layer SVG metadata, malformed fixture 단일 원인을 각각 실패 출력으로 확인한 뒤 GREEN으로 전환했다.
4. XML 고립 surrogate 보안 테스트를 추가해 RED를 확인한 뒤 code-point validation으로 GREEN을 확인했다.
5. transform 후 좌표 증폭 테스트를 추가해 RED를 확인한 뒤 최종 bounds 좌표 상한으로 GREEN을 확인했다.

최종 focused suite는 parser/renderer/converter/rule detector/disabled AI 5개 suite, 18개 테스트다. 1,000개 반복 INSERT 후보, malformed DXF, input/entity/output/coordinate/time/candidate/render 상한, 위험 argv, timeout, XML injection을 포함한다.

## 검증 결과

- `pnpm --filter @led-control/api exec jest src/floor-import --runInBand`: 통과, 5 suites / 18 tests
- CAD 파일 strict 단독 TypeScript compile: 통과
- `pnpm --filter @led-control/api typecheck`: 통과
- `pnpm --filter @led-control/api build`: 통과
- API 전체 Jest 실행 시점: CAD 포함 1,734 passed / 475 environment-gated skipped / report 영역 2 failed

전체 Jest 실행 중 실패한 두 report 계약은 공유 worktree의 동시 변경으로 이후 내용이 계속 바뀌었다. typecheck와 build는 후속 변경 후 재실행해 통과했다. 최신 report targeted 재검증에서는 `src/energy/reports/pdf-energy-report.renderer.spec.ts:51`의 row 순서 변조가 reject되지 않는 1건이 남았다. 이 파일들은 작업 시작 후 공유 worktree에서 별도로 변경됐으며 Task 19.2 범위 밖이므로 수정하지 않았다.

## 남은 범위와 우려

- 실제 ODA/DWG 변환 binary 선택·배포와 worker 연결은 Task 19.3 이후 범위다. 이 task는 argv-array adapter 계약과 fail-close 실행 경계만 제공한다.
- 실제 제공 DWG 품질·정확도 평가는 Task 19.5 범위다.
- rule detector는 의도적으로 보수적이다. layer와 block 이름이 profile에 모두 맞고 동일 block이 반복될 때만 검출하므로 현장 profile이 부족하면 false negative가 발생한다.
- 전체 API Jest green은 동시 report 작업의 오류가 해소된 뒤 다시 확인해야 한다.
