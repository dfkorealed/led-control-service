# PKI 비활성화·인증서 발급 경쟁 방어 설계

기준일: 2026-09-12

## 목표

Gateway inventory 비활성화·인증서 폐기와 device/MQTT 인증서 발급·갱신·활성화가 동시에 실행돼도 비활성 장비에 사용 가능한 인증서가 남지 않게 한다. CA가 서명했지만 DB 저장이 거부된 인증서는 process crash와 일시적인 Vault/CRL 장애를 지나서도 폐기 의무가 유실되지 않아야 한다.

## 확인된 원인

- MQTT 발급과 device 갱신만 `inventory.id` advisory lock을 사용하고 disable, revoke, activate, 최초 device 발급은 같은 잠금 영역에 참여하지 않는다.
- 인증서 경로가 `GatewayInventory` row를 `FOR UPDATE`로 잠그지 않는다.
- MQTT 발급과 device 갱신은 CA 서명 이후 inventory, 인증서 상태·pointer, Gateway 배정을 다시 확인하지 않는다.
- 폐기 대상 조회, CA 폐기, DB 상태 전환이 분리돼 조회 뒤 발급되거나 activate된 인증서를 놓칠 수 있다.
- 서명 뒤 저장 실패 시 CA 폐기는 best-effort뿐이며, 실패한 serial을 회수하는 영속 원장과 worker가 없다.

## 잠금 계약

모든 inventory 변경 경로는 다음 순서를 사용한다.

1. inventory ID를 확정한다. 여러 ID면 문자열 오름차순으로 정렬한다.
2. `pg_advisory_xact_lock(hashtextextended(inventory.id::text, 0))`을 얻는다.
3. 같은 transaction에서 `GatewayInventory ... FOR UPDATE`를 조회한다.
4. 필요한 `GatewayCertificate` row를 ID 순서로 `FOR UPDATE` 조회한다.
5. Gateway 배정이 필요한 경로는 inventory 다음에 Gateway row를 잠그거나 authoritative relation을 다시 조회한다.

사전 조회는 입력 검증과 빠른 거절에만 사용한다. 상태를 바꾸는 판단은 위 잠금 뒤 다시 읽은 값만 신뢰한다.

## 서명과 영속 폐기 원장

새 `CertificateRevocationReconciliation` 원장은 인증서 PEM, CSR, private key 없이 purpose, issuer, serial, fingerprint와 정제된 source code만 저장한다. issuer+serial 및 fingerprint는 각각 idempotency key다.

CA 서명 직후 인증서 row 저장 전에 별도 autocommit transaction으로 원장을 `pending` 상태로 먼저 기록한다. 처리 가능 시각은 인증서 DB transaction 최대 시간보다 뒤로 둔다. 바깥 인증서 transaction이 성공하면 인증서 저장과 같은 commit에서 원장을 `cancelledAt`으로 종료한다. 저장 거부, timeout 또는 process crash로 성공 commit이 없으면 worker가 원장을 회수한다. 따라서 정상 저장된 인증서를 worker가 먼저 폐기하는 경쟁을 피하면서 서명 orphan을 보존한다.

원장 자체를 기록할 수 없으면 인증서 저장을 진행하지 않고 즉시 CA 폐기를 시도한 뒤 일반화된 503을 반환한다. DB와 CA가 동시에 장기간 장애인 극단적인 구간은 Vault가 request ID로 발급 결과를 재조회하는 기능 없이는 완전히 제거할 수 없으며 남은 위험으로 보고한다.

## 논리적 폐기와 worker

Inventory disable은 같은 transaction에서 `disabledAt`을 설정하고 미폐기 인증서를 `revocation_pending`으로 바꾸며 active device pointer를 비운 뒤 각 인증서 metadata를 원장에 upsert한다. API·MQTT 인가는 `active`만 허용하므로 commit 직후 fail-closed다.

Worker는 시작 시와 30초마다 `FOR UPDATE SKIP LOCKED`로 처리할 원장을 임대한다. 외부 CA 폐기는 DB transaction 밖에서 수행한다. owner와 유효한 lease를 조건으로 결과를 기록하며, CA 폐기 성공 뒤에는 `revokedAt`, CRL 배포까지 성공하면 `completedAt`을 기록한다. 실패는 정제된 error code와 최대 1시간 지수 backoff로 무기한 재시도한다. 인증서 row가 있는 작업은 완료 시 해당 row를 `revoked`로 전환한다.

