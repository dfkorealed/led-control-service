# BIO 실사용 운영 적용 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 BIO 시간제 제어·달력의 공휴일/시각/MQTT/Gateway 운영 관문을 충족하고 실제 점등 시험과 구분해 실사용 준비 상태로 인계한다.

**Architecture:** 기존 API·MQTT·DB 계약은 유지한다. Mac DB-host의 별도 UID producer→보호 Unix socket→API reader와 BIO 전용 세 root 백업·복원/업그레이드 도구를 추가한다. API 점검 창 아래에서 실제 환경을 순차 적용하고, current V3/ACK·시각·coverage·권한을 확인한 뒤 정상 admission을 연다.

**Tech Stack:** Node 22 / pnpm 9.15.0, NestJS/Jest/Prisma PostgreSQL 16, Python 3.9+ 표준 라이브러리, macOS launchd/Unix socket/SNTP, Docker ARM64/Buildx, OpenSSL 3 CMS, Mosquitto mTLS, Gateway Vitest/esbuild.

**Spec:** `docs/superpowers/specs/2026-10-15-bio-operational-enablement-design.md` (설계 커밋 `2456c806`, 사용자 2026-10-15 진행 승인).

## Global Constraints

- 별도 브랜치 `codex/bio-operational-enablement-20261015`와 격리 작업 공간을 유지하고 확인 후 로컬 `codex/mvp1-cloud-web`에 머지한다. 원본 사용자 미커밋 변경은 보존한다.
- 실제 밝기 SET, 시간제 시작/종료, 센서 움직임 HIL, 기존 시험 규칙 활성화는 포함하지 않는다.
- 기존 조명 등록·기본 밝기·센서 설정·지도·비활성 시험 규칙·백업은 보존한다. 기존 native 데이터 삭제·변환은 금지한다.
- 기존 Command Set epoch egress/retention/purge 활성화 및 durable epoch continuity 구현은 포함하지 않는다.
- Gateway 인증서 신규 발급·회전 강제, TLS/ACL/시각 안전 관문 완화, OS 시각 강제 조정은 포함하지 않는다.
- 클라우드 이전, 새로운 DB 역할/DB 자격 증명 발급, DB 스키마 변경은 포함하지 않는다. 기존 migration을 재적용하지 않는다.
- 키는 Git·클라이언트·로그·문서에 넣지 않는다. 기존 보호 파일은 원본 checkout의 ignored `.local/secrets/kasi-holiday-service-key`이고 테스트는 이를 읽지 않는다.
- 실제 환경 쓰기 전 source/대상/프로세스/등록 귀속을 새로 확인한다. 이전 PID·receipt·승인 토큰을 재사용하지 않는다.
- 테스트는 변경·최소 연관 범위만 실행한다. 기존 Web 5개 실패와 무관한 경고는 고치거나 숨기지 않는다. 전체 suite/production audit는 실행하지 않는다.
- 구현 파일과 함께 영향 메뉴·운영 문서를 갱신한다. 총괄은 이 체크리스트와 `docs/project-status.md`를 결과에 맞춰 함께 갱신한다.

## Review Focus

1. 시각/배포 장애 중 기존 accepted end·recovery를 버리거나 운영 중 hold가 있는 상태를 롤백하지 않는다 — Tasks 4/5/7.
2. 오래된 SNTP 표본 재포장·producer 재시작·sleep/step·변경된 primary로 새 시작을 허용하지 않는다 — Tasks 2/3/4.
3. API UID가 socket/설정/실행물·세대 상태를 바꾸어 증거를 위조하거나 root 승인 명령을 호출하지 못한다 — Tasks 3/4.
4. V10 기록 뒤 이미지 단독 복귀·늦은 Docker 성공·세 root 부분 복원·credential/RF 외부 효과를 안전한 롤백으로 오인하지 않는다 — Tasks 6/7.
5. 다음 해 전부 빈 데이터·부분 수집·승격 hook 실패로 정상 coverage/현재 snapshot을 덮어쓰지 않는다 — Task 1.

## 실행 방식·소유권·준비

기존 요청대로 총괄 오케스트레이터→담당 역할 구현→독립 검토 방식으로 진행한다. 각 소프트웨어 Task는 새 작업 맥락의 담당 역할 하나와 검토자 하나를 사용하고, 수정 라운드는 같은 구현자에게 돌려준다. 공유 파일/계약 변경과 운영 쓰기는 병렬화하지 않는다. 검토 중 총괄도 읽기 전용을 유지한다. 마지막에는 전체 변경 diff를 한 번 독립 검토한다.

