# Release hardening: production dependency, shared build, CI 설계

상태: 승인됨. 사용자가 dependency 보안, `packages/shared/dist` 경쟁 제거, CI/HIL gate 구현 진행을 승인했다.

## 목표와 범위

- `pnpm audit --prod --audit-level=moderate`의 advisory를 패키지·경로·도달성·조치로 추적한다.
- 지원되는 upstream 릴리스를 우선 적용하고 production High를 0으로 만든다. 안전 릴리스가 없는 항목은 숨기지 않고 도달 경로, 보완책, 예외 종료 조건과 배포 차단 여부를 기록한다.
- 같은 checkout에서 root `lint`, `typecheck`, `test`, `build`가 겹쳐도 `packages/shared/dist` writer와 consumer가 충돌하지 않게 한다.
- CI가 frozen install부터 production audit까지 순차 gate를 제공하고, HIL은 수동 승인과 전용 runner가 필요한 별도 fail-closed workflow로 둔다.
- 사용자 DB, 운영 서비스와 실장비는 변경하지 않는다.

## 현재 증거

### Production dependency

2026-09-12 fresh audit는 807개 production graph package에서 Critical 0, High 21, Moderate 11, Low 2, 총 34건이다.

| 묶음 | 현재 경로 | 판단 |
| --- | --- | --- |
| Multer | API → Nest platform-express → `multer@2.0.2` | 업로드 API는 현재 없지만 request runtime에 설치된다. Nest 지원 버전과 검증된 최소 override로 `>=2.3.0`을 사용한다. |
| Nest/file-type | API → Nest 10.4.22 | SSE/file validator는 현재 미사용이지만 direct runtime이다. Nest suite를 최소 안전 11.1.18 이상으로 함께 올린다. |
| React Router | Web → `react-router-dom@7.18.1` → router 7.18.1 | RSC는 미사용이지만 직접 production dependency다. 7.18.2 이상으로 올린다. |
| qs/body-parser | API → Express/body-parser | query/body parser runtime이다. upstream 갱신을 우선하고 남으면 `qs>=6.16.0`, `body-parser>=1.20.6`으로 제한한다. |
| ip-address | API/Gateway → MQTT → socks | production은 `mqtts://`만 허용해 SOCKS 경로는 미사용이지만 production graph다. 호환 patch release로 갱신한다. |
| brace-expansion/uuid | API → ExcelJS archive tooling | 사용자 glob과 UUID buffer API는 미사용이다. maintenance release 또는 검증된 범위 override를 적용한다. |
| js-yaml/browserslist/baseline mapping | Mobile → React Native build graph | shipped runtime이 아닌 trusted repository build 입력이다. 호환 patch release로 갱신한다. |
| Prisma/deepmerge-ts | API → Prisma CLI/config | request runtime은 아니지만 production graph에 포함된다. upstream 또는 실제 Prisma 명령으로 검증한 제한 override만 허용한다. |
| image-size | Mobile → Metro asset inspection | ICNS/JXL/HEIF build 입력만 도달하며 현재 upstream safe release가 없다. 취약 parser를 제거·차단하는 repository patch와 exact regression을 우선하며, raw advisory 예외가 필요하면 exact GHSA·patch·만료/제거 조건을 출력한다. |

### Shared output 경쟁

`packages/shared/scripts/build.mjs`는 writer끼리 잠그지만 잠금 안에서 기존 generated file을 모두 지운 뒤 CJS/ESM을 순차 복사한다. consumer인 TypeScript/Vitest/Jest/Vite는 잠금을 잡지 않는다. Root `pnpm lint`와 `pnpm test`를 동시에 실행했을 때 Web TypeScript가 `@led-control/shared/dimming-command`를 찾지 못해 exit 2가 됐고, 직접 polling에서는 `dist/esm/dimming-command.d.ts`가 8/8 publish cycle마다 29~220ms 사라졌다.

## 선택한 구조

### 1. 지원 업그레이드 우선의 audit policy

