# Task 19.5 샘플 DWG 분석 및 문서 구현 보고서

기준일: 2026-09-17

## 구현 범위

- `scripts/analyze-cad-import.mjs`: DXF 직접 분석, DWG argv 기반 변환, 안정된 JSON과 한글 요약 출력
- `scripts/analyze-cad-import.test.mjs`: 통계, ground truth 지표, 0분모, 안전 상한, 임시 파일 정리, 반복 출력 계약
- 설정 메뉴 기능 현황, 프로젝트 상태판, 반복 교훈 갱신
- 제품 코드나 package 의존성에 LibreDWG를 추가하지 않음

## 실행 계약

```bash
node scripts/analyze-cad-import.mjs \
  --input "/absolute/path/to/sample.dwg" \
  --converter /opt/homebrew/bin/dwgread \
  > analysis.json \
  2> analysis.ko.txt
```

- DXF는 변환기 없이 직접 읽는다.
- DWG는 절대 경로로 명시한 converter를 `spawn`의 분리된 argv와 `shell: false`로 실행한다. 현재 개발 검증기는 `/opt/homebrew/bin/dwgread`다.
- 기본 hard cap은 입력 128 MiB, 변환 DXF 256 MiB, converter stdout+stderr 1 MiB, JSON 8 MiB, 변환 30초, parse 30초, DXF entity record 1,000,000개다. CLI limit 인자는 hard cap을 낮출 수만 있다.
- converter 미설치·미지정, malformed/지원하지 않는 파일, 상한 초과는 결과를 내지 않고 fail-close한다. 변환 성공·실패 모두 임시 디렉터리를 정리한다.
- ground truth JSON은 `{ "truePositive": N, "falsePositive": N, "falseNegative": N }`만 허용한다. precision 또는 recall 분모가 0이면 해당 값과 F1은 `null`이다. 둘 다 정의되지만 0이면 F1은 `0`이다.

## 제공 샘플 결과

| 항목 | 결과 |
| --- | ---: |
| 원본 SHA256 | `01f25d539c20f93663c9183bbf70d83e578ae9990c2eb6dabb543bf39d71854d` |
| 원본 크기 | 17,887,748 bytes |
| analyzer | `cad-import-analysis/1` |
| converter | LibreDWG `dwgread 0.14` |
| 변환 DXF | AC1024, `ANSI_949` 메타데이터, 실제 UTF-8 text bytes, 105,432,404 bytes |
| raw entity record | 310,153 |
| model-space entity | 31,037 |
| layer / block | 107 / 11,243 |
| INSERT / 고유 INSERT 좌표 | 9,365 / 9,358 |
| 규칙 후보 / 고유 후보 좌표 | 0 / 0 |

Model-space entity 구성은 `ARC 266`, `CIRCLE 831`, `DIMENSION 2,761`, `HATCH 9`, `INSERT 9,365`, `LINE 3,544`, `LWPOLYLINE 7,349`, `POINT 2`, `POLYLINE 7`, `SPLINE 87`, `TEXT 6,409`, `VIEWPORT 10`, `WIPEOUT 397`이다.

이 표는 개발 분석기 결과다. 샘플의 변환 DXF 105,432,404 bytes는 `FloorImportWorkerService`의 현재 고정 `MAX_DXF_BYTES = 16 MiB`와 converter 기본 상한을 초과한다. 따라서 현재 제품 worker에서는 변환 결과 크기 검사에서 fail-close하며, 아래 맵 기하 수치는 import 성공률이 아니라 상한 밖 파일을 별도 분석한 예상치다. 상한을 높이려면 parser의 전체 파일 적재, CPU/메모리, SVG 8 MiB, entity/candidate 제한을 함께 부하 검증해야 한다.

주요 layer와 block은 다음과 같다. 모든 현재 후보 수는 0이다.

| 종류 | 이름 | entity/정의 entity | INSERT | 후보 |
| --- | --- | ---: | ---: | ---: |
| layer | `#01-1-1.지하주차장_전등` | 3,108 | 2,075 | 0 |
| layer | `#02-3.지하주차장_유도등` | 1,007 | 252 | 0 |
| block | `xx4` | 4 | 1,816 | 0 |
| block | `몰드바등` | 1 | 1,371 | 0 |
| block | `*U976` | 4 | 836 | 0 |
| block | `*U978` | 4 | 749 | 0 |

현재 규칙은 layer와 block 이름 token, 동일 block 반복을 모두 요구한다. 샘플의 전등 layer는 일치하지만 `몰드바등`, `xx4`, 익명 dynamic block은 허용 block token과 일치하지 않는다. 따라서 후보 0개는 검출 성공이 아니라 현장 profile과 ground truth 보강이 필요하다는 결과다.

## 정확도 해석

1. **좌표·심볼 추출 coverage 100%**: 9,365개 INSERT 모두에서 block 이름과 유한 좌표를 추출했다는 뜻이다. 실제 유효 조명 recall 100%를 뜻하지 않는다.
2. **지원 entity 기준 맵 기하 재현 예상 89.4771%**: model-space entity 31,037개 중 현재 renderer 지원 종류 27,771개의 비율이다. 제품 worker의 16 MiB 상한 통과, `DIMENSION`, `HATCH`, `POINT`, `SPLINE`, `VIEWPORT`, `WIPEOUT`의 시각적 재현이나 최종 렌더 픽셀 정확도를 보장하지 않는다.
3. **검출 precision/recall/F1 미확정**: 사람이 라벨링한 TP/FP/FN ground truth를 입력하지 않았다. 후보 0개만으로 precision 또는 F1을 100%로 기록하지 않는다.
4. **실제 BLE identity 매핑 0%**: CAD 후보는 실제 장비 identity가 아니며 `Fixture`나 `MeshNode`를 만들지 않고 자동 등록·바인딩하지 않는다.

AI는 I/O 호출이 없는 `disabled` adapter만 사용한다. `LightingSymbolDetector` 경계로 provider를 교체할 수 있지만 좌표는 CAD parser 결과만 사용하며 외부 전송은 별도 승인 전 비활성이다. 신규 import는 DWG/DXF만 지원하고 PDF는 제외한다. 기존 PDF 읽기 호환은 유지한다.

## 검증 증거

- TDD RED: 구현 파일 부재 상태에서 `node --test scripts/analyze-cad-import.test.mjs` 7개 실패를 확인했다.
- 인코딩 RED/GREEN: `ANSI_949` 헤더와 UTF-8 문자열을 함께 내는 LibreDWG fixture가 수정 전 실패, 수정 후 통과했다.
- analyzer test: 8/8 통과.
- 제공 DWG 실행: 종료 코드 0, JSON과 한글 요약 생성.
- 같은 입력을 두 번 실행한 JSON SHA256은 모두 `9040d8c29dd7938121f21bd1fa58a18323fa567a09050dd5373e357f61cc426e`였다.
- 같은 입력을 두 번 실행한 한글 요약 SHA256은 모두 `4b7732e3cd67045b44715aab29a71aa92f7e3578de09f10d878a82d276f94a84`였다.
- Shared/API/Web 최종 전체 검증은 병렬 Task 19.4 fix가 끝난 뒤 메인 에이전트가 수행한다.