소유 순서: backend(Task 1)→gateway/운영(Task 2/3)→backend(Task 4/5)→gateway/운영(Task 6/7)→qa/총괄 통합·운영(Task 8). UI 변경은 없으며 필요해지면 `제어 UI 개선 담당자`와 협의한다. `제어 페이지 담당자`의 별도 시험 준비를 수정하지 않는다.

계획 승인 뒤에만 격리 checkout에서 Node 22·pnpm9.15·PG16 도구 경로를 확인하고 `pnpm install --frozen-lockfile`, `pnpm workspace:prepare`, `pnpm --filter @led-control/api prisma:generate`를 수행한다. 실제 `.env`를 테스트용으로 복사하지 않는다. 기본선은 아래 지정 직접 테스트만 사용하며 환경 부족을 skip/timeout 확대로 숨기지 않는다. 현재 서면 설계/계획 작업에서는 설치·제품 테스트·운영 변경을 실행하지 않는다.

---

### Task 1: 공휴일 credential loader·실제 provider DI 연결

**Owner:** backend. **Files:** Create `apps/api/src/automation/holiday-provider-config.ts`, `holiday-provider-config.spec.ts`; Modify `automation-runtime.module.ts`, `holiday-dataset.service.ts`, `holiday-dataset.service.spec.ts`, `.env.example`, `docs/menus/control.md`, `docs/runbooks/production-api-web-deployment.md`.

**Interfaces:** `createConfiguredHolidayProvider(env: NodeJS.ProcessEnv): HolidayProvider | undefined`를 export한다. `KASI_HOLIDAY_SERVICE_KEY_PATH` 미설정/잘못된 보호 파일은 undefined→기존 provider unavailable 경로이며 전체 API 부팅을 실패시키지 않는다. `HOLIDAY_PROVIDER` useFactory가 이 함수를 소비한다. 기존 `HolidayDatasetService.refreshYear(year): Promise<HolidayRefreshResult>`/승격 hook 계약은 유지한다.

- [ ] **1. RED 테스트 작성:** 임시 fixture의 절대 regular 0600/상위0700/현재 UID key만 provider로 연결되고, symlink·다른 owner·그룹/전체 read·512bytes 초과·내부 공백/내부 개행/끝 개행2개·오류는 키/경로/URL 없이 unavailable인지 고정한다. 끝 개행1개는 정상이다. Nest 테스트 모듈에서 실제 `HOLIDAY_PROVIDER` binding을 확인한다. KR 연도 전체 휴일이 0개면 새 coverage를 승격하지 않고, 정상 빈 월은 허용하며 hook 실패 시 pointer/revision이 보존되는 회귀를 추가한다.
- [ ] **2. RED 확인:** `pnpm --filter @led-control/api exec jest src/automation/holiday-provider-config.spec.ts src/automation/holiday-dataset.service.spec.ts --runInBand`. 새 동작의 semantic 실패를 기록하고 fixture/도구 실패와 구분한다.
- [ ] **3. 구현:** no-follow open→동일 descriptor fstat/크기/owner/mode→bounded read를 사용한다. key는 16~256자의 `[A-Za-z0-9+/%=._-]` 단일 값이며 URL decode/출력하지 않는다. 원본 보호 파일의 끝 개행 1개는 허용하되 내부 개행은 거절한다. 성공 시 기존 `KasiHolidayProvider`를 구성한다. 전체 연도가 비어 있으면 refresh와 cache 검증에서 unavailable로 처리하고 기존 정상 캐시는 유지한다. 메뉴/runbook에 운영 연결 전 상태와 키 경계를 기록한다.
- [ ] **4. GREEN 확인:** Step 2와 `pnpm --filter @led-control/api typecheck`, `git diff --check`. 자기 소유 disposable PG만 사용하고 실제 provider/키 호출은 0이어야 한다.
- [ ] **5. 커밋·검토:** 소유 파일만 커밋하고 독립 검토에 spec §5/Review Focus 5·원 로그를 전달한다. C/I 미해결 시 다음 Task로 넘어가지 않는다.

### Task 2: 시각 wire 계약·SNTP parser·trust 상태 기계

**Owner:** gateway/운영. **Files:** Create `scripts/clock-attestor/protocol-v1.json`, `core.py`, `test_core.py`, `fixtures/evidence-v1.json`; Modify `docs/runbooks/production-api-web-deployment.md`.

**Interfaces:** Python 3.9 호환 dataclass `PrimaryBinding(started_at:str,address:Optional[str],port:Optional[int],pid:int,process_started_at:str)`, `ClockSample(issued_at:str,offset_ms:float,uncertainty_ms:float,read_bracket_ms:float)`, `ClockTrustState(primary:PrimaryBinding,producer_boot_id:str,persisted_generations:dict)`를 정의한다. `parse_sntp(text:str)->Tuple[float,float]` 및 state 메서드 `observe(wall_ms:float,continuous_ns:int,primary_matches:bool)->None`, `record_sample(sample:ClockSample)->None`, `status()->dict`, `approve(observation_id:str,peer_uid:int)->None`, `evidence(nonce:str)->dict`를 제공한다.

