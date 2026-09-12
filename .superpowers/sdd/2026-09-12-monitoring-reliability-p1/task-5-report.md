# Task 5 보고서: Browser integration, docs, final convergence

기준일: 2026-09-12

## 결과

Task 5의 browser integration과 문서 최종 수렴을 완료했다. monitoring Chromium은 cached dashboard/fixture/map 부분 실패, 서버 snapshot exact 60,000ms fresh/60,001ms stale, 네 장애 원인의 공통 presenter, production-valid 관리자 incident 확인·자기 지정·메모 해결, 정책 변경, 1440/1024/390/320 page/map/panel overflow와 selection·zoom 보존을 실제 화면 조작으로 검증해 review fix 후 `19/19`을 통과했다.

빈 disposable PostgreSQL에는 전체 `59` migrations를 적용하고 monitoring policy/incident lifecycle `69/69`(`37` PostgreSQL integration + `32` unit)을 통과했다. schema 변경은 없으며 사용자 DB와 기존 Docker 리소스는 건드리지 않았다.

## 구현

- `calm-operations-monitoring.spec.ts`
  - dashboard·map과 fixture 각 background failure를 React Query의 실제 2회 retry까지 포함한 3회 `503`으로 주입했다.
  - 실패 뒤 cached KPI·도면, 선택 층/조명, 상태 원인·권장 조치, 지도 120% 배율이 유지되는지 검사했다.
  - browser clock을 사용해 정확히 `60,001ms` 경과한 서버 snapshot의 stale 전환을 검사했다.
  - incident 확인 → 현재 관리자 자기 지정 → 메모 해결과 policy `90/180 → 120/300` mutation payload를 검사했다.
  - 1440×900, 1024×768, 390×844, 320×740에서 document와 incident/policy panel의 실제 `clientWidth/scrollWidth/bounds`를 검사했다.
  - 기존 map drag 회귀의 불가능한 고정 이동량 기대를 drag 직전 `scrollLeft`, drag delta, drag 뒤 current `maxScroll`을 사용한 clamped 계약으로 교정했다.
- `settings-api.ts`
  - production 응답 계약과 같이 dashboard `generatedAt`, `monitoringPolicy`, fixture page `generatedAt`을 제공한다.
  - 기본 snapshot 시각은 요청마다 새로 생성하고, stale 경계 테스트만 명시적 고정 시각을 주입한다.
  - production의 전체 fixture status reason union을 지원한다.
- `styles.css`
  - 축소된 detail grid에서 tab row가 1px track으로 눌려 panel이 pointer event를 가로채던 문제를 `min-height: 45px`, stacking context로 수정했다.
- 문서
  - DB schema가 Task 5에서 바뀌지 않았음과 disposable migration/lifecycle 결과를 기록했다.
  - `Web 연결은 후속`, `Task 5 대기`, incident workflow가 P1 전환 대상이라는 상충 문구를 완료 상태로 수정했다.
  - 실제 검증 수치와 실제 MQTT broker/Raspberry Pi/BlueZ/ESP32-H2 HIL/production notification 제외 범위를 명시했다.
  - Task 5 checklist를 실제 완료 근거와 함께 갱신했다.

## TDD RED/GREEN 증거

### Task 5 browser RED 1: stale fixture contract

명령:

```sh
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts --project=chromium --workers=1 --grep '서버 snapshot 시각이 60초를 초과하면 stale 경고를 표시한다'
```

초기 RED는 공통 browser fixture가 새 production 응답 계약인 `generatedAt`을 제공하지 않아 `서버 snapshot 시각을 확인할 수 없습니다.`를 표시했다. 최소 수정으로 dashboard와 fixture page에 server snapshot metadata를 추가하고, 고정 시각 주입을 테스트 옵션으로 제한했다.

### Task 5 browser RED 2: incident tab pointer interception

명령:

```sh
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts --project=chromium --workers=1 --grep '관리자는 인시던트를 확인·담당·해결'
```

