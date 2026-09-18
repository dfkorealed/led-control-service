### Task 9: 실제 샘플과 전체 사용자 여정 검증

**목표**
- 제공 DWG를 실제 변환기/worker/storage/API 경로로 처리한다.
- 기존 맵 교체 경고부터 CAD 적용, 미배치 전환, slot 배치, 저장, 새로고침, 모니터링 반영까지 브라우저 여정을 검증한다.
- 1,000 fixture + 2,000 slot + 2,000 map object 최대 부하에서 Task 7 성능 예산을 다시 확인한다.

**대상 파일**
- `apps/api/src/floor-import/cad-sample-pipeline.integration.spec.ts`
- `apps/api/src/floor-import/dxf-document-parser.ts`
- `apps/api/src/floor-import/cad-core-child.ts`
- `apps/api/src/floor-import/cad-core-executor.ts`
- `scripts/run-cad-sample-pipeline.mjs`
- `scripts/run-cad-sample-pipeline.test.mjs`
- `apps/web/e2e/cad-import-journey.spec.ts`
- `apps/web/e2e/floor-placement-real.spec.ts`
- `apps/web/e2e/floor-placement.spec.ts`
- `scripts/analyze-cad-import.mjs`
- `scripts/analyze-cad-import.test.mjs`
- `docs/menus/settings.md`
- `docs/menus/monitoring.md`

**필수 회귀**
1. 0개 후보 apply도 성공하며 기존 맵과 배치가 원자적으로 교체된다.
2. 2,000개 후보 제품 경로가 상한 안에서 성공한다.
3. revision change summary/audit payload가 실제 교체 수량과 일치한다.
4. 기존 맵/도형/배치 조명 준비 -> DWG 업로드 -> 진행률 변화 -> 100% -> reset dialog 취소 -> 재확인 -> apply -> 새로고침 -> 모두 미배치/slot 표시 -> 두 fixture slot 배치 -> 저장 -> 모니터링 반영을 검증한다.
5. 제공 샘플은 ground truth가 없으므로 후보 수를 정확도로 표현하지 않고, viewport/excluded/unsupported count와 후보 transform 일치율을 기록한다.

**검증 명령**
```bash
CAD_SAMPLE_DWG_PATH="/Users/kim-jh/Downloads/2단지지하주차장전등설비합본평면도20260803.dwg" \
CAD_SAMPLE_CONVERTER_PATH=/opt/homebrew/bin/dwgread \
CAD_SAMPLE_CONVERTER_ARGV_JSON='["-O","DXF","-o","{output}","{input}"]' \
RUN_OBJECT_STORAGE_INTEGRATION=true \
pnpm test:cad-sample

pnpm --filter @led-control/web test
pnpm --filter @led-control/web exec playwright test e2e/cad-import-journey.spec.ts --project=chromium --workers=1
pnpm --filter @led-control/web exec playwright test e2e/floor-placement.spec.ts --project=chromium --workers=1 --grep '1000 fixtures, 2000 slots and 2000 objects'

pnpm --filter @led-control/shared typecheck
pnpm --filter @led-control/api typecheck
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/api build
pnpm --filter @led-control/web build
git diff --check
```

`test:cad-sample`은 `apps/api/dist`를 제거한 뒤 저장소의 공식 `pnpm workspace:prepare`로 shared와 automation-engine을 준비하고, 공식 API `prisma:generate`, 현재 checkout의 API build, sample Jest를 순서대로 실행한다.

**완료 조건**
- 실제 샘플 pipeline, 최대 부하 성능, 브라우저 전체 여정이 모두 통과한다.
- 설정/모니터링 메뉴 문서와 구현 계획 체크리스트를 실제 상태로 갱신한다.
- 다른 작업의 dirty hunk를 포함하지 않고 Task 9 변경만 커밋한다.