wire v1은 newline-framed 단일 JSON이다. 요청 `{version:1,op:"read",nonce:UUID}`; 정상 응답은 exact keys `version,nonce,producerBootId,observationId,issuedAt,offsetMs,uncertaintyMs,readBracketMs,stepGeneration,clearedStepGeneration,failoverGeneration,clearedFailoverGeneration,primary`이고 primary는 exact `startedAt,address,port`다. 시각은 UTC millisecond ISO, ID는 canonical UUID, 세대는0이상 safe integer, port는1~65535 또는 null, 오차는 finite number이고 uncertainty/bracket은0이상이다. unhealthy 응답은 exact `{version:1,nonce,status:"unavailable",reason}`이고 reason은 `not_approved|sample_unavailable|clock_unhealthy|primary_changed|request_invalid` 중 하나다. UID0만 호출하는 `status`/`probe` 요청도 `version,op,nonce`를 사용하고 `approve`만 `observationId`가 추가된다. control 응답은 exact `version,nonce,status,observationId,consecutiveSamples,stepGeneration,failoverGeneration,primary`이며 status는 `observed|approved`다. probe는 캐시와 다른 독립 표본1개를 얻고, status는 수집하지 않는다. 관리자 도구는3개의 독립 probe와 마지막 관측의 approve를 한 관리자 invocation 안에서 수행할 수 있지만 관측 변경 시 자동 재시도하지 않는다. API consumer는 Task4가 구현한다.

wire canonical 형식은 UTF-8, object key 사전순, 공백 없는 JSON+마지막 LF 하나다. 숫자는 지수/불필요한 끝0/negative-zero 없이 소수점3자리 이하로 표기한다. offset은0.001ms로 반올림하고 uncertainty/bracket은 같은 단위로 올림해 보수성을 유지한다. 오차 합계는 integer microseconds로 계산한다. Python/JS 양쪽은 이 제한된 domain의 재직렬화 bytes 일치를 확인해 duplicate/비정규 표현을 거절한다. 이 형식과 정상/오류/0.0→0·fractional 경계 예시는 protocol/fixture에 함께 고정한다.

- [ ] **1. RED 테스트 작성:** 초 단위 `+0.058639 +/- 0.005864 ...`를 58.639/5.864ms로 파싱하고 잘못된 단위·음수 uncertainty·NaN/Infinity·모호/다중 결과를 거절한다. 오차 합계 정확100ms/초과, 측정 원시각1초/초과·미래100ms/초과, 관측 gap1초/초과, wall/continuous 변화10ms/초과, 시작/재시작 deny, primary 불일치, 정상3표본 전/후 exact 관측 root 승인과 오래된 승인 거절을 고정한다. 과거 표본의 `issuedAt`은 새 nonce에서도 불변이어야 한다.
- [ ] **2. RED 확인:** `/usr/bin/python3 -m unittest discover -s scripts/clock-attestor -p 'test_core.py' -v`. 실제 SNTP·OS 시각·DB는 접근하지 않는다.
- [ ] **3. 구현:** 새 boot/generation은 우선 deny, continuous 관측100ms·gap1000ms·step10ms 관문을 구현한다. `abs(offset)+uncertainty+readBracket+2 <=100`을 강제하되 wire `offsetMs`는 signed 실제 값이다. clear는 같은 primary의 독립 정상3표본과 현재 observationId에 대한 UID0 승인만 가능하다. epoch continuity는 만들지 않는다. 부정확한 표본/세대 상태는 새 증거가 아니라 unavailable이다.
- [ ] **4. GREEN 확인:** Step 2, protocol/fixture의 exact keys·중복/unknown key 거절, `git diff --check`. 현재 SNTP가 인증된 NTS라는 주장을 하지 않는다.
- [ ] **5. 커밋·검토:** producer/consumer private wire 계약과 fixture를 총괄 승인 후 커밋하고 다음 소비 작업에 정확 커밋을 전달한다. 독립 검토는 Focus 2를 확인한다.

### Task 3: 독립 producer·launchd 설치·관리자 승인 도구

**Owner:** gateway/운영. **Files:** Create `scripts/clock-attestor/daemon.py`, `installer.py`, `operator.py`, `test_daemon.py`, `test_installer.py`; Modify `docs/runbooks/production-api-web-deployment.md`, `docs/menus/control.md`.