RED에서 `인시던트 1` tab은 visible이지만 click이 30초 후 timeout 됐다. timeout을 늘리지 않았다. browser geometry는 `.monitoring-detail-tabs` 자체 높이는 45px인데 grid track이 `1px 1077px`이고 tab panel이 y=276부터 시작해 tab center를 가로채는 것을 보였다. 최소 production 수정으로 tab의 45px hit 영역과 panel 위 stacking을 보장했다.

### 최초 Task 5 GREEN (review 전)

최종 명령:

```sh
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts --project=chromium --workers=1
```

결과: `18 passed (11.6s)`, exit 0. timeout 값은 변경하지 않았다. `NO_COLOR`와 `FORCE_COLOR` 동시 설정 경고만 있었고 테스트 결과에는 영향이 없었다.

### 별도 분류: 기존 map drag 테스트 결함

Task 5 신규 기능 RED로 계산하지 않았다. 변경 전 browser spec `11`개 기준으로 `10 passed / 1 failed`였고, 같은 실패를 3회 확인했다. 고정 기대값은 `scrollLeft > centered + 70`이었지만 당시 horizontal `maxScroll=49`여서 수학적으로 도달할 수 없었다.

최종 self-review 중에도 pre-drag snapshot의 오래된 max `313`을 기대하는 동안 실제 scroll은 새 max `335`로 정상 clamp되어 `17 passed / 1 failed`가 한 번 발생했다. production 코드는 바꾸지 않고 drag 직전 origin, pointer delta, drag 뒤 current max로 기대값을 계산하도록 test만 최소 교정했다. focused 재검증은 `1/1`, 이어서 전체는 `18/18`을 통과했다.

## Disposable PostgreSQL

### 최초 환경 실패

- container: `led-p1-task5-db-20260912-0625`
- container id: `95b6f6e7c361c3874243bf1132fdf1c2348abefc117808cf1dd98bec2edc839c`
- volume: `led-p1-task5-db-20260912-0625-data`
- binding: `127.0.0.1:60491 -> 5432`
- 빈 DB에 `59` migrations 적용은 성공했다.
- focused lifecycle 실행 전 리소스가 사라져 `Can't reach database server at 127.0.0.1:60491`로 `4 suites failed / 3 passed`, `37 failed / 32 passed`가 발생했다.
- Docker event 확인 결과 2026-09-12 15:19:08 KST에 `signal=9`, `exitCode=137`, `execDuration=46` 뒤 container와 volume이 destroy됐다. 이미 destroy되어 당시 container state/log는 추가 조회할 수 없었다. 제품 assertion 실패가 아니라 검증 리소스 수명 환경 실패로 분리했고 무한 재시도하지 않았다.

### 고유 리소스 1회 재실행

- container: `led-p1-task5-db-20260912-0645`
- container id: `9d013d9c9484c170027348b7253e68c691cecd430dc74f43a20611c3c9ac0c22`
- volume: `led-p1-task5-db-20260912-0645-data`
- binding: `127.0.0.1:60492 -> 5432`
- database/user: `p1task5` / `p1task5`

명령과 결과:

```sh
docker volume create led-p1-task5-db-20260912-0645-data
docker run -d --name led-p1-task5-db-20260912-0645 -e POSTGRES_USER=p1task5 -e POSTGRES_PASSWORD=p1task5 -e POSTGRES_DB=p1task5 -p 127.0.0.1:60492:5432 -v led-p1-task5-db-20260912-0645-data:/var/lib/postgresql/data postgres:16-alpine
```

container는 `Up`, port는 `127.0.0.1:60492->5432/tcp`, `pg_isready`는 `accepting connections`를 반환했다.

```sh
DATABASE_URL=postgresql://p1task5:p1task5@127.0.0.1:60492/p1task5 pnpm --filter @led-control/api exec prisma migrate deploy
```

`59 migrations found`, `All migrations have been successfully applied.`, exit 0. DB query에서 완료되고 rollback되지 않은 `_prisma_migrations`가 `59`개임을 확인했다.

```sh
MONITORING_INCIDENTS_TEST_DATABASE_URL=postgresql://p1task5:p1task5@127.0.0.1:60492/p1task5 pnpm --filter @led-control/api exec jest --runInBand src/monitoring-incidents
```

