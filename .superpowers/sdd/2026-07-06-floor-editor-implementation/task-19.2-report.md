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

## 최초 구현 검증 결과

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

## Fix round 1 (2026-09-16)

`task-19.2-review.md`의 P1 4건과 P2 4건을 모두 TDD로 보완했다.

### Converter resource isolation

- macOS/Unix production 전용 `ArgvCadConverter`로 경계를 명시했다. Windows와 process group을 제공하지 않는 platform은 constructor에서 fail-close한다.
- converter를 `detached` Unix process group으로 실행하고 timeout, abort, process output 초과, output file 초과 시 negative PID에 `SIGKILL`을 보내 descendant 전체를 종료한다.
- kill과 함께 stdout/stderr pipe를 destroy해 descendant가 상속한 pipe 때문에 `close`가 wall-clock 상한 뒤까지 지연되지 않게 했다.
- 실행 중 output file을 20ms 간격으로 `lstat`해 size cap, symlink, non-regular file을 감지하면 즉시 process group을 종료한다.
- timeout, nonzero exit, launch failure, process/file output 초과와 최종 검증 실패를 포함한 모든 실행 실패에서 partial output을 제거한다.
- 실제 Node parent/descendant process와 inherited pipe를 사용한 회귀 테스트로 timeout 반환 시간과 지연 marker 미생성을 검증했다.

### Strict DXF identity and numeric parsing

- 좌표·scale·angle·bulge는 DXF decimal 문법을 full-match한 뒤 변환한다. empty, whitespace-only, hex, numeric separator, `Infinity`, `NaN`을 거부한다.
- integer group은 별도 integer 문법과 safe-integer 검사를 사용한다.
- group 5 handle은 문서 전체에서 대소문자를 무시해 중복 검사한다.
- parser 생성 source ID와 명시 handle/source ID의 충돌도 fail-close한다.
- INSERT 뒤의 ATTRIB/SEQEND를 구조적으로 소비하고 tag, value, position, rotation, height, source ID를 정규화한다. orphan ATTRIB/SEQEND는 거부한다.

### Geometry and SVG correctness

- polyline vertex에 group 42 bulge를 보존한다. signed bulge를 center/radius/start/sweep arc로 변환해 bounds extrema와 SVG sampled arc가 같은 geometry를 사용한다.
- nested non-uniform INSERT 안의 TEXT/MTEXT는 `viewport projection × parent affine × text translation/rotation × glyph Y-flip` 전체를 SVG matrix로 적용한다.
- text bounds와 SVG glyph가 같은 parent affine 계보를 사용하므로 non-uniform scale과 nested rotation에서 shear/축 scale을 잃지 않는다.

### Detector evidence and nested INSERTs

- `includes()`를 제거하고 Unicode NFKC token sequence 경계를 사용하는 matcher로 바꿨다. `LEDGER`, `SCHEDULED_NOTE` 같은 부분 문자열 false positive를 거부한다.
- profile에 layer/block/ATTRIB/nearby-text positive matcher와 각 category deny matcher, nearby 거리, expanded INSERT 상한을 추가했다.
- ATTRIB와 근접 TEXT positive evidence를 각각 `attribute_pattern`, `nearby_text_pattern`으로 결과에 기록하고 deny evidence가 있으면 후보를 제외한다.
- detector 전용 INSERT expansion이 nested block을 world position/rotation/scale과 effective layer로 펼친다. source ID는 `ROOT/N1` 형식의 안정적인 insertion path를 사용한다.
- 1,000개 후보 테스트도 expanded world traversal에서 유지된다.

### Fix round 1 TDD/verification

- 각 finding의 회귀 테스트를 먼저 추가해 4 converter, 6 parser, 2 renderer, 3 detector 실패를 확인한 뒤 구현했다.
- 추가 identity review에서 handle case variant와 generated/explicit source collision 2건을 RED→GREEN으로 보강했다.
- focused CAD: `5 suites / 37 tests` 통과
- CAD strict standalone TypeScript compile: 통과
- API typecheck: 통과
- API build: 통과
- API 전체 Jest: `152 suites passed / 43 environment-gated skipped`, `1,778 tests passed / 475 skipped / 실패 0`

### 운영 주의

- process-group isolation은 macOS/Unix production 기준이다. Windows는 지원하지 않고 fail-close한다.
- 20ms output polling은 runaway file을 빠르게 종료하지만 filesystem quota 자체를 대체하지 않는다. 배포 worker의 임시 볼륨 quota는 Task 19.3 운영 구성에서도 유지해야 한다.

