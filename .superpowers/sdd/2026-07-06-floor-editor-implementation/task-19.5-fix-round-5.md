# Task 19.5 Fix Round 5 구현 보고서

## 범위

`task-19.5-rereview-4.md`의 P1 2건과 P2 3건을 TDD로 교정했다. LAYER flag 2, source SHA profile binding, 후보 최대 2,000건, gzip SVG 8 MiB, AI disabled, 신규 PDF 제외, 후보 비자동등록 계약은 유지했다. 기존 `20260917150000_cad_profile_binding` migration은 수정하지 않았다.

## RED -> GREEN

- 기존 linked SVG의 encoding을 `createdAt`으로 추정하던 경계를 제거했다. 후속 migration은 committed attempt provenance가 없는 SVG를 `unknown`으로 만들고, review/apply/content가 MinIO HEAD를 검증해 identity/gzip으로 조건부 원자 갱신한다. Missing/mismatch/concurrent-change는 fail-close한다.
- 애플리케이션 drain만으로는 구 worker claim을 막지 못했다. `20260917144000` singleton gate와 DB trigger가 queued→processing을 모든 worker 버전에서 거부하고, profile/content migration 완료를 확인하는 `20260917170000`만 gate를 연다.
- Converter가 API UID/PID namespace/cgroup/secret mount를 공유했다. Production Compose에 network-none, UID 2000, read-only rootfs, 별도 1024 MiB cgroup sidecar를 추가하고 bounded tmpfs spool만 API와 공유했다.
- Bundle 존재만 확인하던 startup을 host+mounted-file 이중 attestation으로 바꿨다. Regular file, symlink 금지, owner execute, group/world write 금지와 필수 SHA-256 불일치·누락·replacement에서 readiness/import를 닫는다.
- 같은 cgroup의 합산 OOM 위험을 분리했다. API/core는 1280 MiB cgroup·heap 256/384 MiB·동시성 1·384 MiB temp이고, sidecar는 1024 MiB cgroup·heap 64 MiB·pids 64·64 MiB temp다. Converter child에는 AS 512 MiB, CPU 60초, nofile 64, nproc 32, fsize와 process-group timeout을 유지한다.

## 구현 결과

- `FloorAsset.contentEncoding`은 확정 `NULL | gzip` 외에 migration reconciliation 전용 `unknown`을 허용한다. 신규 worker gzip은 committed attempt provenance로 확정 상태를 유지한다.
- Runtime reconciler는 object key, MIME, stored byte size, checksum, viewport와 실제 `Content-Encoding`을 HEAD로 검증한다. UPDATE는 기존 asset identity 전체와 `unknown`을 조건으로 하며 경쟁에서 같은 결과만 수용한다.
- API container에는 converter executable/argv/bundle mount가 없다. Sidecar에는 DB, S3, Redis, Vault, MQTT, TLS env·mount와 external network가 없다. API readiness는 sidecar digest readiness를 포함한다.
- Production preflight는 exact UID, namespace, cgroup/heap/tmpfs/spool/concurrency/timeout 계약과 converter env/mount allowlist를 검사한다.
- Migration 회귀는 clean replay, old-worker race, gate lock rollback과 `migrate resolve --rolled-back` 후 deploy retry, 기존 15000 완료 history를 실제 PostgreSQL에서 검증한다.

## 실제 검증

| 검증 | 결과 |
| --- | --- |
| API focused unit | 10 suites, 69/69 |
| Upgrade safety PostgreSQL+MinIO | 13/13 |
| Production/container contract | 23/23 |
| API typecheck/build | 모두 exit 0 |
| Diff | `git diff --check` exit 0 |
| Production Compose smoke | migration 84/84, exit 0, exact cleanup |

Production smoke project `led-production-smoke-6af670a676e4adf16078984a2938d70d`에서 API/sidecar cgroup `1342177280`/`1073741824`, sidecar network none, UID 분리, secret env·mount 부재를 관측했다. 실제 Nest worker+sidecar+converter+core+PostgreSQL+MinIO의 HTTP create/status/candidates/content/apply와 gzip signed GET을 통과했다. API memory는 `166907904 -> 145014784`, sidecar는 `14929920 -> 17113088` bytes였고 malformed, memory bomb, output bomb, timeout 뒤 두 container/readiness가 생존했다. 후속 정상 작업은 `review_required`로 재처리됐다. 종료 후 container/volume/network/owned image는 모두 0이었다.

실제 PG+MinIO staged history는 legacy identity, pre-profile gzip, committed post-profile gzip을 각각 검증했다. HEAD missing/checksum mismatch는 `unknown`을 유지했고 동일 asset의 concurrent reconciliation은 하나의 확정값으로 수렴했다. 기존 profile migration SHA-256은 `56b83ce4e6e2310f1d0062684187c681aed0385f1c794799e29ba6cad4cf1b4f`로 유지됐다.

## 커밋

- `e249e0c4 fix(cad): reconcile legacy encoding behind migration gate`
- `285585fc fix(cad): isolate converter in attested sidecar`
- 문서와 이 보고서는 별도 documentation commit으로 분리한다.

## 남은 외부 승인

제공 DWG는 AutoCAD 2010/2011/2012 파일이고 SHA-256 `01f25d539c20f93663c9183bbf70d83e578ae9990c2eb6dabb543bf39d71854d`로 확인했다. Host의 `/opt/homebrew/bin/dwgread`는 macOS 실행 파일이며 승인된 Linux self-contained production converter bundle과 digest가 제공되지 않아 새 sidecar 실제 DWG HIL에는 사용하지 않았다. 이 opt-in HIL, 운영 DB backup/migration/restore와 실제 배포는 synthetic production 증거에 포함하지 않는다.

WIPEOUT/SPLINE, 사람 ground truth 기반 precision/recall/F1, BLE identity mapping과 실장비 HIL은 기존 후속 범위를 유지한다.