**Interfaces:** `daemon.py --config <protected-json>`는 Task2 계약으로 서비스한다. `installer.py check|prepare|install|status --receipt <file>`, `operator.py status|probe`, `operator.py approve --observation-id <id>`를 제공한다. 설치 prefix는 `/Library/Application Support/Kinda/ClockAttestor`, socket은 하위 `runtime/evidence.sock`, config는 하위 `config.json`, launchd label은 `com.kinda.clock-attestor`다. root-owned config는 exact `version,producerUid,producerGid,apiUid,primary,sourceCommit,fileHashes`만 포함하고 receipt에는 설치 source hash와 fresh native PG process/primary binding이 있다. DB credential은 없다. `prepare/check`는 root/OS 변경 없이, `install/approve`만 관리자 권한으로 실행한다.

- [ ] **1. RED 테스트 작성:** same UID/nobody/기존 무관 계정·root가 아닌 설치·쓰기 가능한 interpreter/ancestor·symlink·소스 hash/primary drift를 거절한다. API peer는 read만, approve는 UID0만, 잘못된 peer/nonce/중복/unknown field/16KiB 초과/partial frame은 거절한다. 재시작·sleep/step 뒤 새 승인을 요구하고, SNTP timeout/늦은 완료/종료 뒤 응답이 증거를 만들지 못하는지 확인한다. 테스트는 injected syscall/명령 recorder와 임시 경로만 사용한다.
- [ ] **2. RED 확인:** `/usr/bin/python3 -m unittest discover -s scripts/clock-attestor -p 'test_*.py' -v`. 실제 dscl/launchctl/sudo/SNTP 호출은 0이어야 한다.
- [ ] **3. 구현:** system `/usr/bin/python3 -I`·root 보호 실행물/설정과 별도 비로그인 `_kinda_clock` UID/GID를 사용한다. UID/GID는 기존 directory 목록에서 501 이상 최저 미사용 값을 각각 선택하고 기존 이름은 자기 설치 receipt로 증명되는 경우만 재사용한다. 로그인 shell false·home `/var/empty`·암호 로그인 disabled를 설정한다. root 소유 prefix0755, producer 소유 runtime0755/state0700, config root0644, state0600과 API 쓰기 불가 ancestor를 검증한다. 새 설정/프로그램은 root 보호 staging에서 해시 대조 후 고정 경로에 설치하며 사용자 PYTHONPATH/모듈을 로드하지 않는다. kernel `getpeereid`와 Darwin continuous counter를 확인하고 지원 부재 시 시작 거절한다. SNTP는 고정 argv/750ms deadline·in-flight 병합, 원 시각1초 미만 캐시만 사용한다. 부하/외부 시간원 실패는 차단이지 합성 건강이 아니다. 종료는 socket/owned child를 drain한다.
- [ ] **4. GREEN 확인:** Step 2, installer가 내보내는 plist/receipt에서 credential0·고정 argv/identity·실행물 전체 hash를 검사하고 `git diff --check`. 실제 관리자 설치는 Task 8까지 하지 않는다.
- [ ] **5. 커밋·검토:** 독립 검토에 Focus 2/3과 설치 rollback(자기 서비스만 중지, 계정/상태는 보존)을 전달한다. 서비스가 source repo를 직접 실행하지 않는지 확인한다.

### Task 4: API의 보호 Unix socket reader와 BIO admission 연결

**Owner:** backend. **Files:** Create `apps/api/src/mqtt/command-db-clock-evidence-source.ts`, `command-db-clock-evidence-source.spec.ts`; Modify `mqtt.module.ts`, `command-db-clock-health.service.spec.ts`, `apps/api/src/temporary-controls/temporary-controls.integration.spec.ts`, `.env.example`, `docs/menus/control.md`.

**Interfaces:** `UnixCommandDbClockEvidenceSource implements CommandDbClockEvidenceSource`의 `read():Promise<CommandDbClockEvidence|null>`와 `createConfiguredCommandDbClockEvidenceSource(env:NodeJS.ProcessEnv):CommandDbClockEvidenceSource|undefined`를 export한다. `COMMAND_DB_CLOCK_EVIDENCE_SOURCE` useFactory가 소비한다. `COMMAND_DB_CLOCK_SOCKET_PATH`가 없으면 기존 optional deny이고, 설정되면 Task 3의 고정 canonical prefix/socket만 허용한다. `readEpochContinuity`는 제공하지 않는다. Task 2 fixture와 wire를 소비한다.