## Fix round 2 (2026-09-17)

`task-19.2-rereview.md`의 P1 2건과 P2 4건을 모두 TDD로 보완했다. 이 절의 실행 정책이 위 Fix round 1 운영 주의를 대체한다.

### Linux hard output cap과 platform 정책

- production 지원 대상을 Linux로 명시하고, absolute `limiterExecutable`과 `{maxOutputBytes}`를 정확히 한 번 포함하는 limiter argv가 없으면 constructor 단계에서 fail-close한다.
- production launch는 `limiter argv + converter executable + converter argv` 배열로 구성하며 `shell: false`를 유지한다. `prlimit --fsize={maxOutputBytes} --` 같은 kernel `RLIMIT_FSIZE` wrapper를 설정할 수 있다.
- limiter와 converter/descendant는 하나의 detached process group으로 실행되어 timeout, abort, stdout/stderr 상한 시 전체가 종료된다. `SIGXFSZ`, nonzero exit, 최종 file 검증 실패에서 partial output을 제거한다.
- macOS는 `macos-development-polling`과 `acknowledgeNonProductionRisk: true`를 함께 지정한 개발 모드만 허용한다. 이 모드의 20ms polling은 production 보장이 아니다.
- Linux에서 polling mode, macOS에서 Linux limiter mode, Windows 및 그 밖의 platform, limiter 미설정은 모두 fail-close한다.

### Bounded rule detector

- TEXT/MTEXT를 한 번만 NFKC/tokenize한 뒤 `nearbyTextDistance` 크기의 uniform grid cell에 넣고, INSERT마다 인접 cell만 radius query한다.
- layer, block, ATTRIB도 INSERT당 한 번만 tokenize해 positive/deny matcher가 같은 token 배열을 재사용한다.
- profile 기본 5초 monotonic deadline과 호출별 override, `AbortSignal`을 detector interface에 추가했다. INSERT expansion, text expansion/indexing, frequency 구축, grid query, candidate 순회마다 budget을 확인한다.
- disabled AI 구현은 확장된 interface를 따르지만 계속 외부 I/O 없이 빈 배열만 반환한다.

### Strict DXF와 안정적 world identity

- INSERT group 66은 strict integer 0/1만 허용하며 중복 flag를 거부한다. 값 1은 하나 이상의 ATTRIB 뒤 필수 SEQEND를 요구하고, 값 0/생략 뒤 ATTRIB 또는 SEQEND는 orphan으로 거부한다.
- INSERT x/y/z scale은 finite signed nonzero 값을 허용한다. 음수 scale의 reflection은 affine bounds/SVG에 그대로 적용하고 world detector 값은 회전과 signed determinant scale로 보존한다.
- nested source path는 각 UTF-8 segment를 `byteLength:value`로 연결한다. 최종 ID의 512-byte 상한과 NFKC/case-insensitive uniqueness를 expansion 결과 전체에서 다시 검증한다.

### Deterministic text bounds와 render

- bundled `NotoSansKR-Regular.ttf`와 `NotoEmoji.ttf`를 fontkit으로 layout하고 glyph advance/bbox를 계산한다.
- bounds와 SVG가 같은 glyph layout 결과를 사용하며 SVG에는 host font fallback이 없는 glyph path만 기록한다. 따라서 긴 `W`/한글, 회전, nested non-uniform affine에서도 viewport와 실제 pixel bounds가 일치한다.
- 원문은 XML-sanitized `aria-label`로 유지하고, XML 금지 scalar는 bundled replacement glyph로 그린다. 외부 font/resource 참조는 만들지 않는다.

### Fix round 2 TDD/verification

- 먼저 limiter 미설정/Linux wrapper, strict group 66 sequence, negative/zero scale, nested path collision/final duplicate, detector abort/deadline/1,000 INSERT + 1,000 TEXT, text path pixel clipping 테스트로 RED를 확인했다.
- focused CAD: `5 suites / 52 tests` 통과
- API typecheck: 통과
- API build: 통과
- API 전체 Jest: `152 suites passed / 43 environment-gated skipped`, `1,793 tests passed / 475 skipped / 실패 0`

### 남은 운영 concern