`7 suites passed`, `69 tests passed`(`37` PostgreSQL integration + `32` unit), `0 snapshots`, `4.113s`, exit 0. PostgreSQL log의 FK/CHECK 오류는 schema negative-path 테스트가 의도적으로 거부한 쿼리이며 Jest 결과는 전부 통과했다.

cleanup:

```sh
docker rm -f led-p1-task5-db-20260912-0645
docker volume rm led-p1-task5-db-20260912-0645-data
```

정확한 이름으로만 제거한 뒤 `docker ps -a`와 `docker volume ls`에서 각각 `container cleanup: confirmed absent`, `volume cleanup: confirmed absent`를 확인했다. 최초 리소스도 Docker event/목록에서 이미 absent였다. 사용자 DB와 다른 container/volume은 조회·변경·삭제하지 않았다.

## 전체 검증

| 명령 | 결과 |
| --- | --- |
| `pnpm --filter @led-control/shared test` | 14 files, `197/197` passed, exit 0 |
| `pnpm --filter @led-control/api test` | 115 suites passed, 31 environment-dependent suites skipped; `1,153` passed, `315` skipped, 1,468 total, exit 0 |
| `pnpm --filter @led-control/web test` | 64 files, `727/727` passed, exit 0 |
| `pnpm --filter @led-control/gateway test` | 62 files, `612/612` passed, exit 0 |
| `pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts --project=chromium --workers=1` | review fix 최종 `19/19` passed, 10.9s, exit 0 |
| `pnpm --filter @led-control/shared typecheck` | exit 0 |
| `pnpm --filter @led-control/api typecheck` | exit 0 |
| `pnpm --filter @led-control/web typecheck` | exit 0; browser fixture 보완 뒤 fresh 재실행 포함 |
| `pnpm --filter @led-control/gateway typecheck` | exit 0 |
| `pnpm --filter @led-control/shared build` | exit 0 |
| `pnpm --filter @led-control/api build` | exit 0 |
| `pnpm --filter @led-control/web build` | exit 0; 2,440 modules, main 1,283.15 kB / gzip 383.95 kB |
| `pnpm --filter @led-control/gateway build` | exit 0; `dist/gateway.mjs 564.6kb` |
| `git diff --check` | exit 0 |

## 변경 파일

- `apps/web/e2e/calm-operations-monitoring.spec.ts`
- `apps/web/e2e/support/settings-api.ts`
- `apps/web/src/styles.css`
- `docs/database-schema.md`
- `docs/menus/monitoring.md`
- `docs/project-status.md`
- `docs/superpowers/plans/2026-09-12-monitoring-reliability-p1.md`
- `.superpowers/sdd/2026-09-12-monitoring-reliability-p1/task-5-report.md`

## Self-review

- 신규 browser assertion은 text 존재만이 아니라 mutation payload, retry 횟수, cache 유지, selection/zoom, 실제 DOM bounds와 `scrollWidth/clientWidth`를 관찰한다.
- 공통 fixture의 기본 `generatedAt`은 설치 시 한 번 고정하지 않고 요청 시 생성해 장시간 spec에서 거짓 stale이 생기지 않게 했다.
- CSS 수정은 공통 `UnderlineNavigation` component를 복제하지 않고 monitoring detail의 layout 경계만 보완한다.
- map drag 보정은 production을 바꾸거나 timeout을 늘리지 않고 도달 가능한 current scroll 범위만 검사한다.
- DB schema/migration 파일은 변경하지 않았다.
- tracked diff를 재검토했고 Task 5 범위 밖 사용자 변경이나 생성 artifact는 포함하지 않았다.

## 경고·제외·우려

- Web production build는 성공했지만 기존 500 kB chunk 경고가 남는다(main 1,283.15 kB, gzip 383.95 kB). 이번 monitoring 신뢰성 범위에서 code splitting은 수행하지 않았다.
- Chromium은 deterministic route/API fixture 기반 software 증거다. 실제 MQTT broker는 실행하지 않았다.
- Raspberry Pi/BlueZ/ESP32-H2 HIL과 실제 LED/RF는 실행하지 않았다.
- production notification 전송은 구현·검증 범위에서 제외했다.
- 사람의 in-app Browser 수동 시각 QA나 사용자 DB migration/배포는 수행하지 않았다.

