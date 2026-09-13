# Task 4 운영 runbook·최종 수렴 보고서

상태: 구현·fresh 최종 소프트웨어 검증 완료, 최종 HEAD `728e0a8`의 Task 4 및 whole-branch 독립 검토 Critical/Important/Minor 0, PASS. 검토 승인 HEAD `349bc4c752c6471a204f8f5367b706db9076c0b3`에서 시작했다. 지정 worktree와 `codex/p0p1-platform-deploy-observability`만 사용했다. 운영 배포·사용자 DB·실제 외부 Vault/MQTT/Object Storage·실장비 HIL·알림은 실행하지 않았다.

## 환경과 명령

- Host: macOS/Darwin arm64, Node `v24.19.0`, 저장소 pnpm `9.15.0`, Docker client `29.6.1` / daemon `29.7.2`, Compose `v5.3.1`.
- 원본 로컬 로그: `/tmp/led-platform-task4-evidence.i1W8kx/`. 테스트 출력만 저장했으며 secret/env 파일과 PKI 내용은 보고서에 복사하지 않았다. 임시 로그는 지속적인 저장소 artifact가 아니다.
- 루트 gate는 owner lock 아래 shared→automation을 준비하고 consumer 전체를 실행한다. Lint/typecheck/test는 여섯 pnpm workspace를 모두 실행한다. Build는 shared·automation 선행 후 API/Web/Gateway를 build한다. Mobile은 package build script가 없고 firmware ESP-IDF target/HIL은 pnpm workspace gate 범위가 아니다.

| 명령 | 종료 코드·증거 |
| --- | --- |
| `pnpm lint` | 0; 여섯 workspace TypeScript gate |
| `pnpm typecheck` | 0; 여섯 workspace TypeScript gate |
| `pnpm test` 최초 | 1; 루트 58개 중 56 통과/2 실패/skip 0. `&&` 뒤 package test는 실행되지 않음 |
| `node --test scripts/dev-runtime.test.mjs scripts/lan-tls-integration.test.mjs` 승인 수정 뒤 | 0; 17/17, skip 0 |
| `pnpm test` fresh 재실행 | 0; 루트 58/58, Shared 14 files·203/203, Automation 2 files·28/28, Mobile 1/1, Web 64 files·712/712, API 120 suites·1,138 통과/289 환경 의존 제외(28 suites), Gateway 64 files·608/608. 합계 2,748 통과/289 제외 |
| `pnpm build` | 0; Web 2,440 modules, chunk-size warning 없음 |
| `pnpm --filter @led-control/web test:bundle-audit` | 0; main 319.19 kB / gzip 99.21 kB, 기존 예산 유지 |
| `pnpm production:contract` | 0; 18/18, skip 0, 필수 env 34개 누락과 실제 render·CLI 격리 계약 |
| `pnpm --filter @led-control/web exec playwright test --project=chromium --workers=1` 최초 | 1; 194개 중 166 통과/23 실패/5 명시적 RealBackendLab 제외, 6.2분 |
| 전체 Chromium 같은 명령 fresh 최종 | 0; 189 통과/5 opt-in 제외, 4.2분. 실제 disposable automation journey 1개 포함 |
| `pnpm ci:production-audit` | 0; production 계약 18/18, MQTT 설정 2/2, Gateway container 24/24, required MQTT persistence/ACL 2/2, bundle·새 image·smoke·dependency policy까지 통과 |
| `git diff --check` | 0; 최종 문서 작성 후에도 확인 |

최종 root lint/typecheck/test는 `e3daa6a`에서 직렬 fresh 실행했고 위 전체 pass/skip 수치를 다시 확인했다. Build/bundle/production 계약/전체 production audit도 같은 HEAD에서 다시 실행해 exit 0이다. Chromium은 모든 Web/CSS 수정이 포함된 `ad864f9`에서 실행했고 이후 `e3daa6a`는 Gateway 테스트 한 파일만 바꾼다. 최종 문서 커밋에는 docs/report/checklist만 포함한다. 원본 로그 suffix는 `lint-final.log`, `typecheck-final.log`, `test-final-green.log`, `build-final-head.log`, `bundle-final-head.log`, `chromium-final.log`, `production-contract-final.log`, `production-audit-final.log`다.