- production 배포 설정은 Linux host에 실제 kernel limit를 적용하는 absolute limiter executable과 올바른 argv를 제공해야 한다. adapter는 argv 구조와 fail-close 정책을 강제하지만 지정된 executable 자체의 운영 신뢰성은 배포 이미지 검증 범위다.
- macOS polling mode는 로컬 개발 전용이며 production으로 승격할 수 없다. Windows는 지원하지 않는다.

## Fix round 3 (2026-09-17)

`task-19.2-rereview-2.md`의 신규 P1 1건과 P2 2건을 TDD로 보완했다. 이 절의 Linux limiter 정책이 Fix round 2의 caller-configured limiter 설명과 concern을 대체한다.

### Incremental SVG text budget

- bounds 전용 glyph traversal은 SVG path를 생성하지 않는다. fontkit layout도 최대 128문자 chunk로 제한해 긴 text 전체 glyph 배열을 한 번에 보관하지 않는다.
- renderer는 `maxOutputBytes`에서 허용 가능한 전체 text glyph 작업 수를 도출하고 bounds 단계부터 누적 차감한다. 20,000자 한글과 1 KiB output cap 조합은 수십 glyph 안에서 즉시 fail-close한다.
- text accessibility label은 XML escape 후 필요한 byte를 먼저 계산하고, 남은 budget 안에 들어올 때만 문자열을 만든다.
- 각 glyph는 trusted font path command를 순회해 정확한 SVG path byte 길이를 먼저 계산한다. 남은 output budget을 확인한 뒤 한 glyph path만 생성하고, 직후 완성된 path element의 실제 UTF-8 byte를 차감한다. 전체 path 배열이나 joined path 문자열은 만들지 않는다.
- 60,000-byte text adversarial 회귀에서 이전 약 108 MiB RSS 증가 경로를 제거하고 64 MiB 미만 delta로 제한됨을 검증한다.

### Repository-owned GNU prlimit adapter

- Linux production policy에서 caller가 limiter executable이나 argv를 제공하는 필드를 제거했다. adapter가 canonical `/usr/bin/prlimit`와 `--fsize=<bytes>:<bytes> -- <converter> ...` argv를 직접 구성한다.
- startup attestation은 `/usr/bin/prlimit`의 real path 일치, non-symlink regular file, uid 0, group/world non-writable mode, executable bit를 확인한다. 하나라도 다르면 converter를 시작하지 않는다.
- 실제 filesystem inspector가 기본이며 unit test에는 identity inspector를 주입할 수 있다. caller가 `/usr/bin/env` 같은 pass-through command를 extra field로 넣어도 launch 의미는 바뀌지 않는다.
- Linux 환경에서는 실제 1 MiB 초과 write가 `RLIMIT_FSIZE`에 의해 중단되고 partial output이 제거되는 integration test가 활성화된다. Darwin에서는 platform-gated skip된다.

### Cooperative detector cancellation

- CAD expansion을 entity 방문 event iterator로 분리해 빈 block INSERT도 작업량에 포함한다.
- detector는 profile의 `cooperativeYieldInterval` 기본 256회마다 `setImmediate`로 event loop에 제어권을 반환한다.
- INSERT/text expansion, spatial index, frequency/token 준비, nearby query, candidate 판정이 동일한 bounded work counter를 사용한다.
- yield 직후 `AbortSignal`과 monotonic deadline을 재검사한다. 실행 중 `setTimeout(...abort...)` 및 yield 중 deadline 경과 adversarial 테스트가 각각 abort/time-limit rejection을 검증한다.

### Fix round 3 TDD/verification

- 큰 text/tiny output cap RSS, caller limiter override와 six invalid identities, 실행 중 abort와 yield 중 deadline 테스트를 먼저 추가해 RED를 확인했다.
- focused CAD: `5 suites / 61 tests` 통과, Linux 전용 hard-cap integration 1건은 Darwin에서 environment-gated skip
- API typecheck: 통과
- API build: 통과
- API 전체 Jest: `152 suites passed / 43 environment-gated skipped`, `1,802 tests passed / 476 skipped / 실패 0`

### 현재 운영 concern

- production은 GNU `prlimit`가 canonical `/usr/bin/prlimit` regular root-owned executable로 설치된 Linux image만 지원한다. 이 identity가 다른 distribution은 의도적으로 fail-close하며 image contract를 맞춰야 한다.
- macOS polling은 개발 전용이고 Windows는 unsupported fail-close다.
