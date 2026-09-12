# Task 1 report: production dependency audit와 최소 안전 갱신

구현 커밋: `3b9cc7df0139c261ad6412641f0d03861f621e87`

## 결과

- Fresh production audit를 Critical 0/High 21/Moderate 11/Low 2, 807개 package에서 Critical 0/High 2/Moderate 1/Low 0, 820개 package로 줄였다.
- 최종 Moderate 이상 3건은 모두 정책 로그에 계속 출력되는 exact exception이다. 예상하지 못한 Moderate/High/Critical은 0건이다.
- Nest common/core/platform/testing을 11.2.3으로, Nest CLI를 11.0.24로, React Router를 7.18.3으로, API/Gateway MQTT를 5.15.2로 먼저 갱신했다.
- 호환 transitive 갱신으로 `qs@6.16.0`, `body-parser@2.3.0`, `ip-address@10.7.0`, `brace-expansion@1.1.18/2.1.4`, `js-yaml@3.15.2`, `browserslist@4.28.9`, `baseline-browser-mapping@2.11.22`를 적용했다.
- Nest 11.2.3이 고정한 Multer 2.2.0만 `@nestjs/platform-express>multer=2.3.0`으로, Prisma 6.19.3 config가 고정한 `deepmerge-ts@7.1.5`만 `@prisma/config>deepmerge-ts=8.0.2`로 제한 override했다.
- upstream safe release가 없는 `image-size@1.2.1`은 ICNS/JXL/HEIF signature를 parser dispatch 전에 fail-close하는 patch를 적용했다. patch SHA-256은 `9b6f61e6da7d91f29322ae809e8640276214dcc836283bb38f821ed6bd9ca6b0`이다.

## 최종 advisory 상태

| Package/advisory | 최종 상태 | Production/build 도달성 | 제거 조건 |
| --- | --- | --- | --- |
| `image-size@1.2.1` `GHSA-w3rx-r6r6-pgpr` | High exception, patch-bound | Mobile → React Native community CLI → Metro의 repository asset build 검사다. ICNS는 parser 전 fail-close한다. 앱 runtime에는 포함되지 않는다. | upstream non-vulnerable release가 나오면 patch와 exception을 함께 제거한다. |
| `image-size@1.2.1` `GHSA-5p2g-fcmc-qvqq` | High exception, patch-bound | 같은 Metro build 경로다. JXL codestream/container와 HEIF/AVIF signature를 parser 전 fail-close한다. | upstream non-vulnerable release가 나오면 patch와 exception을 함께 제거한다. |
| `uuid@8.3.2` `GHSA-w5hq-g745-h8pq` | Moderate exception | API → ExcelJS 4.4.0 경로는 runtime XLSX 생성/읽기에 도달하지만 ExcelJS는 `uuid.v4()`만 사용하고 취약한 caller-provided buffer API는 호출하지 않는다. | ExcelJS가 `uuid>=11.1.1`을 지원하거나 검증된 대체재를 채택하면 제거한다. |
| Multer 4건 | `2.3.0`으로 해소 | API Nest/Express graph에는 있으나 현재 multipart/FileValidator endpoint는 없다. Nest bootstrap/controller/typecheck/build로 호환성을 검증했다. | Nest가 안전 Multer를 직접 고정하면 selector override를 제거한다. |
| Prisma/deepmerge-ts | `8.0.2`로 해소 | request runtime이 아닌 Prisma CLI config 경로다. | Prisma가 8.x 이상을 직접 사용하면 override를 제거한다. |
| React Router, qs/body-parser, MQTT/ip-address, brace-expansion, js-yaml, browserslist/baseline-browser-mapping | 지원 upstream/호환 patch로 해소 | Web browser route, API/Gateway MQTT, Excel archive, Mobile build tooling의 각 scoped 경로를 검증했다. | 별도 exception 없음. |

## TDD/정책 증거