추가 focused 명령은 다음과 같다. Gateway case 필터의 나머지 50개 제외는 이름 필터이며 최종 전체 Gateway/root 실행에서는 608/608을 모두 실행했다.

```bash
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-manual-control.spec.ts e2e/monitoring-control-flow.spec.ts e2e/floor-editor-layout.spec.ts e2e/floor-placement.spec.ts e2e/mvp1.spec.ts e2e/automation-control-flow.spec.ts --project=chromium --workers=1
pnpm --filter @led-control/gateway exec vitest run src/automation/schedule-runtime.test.ts --maxWorkers=1 --minWorkers=1
pnpm --filter @led-control/gateway exec vitest run src/automation/schedule-runtime.test.ts -t 'requeues 4,098 durable fences' --maxWorkers=1 --minWorkers=1
pnpm --filter @led-control/gateway test
```

남은 출력 경고는 launcher의 package.json pnpm 설정 위치 안내와 Playwright의 NO_COLOR/FORCE_COLOR 충돌 안내다. Chunk-size warning은 없었다. Dependency policy는 820개에서 High 2/Moderate 1 기존 승인 예외를 출력했다: image-size 1.2.1의 GHSA-5p2g-fcmc-qvqq/GHSA-w3rx-r6r6-pgpr(빌드용 Metro 자산 parser patch·회귀), ExcelJS의 uuid 8.3.2 GHSA-w5hq-g745-h8pq(v4만 소비)다. Unexpected 0이며 신규 예외나 정책 완화는 없다.

API 제외는 opt-in PostgreSQL migration/access/auth/site-user/setup/registration/command/automation/energy/report/PKI concurrency·PKI E2E, Redis editor lease/fixture identify, Object Storage/report storage, Vault token lifecycle 통합이다. 각 파일의 명시적 env gate를 확인했으며 이번 변경 경로인 observability/recovery/production contract를 제외하지 않았다. 별도 `ci:integration`과 opt-in RealBackendLab 전체 통합을 이 루트 통과로 대체하지 않는다.

## 실패 조사와 승인된 최소 수정

### 루트 CRL 계약

`scripts/dev-runtime.test.mjs:170`, `scripts/lan-tls-integration.test.mjs:144`가 이전 `/mosquitto/certs/mqtt-client.crl`을 기대해 실패했다. `git diff 03af2cd HEAD -- infra/mosquitto.production-tls.conf scripts/dev-runtime.test.mjs scripts/lan-tls-integration.test.mjs`는 Task 2의 승인된 CRL named volume 때문에 production config만 `/mosquitto/crls/mqtt-client.crl`로 바뀌었고 두 assertion이 남았음을 보였다. 총괄 승인 후 두 경로만 수정했다. 기존 root RED 56/58 → focused GREEN 17/17 → fresh 전체 root GREEN이다. 별도 test-only commit은 `73e413d`다. 제품 동작·인증서/seed mount·timeout/retry는 변경하지 않았다.

### Chromium 기존 fixture/문구 불일치

전체 194개 실행을 끝까지 수집한 뒤 총괄이 각각 승인한 테스트 파일만 수정했다. 아래 원인은 실패 snapshot과 현재 source, `git diff ed873b6 -- <test/source path>` 및 `git show ed873b6:<source>`를 대조했다. 별도 baseline checkout에서 전체 실행했다는 뜻은 아니다.