직접 dependency와 지원되는 upstream release를 먼저 올린다. 그 뒤에도 upstream 제약으로 남는 전이는 package-selector가 붙은 최소 override만 사용한다. 모든 override는 `docs/agent-operations.md`에 이유, 실제 도달성, covering command와 제거 조건을 기록한다.

Raw audit 결과는 별도 정책 스크립트가 JSON으로 읽는다. 예상하지 못한 Moderate/High는 항상 실패한다. 예외는 안전 릴리스가 없고 repository 보완책과 exact regression이 있는 항목만 허용하며, 실행 로그에 advisory를 명시적으로 출력한다. 예외는 성공 출력에서 사라지지 않는다.

### 2. Root workspace gate와 graph-pure consumer

단순 writer lock 확장은 consumer 전체가 read lease를 잡아야 하고, non-empty directory를 portable하게 한 번에 교체할 수도 없다. 따라서 root 검증 command를 하나의 repository gate로 직렬화한다.

Gate는 다음 순서를 보장한다.

1. repository-level owner lock 획득
2. `shared` 한 번 build
3. `automation-engine` 한 번 build
4. leaf `lint`/`typecheck`/`test`/`build` 실행
5. 모든 consumer 종료 뒤 lock 해제

Leaf 검증 script에서 nested workspace dependency build를 제거해 outer pnpm graph 밖의 writer를 없앤다. Shared 자체의 build-output writer/writer lock과 path/symlink 방어는 유지한다. 직접 package 명령은 root dependency preparation 뒤 사용하는 계약으로 문서화하고, CI와 정식 검증은 root gate만 사용한다.

Root gate는 timeout 재시도가 아니라 전체 writer/reader 수명에 대한 상호 배제다. 같은 checkout에서 root gate 두 개가 겹치면 한 명만 build·consume하고 후속 gate가 그 뒤 새 generation을 만든다.

### 3. CI와 HIL 분리

GitHub Actions software CI는 다음 `needs` 순서를 사용한다.

1. Node 22 + pnpm 9.15.0, `pnpm install --frozen-lockfile`
2. root lint/typecheck
3. root unit와 `tests/mqtt-production-config.node.mjs`
4. disposable PostgreSQL 16/Redis 7 service에서 migration과 결정적 integration
5. Chromium과 로컬 격리 API/PostgreSQL/Redis/Mosquitto를 사용하는 real-backend 핵심 설치·운영 journey
6. production build
7. production audit policy

Integration은 하나의 임시 DB URL을 명시적으로 주입하고 `--runInBand`로 cleanup 충돌을 막는다. RealBackendLab은 고정 fixture가 아니라 실행마다 격리된 DB/Redis/MQTT/API/Web process를 만들며 Chromium 한 worker로 실행한다.

HIL은 `workflow_dispatch`, 보호된 GitHub environment, `[self-hosted, led-hil]` runner와 exact 확인 입력을 모두 요구한다. 사전 조건 하나라도 없으면 job은 실패하고 flash/deploy를 시작하지 않는다. Software CI 성공을 HIL 완료로 기록하지 않는다.

## 테스트와 완료 조건

- 취약 dependency 변경 전 관련 API upload/parser, report workbook, MQTT, Web router, Mobile build regression을 고정한다.
- `shared` reader가 writer publish 중 export를 읽는 실패를 RED로 확인하고, root gate 계약과 실제 concurrent root command 반복을 GREEN으로 확인한다.
- CI workflow 구조를 Node test로 검증해 단계 누락, 순서 역전, audit/HIL 완화를 막는다.
- API/Web/Gateway/Mobile/Shared/automation scoped test, root lint/typecheck/test/build, Prisma validate와 `git diff --check`를 실행한다.
- Fresh production audit에서 unexpected High 0이어야 한다. 남는 예외는 로그·문서·최종 보고에 그대로 노출한다.

## 제외와 남은 운영 경계

- 사용자 또는 운영 DB migration, 운영 배포, 실제 Vault/MQTT/MinIO 변경은 하지 않는다.
- Raspberry Pi/ESP32-H2 flash와 HIL은 실행하지 않는다.
- GitHub repository secret/environment/branch protection 자체 생성은 코드만으로 완료할 수 없으므로 필요한 운영 설정을 문서화한다.