- Baseline JSON을 새 정책에 입력했을 때 unknown Moderate/High가 모두 `UNEXPECTED`로 출력되고 exit 1이었다.
- 정책 단위 RED는 missing script, unknown advisory, stdin audit, changed exception path, missing patch/digest/config 순서로 만들고 최소 구현 뒤 GREEN으로 전환했다.
- `image-size` 악성 ICNS fixture는 patch 전 500ms 뒤 `SIGTERM`으로 RED였다. JXL/HEIF shape를 포함한 patch 뒤 세 형식 모두 exact `security-disabled image type` 오류로 빠르게 fail-close했고 정상 1×1 PNG는 계속 파싱했다.
- 지원 upstream 적용 뒤, override 전 중간 raw audit는 Critical 0/High 6/Moderate 1/Low 1이었다. 남은 High는 image-size 2, Multer 3, deepmerge-ts 1이었다.

## 검증 명령과 결과

```text
node --test scripts/production-audit-policy.test.mjs scripts/image-size-security.test.mjs
=> 7 passed

pnpm --filter @led-control/api exec jest \
  src/auth/bootstrap-operator.spec.ts src/auth/auth.controller.spec.ts \
  src/floor-editor/editor-http.spec.ts \
  src/energy/reports/excel-energy-report.renderer.spec.ts \
  src/mqtt/mqtt.service.spec.ts --runInBand
=> 5 suites, 81 tests passed

pnpm --filter @led-control/api typecheck
pnpm --filter @led-control/api build
=> passed

pnpm --filter @led-control/gateway exec vitest run \
  src/mqtt/create-mqtt-client.test.ts src/mqtt/mqtt-security-config.test.ts \
  src/runtime/gateway-mqtt-runtime.test.ts
pnpm --filter @led-control/gateway typecheck
=> 3 files, 36 tests passed; typecheck passed

pnpm --filter @led-control/web exec vitest run src/App.test.tsx
pnpm --filter @led-control/web build
=> 62 tests passed; build passed (existing >500 kB chunk warning remains)

pnpm --filter @led-control/mobile test -- --runInBand
pnpm --filter @led-control/mobile typecheck
=> 1 test passed; typecheck passed

DATABASE_URL=<non-connecting-placeholder> pnpm --filter @led-control/api exec prisma validate
DATABASE_URL=<non-connecting-placeholder> pnpm --filter @led-control/api exec prisma generate
=> schema valid; Prisma Client 6.19.3 generated

DATABASE_URL=<fresh-disposable-postgres-16> pnpm --filter @led-control/api exec prisma migrate deploy
=> 57 migrations applied; all migrations successfully applied

pnpm install --frozen-lockfile
pnpm audit:production
git diff --check
=> frozen install passed; audit policy exit 0; diff check passed
=> final raw counts C0/H2/M1/L0/820, 3 exceptions printed, unexpected Moderate+=0
```

Disposable container `led-dep-audit-task1-20260912`는 새 PostgreSQL 16 DB로만 사용했고 migration 성공 뒤 제거했다. 기존 DB/container, 서비스, 실제 장비는 변경하지 않았다.

## pnpm launcher 확인

저장소 계약인 `pnpm --version`은 `9.15.0`이며 `packageManager`와 일치한다. 이 버전에서 `package.json#pnpm`이 override/patch의 단일 설정 위치이고 lockfile에 selector와 patch hash가 고정된다. 현재 호스트의 Homebrew pnpm 11 launcher는 저장소 고정 버전을 선택하면서도 새 설정 위치 경고를 먼저 출력하지만, 일반 `pnpm install --frozen-lockfile`, 직접 고정 binary frozen install과 실제 `pnpm why` graph가 모두 Multer 2.3.0, deepmerge-ts 8.0.2, patched image-size를 확인했다. 중복 workspace 설정은 남기지 않았다.

## 남은 위험

- `image-size` 두 High는 registry상 safe release가 아직 없어 raw audit에서 사라지지 않는다. 정책은 patch 파일/해시, exact graph, regression 존재 여부가 바뀌면 fail-closed한다.
- ExcelJS의 UUID Moderate는 API XLSX runtime 경로에 남지만 취약 API는 도달하지 않는다. exact ExcelJS version/path가 바뀌면 정책은 fail-closed한다.
- Web build의 기존 500 kB chunk 경고, 실제 mobile bundle/HIL과 실제 장비 검증은 이번 dependency Task 범위 밖이며 완료로 간주하지 않았다.