## Review fix round 증거

중요 review 4건과 DB count 표기 1건을 같은 worktree에서 보완했다. production runtime은 추가로 변경하지 않았고 Chromium test/fixture와 문서/보고서만 수정했다.

### Incident production fidelity RED/GREEN

먼저 assign option을 production DTO가 허용하는 UUID `88888888-8888-4888-8888-888888888888`로 기대하도록 회귀를 변경했다.

```sh
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts --project=chromium --workers=1 --grep '관리자는 인시던트를 확인·담당·해결'
```

RED: 기존 fixture가 `admin-user-1`만 제공해 유효 UUID option을 찾지 못하고 기존 30초 test timeout으로 실패했다. timeout은 늘리지 않았다.

최소 fixture 수정:

- incident id와 현재 admin/assignee id를 RFC 4122 UUID 형태로 변경했다.
- 초기 incident revision을 `00:01:00`, acknowledge/assign/resolve revision을 각각 `00:01:01`/`00:01:02`/`00:01:03`으로 모델링했다.
- 각 PATCH의 `expectedUpdatedAt`이 현재 revision과 정확히 일치하지 않으면 `409 INCIDENT_CONFLICT`를 반환한다.
- `recoverIncidentTarget()` 호출 전 resolve는 `409 INCIDENT_STILL_ACTIVE`를 반환하며, test는 담당 지정 뒤 target recovery를 명시적으로 전환하고 해결한다.
- 최종 `resolvedAt=00:01:03`이 `lastObservedAt=00:01:00` 뒤인지 검증한다.

GREEN: 같은 focused 명령 `1 passed (4.1s)`, exit 0.

### Boundary/presenter/viewport coverage

첫 focused 실행은 의도한 계약과 무관한 test-authoring 문제 두 건을 드러냈다. page load 중 fake clock이 266ms 진행되어 fixed origin assertion이 실패했고, desktop에서 의도적으로 hidden인 mobile fixture selector를 1440/1024에서도 role로 찾았다. 이는 production failure로 계산하지 않았다.

Playwright clock 권장 흐름대로 page를 먼저 정상 로드하고 snapshot+10초에서 `pauseAt`으로 정지했다. 이후 50,000ms를 진행해 exact age 60,000ms에서 stale banner가 없음을 확인하고, 1ms 뒤 banner와 설명이 나타나는지 확인했다.

네 장애 계약은 다음 literal을 독립적으로 검증한다.

- `gateway_offline`: 게이트웨이 오프라인 / 게이트웨이 연결 확인
- `fixture_stale`: 상태 수신 지연 / 조명 통신 상태 확인
- `fixture_fault`: production과 같이 `status=fault`와 Health fault로 표현 / Health fault 확인
- `command_failed`: 명령 처리 실패 / 명령 이력 및 조명 연결 확인

각 case는 mobile selector option, marker `aria-label`, badge, 상세 원인과 권장 조치가 같은 presenter 결과인지 검사했다. 네 viewport는 공통으로 visible map marker를 선택하고 120%로 확대한 뒤 incident tab과 policy dialog를 열며, 각 단계에서 floor/fixture selection과 zoom, page/detail/incident/dialog overflow를 함께 검사했다.

Focused GREEN:

- exact stale boundary: `1/1` passed
- 네 상태 presenter: `1/1` passed
- 1440/1024/390/320 preservation/overflow: `4/4` passed

최종 Chromium:

```sh
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts --project=chromium --workers=1
```

`19 passed (10.9s)`, exit 0. timeout 변경 없음. 기존 `NO_COLOR`/`FORCE_COLOR` 경고만 남았다.

DB 문서는 lifecycle 전체 `69`개를 실제 PostgreSQL을 사용하는 integration `37`개와 unit `32`개로 분리해 표기했다.