- [ ] **1. RED 테스트 작성:** socket/non-symlink·보호된 ancestor·producer UID가 API/root/nobody와 다른 경계, 교체된 inode/owner, wrong nonce/중복/unknown key/초과/partial/trailing frame·timeout·stale/future·오차 합계 초과를 거절한다. healthy wire만 Date 객체로 매핑한다. 실제 Nest binding과 같은 transaction primary 비교를 확인한다. 새 BIO clock 통합 테스트는 clock 실패 때 신규 reserve/outbox0, 기존 replay/query/accepted expiry recovery 보존을 고정한다. epoch 호출에는 계속 durable continuity 부재 오류가 나야 한다.
- [ ] **2. RED 확인:** `pnpm --filter @led-control/api exec jest src/mqtt/command-db-clock-evidence-source.spec.ts src/mqtt/command-db-clock-health.service.spec.ts --runInBand`; 새 통합 케이스는 `src/temporary-controls/temporary-controls.integration.spec.ts --runInBand -t 'operational clock reader'`로 별도 실행한다. 임시 IPC/자기 소유 PG fixture만 사용한다.
- [ ] **3. 구현:** 한 요청 nonce·총 IPC deadline1000ms·16KiB 상한·Task2 canonical JSON 규칙으로 파싱한다. 예상 producer UID는 API가 수정할 수 없는 Task3의 root-owned0644 `config.json`에서 읽고, same UID/root/nobody는 거절한다. socket/설정/보호 ancestor metadata를 연결 전후 재확인하고 raw 응답·path·Error를 노출하지 않는다. nonce 오류/교체/EOF/timeout은 null이다. uncertainty 포함 상한을 reader에서도 검사하고 원 `issuedAt`/signed offset/세대·primary를 보존한다. 기존 `CommandDbClockHealth`의100ms/1000ms/같은tx비교를 완화하지 않는다.
- [ ] **4. GREEN 확인:** Step 2, 직접 관련 `command-clock-responder.service.spec.ts`, `temporary-control-publisher.spec.ts`, API typecheck, `git diff --check`. 이 범위의 unit/PG 성공을 실제 producer 설치로 기록하지 않는다.
- [ ] **5. 커밋·검토:** Focus 1/2/3과 module default-off·epoch 미지원·accepted intent 보존을 독립 검토한다.

### Task 5: 배포 중 HTTP 쓰기 차단 점검 창

**Owner:** backend. **Files:** Create `apps/api/src/gateway-deployment-read-only.ts`, `gateway-deployment-read-only.spec.ts`; Modify `apps/api/src/main.ts`, `.env.example`, `docs/runbooks/production-api-web-deployment.md`, `docs/menus/control.md`, `docs/menus/settings.md`.

**Interfaces:** `installGatewayDeploymentReadOnly(app:NestExpressApplication,env:NodeJS.ProcessEnv):void`를 export하고 `main.ts`의 observability 설치 뒤/body parser 앞에서 호출한다. flag는 미설정/`0`이면 기존 동작, `1`이면 read-only이며 다른 값은 부팅을 거절한다.

- [ ] **1. RED 테스트 작성:** mode1의 모든 HTTP GET/HEAD/OPTIONS는 통과하고 POST/PUT/PATCH/DELETE와 다른 unsafe method는 handler·body parser/DB 부작용 전에503/`gateway_deployment_read_only`인지 고정한다. mode1 응답은 `X-Kinda-Read-Only: 1`, mode0는 header/상태/본문 변경0이다. flag typo·로그인/새 명령 차단, health 읽기와 기존 accepted worker recovery가 middleware로 삭제/해제되지 않음을 확인한다.
- [ ] **2. RED 확인:** `pnpm --filter @led-control/api exec jest src/gateway-deployment-read-only.spec.ts --runInBand`. 자기 소유 HTTP app과 counter를 사용하며 운영 endpoint를 호출하지 않는다.
- [ ] **3. 구현:** main의 지정 위치에 middleware를 한 번 설치한다. 기존 authentication/CSRF/권한 정책을 우회하지 않고 점검 시 모든 unsafe 요청을 먼저 닫는다. `Retry-After: 60`을 제공하고 health body의 고정 dependency key는 바꾸지 않는다. 이 flag가 worker drain이나 규칙 비활성화를 대신하지 않는다고 문서화한다.
- [ ] **4. GREEN 확인:** Step 2와 API typecheck/build, `git diff --check`. 신규 기능 테스트를 위해 실제 POST/장비 쓰기를 보내지 않는다.
- [ ] **5. 커밋·검토:** HTTP 처리 순서·정상 모드 비변경·Focus 1을 독립 검토한다.

### Task 6: BIO 세 root의 quiesced CMS 백업·검증·전체 복원

**Owner:** gateway/운영. **Files:** Create `scripts/bio-upgrade/state_archive.py`, `test_state_archive.py`; Modify `docs/runbooks/raspberry-pi-gateway-appliance.md`.