Task 1 fix round 1에서 승인된 예외로 CRL read → publish → fenced finalize는 purpose별 PostgreSQL advisory lock을 가진 transaction 안에서 직렬화한다. 예약된 두 int key `(0x504b4943, device=1/mqtt=2)`는 inventory bigint 잠금 공간과 분리한다. 서로 다른 purpose는 독립적으로 진행한다. publish 직전에는 CA read를 기다리는 동안 transaction/lease를 잃지 않았는지 조회하고, publish 뒤에는 CA를 다시 읽어 snapshot이 달라졌다면 최신 CRL로 수렴시킨 뒤 완료한다. 최대 3회 배포·검증으로 제한하며 계속 달라지면 미완료/backoff로 남긴다. Vault 요청별 120초 제한에 따라 최초 조회와 3회 확인의 네트워크 요청 예산은 최대 8분이다. CRL transaction의 15분은 네트워크·인증 토큰/파일 I/O·DB 작업의 누적 예산이며 엄격한 filesystem 상한이 아니다. 5분 row lease 이후에도 살아 있는 transaction은 purpose 잠금을 유지한다. 하지만 누적 I/O가 예산을 넘거나 DB session이 유실되면 기존 publish가 잠금 해제 뒤에도 계속될 수 있다. Prisma는 시작한 외부 I/O를 취소하지 못하므로 개별 파일 호출이 15분 미만이어도 발생할 수 있는 이 경계를 운영 위험으로 기록한다.

## 경로별 재검증

- 최초 device 발급: inventory가 enabled, unclaimed, no active pointer인지 잠금 뒤와 CA 서명 뒤 다시 확인한다.
- MQTT 발급: 인증 device 인증서가 active이고 `revokedAt`이 없으며 inventory/gateway pointer와 배정이 일치하는지 잠금 뒤와 CA 서명 뒤 다시 확인한다.
- device 갱신: 기존 device 인증서와 pointer, enabled inventory, Gateway 배정, pending 부재를 잠금 뒤 확인하고 CA 서명 뒤 다시 확인한다.
- device 활성화: pending과 기존 active, inventory/gateway pointer, enabled/assignment 상태를 잠금 뒤 확인하고 조건부 상태 전환한다.
- disable/site deletion/revoke: 같은 잠금 순서 안에서 logical revoke와 원장 생성을 먼저 commit한 뒤 외부 폐기 처리를 시도한다.

## 검증

- 단위 테스트는 잠금 순서, CA 후 재조회, 원장 선기록·성공 취소, worker lease fencing과 재시도를 검증한다.
- 실제 PostgreSQL 테스트는 서로 다른 Prisma connection과 deferred CA barrier를 사용한다.
- 양방향 경합은 disable이 먼저인 issue/renew/activate와, issue/renew/activate가 잠금을 잡은 상태에서 disable이 기다리는 경우를 모두 포함한다.
- 각 경합 종료 뒤 disabled inventory에는 `active` 또는 `pending` certificate가 없고 active pointer가 비어 있어야 한다.
- 기존 동시 MQTT issuance 직렬화와 정상 device renewal/activation을 함께 회귀 검증한다.
- disposable PostgreSQL에 migration을 적용하되 사용자 로컬 DB에는 migration을 실행하지 않는다.

Task 3 최종 회귀는 전용 disposable PostgreSQL에서 기존 manufacturing → claim → bootstrap → MQTT와 revoked/disabled E2E 2개, 양방향 경쟁·Site 삭제·rollback 회수·동시 MQTT 직렬화·정상 renewal/activation integration 16개를 통과했다. 실제 경계는 PostgreSQL connection·migration·transaction·advisory/row lock·원장 저장까지이며 CA·CSR 검증·CRL 파일 배포는 fixture다. 실제 Vault/CRL과 장비/HIL은 실행하지 않았다.

## 문서 영향

- `docs/database-schema.md`: enum, 원장, 잠금·worker 불변식
- `docs/menus/settings.md`: inventory disable/인증서 폐기 신뢰성 및 아직 UI가 없는 한계
- `docs/project-status.md`: 구현·검증 증거와 남은 운영 위험