| 파일 | 최초 실패·원인 | 승인된 범위 |
| --- | --- | --- |
| `calm-operations-manual-control.spec.ts` | 네 viewport가 이전 `조명 제어` heading을 기다림. 실제 baseline/current content heading은 `조명 밝기 제어` | Positive·viewer negative heading assertion을 실제 content heading으로 맞춤 |
| `monitoring-control-flow.spec.ts` | 네 viewport에서 동일한 이전 control heading 기대 | 해당 heading 한 곳만 갱신, responsive/touch assertion 유지 |
| `floor-editor-layout.spec.ts` | 7개가 editor mount 이전 site-permission fail-closed 화면에서 실패. Dashboard fixture의 필수 capabilities 누락 | 기존 settings fixture와 동일 admin capability shape 추가 |
| `floor-placement.spec.ts` | 6개가 같은 capability 누락으로 canvas mount 전 실패 | Admin capability만 추가, pointer/performance/undo·timeout 유지 |
| `mvp1.spec.ts` | 1개가 같은 capability 누락으로 monitoring mount 전 실패 | Admin capability만 추가, navigation assertion 유지 |
| `automation-control-flow.spec.ts` | 1개가 setup 완료 후 설정 개요에서 Gateway 이름 input을 기다리다 기존 15초 timeout. 이전 작업부터 기록된 registration route drift | 실제 설정 메뉴의 조명 등록 링크를 클릭하고 siteId 보존 URL을 확인한 뒤 원래 여정 유지 |

최초 23개 실패는 8개 heading, 14개 capabilities fixture, 1개 실제 lab UI navigation 불일치다. 제품·권한 소스는 변경하지 않았다. 다섯 skip은 `E2E_REAL_BACKEND_LAB` opt-in인 auth 1, floor placement 1, installation journey 2, site-user 1이다. Automation journey는 기본 전체 실행에도 별도 격리 RealBackendLab을 실제 시작하므로 mock-only 수치로 합쳐 해석하지 않는다.

승인된 여섯 파일의 첫 focused 실행은 64개 중 59 통과/5 실패(1.5분)였다. 이는 timeout을 늘려 가려야 할 실패가 아니라 이전 조기 실패 뒤에 숨어 있던 별도 전제 불일치였다. 추가 수정 전 다음 증거와 권고를 총괄에게 보고하고 각각 승인을 받았다.

- Automation의 claim click 뒤 `조명 등록` heading은 이미 존재해 완료 대기가 아니었다. 실제 network evidence는 `POST /api/gateways/claim`의 `status: null`, `outcome: pending`을 보였고 `RealBackendLab.attachGatewayPublisher()`는 Gateway ID를 한 번 조회한 뒤 빈 CN으로 인증서를 준비하다 실패했다. 기존 `installation-customer-journey.spec.ts`와 같이 click 전에 response wait를 등록하고 201·등록 층/게이트웨이 필드를 확인한 뒤 attach한다. Production onboarding/PKI 소스와 lab helper는 변경하지 않았다.
- Editor 390px의 `비밀번호 변경`은 실제 border box `100.125×44px`인데 가로 scroll viewport에 `38.484375px`만 보였다. 같은 fixture의 별도 read-only Playwright 측정에서 nav clientWidth 362/scrollWidth 424, scrollLeft `0→62`, visible width `38.484375→100.125`를 확인했다. 즉 CSS 크기 회귀가 아니며 `.app-shell`의 동일 전체 대상과 44px 기준을 유지하는 기존 `expectMinimumTouchTargetsAfterScrolling`으로 검사한다. 진단용 Vite 프로세스는 종료했다.
- Placement 세 zoom case는 기본 `snap=true`, grid 10인 실제 store와 달리 fractional 좌표를 그대로 기대했다(예: `179.734375` 기대/`180` 실제). 기존 editor-layout 회귀는 기본 ON·grid snapping을 이미 검증한다. 변환 전용 case에서 실제 `격자 스냅` UI를 한 번 끄고 두 drop 모두 기존 정확한 fractional/pixel/pan/Escape assertion을 유지했다. Store·좌표 계산·오차 허용치는 변경하지 않았다.

같은 64개 focused 재실행은 61 통과/3 실패(2.0분)였다. Placement의 세 zoom은 모두 통과했다. 남은 두 원인은 추가 수정 전에 별도 보고했다.