**Interfaces:** `BioStateBindingV1`는 `version=1,operationId,siteId,gatewayId,assignmentVersion,sourceContainerId,sourceImageId,roots`를 가진다. roots는 identity/gateway/mesh exact absolute 경로다. `RestoreGuardV1`는 `candidateStopped,usbOwnerCount,expectedBindingHash,credentialUnchanged,rfMutationAbsent,serverMutationAbsent,observationsComplete`다. `backup_quiesced_roots(binding,recipient_path,destination)->BackupReceiptV1`, `verify_backup(receipt,recipient_key,staging)->VerifiedBackupV1`, `restore_verified_backup(verified,binding,journal,guard)->RestoreResult`를 제공한다. receipt는 ciphertext SHA/bytes와 manifest SHA·정확 binding만 포함하고 키/평문 내용은 출력하지 않는다. live 사용은 Task7/8에 한정한다.

- [ ] **1. RED 테스트 작성:** 실제 OpenSSL3의 임시 recipient로 disposable3root(권한·허용 내부 symlink·dummy identity 포함)를 암호화→검증→drill→전체 복원한다. source V10 모사 쓰기 뒤 원본 세 root의 byte/hash/uid/gid/mode·pointer 복원을 확인한다. traversal/escape symlink/hardlink/중복 header·변조 manifest/ciphertext·용량 초과·복원 1/2번째 rename 중단과 재진입·identity rotation/외부 효과가 있는 자동 복원 거절을 고정한다. 실제 운영 key/root는 읽지 않는다.
- [ ] **2. RED 확인:** `/usr/bin/python3 -m unittest discover -s scripts/bio-upgrade -p 'test_state_archive.py' -v`. 실제 CMS happy path가 skip 없이 실행되어야 한다. 도구 부족이면 설정/시간 완화 없이 중단한다.
- [ ] **3. 구현:** 기존 BlueZ4root 명령을 재사용하지 않고 검증 원칙만 가져온다. 4096 headers·파일256MiB·regular합512MiB·manifest16MiB·ciphertext544MiB 상한을 hash/quiesce와 streaming parse 전에 검사한다. 사용자/장비 데이터의 partial backup은 만들지 않는다. CMS recipient만 Pi에서 사용하며 private key는 off-Pi custody에 유지한다. 같은 filesystem의 보호 staging·journal·atomic rename으로 세 root 전체를 전환하고 각 경계의 crash 상태를 기록한다. 불명확한 writer/USB/외부 효과는 복원이 아니라 보존+중단이다. key/plaintext staging cleanup 실패를 성공으로 처리하지 않는다.
- [ ] **4. GREEN 확인:** Step 2, backup↔verify↔drill↔restore의 binding/전체 metadata 대조·키 비노출·자기 임시 경로 cleanup 증거와 `git diff --check`. 운영 백업은 삭제하지 않는다.
- [ ] **5. 커밋·검토:** Focus 4와 실제 CMS 증거·중단 행렬을 독립 검토하고, archive/receipt 계약을 Task 7에 전달한다.

### Task 7: BIO 전용 업그레이드 journal·상태 복사본 preflight

**Owner:** gateway/운영. **Files:** Create `scripts/gateway-bio-upgrade.mjs`, `scripts/bio-upgrade/upgrade.py`, `test_upgrade.py`, `scripts/gateway-bio-upgrade.test.mjs`, `apps/gateway/src/bio-upgrade-state-preflight.ts`, `bio-upgrade-state-preflight.test.ts`, `apps/gateway/docker/bio-upgrade-preflight-contract.test.mjs`; Modify `apps/gateway/package.json`, `apps/gateway/docker/Dockerfile`, `docs/runbooks/raspberry-pi-gateway-appliance.md`, `docs/menus/control.md`, `docs/menus/settings.md`, `docs/menus/monitoring.md`.

**Interfaces:** host CLI는 `gateway-bio-upgrade.mjs check|stage|upgrade|resume|status --receipt <file>`다. receipt는 Task 6 binding에 candidate image/archive/commit/policy hashes, exact source StartedAt/Engine-config digest, fresh USB physical identity, assignment/mapping/credential fingerprints, API read-only proof·pending0·비활성/운전 기간 밖 규칙 증거를 결속한다. `check`는 mutation0, `stage`는 후보 image/helper만 보호 staging, `upgrade`는 지정 대상의 단계별 journal 실행, `resume`는 fresh receipt+기존 journal 검토 후 재진입이다. `validateBioUpgradeState(value:unknown):{sourceSchemaVersion:number,targetSchemaVersion:10}`는 기존 `parseAutomationState`를 소비하고 복사본 입력만 읽는다. bundle에는 `/opt/led-control/bio-upgrade-state-preflight.mjs`로 포함한다.

