# Task 19.5 Fix Round 4 구현 보고서

## 범위

`task-19.5-rereview-3.md`의 P1/P2를 TDD로 교정했다. AI는 disabled, 신규 PDF import는 제외, 후보는 review 전용이며 자동 `Fixture`/`MeshNode` 등록을 하지 않는다. Source SHA profile binding, 후보 2,000건, gzip SVG 8 MiB 상한을 유지했다. GPL LibreDWG는 production image와 bundle 계약에 포함하지 않는다.

## RED -> GREEN

- Production Compose에 converter env/mount가 없고 image에 `/usr/bin/prlimit`가 없었다. 필수 env 누락, 잘못된 argv JSON/placeholder, writable/missing mount와 resource mutation RED를 추가한 뒤 exact preflight와 image attestation으로 닫았다.
- Converter child가 API env 전체를 상속하고 Linux limit가 fsize뿐이었다. credential noninherit와 AS/CPU/nofile/nproc/fsize argv RED 뒤 최소 env allowlist와 GNU prlimit 정책을 구현했다.
- `20260917150000_cad_profile_binding`이 legacy SVG를 모두 gzip으로 오표기하고 active profile 의미를 바꿀 수 있었다. 원 checksum을 고정한 채 clean/staged/active/race/lock-timeout/terminal invariant와 PG+MinIO identity/gzip RED를 후속 migration으로 닫았다.
- Review job 조회가 apply/content 수정 뒤에도 legacy identity SVG를 거부했다. Identity review RED를 추가하고 ledger의 실제 `NULL | gzip` 값을 HEAD 검증에 전달했다.
- LAYER flag 2가 전역 hidden 처리됐다. Flag 2 entity가 후보/bounds/render에 남는 RED 뒤 bit 1, 음수 color, group 60만 현재 model visibility에서 제외했다.
- Synthetic production smoke가 Nest CAD 경로를 통과하지 않았다. 외부 converter mount, HTTP create/status/candidates/content/apply, malformed와 `MEMORY_BOMB`, parent 생존 계약을 RED로 추가한 뒤 실제 image/cgroup에서 통과시켰다.

## 구현 결과

- Production API는 운영자가 승인한 절대 host bundle을 `/opt/cad-converter:ro`로만 받는다. `CAD_IMPORT_CONVERTER_BUNDLE_PATH` 또는 올바른 `CAD_IMPORT_CONVERTER_ARGV_JSON`이 없으면 Compose config/preflight가 실패한다.
- Runtime image는 util-linux의 canonical root-owned mode 755 `/usr/bin/prlimit`를 attestation하고 converter/LibreDWG는 포함하지 않는다. API는 heap 256 MiB, core heap 384 MiB, cgroup 768 MiB, CAD concurrency 1, UID 1000용 512 MiB temp tmpfs를 사용한다.
- Converter env는 고정 PATH, `C.UTF-8` locale, job temp `TMPDIR`만 전달한다. Address space 512 MiB, CPU 60초, nofile 64, nproc 32와 output fsize를 제한하며 기존 detached process-group timeout/kill/close reap을 유지한다.
- `20260917145000_cad_profile_upgrade_preflight`와 `20260917160000_cad_upgrade_safety`는 table lock 뒤 processing/applying이 있으면 fail-close하고 10초 lock timeout에서 부분 schema를 남기지 않는다. Queued만 profile을 NULL staging하고 lease worker가 source SHA로 resolve한다. Review/applying/completed는 non-null profile identity를 요구하며 legacy terminal은 `legacy-unknown` sentinel을 사용한다.
- Legacy 비압축 SVG는 `contentEncoding = NULL`, 신규 worker SVG는 `gzip`이다. DB trigger와 review/apply/content redirect는 ledger와 S3 HEAD의 encoding/size/checksum을 정확히 비교한다. 기존 migration checksum `56b83ce4e6e2310f1d0062684187c681aed0385f1c794799e29ba6cad4cf1b4f`는 변경하지 않았다.
- 상시 synthetic smoke는 production Compose/image/Nest provider/worker/external converter/core/PostgreSQL/MinIO/HTTP를 하나의 경로로 연결한다. 승인 실도면 HIL은 외부 executable과 JSON argv를 명시하는 opt-in으로 분리했다.

## 실제 검증

| 검증 | 결과 |
| --- | --- |
| API focused unit | 6 suites, 138 passed, Linux-only 1 skipped |
| Floor import PostgreSQL | 10/10, 2,000건 rollback/retry/apply 포함 |
| 기존 CAD migration PostgreSQL | 23/23 |
| Upgrade safety PostgreSQL+MinIO | 10/10, clean/staged/race/lock timeout/identity+gzip signed GET 포함 |
| Object Storage MinIO | 3 passed, unrelated report 1 skipped |
| Production/container contract | 17/17 |
| Production image smoke | 빈 DB migration 81/81, exit 0, exact cleanup |
| Shared/API/Web | typecheck와 build 모두 exit 0 |
| Diff | `git diff --check` exit 0 |

Production smoke project `led-production-smoke-9e88ead9a2560afbcdb2066d683b9d0f`에서 정상 synthetic DXF가 review 후보를 만들고 gzip signed GET과 apply를 통과했다. 같은 768 MiB cgroup에서 memory current는 158,093,312 -> 162,529,280 bytes였고 malformed parser 입력과 converter memory bomb가 각각 terminal failure로 수렴한 뒤 같은 API container의 live 200을 확인했다. 종료 시 containers/volumes/networks/owned-images는 모두 0이었다.

## 커밋

- `382de14e fix(cad): preserve legacy assets across profile migration`
- `6004748d fix(cad): harden production converter execution`
- `4b17a919 fix(cad): keep layer flag two visible in model space`

## 남은 경계

Round 3의 승인 DWG/LibreDWG sample HIL 수치를 재사용해 새 production 증거로 주장하지 않는다. 이번 round의 상시 smoke는 외부 read-only synthetic converter를 사용했으며, 승인된 실제 converter bundle과 제공 DWG의 opt-in HIL은 미실행이다. 실제 운영 배포, 사용자 DB backup/migration/restore, 외부 Vault/MQTT/Object Storage와 Raspberry Pi/ESP32-H2 HIL도 실행하지 않았다. WIPEOUT/SPLINE과 사람 ground truth 기반 precision/recall/F1, BLE identity mapping은 여전히 후속 범위다.