- Automation은 claim을 완료하고 실제 일정 추가 dialog까지 진행했으나 이름 input이 접힌 `세부 일정 설정` 아래 있어 실패했다. `ScheduleDialog.tsx:303`, `VehicleEventDialog.tsx:201` 이후 UI는 상세 설정과 대상 선택기 진입을 요구한다. 최신 `calm-operations-automation.spec.ts:59` 이후가 같은 실제 경로를 이미 검증한다. 일정은 `세부 일정 설정`·`제어 대상 선택`→checkbox→`선택 완료`, 이벤트는 `감지 센서 선택`/`실행할 조명 선택` 각각의 picker→`선택 완료`, `고급 설정`, 유지 시간 `직접 입력`을 거쳐 기존 값을 넣도록 test-only 전환을 제안했다. 실제 lab의 생성·발행·ACK·restart assertion은 유지한다.
- Editor 390/320px의 남은 실패 대상은 navigation이 아니라 `리비전 7 복구`다. `styles.css:4426`은 44×44px이고 common Button의 radius 10px을 상속한다. 동일 fixture의 read-only 실측 border box는 `(317, 679.5625, 44, 44)`였다. 네 모서리 내부 offset `(0.5,0.5)`, `(43.5,0.5)`, `(0.5,43.5)`, `(43.5,43.5)`에서 `elementFromPoint`는 버튼이 아닌 부모 `LI`, 중심 `(22,22)`는 버튼의 SVG를 반환했다. 가려짐이 아니라 둥근 모서리의 실제 hit 영역 제외이며, 기준부터 존재한 저장소의 연속 44×44px touch 계약 결함이다. 테스트를 완화하지 않고 해당 버튼만 기존 icon tooltip과 같은 52×52px로 확대하는 production CSS 범위 승인을 요청했다. [WCAG 2.5.5 AAA](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)와 [C44 CSS 기법](https://www.w3.org/WAI/WCAG22/Techniques/css/C44)은 target 크기를 설명하지만 저장소의 모든 모서리 sample 알고리즘 자체를 규정하지 않는다. 따라서 이 결과만으로 WCAG AA 위반이라고 단정하지 않는다.

총괄의 추가 승인으로 automation의 실제 UI 전환과 restore selector 한정 접근성 보완을 적용했다. 이후 focused는 63/64로, `반복 프리셋` group과 `반복` select의 부분 label 일치 strict-mode만 남았다. 최신 helper와 동일하게 `반복`·`유지 시간`을 exact label로 지정했다. 최종 focused 64/64(2.2분, skip 0)는 실제 automation 전체 journey 31.0초와 320/390/1024/1440px editor overflow/layout/restore hit target을 포함한다. 생성·발행·ACK·manual override·vehicle hold·session expiry·API restart 검증과 timeout/retry는 그대로다. Stale E2E 여섯 파일은 `651a3ce`, CSS selector 하나와 네 viewport의 추가 restore touch assertion은 `ad864f9`로 분리했다. Common Button·radius·production 행동은 변경하지 않았다.

접근성 수정 후 root lint/typecheck는 다시 exit 0이었다. 같은 시간의 root test는 Gateway의 기존 `schedule-runtime.test.ts:573` 한 건이 pending→terminal 관찰에서 실패했다(607/608). 해당 source/test는 기준 `ed873b6`부터 변경되지 않았고 앞선 fresh root에서는 608/608이었다. 경쟁 실행 중인 Chromium lab을 종료한 뒤 변경 없이 단독 51/51을 재현했다(전체 3.34초, 해당 case 710ms). CPU/IO 경쟁은 가능한 설명이지 확정된 원인으로 단정하지 않는다. Timeout/retry·Gateway 파일을 수정하지 않고 루트 전체를 단독 fresh 재실행한다.

자동 생성된 editor 전체 화면 PNG 네 장(320/390/1024/1440)을 직접 확인했다. 확대된 복구 버튼이 revision 정보와 겹치지 않고 mobile 세로 stack/desktop 세 패널과 우측 정렬을 유지한다. 이 제한된 fixture screenshot 검토를 전체 앱 수동 시각 QA나 native WebView 검증 완료로 확대하지 않는다.

단독 root 전체도 같은 Gateway case에서 607/608로 실패하여 Chromium 경쟁만의 문제라는 가설은 배제했다. Root gate는 별도 env/fake clock 변경 없이 `pnpm -r test`를 실행하고 내부 API/Jest와 Gateway/Vitest가 병렬이다. Gateway는 1 worker·기본 파일 격리, 고유 임시 파일, finally의 두 resync drain과 afterEach exact cleanup을 쓴다. Fake timer case는 해당 case보다 뒤에 있고 real timer로 복원한다. 실패 지점은 targeted batch를 배열에 추가한 뒤 두 overflow `recordFixtureState`를 순차 await하는 producer와, batch 수만 보고 기본 1초 `vi.waitFor`로 terminal을 검사한 consumer 사이였다. 실제 production Promise는 4,098 fixture 상태의 clone/parse·atomic write·commit·telemetry handoff·재계산을 완료해야 resolve한다. 배열 길이는 이 완료를 증명하지 않는다.

총괄 승인 후 기존 test-local `deferred`로 두 durable observation 완료를 명시적으로 기다리고 queue `onError`는 실패 결과를 전달해 즉시 throw하도록 변경했다. Production Gateway source는 그대로다. 기존 4,098/4,096·batch 64·fairness·RF 1회·pending fence와 30초 case 상한, retry 설정을 유지했다. Polling deadline을 키우거나 root gate 병렬성을 낮추지 않는다. 단독 case→Gateway 전체→root 전체를 직렬 fresh 검증하며 최종 root GREEN 전에는 완료로 판정하지 않는다.

Gateway 수정은 별도 test-only `e3daa6a`다. 커밋 전 해당 case 1/1(740ms), 커밋 후 1/1(736ms; 나머지 50개는 이름 필터 제외), 전체 Gateway 64 files·608/608(34.15초), root lint/typecheck 0을 확인했다. 이어진 root 내부 병렬 실행에서 같은 overflow case가 2,504ms로 통과하여, 긴 실제 durable 작업 완료를 기존 30초 상한 내에서 기다린다는 증거를 확보했다. 짧은 파일 단독 성공만으로 root 성공을 대체하지 않는다.

최종 전체 Chromium은 194개 중 189 통과/5 opt-in 제외, 4.2분, exit 0이다. 통과 범위는 mock/브라우저 회귀 188개와 실제 disposable automation journey 1개(30.4초)로 나눠 해석한다. 이 journey는 실제 로컬 API/PostgreSQL/Redis/MQTT 및 software Gateway adapter를 쓰며 실제 외부 운영 서비스·Raspberry Pi/ESP32-H2 HIL은 아니다.

## Runbook 자기 검토

- `docs/runbooks/production-api-web-deployment.md`에 읽기 전용 preflight/진단, image digest 준비, secret/PKI RO mount, 명시적 운영 project, backup·유지보수 승인, migration-before-app, health/metrics/request ID, browser TLS와 별도 장비 socket mTLS, CRL publish/SIGHUP, rollback·정지·incident 절차를 한글로 작성했다.
- 15개 Bash code block을 추출해 `bash -n`으로 구문 검사했다. `node --check scripts/production-compose-config.mjs`, `bash -n scripts/ci-production-audit.sh scripts/production-compose-smoke.sh`, helper의 project/env argument 배열 assertion, 예약 project fail-closed 음성 검사를 통과했다. Compose stop/kill/logs/exec/restart/image inspect help와 curl TLS/fail-with-body, OpenSSL checkhost 지원을 읽기 전용으로 확인했다.
- 직접 Compose 함수는 기존 helper와 같은 제한된 env 및 명시적 project/env/standalone 파일만 사용한다. 값이 포함되는 raw config/inspect·source/env 출력과 실제 운영 mutation 명령은 실행하지 않았다.
- Prisma forward-only와 schema-compatible image rollback, 별도 승인 DB restore, MinIO UID0/no-capability 예외, process-local metrics, nginx upstream 재해석·재시작, 수동 broker reload, 공개 MQTT/Object Storage·외부 Vault 및 single-host 한계를 명시했다.

## 최종 smoke·경계·남은 검증

- 새 project: `led-production-smoke-a9dac54a523c9484dbc4b9eade7b9d5e`.
- API image: `led-production-smoke-a9dac54a523c9484dbc4b9eade7b9d5e-api:sha-a9dac54a523c9484dbc4b9eade7b9d5e`, ID `sha256:b3f08cd500def9667cfcdbaafde721565e713ec0bbfbe4283b670cc25cf78ecc`, user `node`.
- Web image: `led-production-smoke-a9dac54a523c9484dbc4b9eade7b9d5e-web:sha-a9dac54a523c9484dbc4b9eade7b9d5e`, ID `sha256:8ad3bcfa79db2d9daa78cc0316550843a23d70ed6475c8c0a515ce0186de9fed`, user `nginx`.
- Initial public tables 0, migration 57/57, migration/API 동일 image와 migration 성공 뒤 API→Web 순서. Live/ready 200, TLS 1.2/1.3, proxy 200, request ID 보존, cache/security header, HTTP 308.
- 장비 raw TLS passthrough: no-client 401, valid-client/빈 serial 400와 정확한 input 오류, server identity 검증, Inventory/Enrollment 0/0, browser proxy 200.
- CRL missing seed nonzero; 실제 production writer atomic publish 2건, API/broker 소비 checksum 일치, broker RO, host seed 불변, init rerun no rollback, SIGHUP 뒤 ready 200.
- Nginx upstream wrong identity 502→복원 200. Redis stop 시 ready 503/live 200/Web healthcheck nonzero→restart ready 200.
- 종료 trap `CLEANUP ... containers=0 volumes=0 networks=0 owned-images=0`과 전체 audit exit 0. 별도 Docker label 조회·두 exact image inspect·임시 디렉터리 prefix 조회로 container/volume/network/owned image/private temp dir 모두 0을 독립 재확인했다. 지운 것은 이 고유 smoke의 disposable 데이터·image·PKI/env뿐이며 재생성 가능하다. 다른 project/volume/image나 사용자 DB는 제거하지 않았다. 이 image ID는 삭제된 로컬 artifact 식별자이고 운영 registry digest가 아니다.

최종 경계는 reviewed HEAD 대비 docs/report와 승인된 CRL 테스트 2개·Web E2E 6개·Gateway 테스트 1개·restore CSS selector 1개다. API source/Prisma schema/migrations, shared 계약, Gateway production, firmware, 개발 Compose diff는 없다. 새로운 secret/env/key/cert 파일은 추적하지 않았고 runbook의 env는 승인 경로 자리표시자다. 최종 diff·Markdown 상대 링크·15개 Bash 구문·secret-like 추가행 검사와 문서 수치 일치를 자기 검토했다.

최종 정적 검사는 staged docs-only 9개, reviewed HEAD 대비 승인된 총 19개 경로, 문서 상대 링크 41개, runbook Bash 15개, env key 34개, 네 메뉴 필수 절·동일 수치 검사 모두 통과했다. Staged 및 Task 4 전체 added diff의 private key/certificate·credential URL·token 형태 휴리스틱 검출은 0이고 diff check도 0이다. 이 휴리스틱을 정식 비밀 탐지 도구의 완전성 보장으로 해석하지 않는다.

운영 Vault 발급/갱신·실제 CRL 폐기 전파, 공인 DNS/TLS와 장비 mTLS/SAN, 공개 MQTT/Object Storage·CORS, 사용자 DB backup/migration/restore, native WebView·전체 앱 수동 시각 QA, Raspberry Pi/BlueZ/ESP32-H2 HIL, 외부 metrics/dashboard/alerts/log shipping은 후속 운영 승인·검증 대상이다. Task 4와 whole-branch 독립 검토는 최종 HEAD `728e0a8`에서 Critical/Important/Minor 0, PASS로 승인됐지만 이 소프트웨어 검토가 운영 배포 승인을 대신하지 않는다.
