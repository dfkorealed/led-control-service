# Task 19.5 Fix Round 1 구현 보고서

> **Fix round 2로 대체됨:** 이 문서의 96,353,981-byte SVG, 128 MiB 제품 SVG 상한, 기본 profile `site-drawing-lighting/2`, 순차 후보 저장과 메모리 성공 표현은 재검토에서 폐기되었다. 현재 증거는 [Task 19.5 Fix Round 2](task-19.5-fix-round-2.md)를 따른다.

기준일: 2026-09-17

이 보고서는 `task-19.5-review.md`의 P1 3건과 P2 4건을 교정하며 이전 `task-19.5-implementation.md`의 model/paper 혼합 수치와 제품 pipeline 실패 상태를 대체한다.

## TDD와 구현

- RED: analyzer에서 mixed-layout 4개를 model 2개로 거르지 못했고, EOF trailing corpus와 line/body 상한이 실패했다. 제품 parser는 streaming API가 없어 테스트가 컴파일되지 않았다.
- GREEN: analyzer와 제품 parser가 공유 malformed corpus에서 EOF final, SECTION/ENDSEC, BLOCK/ENDBLK, ATTRIB/SEQEND, line/entity body 상한을 fail-close한다. group 67이 0이 아니거나 group 410이 `Model`이 아닌 entity는 paper-space로 제외한다.
- 제품 parser는 105 MB 파일의 `readFile`, 전체 string/split/pair 배열을 제거하고 chunk→line→pair→현재 entity body 순서로 처리한다. 입력 256 MiB, line 1 MiB, entity body 250,000 pair, entity 1,000,000, block 100,000, 좌표 5,000,000, expanded entity 1,000,000, depth 32, normalized output 128 MiB, parse CPU 45초/wall 60초를 독립 적용한다.
- renderer는 제품 경로에서 검증된 bounds와 incremental expansion을 사용하고 compact SVG path를 만든다. SVG 128 MiB, 후보 2,000개, temp disk 512 MiB 상한을 유지한다.
- 현장 profile `site-drawing-lighting/2` exact allowlist에 `몰드바등`을 추가했다. 전등 layer, 반복 빈도, deny evidence를 함께 요구하며 version/digest를 detector 결과와 job `detectorVersion`에 남긴다.
- 후보 list/apply bulk 계약은 2,000개로 확장했다. 샘플 1,302개를 잘라내지 않으며 Web 응답 shape나 Web 파일은 변경하지 않았다. 후보 apply 전에는 `Fixture`와 `MeshNode`를 만들지 않는다.
- F1은 `2TP / (2TP + FP + FN)` count 공식으로 계산한다. `{0,0,0}`만 `null`이고 FP 또는 FN이 있으면 0이다.
- `--help`는 모든 입력/상한/출력/ground truth/converter trust 경계를 exit 0으로 출력한다. LibreDWG는 개발 샘플 변환 도구일 뿐 package, image, 제품 런타임 의존성이 아니다.

## 샘플 결과

| 항목 | 교정 결과 |
| --- | ---: |
| 원본 SHA256 / bytes | `01f25d539c20f93663c9183bbf70d83e578ae9990c2eb6dabb543bf39d71854d` / 17,887,748 |
| analyzer / converter / DXF | `cad-import-analysis/2` / `dwgread 0.14` / AC1024 |
| 변환 DXF | 105,432,404 bytes |
| model / paper 비-structural entity | 26,887 / 4,150 |
| model 직접 INSERT / 고유 원점 | 8,954 / 8,947 |
| non-zero rotation / non-unit scale INSERT | 8,623 / 6,853 |
| nested 포함 INSERT occurrence / 고유 world 좌표 | 23,734 / 23,360 |
| 최대 nested depth / unresolved / cyclic | 5 / 0 / 0 |
| layer / block | 107 / 11,243 |
| 지원 entity / 예상 coverage | 26,389 / 98.1478% |
| review 후보 / 고유 좌표 | 1,302 / 1,302 |
| profile digest | `d1d50780d863c1d65bf11ea2c71ccf2f38d3a2ae605b8ea6c107fa1900031dc8` |
| 반복 출력 SHA256 | JSON `06feaf83...5fcfb`, 한글 요약 `b432a170...2a82` |

직접 model-space INSERT 이름+유한 원점 비율은 100%다. 이는 직접 INSERT의 제한된 구문 추출률이며 nested transform, 렌더 픽셀 정확도, 조명 검출 recall 100%를 뜻하지 않는다. 지원 entity coverage도 현재 지원 type 수의 비율이지 unsupported entity 시각 재현 품질이 아니다.

사람 ground truth가 없으므로 검출 precision/recall/F1은 미확정이다. 실제 BLE identity 매핑은 0%, 자동 등록은 없고 CAD 후보는 `Fixture`/`MeshNode`를 생성하지 않는다. AI는 I/O 호출 0회의 disabled adapter이고 `LightingSymbolDetector` provider 교체 경계만 유지한다. 신규 PDF import는 제외하며 기존 PDF 읽기 호환은 유지한다.

## 제품 Pipeline 실측

동일 샘플을 `dwgread`→stream parser→rule detector→compact SVG renderer로 연속 실행했다.

| 단계 | 결과 |
| --- | ---: |
| parser 결과 | 지원 model entity 26,389, block 11,243 |
| detector 결과 | review 후보 1,302 |
| SVG | 96,353,981 bytes |
| parse / detect / render | 약 10.6초 / 1.2초 / 6.6초 |
| 전체 Jest+converter `/usr/bin/time -lp` | real 23.29초, maximum resident set size 1,681,506,304 bytes, peak memory footprint 151,989,744 bytes |

`/usr/bin/time` 값은 Jest, TypeScript transform과 converter 자식 과정을 포함하므로 배포 worker 단독 RSS 보장이 아니다. 샘플 제품 경로가 설정 상한 안에서 성공했다는 증거로만 사용하고, 양산 자원 확정에는 배포 컨테이너 cgroup에서 샘플보다 큰 정상/적대 입력 부하 검증이 필요하다.

## 검증

- `node --test scripts/analyze-cad-import.test.mjs`: 13/13 통과
- parser focused Jest: 33개 회귀 통과(32 MiB streaming fixture, CPU/wall, structure/body bounds 포함)
- detector/worker focused Jest: 23개 통과
- renderer focused Jest: 9개 통과
- Shared CAD contract: 7개 통과, 1,308 허용/2,001 거부
- 제공 샘플 analyzer: 성공, JSON/한글 요약 생성
- 제공 샘플 제품 pipeline: 성공, 후보 1,302개와 SVG 생성
- Shared build, API typecheck/build, `git diff --check`: 통과

Shared/API/Web 전체 검증은 병렬 Task 19.4 fix와 겹치므로 메인 에이전트가 공유 브랜치 상태에서 재실행한다. 이 round에서는 관련 focused test와 Shared/API typecheck/build만 수행한다.