- [ ] **1. RED 테스트 작성:** strict V6→V10 parser가 기존 필드/값을 보존하고 신규 임시 map은 비어 있으며 malformed legacy/읽기 중 원본 변경을 거절하는지 고정한다. Docker/SSH/USB fake의 exact-ID drift·credential change·pending hold/release·새 active rule·TERM timeout/USB owner 미확정·늦은 create/start·중간 rename·unknown journal에서 원본/다른 container 중지0을 확인한다. stopped 기존 `led-control-gateway-bio`는 보존하고 V10 기록 후 이미지 단독 복귀가 불가능해야 한다.
- [ ] **2. RED 확인:** `/usr/bin/python3 -m unittest discover -s scripts/bio-upgrade -p 'test_*.py' -v`; `node --test scripts/gateway-bio-upgrade.test.mjs`; `pnpm --filter @led-control/gateway exec vitest run src/bio-upgrade-state-preflight.test.ts --maxWorkers=1 --minWorkers=1`. 실제 SSH/Pi/RF0이어야 한다.
- [ ] **3. 구현:** fresh source 검사는 stop 직전30초 이내 관측을 요구하고 ongoing operation은 동일 lock/journal·exact 신원으로만 이어간다. pending0·API admission 차단/기존 broker TTL 대기 뒤 TERM45초·USB0→Task6 동일 시점 backup/검증/drill→RO/no-network/no-device preflight→고유 candidate create/start 순서를 고정한다. 허용 drift는 image/name/새 ownership label뿐이다. 새 credential/RF/서버 작업 이후 자동 롤백은 금지한다. 안전하게 복원 가능한 실패만 candidate 종료/USB0→실패 상태 보존→Task6 전체 root 복원→old 재개로 처리한다. actual V3 capability/current applied ACK와 heartbeat3회 전에는 commit/admission 재개를 허용하지 않는다.
- [ ] **4. GREEN 확인:** Step2, Gateway typecheck/build, `node --test apps/gateway/docker/bio-upgrade-preflight-contract.test.mjs`(새preflight build/COPY·기존BIO security profile만), `git diff --check`. release전체audit/HIL은 실행하지 않는다.
- [ ] **5. 커밋·검토:** Focus 1/4와 배포 전/후 실패 복구 순서, helper ownership/receipt·새 image preflight 존재를 독립 검토한다. 기존 first-transition/BlueZ launcher를 바꾸어 차단을 풀지 않는다.

### Task 8: 최종 검토·로컬 머지·실제 환경 적용·인계

**Owner:** qa_reviewer→총괄 통합→gateway/운영·backend 순차 운영. **Files:** 기존 runbook/영향 메뉴/`docs/project-status.md`/본 체크리스트. 실제 `.env`/ACL·서비스 설치·Pi journal/evidence는 ignored 또는 보호된 운영 경로에만 둔다.

- [ ] **1. 전체 diff 검토:** Tasks1–7 커밋과 소유 경계·최소 검증 로그를 한 독립 검토자가 판정한다. C/I가 있으면 원 구현자 수리와 해당 지적만 재검토한다. 검토 중 총괄/다른 구현자는 제품 파일을 쓰지 않는다.
- [ ] **2. 안전한 로컬 머지:** 원본 HEAD/dirty/hash·현재 담당 작업을 다시 확인한다. 겹치는 사용자 변경은 자동 stash/커밋/덮어쓰기하지 않는다. 필요 시 기존 승인된 담당자 협의로 안전한 커밋 경계를 만든 뒤 일반 local merge한다. 원본 userdirty·DB·현재 runtime/cert/ACL SHA 보존을 대조한다. 원격 push/PR은 하지 않는다.
- [ ] **3. exact release 준비:** 검토된 clean 격리 commit에서 `pnpm gateway:appliance:build`로 production ARM64 bundle을 만든다. 해당 invocation이 반환한 exact bundle과40자 commit을 `BIO_BUNDLE`/`BIO_RELEASE_COMMIT`으로 결속해 `node scripts/gateway-release-bundle.mjs verify --bundle "$BIO_BUNDLE" --policy apps/gateway/release-policy.json --expected-commit "$BIO_RELEASE_COMMIT"`로 검증한다. image/archive/inventory/policy/commit의 exact 결속과 no-device preflight를 기록한다. 이전 test-only bundle을 사용하지 않으며 빌드 자체를 배포 완료로 기록하지 않는다.
- [ ] **4. 운영 설치 가능 여부:** fresh Mac DB-host/primary/Pi 귀속·NTP 상태, 백업 custody·recipient, 단독 USB owner·현재 규칙·대기0·인증서 남은 유효기간을 재확인한다. `sudo -n` 권한이 없으면 사용자가 수행할 exact 설치 단계로 넘기고 OS 보안을 우회하지 않는다. Task3 설치→새3표본/현재 observation 관리자 승인→실제 보호 IPC/같은 read-only DB transaction health 판정을 확인한다. 기존 epoch gate는 그대로 OFF/미지원이다.
- [ ] **5. 공휴일/점검 창 연결:** 기존 환경을 private memory로 보존하고 KASI path·clock socket·`GATEWAY_DEPLOYMENT_READ_ONLY=1`만 명시 추가해 owned API를 정상 재기동한다. 원본 runtime의 leaf/descendant 신원을 새로 확인하고 `dev.mjs`의 PKI/환경 재생성·과거 PID 재사용은 하지 않는다. read-only header/health200/5up과 본래 쓰기 handler가 없는 `POST /health/live`의 빈 본문 요청503·부작용0을 확인하며 실제 명령 endpoint로 검증 요청을 보내지 않는다. 실제 2026/2027년12개월/페이지를 수집해 complete pointer/hash·snapshot 승격을 읽기로 검증한다. 실패한 연도를 평일/빈 coverage로 간주하지 않는다.
- [ ] **6. 최소 MQTT 권한 적용:** DB/Pi current assignment가 같은 단일 scope만 `DEV_TEMPORARY_CONTROL_SCOPES`에 설정한다. canonical base와현재ACL을대조하고6grant외diff0·기존권한/PKI불변을확인한뒤 exact broker reload한다. disposable mTLS 직접 회귀는 `DEV_MQTT_ACL_INTEGRATION=1 node --test --test-name-pattern='temporary control exact site and Gateway delivery' scripts/dev-mqtt-acl.integration.test.mjs` 하나만 실행한다. 실제 broker에서는6grant/신원/연결·ready를 확인하며 유효한 장치 제어 payload를 발행하지 않는다.
- [ ] **7. 실제 BIO 교체:** Step4/5/6의 fresh evidence와pending0/drain을Task7receipt에결속해stage/upgrade한다. 새동일시점3rootCMSbackup→off-Piverify/drill통과전candidate를시작하지않는다. health6항목·restart0·단일USBowner·증가heartbeat3회·actualV3/temporary/durable/readback/currentrevision/hashACK·clockmarker를확인한다. 이상시Task7의명시복구경계로만처리하고기존backup/oldcontainer는남긴다.
- [ ] **8. 정상 운전 재개·읽기 검증:** 모든관문통과뒤`GATEWAY_DEPLOYMENT_READ_ONLY=0`으로ownedAPI를정상재기동한다. live/ready200·5up/Web200·read-onlyheader부재, 실제스케줄목록/달력/주말·휴일표시·시간제선택UI를읽기전용으로확인한다. 새start/SET/시험규칙활성화는하지않는다. metadata·등록·기본밝기·센서설정/비활성규칙·키/인증서보존을대조한다. UI수정이필요하면지정담당자로전환하고그변경의최소검증을추가한다.
- [ ] **9. 증거·문서·인계 커밋:** 실제source/image/설정diff·백업/복구가능성·서비스/시각/coverage/ACL/V3판정을비밀값없이보존한다. 기존단계의실패·미실행과최종상태를구분해영향메뉴/runbook/정본/체크리스트를같이갱신한다. finaldocs때문에HEAD가달라지면image의실제코드SHA와제품diff0을명시하며마지막docsHEAD의image라고오인시키지않는다. `git diff --check`뒤소유문서만커밋/로컬반영한다. 실사용준비완료와실제점등/유지/복귀HIL미실행을명확히구분한다.

## 계획 자체 검토·현재 상태

- [x] Spec §1–8을 Tasks1–8과 연결했고 제외 범위·보호 경계·역할 순서를 반영했다.
- [x] Review Focus 5개를 소유 Task의 RED·운영 확인 항목에 배치했다.
- [x] producer→reader wire/타입·백업→업그레이드 receipt와 파일 책임을 대조했다.
- [x] 현재 Mac Python3.9.6의 continuous clock/Unix socket 지원을 읽기로 확인했다. 관리자 설치 권한 확인은 실행 단계에 남겼다.
- [x] 사용자 계획 검토·진행 승인 (2026-10-15 “진행해”, 기존 담당 역할 위임 방식 유지)

2026-10-15 계획 승인 뒤 SDD 사전 교차 검토와 격리 환경 준비를 시작했다. Tasks1–8은 위 체크리스트의 실제 검증·독립 검토 결과에 따라 갱신하며 설치/머지/실배포를 선완료 표시하지 않는다.
