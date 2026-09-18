# 설정 메뉴 기능 현황 및 구현 설계

> 모든 설계와 완료 판정은 양산 기준을 사용한다. 코드·자동 테스트 완료와 Raspberry Pi/ESP32-H2 실기 검증 완료를 구분하며, 실기 증거가 없으면 양산 E2E 완료로 표시하지 않는다.

기준일: 2026-09-17

## 현재 우선순위

- 2026-09-09 승인 맵 편집 개선은 소프트웨어 구현과 최종 회귀 검증을 완료했다. 층별 미배치 목록 드래그 배치, 단일 조명 우상단 `배치 해제`와 확인 팝업, Undo/Redo·검색·일괄 편집·등록 후 식별을 연결했다. 두 층 실제 API/DB 브라우저 E2E는 2026-09-10 통과했다. 비공개 배경 자산의 신규 업로드는 DWG/DXF CAD 원본만 허용하고 기존 ready image/PDF/rendered SVG 읽기 호환은 유지한다. 2026-09-17에는 DWG/DXF 자동 맵 구성의 샘플 분석 도구와 검증 보고서를 추가했다. image/PDF 신규 업로드와 실제 BLE 장비 identity 자동 연결은 제공하지 않는다. 최신 범위는 [에디터 설계](../superpowers/specs/2026-07-06-floor-editor-design.md) 13장과 [실행 계획](../superpowers/plans/2026-07-06-floor-editor-implementation.md) Task 19를 따른다. 실장비 검증·배포는 사용자 요청으로 후속이다.
- Scene 24~26 설정 개요·역할별 navigation·도면 목록/편집·계정 보안 UI 교정은 완료했다. 새로운 설정 도메인 기능은 아래 미구현 목록과 후속 범위를 유지한다.
- 기존 맵 편집기는 계속 설정 메뉴가 소유하며, 저장한 배경, 도형, 텍스트, 색상과 조명 배치를 모니터링에서 읽기 전용으로 재사용한다.
- 현장 일반 유저 관리, 본인 비밀번호 변경, operator/admin MFA, 모든 역할의 활성 세션 관리와 설치 후 현장·층·조명 메타데이터 운영 관리는 구현 완료했다. 구역은 기존 목록 조회와 안전한 보관 전환만 제공한다. 공통 감사 조회, 구역 생성·수정, 정책/알림, OTA, 외부 연동의 미구현 상태는 유지한다.
- BLE Mesh floor/zone Group Address와 subscription 동기화는 설정 화면 확장이 아니라 제어 기반 기능으로 구현한다. 기존 FixtureGroup 데이터만 사용하며 이번 범위에서 그룹 CRUD UI는 추가하지 않는다.
- Task 6에서 로그인 화면을 `loginId` 전용으로 정리하고 operator/customer shell을 분리했다. Task 7에서 operator는 설정을 포함한 고객 메뉴 대신 `/operator/site-admins` 전용 목록으로 replace되며, 현장·관리자 생성, 기존 현장 관리자 지정, 수정, 비밀번호 재설정과 삭제를 제공한다. 삭제는 현장명을 다시 입력한 경우에만 실행하며 해당 현장의 층·도면·조명·게이트웨이·제어·통계 데이터와 고객사 계정을 영구 삭제한다. Task 8에서 assigned admin의 최초 설치와 commissioning 역할 노출을 웹에 연결했다.
- P2 보고서가 있는 현장도 모든 비공개 시도 파일 삭제 후에만 DB에서 삭제한다. 처리 중 보고서는 `409`, 저장소 정리 실패는 `503`으로 현장 삭제를 보류하며 재시도할 수 있다. 생성/claim은 Site 잠금 뒤 준비 원장을 재확인하고, 기존 원장 아래 남은 processing도 임대 만료 후 worker가 회수한다. 삭제 성공과 도면·인증서 정리 완료 뒤에도 독립된 보고서 키 원장이 늦은 업로드를 반복 회수한다. 이 준비 단계에서 중단되면 운영자가 현장 삭제를 다시 요청해야 한다.
- 롤링 업그레이드 중 구버전 인스턴스의 현장 cascade도 DB DELETE 트리거가 보고서별 세 키를 기록한다. 이 보호는 트리거 migration 커밋 뒤 적용되며, 원장 기록과 삭제가 함께 rollback/commit되어 runtime helper 누락으로 파일 회수 권한이 사라지지 않는다.

상세 계약은 `docs/superpowers/specs/2026-08-19-monitoring-control-focused-completion-design.md`를 따른다.

## 목표와 기능 경계

- 설정 메뉴를 현장 구성, 맵 관리, 장비 시운전, 운영 정책, 보안, 유지보수의 관리 허브로 만든다.
- 실시간 상태 확인은 모니터링, 조명 명령 실행은 제어, 에너지 분석은 통계에서 담당한다.
- 맵 편집기는 설정의 `맵 관리`에서만 열고, 모니터링은 읽기 전용 상태 확인에 한정한다.
- assigned customer `admin`이 자기 pending Site의 최초 주소·단가·시간대·층 설치와 Gateway claim·조명 검색·등록 commissioning API를 수행한다. Gateway claim은 Site row lock 뒤 할당·활성 상태·고객사 소속을 다시 확인하며, operator, 다른 admin, viewer는 고객 Site를 `404`로 접근할 수 없다. Task 9 격리 실백엔드 E2E가 이 웹/API 역할 계약을 검증했다.
- 설치 완료 후 고객사의 `admin`은 도면 배경, 도형, 조명 배치, 일반 조명 정보와 운영 정책을 직접 관리한다.
- 설정값은 임의 JSON 한 필드에 모으지 않고 검증 가능한 명시적 모델과 컬럼으로 관리한다.

## 권한 기준

| 기능 | operator | admin | viewer |
| --- | --- | --- | --- |
| 설정 조회 | 고객 현장 capability 없음 | 직접 배정된 한 현장 | 배정 현장 |
| 최초 현장·층 설치 | 금지 | 직접 배정된 pending 현장만 허용 | 금지 |
| Gateway claim·BLE Mesh 검색·provisioning | 금지 | 설치 완료 후 웹 UI와 API 허용 | 금지 |
| 현장 정보와 층 관리 | 금지 | 허용 | 금지 |
| 도면 배경·도형 편집 | 금지 | 허용 | 금지 |
| 조명 이름·정격전력·위치 편집 | 금지 | 허용 | 금지 |
| 그룹 관리와 운영 정책 | 금지 | 허용 | 금지 |
| 맵 버전 복구 | 금지 | 허용 | 금지 |
| Gateway 해제·장비 교체·초기화 | 후속 계약 확정 대기 | 후속 계약 확정 대기 | 금지 |
| 고객사 일반 유저 관리 | 금지 | 허용 | 금지 |
| 알림 규칙 | 후속 계약 확정 대기 | 후속 계약 확정 대기 | 금지 |
| operator 배정·인증서·OTA 변경 | 허용 | 금지 | 금지 |
| 편집 잠금 강제 해제 | 금지 | 허용 | 금지 |

- 프론트의 버튼 노출과 무관하게 모든 변경 API가 서버에서 조직, 현장 접근 범위와 역할을 검사한다.
- `operator`는 서비스 운영사 소속이지만 고객 Site의 `read/manage/commission` capability와 Site 목록을 갖지 않는다.
- `admin`은 `Site.adminUserId`로 직접 배정된 한 customer Site만 `read/manage/commission`할 수 있으며 같은 Organization의 다른 Site도 `404`다.
- `viewer`는 자기 고객사 조직 안에서도 `SiteMembership`으로 배정된 현장만 접근하며, membership의 `read | control` capability를 따른다.
- 마지막 고객사 admin은 비활성화하거나 viewer로 낮출 수 없다.
- operator 배정, 현장 초기화, Gateway 해제, 인증서 폐기, 전체 OTA에는 재인증과 감사 로그를 적용한다.
- admin은 자기 현장에 일반 유저만 생성할 수 있으며 두 번째 admin이나 operator를 생성·배정할 수 없다.

## 설정 정보 구조

| 하위 메뉴 | 책임 |
| --- | --- |
| 설정 개요 | 현장, 조명, Gateway, 사용자, 펌웨어 상태 요약과 필요한 조치 표시 |
| 현장 및 층 | 현장 기본 정보, 층 추가·수정·정렬·보관 |
| 맵 관리 | 층별 배경 도면, Konva 편집기, 버전 조회·복구 |
| 조명 및 그룹 | 조명 일반 정보, 그룹과 구성원 일괄 관리 |
| Gateway 및 네트워크 | Claim, 담당 층·구역, 연결·Mesh·인증서 진단 |
| 설치 및 시운전 | BLE Mesh 검색, provisioning, 배치, 통신 품질 검사, 시운전 보고서 |
| 운영 정책 | 오프라인·stale·명령 제한 시간, 디밍 범위, 정전 복구 정책 |
| 알림 | 장애 조건, 수신자, 채널, 지연·cooldown, 점검 시간 |
| 사용자 및 보안 | 초대, 역할, 현장 접근, MFA, 세션, 감사 로그 |
| 펌웨어 및 유지보수 | 버전, 서명된 OTA, 단계 배포, 중단·롤백, 인증서 수명주기 |
| 외부 연동 | API key, Webhook, BMS/BACnet 연동과 접근 범위 |

- 주 메뉴의 설정 항목은 팝업이나 별도 서브메뉴 없이 `/settings`로 이동하는 일반 메뉴 링크로 표시한다.
- 설정 Shell 상단에는 제어·통계와 같은 공통 밑줄형 탭을 배치한다. 탭은 역할별 capability로 필터링하고 모바일에서는 가로 스크롤하며 현재 `siteId`, query와 hash를 유지한다.
- 설정과 에디터는 URL을 가지며 새로고침, 브라우저 뒤로 가기와 직접 진입을 지원한다.

## 구현 완료

- 2026-09-18 CAD worker 진행률은 처리 단계와 재시도 전체에서 이전 값보다 감소하지 않고 `15 → 35 → 70 → 90 → 100%`로 수렴한다. Web은 `updatedAt`에 timer 생명주기를 의존하지 않는 1초 polling을 terminal 상태 전까지 유지하고, `review_required / 100%` 전환 commit부터 후보 조회가 끝날 때까지 완료 진행 UI를 한 render도 끊지 않는다. 후보 조회 실패 시 loading UI를 제거하고 `다시 확인`으로 재개하며, 이미 준비된 review에는 loading UI를 남기지 않는다. 상태 조회 실패도 기존 job과 진행률을 보존한 채 재개하고 apply 요청은 맵 초기화 확인 계약을 명시한다. 신규 DB migration은 재시도 queued job의 `0~90%` 보존 진행률과 해제된 lease를 lifecycle CHECK에 반영한다.
- 2026-09-17 CAD 원본 단위를 맵 픽셀로 직접 사용하지 않도록 SVG와 조명 후보에 같은 정규화 행렬을 적용한다. 맵은 원본 종횡비를 유지하면서 최대 `2400 × 1600`, 최소 변 800px, 도형 여백 40px로 생성한다. CAD 검토 배경이나 적용 overlay가 처음 나타날 때 전체 맵을 편집 영역에 한 번 맞추며 이후 사용자 줌·이동은 덮어쓰지 않는다. 실제 `킨다_도면등록_테스트.dwg`는 원본 viewport `15,020,849 × 164,134`에서 `2,400 × 800`로 줄었고 후보 2개, raw SVG 29,978,290 bytes, gzip SVG 3,285,375 bytes를 유지했다. Web 전체 1,309개와 실제 Chromium 맵 편집 7개에서 자동 맞춤 뒤 사용자 줌 보존 및 1,000개 조명 회귀를 통과했다. 정규화 도입 전에 이미 적용한 CAD는 원본을 다시 가져와 적용해야 한다.
- 2026-09-17 로컬 개발 서버는 PATH 및 표준 Homebrew 경로의 `dwgread`를 실제 경로로 자동 감지해 shell 없는 `development-argv` CAD worker를 활성화한다. 변환기가 없는 개발 환경에서는 import 생성 API가 `503`으로 실패해 `queued / 0%` 작업을 영구 생성하지 않는다. 이 개발 어댑터는 production에서 거부되며 운영의 network-none sidecar·승인 digest 계약은 유지한다.
- CAD job이 `review_required`에 도달하면 Web은 durable active job과 후보를 다시 읽어 검토 화면을 복구한다. 후보 요청 중 부모 callback identity가 바뀌어도 요청 결과를 폐기하거나 같은 job을 영구적으로 로드 완료 처리하지 않는다. 실제 Chromium에서 완료된 DWG job이 후보 2개 화면으로 복구되는지와 새로고침 5회 동안 15% 표시·API 5xx·console error가 없는지 확인했다.
- 2026-09-17 `킨다_도면등록_테스트.dwg` 실파일 검증에서 LibreDWG가 맵 구성과 무관한 `OBJECTS` 메타데이터에 잘못된 group code와 정의 없는 치수 보조 블록 INSERT를 출력하는 사례를 보완했다. 파서는 정상 종료된 `BLOCKS`/`ENTITIES`를 계속 엄격히 검사하고 이후 `OBJECTS` 본문은 입력 크기·NUL·시간 상한 안에서 건너뛰며, 형상이 없는 고아 INSERT만 제외한다. 정규화 전 검증에서 해당 파일은 엔티티 1,413개·블록 378개·gzip SVG 3,285,366 bytes를 저장하고 `review_required / 100%`에 도달했다. 일반 profile은 의미가 명확한 `LED직부등` 정확 일치를 허용하며, 실제 DB에 confidence 0.95 후보 2개만 저장하고 관련 없는 건축·문자·일반 심볼 463개는 제외했다.
- 2026-09-17 Task 19.5 fix round 3에서 analyzer와 제품 parser의 model-space(group 67/410), BLOCK base point, nested world transform을 다시 검증했다. 샘플 SHA256 `01f25d539c20f93663c9183bbf70d83e578ae9990c2eb6dabb543bf39d71854d`, `dwgread 0.14`, analyzer `cad-import-analysis/2` 기준 model/paper 비-structural entity는 26,887/4,150개, 직접 model INSERT는 8,954개, 고유 원점 8,947개, block은 11,243개다. 지원 entity 예상 coverage 98.1478%와 직접 INSERT 이름+유한 원점 비율 100%는 제한된 구문 추출률이며 시각·검출 정확도 100%가 아니다.
- Web과 요청자는 detector profile을 선택하지 않는다. 서버 registry가 ready source asset SHA-256을 검증해 제공 샘플만 `site-drawing-20260803-v1`에 연결하고 그 외 입력은 `generic-lighting-v1`로 닫는다. 기존 queued job은 migration에서 profile을 `NULL`로 staging한 뒤 lease를 획득한 worker가 source digest로 한 번만 해석하며, processing/applying이 있으면 migration이 fail-close한다. 샘플 profile version/digest는 `site-drawing-20260803/1`/`d6dbdda9bd28a4eca8e54db48f0ff88129001bc72409f92f3f2196b4cc7de962`이며 analyzer 1,302개, 제품 1,308개 review 후보를 얻었다. ground truth가 없어 precision/recall/F1은 미확정이다.
- 제품 parser는 LAYER flag bit 1, 음수 color와 entity group 60만 현재 model visibility에서 제외한다. bit 2는 새 viewport 기본 frozen 의미이므로 전역 hidden으로 취급하지 않는다. renderer와 후보는 같은 scale·translation·y-flip을 사용한다. 제공 샘플에서 visible model entity 26,387개와 block 11,243개를 보유했다. model-space WIPEOUT 397개와 SPLINE 84개는 여전히 미지원이므로 가림/곡선까지 포함한 시각 정답률을 주장하지 않는다.
- 105,432,404-byte DXF의 parse/detect/render는 API process가 아닌 `--max-old-space-size=384` child에서 실행한다. macOS standalone child peak RSS는 489,635,840 bytes, parent peak는 53,346,304 bytes였다. Linux 768 MiB cgroup에서 API module-loaded parent baseline/peak 139,603,968/142,684,160 bytes와 child peak 376,909,824 bytes로 샘플이 통과했고 malformed child 실패 뒤 parent 생존도 확인했다. production은 API heap 256 MiB, child heap 384 MiB, CAD 동시 job 1, cgroup 768 MiB를 정확히 검사한다.
- 샘플 SVG는 raw 17,046,497 bytes, deterministic gzip 3,731,451 bytes/SHA-256 `bc71ccb314e7a687144a54dba8d74f23f20ab5364fcb47fa0fbd99f204cb2185`다. 신규 worker 출력은 gzip ledger가 필수지만 migration 이전 비압축 SVG는 `contentEncoding = NULL` identity로 유지한다. 실제 PostgreSQL+MinIO staged migration에서 legacy identity와 신규 gzip의 HEAD/review/apply/signed GET을 함께 검증했다.
- 후보는 250건 단위 transaction으로 최대 2,000건을 보존한다. 실제 PostgreSQL에서 4번째 chunk 강제 실패 시 앞선 750건이 rollback되고 retry 2,000건 저장 및 실패 attempt cleanup이 수렴했으며 2,000건 list/1,302건 apply와 Web 2,000건 review도 통과했다. 적용된 accepted 후보는 현재 배경 자산·map revision에 결속된 읽기 전용 오버레이로 재조회되어 새로고침 뒤에도 수동 조명 배치·식별 기준점으로 남는다. 후보는 자동 등록이 아니며 `Fixture`/`MeshNode`/`FloorMapObject`를 만들지 않고 실제 BLE identity 매핑은 0%다. AI adapter는 I/O 0회의 `disabled`이고 provider 교체 경계만 있다. 신규 PDF upload/import는 제외하며 기존 PDF 읽기 호환은 유지한다. GPL LibreDWG는 개발 분석/HIL 전용이고 제품 의존성에 포함하지 않는다.
- Task 19.5 fix round 4는 production API image에 root-owned canonical `/usr/bin/prlimit`만 추가하고 GPL LibreDWG나 converter는 포함하지 않는다. 운영자가 승인한 self-contained converter bundle을 절대 host path에서 `/opt/cad-converter:ro`로 주입해야 Compose가 render되며, API heap 256 MiB, core heap 384 MiB, cgroup 768 MiB, 동시 job 1과 512 MiB 전용 temp tmpfs를 preflight가 고정한다. converter는 API credential을 상속하지 않고 PATH/locale/TMPDIR만 받으며 address-space 512 MiB, CPU 60초, nofile 64, nproc 32, output fsize와 process-group timeout을 적용한다.
- 상시 synthetic production smoke는 실제 production image/Nest provider/worker/external read-only converter/child core/PostgreSQL/MinIO를 HTTP create/status/candidates/content/apply 한 경로로 통과했다. 81/81 migration, gzip signed GET, 후보 비자동등록, malformed와 converter memory bomb 뒤 같은 API parent 생존, exact cleanup을 확인했다. 승인 샘플 HIL은 `CAD_SAMPLE_DWG_PATH`, 외부 `CAD_SAMPLE_CONVERTER_PATH`와 `CAD_SAMPLE_CONVERTER_ARGV_JSON`을 명시하는 opt-in이며 이번 round에서는 재실행하지 않았다.
- Task 19.5 fix round 5와 최종 보정은 converter를 API에서 분리된 UID 2000, network-none, read-only sidecar와 별도 1024 MiB cgroup으로 옮겼다. API는 bundle/argv/실행 권한 없이 512 MiB bounded spool만 공유하며 DB/S3/Vault/MQTT/TLS secret은 sidecar에 전달하지 않는다. Host와 mounted sidecar가 필수 승인 SHA-256과 executable owner/mode를 각각 검증한다. Sidecar readiness는 instance별 2초 만료 heartbeat이고 startup attestation 전에 이전 marker를 제거하므로 crash·OOM·digest mismatch 뒤 stale ready를 수용하지 않는다. 취소·변환 중 readiness 상실은 terminal 응답을 제한 시간 동안 기다리고, 이미 사라진 job directory는 sidecar 전체가 아닌 해당 job 정리로 수렴한다. Source 50 MiB, DXF 256 MiB, raw SVG 128 MiB, gzip SVG 8 MiB와 filesystem overhead 64 MiB를 공통 계약으로 두고 렌더 전 200 MiB를 예약한다. API/core cgroup은 1408 MiB, heap은 256/384 MiB, sidecar heap은 64 MiB다. Production smoke는 84/84 migration과 HTTP 전 경로, output/memory/timeout bomb 뒤 양쪽 생존·readiness·정상 재처리를 통과했다.
- Migration 이전 linked SVG는 생성 시각으로 identity/gzip을 추정하지 않는다. 후속 migration이 provenance가 불명확한 값을 `unknown`으로 만들고 review/apply/content가 MinIO HEAD의 encoding/size/checksum/viewport를 확인한 뒤 조건부 원자 reconciliation한다. 신규 worker gzip은 확정값으로 유지한다. `20260917144000` singleton gate/DB trigger는 최종 release 전 구 worker claim도 거부한다. 실제 PG+MinIO 13/13이 clean, identity, pre/post-15000 gzip, HEAD 오류/불일치/동시성, lock rollback+retry와 기존 15000 적용 이력을 검증했다.
- 최종 제공 DWG 제품 경로 재실행은 source 17,887,748 bytes/SHA-256 `01f25d...1854d`, 후보 1,308개, 정규화된 gzip SVG 3,732,245 bytes, profile `site-drawing-20260803/1`을 기록하고 PostgreSQL·MinIO 저장, API 조회와 signed GET을 통과했다. 최종 독립 whole-feature review는 P1/P2 없음, Spec/Quality Ready로 판정했다.

- 2026-09-16 Tailwind Task 12에서 설정 개요·현장·사용자·등록·맵·보안 화면과 공통 dialog/navigation의 legacy class/CSS adapter를 제거하고 의미 토큰·utility 및 `data-*` 테스트 계약으로 수렴했다. legacy `components/ConfirmDialog.tsx`는 production/test import 0을 확인한 뒤 삭제했으며 정책 baseline은 빈 violation map을 사용한다. Fresh Web **1,224/1,224**, UI policy **53/53**, 전체 Chromium 직렬 **257 passed·5 환경 의존 skip·실패 0**, 별도 opt-in RealBackendLab 설치 여정 **2/2**와 층 배치 **1/1**을 통과했다. 실제 iOS/Android WebView, 운영 Object Storage, 사용자 DB 적용과 Raspberry Pi/ESP32-H2 HIL은 실행하지 않았다.

- 2026-09-16 공통 셸·인증·운영자 UI 이전에서 설정 진입 셸과 로그인/MFA/필수 비밀번호 변경 폼을 Tailwind 의미 토큰 및 공통 field/typography/feedback/overlay로 통합했다. 운영자의 현장 관리자 생성·지정·수정·비밀번호 재설정·현장 전체 삭제 dialog도 공통 `ModalDialog`/`ConfirmDialog`로 전환해 기존 API payload, 비밀번호 비캐시 계약, validation focus, Escape/trigger focus 복원을 유지했으며 전용 비밀번호 변경 CSS와 production `window.confirm`/legacy dialog focus hook 의존을 제거했다. 관련 Vitest 157개와 320/390/1024/1440px Chromium 셸·인증·복구 시나리오 19개로 검증했으며, 이는 mock API 기반 browser 회귀로 실제 운영 DB·Gateway·ESP32-H2·조명 실장비 HIL 완료를 뜻하지 않는다.
- 조명 등록, 최초 설치, Gateway claim과 맵 편집 정적 UI를 공통 React Aria/Tailwind 시스템으로 이전했다. 등록의 일괄·개별 payload와 진행 상태는 유지하고 `TextField`, `NumberField`, `SelectBox`, `Checkbox`, `RadioGroup`, `FileField`를 사용한다. 맵 편집의 정적 색상은 `themeColor` 의미 토큰으로 통일했으며 Konva 좌표·크기·배율처럼 실행 중 계산되는 geometry만 inline 예외로 남긴다. 미배치 조명 목록과 캔버스는 callback ref registry를 공유해 DOM `querySelector` 없이 선택 조명으로 포커스를 복귀한다. 편집 이탈·충돌 재조회와 개발·검증 전용 테스트 데이터 삭제는 공통 `ConfirmDialog`를 사용한다. 테스트 데이터 삭제 중 확인·닫기 중복 실행을 차단하고 완료 뒤 삭제 버튼으로 포커스를 복귀하며, 브라우저 종료의 native `beforeunload` 보호만 유지한다. 설정 Shell은 남는 화면 높이와 관계없이 현장 선택기·탭·본문을 상단부터 배치한다.
- 조명 등록, 최초 설치, Gateway claim, 맵 목록, RF 안내와 조명 위치 확인 화면의 기능별 legacy `styles.css` class hook을 제거하고 의미 토큰 유틸리티로 레이아웃·상태 표현을 소유하게 했다. 등록 세션·도면 목록·Konva 캔버스 E2E는 제거 대상 CSS 클래스 대신 role, 접근 가능한 이름과 전용 `data-*` 계약을 사용하며, 회귀 테스트가 해당 production class hook의 재도입을 차단한다. 실행 중 계산되는 Konva 좌표·크기·배율 외에 이 범위에 남은 legacy 정적 class hook은 없다.
- 설정 개요, 현장 관리, 유저 관리, 계정 보안과 현장 선택기를 공통 React Aria/Tailwind 디자인 시스템으로 전환했다. 원시 `input/select`와 기능별 정적 CSS를 제거하고 `TextField`, `PasswordField`, `SelectBox`, `RadioGroup`, `Switch`, `ModalDialog`, `ConfirmDialog`를 사용한다. kWh 단가와 조명 정격전력은 입력 중 소수 문자열을 보존하는 `TextField inputMode="decimal"` 계약을 유지하며, 제출 시 빈 값·소수 둘째 자리 형식·유한 숫자·기존 허용 범위(단가 0~99,999,999.99원, 정격전력 0.01~999,999.99W)를 검증한 뒤 API에 숫자로 전달한다.
- 맵 편집 중 현장 전환은 브라우저 `window.confirm` 대신 앱 내부 확인 대화상자를 사용한다. 취소하면 URL과 편집 초안을 유지하고, 확인한 경우에만 초안을 폐기한 뒤 새 현장으로 이동한다. 현재 로그인 세션 종료도 같은 앱 내부 확인 흐름을 사용한다. 설정 상단 활성 탭 스크롤은 DOM `querySelector` 없이 경로별 ref registry로 처리한다.

- 도면 이력은 층별 **최근 100개 또는 최근 365일 중 넓은 범위**를 보존하고, 범위 밖 이력은 분당 최대 1,000개씩 정리한다. 보존된 이력만 목록 조회·복구할 수 있다. 로그인 `Session`은 만료 또는 폐기 후 30일이 지난 행만 분당 최대 10,000개씩 정리하며 활성 세션은 보존한다.
- 게이트웨이 이벤트 원장은 heartbeat 7일, 조명 상태 30일, 종료된 검색 세션 이벤트 90일, 대체된 차량 센서 capability 365일 이후에 안전 조건을 확인해 분당 최대 10,000개씩 정리한다. watermark·현재 상태·검색 terminal ACK identity가 부족하면 보존한다. 각 정리는 안정된 순서와 `SKIP LOCKED`를 사용하고, 중복 timer 실행을 막으며 삭제 건수·실패 단계를 구조화 로그로 남긴다. 기간 경계와 두 연결의 잠금 건너뛰기·재실행 수렴은 일회성 PostgreSQL에서 검증했다.
- API 종료 시 정리 timer를 중지하고 진행 중인 정리 작업을 마친 뒤 Prisma 연결을 닫는다. 실제 Nest 모듈 종료에서 삭제 완료·최종 disconnect 순서와 남는 DB 연결이 없음을 일회성 PostgreSQL로 검증했다.

- 신규 scan completed/failed는 session에 전체 payload hash·event ID·sequence·최초 ACK 시각을 보존한다. raw 이벤트와 ACK outbox가 삭제된 뒤에도 동일 terminal은 최초 application ACK로 재생성하고 변경된 acceptedNodeCount/failure message는 거부한다. found의 gateway/type 순서는 session을 바꿔도 watermark로 유지하며 임시 PostgreSQL에서 검증했다.
- 등록 세션 API는 terminal replay identity와 `BigInt` sequence를 서버 내부 복구 정보로만 유지하고 HTTP 응답에서는 제외한다. 완료된 첫 검색의 상태 조회, 재검색, 두 조명 등록과 세션 완료가 격리 RealBackendLab의 실제 PostgreSQL·Redis·MQTT·브라우저 여정 2/2에서 통과했다.
- 플랫폼 Task 4 최종 소프트웨어 검증은 root lint/typecheck/build exit 0, root script 58/58·Shared 203·Automation 28·Mobile 1·Web 64 files 712/712·API 120 suites 1,138 통과/289 환경 의존 제외·Gateway 64 files 608/608(총 2,748 통과/289 제외)다. 전체 Chromium은 194개 중 189 통과/5 opt-in 제외(188개 mock/브라우저 회귀 + 실제 disposable automation journey 1개), main 319.19 kB/gzip 99.21 kB다. Production 계약 18/18, 전체 audit의 MQTT 설정 2/2·Gateway container 24/24·required MQTT 2/2와 새 smoke `led-production-smoke-a9dac54a523c9484dbc4b9eade7b9d5e`의 당시 브랜치 빈 DB 57/57 migrations, TLS/mTLS·CRL·장애 복구·exact cleanup을 통과했다. Dependency 820개 중 기존 승인 예외 High 2/Moderate 1, unexpected 0이며 무취약 판정이 아니다. 운영 배포·사용자 DB·실제 외부 Vault/MQTT/Object Storage·native WebView·HIL·외부 관측 연결은 미검증이다. [운영 runbook](../runbooks/production-api-web-deployment.md)에 절차와 한계를 기록했다. 최종 독립 검토는 Critical/Important/Minor 0, PASS로 승인됐다.

- 플랫폼 Task 4 최종 회귀에서 기준부터 존재한 맵 리비전 복구 버튼의 클릭 영역 부족을 발견했다. 해당 버튼만 44×44px에서 52×52px로 확대해 기존 둥근 모서리 안에서도 연속 44×44px hit 영역을 확보했다(`ad864f9`). 공통 Button 크기·권한·복구 동작은 변경하지 않았으며 320/390/1024/1440px layout·overflow·touch 계약을 통과했다. 이는 Task 3 recovery 변경의 회귀가 아닌 기존 접근성 보완이다.

- 플랫폼 Task 3에서 공통 앱 셸 복구를 구현했다. 초기 인증 401은 기존 로그인, 403과 그 밖의 비일시 오류는 권한·재로그인 안내로 분기한다. 브라우저가 부팅부터 offline이면 요청 없이 서비스 복구 화면을 표시하고 online 복귀 시 인증을 재개한다. 네트워크·전송 timeout·5xx는 자동 최대 2회 재시도하고 실패하면 `다시 시도`로 연결을 복구한다. `AppRoot`의 boundary는 App 자체의 hook/render와 Router/lazy shell 실패를 단일 main·alert·포커스 heading으로 표시한다. 인증 실패·재로그인·principal 전환 시 새 QueryClient를 먼저 활성화해 늦은 이전 mutation callback을 폐기된 client에 격리한다. 재로그인은 앱 active-command namespace와 tenant/auth 캐시·초안을 정리하고 최대 5초 logout 종료 뒤 로그인으로 수렴한다. 무관한 저장값과 최초 정상 부팅의 제어 복구 기록은 유지하며 원시 오류/응답/stack은 표시하지 않는다. Task 3 Web 64 files·712/712 unit, 관련 auth/shell Chromium 23/23(신규 복구 10개 포함), typecheck/build와 main `319.19 kB`/gzip `99.21 kB` bundle audit를 통과했다.

- Route 기능 코드 SHA `34261b6`에서 로그인·최초 비밀번호 변경은 초기 main에 유지하고 고객/운영자 shell과 설정 shell·개요·유저·등록·도면·편집기·계정 보안 화면을 각각 dynamic chunk로 분리했다. 역할 shell 전체 화면과 shell 내부 route는 공통 `RouteLoadingState`의 `role="status"`·`aria-live="polite"` 로딩 상태를 사용한다. 별도 Web route bundle 작업 당시 Task 4 Web 검증은 60 files·686/686 unit, 2,437 modules production build와 main `314.83 kB`/gzip `97.58 kB`(예산 `1,070.00 kB`/`325.00 kB`)를 통과했고, 14개 계획 route chunk와 main의 Konva·Recharts 격리를 audit으로 확인했다. 같은 별도 작업 당시 Task 3 Chromium 64/64는 1440/1024/760/390/320px에서 설정·도면 편집을 포함한 대표 route 전환을, disposable RealBackendLab 2/2는 실제 API/DB 기반 고객 여정을 검증했다.
- 공통 고객 셸 상단은 현재 메뉴 제목과 실제 현장명 배지만 표시한다. 기존 층명 기반 `B2 주차장` 표기와 동작 없는 Gateway 정상·오프라인·미등록 상태 배지는 제거하되 설정의 `Gateway 상태` 상세 카드는 유지한다. 로그아웃 위치와 인증·dirty editor 확인 로직은 유지하고, 고객·운영자 셸의 로그아웃은 공통 `IconTooltipButton`으로 아이콘만 표시한다. `로그아웃` 도움말은 hover와 키보드 focus에서 열리고 도움말 위로 포인터를 옮겨도 유지되며 `Escape`로 닫힌다. 모바일 버튼은 52px 실제 터치 영역을 사용한다.

- admin 전용 `/settings/users`에서 현장 일반 유저를 최대 100명까지 조회·검색·생성·수정·비활성화·재활성화·비밀번호 초기화·영구 삭제한다. 일반 유저는 시스템 role `viewer`를 유지하고 현장 capability만 `read | control`로 분리한다. `control`은 `read`를 포함하며 admin 설정 화면에는 접근하지 못한다. 일반 유저가 `/settings/users`를 직접 열면 `/settings`로 replace되며 mock 및 격리 실백엔드 Chromium에서 확인한다. 비활성화는 기존 세션을 즉시 폐기하고 재로그인을 차단하며, 영구 삭제는 로그인 아이디 확인 뒤 사용자·membership·세션을 제거한다. 비밀번호가 포함된 생성·초기화 요청은 React Query mutation cache를 사용하지 않는다. API 응답·DOM/input·Web Storage의 평문 부재는 E2E가, React Query cache의 password·삭제 PII 부재는 API/View 단위 테스트가 검증한다.
- 사용자 수정과 상태 변경은 `expectedUpdatedAt`으로 충돌을 감지한다. 비밀번호 변경처럼 다른 요청이 user revision을 갱신해 상태 변경이 `SITE_USER_CHANGED`로 거부되면, UI는 최신 목록을 다시 조회해 사용자가 요청한 상태만 한 번 재시도한다. 서버는 모든 쓰기 transaction 안에서 호출자 admin과 대상 Site를 다시 인가한다.

- 설정 Shell의 자동 Grid 행은 남는 세로 공간을 나눠 늘리지 않고 상단부터 배치한다. 설정 개요, 현장 관리, 조명 등록, 맵 관리, 계정 보안 페이지는 현장 선택기 바로 아래의 일정한 간격에서 시작하며 1440/1024/390/320px Chromium 위치 계약으로 검증한다.
- 맵 편집기의 오른쪽 속성·배치·레이어 영역은 이름 있는 공통 `SidePanel`과 `ui-side-panel-layout` overflow 계약을 사용한다. 긴 조명명과 속성값은 패널 폭 안에서 줄바꿈하고, 높이가 제한되면 오른쪽 영역 내부에서 스크롤해 속성 UI가 화면 밖으로 잘리지 않는다.

- 맵 편집 화면의 기능명과 진입 메뉴를 `맵 관리`/`맵 편집`으로 통일했다. 아무 요소도 선택하지 않으면 우측 속성 패널에는 맵 너비·높이·격자 간격만 표시하고, 조명 단일/다중 선택과 네모·세모·선·텍스트 선택 시에는 해당 요소에 유효한 속성만 표시한다. 선택이 바뀌면 속성 탭으로 자동 복귀한다.
- 맵 크기와 층별 격자 간격(5~200)을 `FloorPlan`에 저장한다. 배경 파일이 없는 층도 `sourceType = none`인 맵 설정을 저장할 수 있다. 격자 스냅은 화면 이동량이 아니라 맵 절대 좌표를 사용하며, 조명·도형의 생성·드롭·이동·크기 변경·키보드 이동에 동일하게 적용한다. 도형은 모서리와 변, 선은 양 끝, 조명은 비율 고정 모서리 핸들로 크기를 바꾼다. 도형 전체가 맵 경계 안에 남도록 보정하고, 기존 요소가 밖으로 밀려나는 맵 축소는 UI에서 거부한다. 격자는 고배율/대형 맵에서도 그리기 부하가 제한되며 배경 이미지 위에 표시된다.
- 맵을 열거나 층을 전환하면 격자 스냅을 기본 ON으로 시작한다. 맵 크기가 격자 간격의 배수가 아니어도 마지막 유효 격자점과 실제 맵 경계를 함께 비교해 가장 가까운 위치에 붙이며, 맵 바깥 작업 영역은 별도 격자 무늬 없이 단색으로 표시한다. 실제 맵 내부의 Konva 격자선은 현재 층의 `gridSize` 기준으로 유지한다.
- 이동 도구를 선택하면 편집 캔버스 커서를 열린 손 모양으로 표시하고, 마우스를 누른 채 상하좌우로 이동하는 동안에는 움켜쥔 손 모양으로 전환한다. 놓기·캔버스 이탈·Escape 취소 시 열린 손 모양으로 복구한다.
- 2026-09-10 맵 편집 보강 검증: 최신 Web 단위 테스트 526개, Web production build와 관련 Chromium 29개 시나리오를 통과했다. Chromium 검증에는 1440/1024/390/320px 레이아웃, 선택별 패널, 기본 ON 격자 스냅, 비격자 배수 맵 경계 정렬, 이동 커서와 저장 도형의 모니터링 실제 픽셀 표시가 포함된다. Raspberry Pi/ESP32-H2 HIL 범위는 변경하지 않았다.
- 2026-09-11 저장 도형 모니터링 표시 보강: 설정 editor가 저장한 네모·세모·선·텍스트는 별도 renderer를 만들지 않고 공통 `FloorScene`/`FloorMapObjectNode`를 재사용한다. shared scene과 Konva wrapper의 명시적 크기 체인이 모니터링 floor map 콘텐츠 높이까지 이어지며, Chromium 회귀는 `.floor-scene-canvas`·`.konvajs-content`·canvas의 최종 높이와 각 도형의 hand-derived RGB 픽셀을 검증한다. 이 결과는 deterministic mock route fixture의 소프트웨어 증거이고 실제 현장 도면 또는 Raspberry Pi/ESP32-H2 HIL 검증은 아니다.
- 2026-09-10 맵 탐색과 정렬 보강: 마우스와 트랙패드 입력을 동일하게 취급해 휠 계열 입력은 포인터 중심 확대·축소, `이동` 도구의 드래그는 상하좌우 이동으로 처리한다. 조명·도형은 이동 중 포인터를 그대로 따라가고 이동을 끝낸 시점에만 가장 가까운 격자 좌표로 확정한다. 단순 도형 이동은 크기를 변경하지 않으며 리사이즈를 끝낼 때만 시작·끝 모서리를 격자에 맞춘다. 조명 단일·다중 이동과 도형 이동 중에는 맵 및 다른 요소의 좌·중앙·우, 상·중앙·하 정렬점에 6px 이내로 접근하면 PPT 방식의 가로·세로 보조선을 표시하고 임시 정렬한다. 격자 스냅이 켜져 있으면 이동 종료 시 격자 좌표가 최종 위치를 결정한다. Web 515개 단위 테스트, production build와 관련 Chromium 27개 시나리오를 통과했으며 DB/API 변경은 없다.
- 2026-09-10 최종 검증: 웹 단위 497개, 편집기 Chromium 29개 및 추가 성능 1개, 실제 설치 여정 2개, 두 층 배치 여정 1개 통과. 1,000개 배치 조명 준비 시간은 warm reload 20회 p95 220.6ms였다(mock API/macOS M2 Pro/Chromium, 운영 cold start 보장 아님). 실제 PostgreSQL 대량 저장 100회 main 재검증은 p95 549ms였다. 전체 결과와 재현 경로는 실행 계획에 기록했다.

- 테스트 데이터 도구는 단일 `VITE_TEST_DATA_TOOLS_ENABLED=true` opt-in 환경에서만 Web UI와 API를 활성화하며, off이면 endpoint가 `404`다. 설치 완료 현장의 assigned `admin` 설정 개요에만 생성·삭제 카드를 노출하며, 다른 역할이나 미설치 현장에는 노출하지 않는다. `POST/DELETE /test-data/sites/:siteId`로 현재 모든 층에 marker Gateway 1개와 MeshNode/Fixture 200개씩을 idempotent하게 생성한다. 생성 transaction은 marker fixture를 다시 읽고 공통 `EnergyDimensionHistoryService.ensureFixtureDimensions()`로 누락 energy identity와 현재 dimension을 일괄 보장한다. 실제 energy service를 사용한 1,000개 회귀에서 신규·반복의 energy DB 호출은 5회·3회(최초 marker 조회 포함 6회·4회)이며 변경된 현재 version만 같은 `effectiveAt`에 닫고 교체한다. 동일 dimension 재실행은 공통 서비스의 no-op 계약으로 version을 중복 생성하지 않는다. `led-control-test-data/v1/`과 `[TEST DATA] Fixture ` 접두사는 이 도구의 예약 namespace이며, Gateway·MeshNode·Fixture marker chain이 모두 일치하는 데이터만 삭제해 실제 장비 데이터는 보존한다. marker identity에 실제 일/시간 집계나 구역 membership 이력이 있거나 marker 장비에 예상하지 않은 노드·그룹·명령·통계 등 종속 데이터가 있으면 부분 삭제하지 않고 `409`로 transaction 전체를 거부한다. 의존성 조회 전에 검증된 marker fixture ID를 정렬한 `FOR UPDATE` 잠금으로 ingestion과 직렬화하며, 안전한 marker identity/dimension만 fixture보다 먼저 정리한다. 생성 직후 recent online으로 표시될 수 있으나 실제 heartbeat가 없으면 freshness 정책에 따라 offline으로 전환될 수 있으며, 실장비나 MQTT 동작을 시뮬레이션하는 기능은 아니다. 2026-09-11 최종 API 회귀는 956개 통과, 환경 의존 196개 skip, typecheck/build 통과였다.

- 각 층 편집 route와 층 선택을 제공하고 지도·목록·선택·Undo/Redo·미리보기·편집권을 층별로 분리한다. 저장하지 않은 변경이 있으면 층 전환을 확인하며, 저장 응답이 늦게 도착해도 다른 층/계정의 작업을 덮어쓰지 않는다. 공통 상단 배지는 실제 현장명을 유지하고 편집 대상 층은 에디터 내부 제목과 층 목록에서 구분한다.
- 좌측 가상 목록에서 이름/시리얼/Mesh 주소 검색과 전체/배치/미배치 필터, 전체 선택을 제공한다. 미배치 조명을 드래그해 현재 확대율·팬 좌표의 포인터 위치에 배치하고, 배치 조명 검색 결과를 선택하면 해당 위치를 보여 준다. 선택한 한 조명 우상단의 휴지통은 장비 삭제가 아닌 `배치 해제`다. 확인 팝업의 취소는 변경하지 않고, 승인은 로컬 초안에서 미배치로 되돌린다. 저장 전에는 모니터링에 반영하지 않으며 Undo/재배치가 가능하다.
- 박스/Shift 선택, 다중 조명 이동, 화살표 이동, 격자 스냅, 정렬/균등 분배, 격자·선형 배치 미리보기/취소/적용과 이름·표시 크기·정격 W 일괄 속성을 제공한다. 잠기거나 숨긴 조명은 변경하지 않는다. 선형 배치는 좌·상 방향과 음수 각도도 처리한다. 조명 등록을 복제하거나 제어 그룹을 변경하지 않는다.
- 맵 맞춤·선택 맞춤·휠 줌·팬·미니맵, 배경/도형/조명 레이어 표시와 편집 잠금을 제공한다. 레이어 보기 상태와 조명 잠금은 편집 세션 상태이며 층 전환 시 초기화한다. 도형의 저장된 표시/잠금 속성은 기존 데이터로 유지한다. 화면 크기의 Konva Stage, 분리된 레이어, 조명 노드 memo와 안정적인 ref, 저배율 이름 생략으로 대량 편집을 처리한다.
- 저장 후 편집 화면을 유지하며 응답을 baseline/cache에 반영한다. 로컬 초안은 사용자/현장/층/revision으로 구분하고 복구 전 검증한다. 저장 중 초안 복구를 차단하며 인증 변경 시 저장소와 에디터 이력을 함께 비운다. `pagehide` keepalive 반납, BFCache 복귀의 새 편집권 획득과 `편집 권한 다시 요청`을 제공한다. 네트워크 손실로 반납에 실패하면 서버 lease 만료를 기다리며 다른 탭의 편집권을 강탈하지 않는다.
- 두 층 실제 API/PostgreSQL/Redis/MQTT 브라우저 E2E는 신규 미배치 등록, 드롭·저장·새로고침, 층 전환 취소/승인, 배치 해제 취소/승인/Undo, 모니터링 마커 분리, 미배치 조명 70% 제어 완료, 통계 대상 보존과 재배치까지 1개 통합 시나리오로 검증했다(2026-09-10, 43.9초). RF/장비 상태 송신은 테스트 전용 simulator이며 실제 BLE/LED 증거가 아니다.

- 등록 조명 위치 확인용 `POST /floors/:floorId/fixtures/:fixtureId/identify`와 전용 MQTT command/result를 구현했다. 현장 admin·현재 편집 lease·등록/연결 상태를 확인하고 10초 절대 만료와 게이트웨이별 단일 대상을 강제한다. 시작 시 lease 잔여가 10초 미만이면 갱신이 필요하다. 실제 Health Attention Status만 장비 응답으로 인정하며 PUBACK·응답 누락은 성공으로 표시하지 않는다. 정확한 session 중지, 오래된 중지/시작·중복·재시작 직후 명령 차단과 제한 시간/종료 정리를 포함한다. API/실DB·Redis 17개와 Gateway 관련 12개를 독립 재실행했다. 웹의 시작/중지/다음/건너뛰기/재시도와 명시적 위치 확인을 연결했다. ACK와 사람이 확인한 위치는 구분한다. 실제 broker/RF/LED 식별 검증은 후속이다.

- 층별 배치 상태를 `Fixture.placementStatus`와 `positionVerifiedAt`으로 분리했다. 신규 등록은 미배치, 기존 조명은 좌표를 보존한 배치/위치 미확인 상태다. 에디터는 미배치를 포함한 전체 조명과 검색용 시리얼/Mesh 주소를 반환한다. 배치 해제와 좌표 변경은 위치 확인만 무효화하며 장비·그룹·자동화·통계 정보는 유지한다. 새 snapshot V2와 기존 V1 복구를 함께 지원한다.
- 에디터 저장/복구를 묶음 SQL로 처리하고 JSON 요청 한도를 에디터 PUT에만 1 MiB로 확장했다. 초과는 413, 충돌은 409, transaction 만료는 503으로 구분한다. 실제 정격 W 변경에만 에너지 checkpoint를 생성한다. 격리 DB/HTTP 18개 회귀와 조명 1,000개·도형 2,000개 100회 저장을 통과했다. 관련 migration과 이번 `gridSize` migration은 로컬 개발 DB에 적용했으며 운영 DB에는 배포 절차의 백업·사전 검증을 거쳐 적용한다.

- 등록 후 위치 확인의 펌웨어 출력 단위를 보강했다. Health Attention은 자체 만료되며 명시적 중지·재시작에 대응한다. 식별 중 수동/자동제어의 최신 밝기 목표를 보존해 종료 후 복귀하고, 지연된 timer callback이나 PWM 오류 후 재시도가 새 요청을 덮어쓰지 않는다. Host 12개 시나리오·portable 테스트와 ESP-IDF 빌드를 통과했으며 API/Gateway/웹 통합은 진행 중이다. 실제 조명의 점멸·가시성 검증은 후속이다.

- 최초 setup, Gateway claim, 등록 대상·일괄/개별 form의 input/select와 checkbox/radio label은 390px·320px에서 연속 44×44px 이상 도달 가능한 영역을 제공한다. Chromium commissioning helper는 기본 일괄 form을 개별 mode 전환 전에 검사하고, 전환 뒤 개별 form도 별도로 검사하며, 버튼 외 모든 enabled interactive control을 스크롤한 뒤 viewport·overflow clipping과 실제 hit-test occlusion까지 확인한다.
- 조명 등록 `ProgressSteps`는 검색·등록 정보·장비 등록·상태 확인을 전체 session status union의 단일 상태 머신으로 표현한다. `completed`·`cancelled` terminal에는 current가 없고, session-level `failed`는 scan/node 도달 상태로 실패 단계를 정한다. 서버 transport 오류는 원시 API 값을 유지한 채 공통 표시 전용 mapper로 자연스러운 한국어 문구를 제공한다.
- 설정 상단 탭은 공통 `UnderlineNavigation`을 사용한다. `nav aria-label="설정 메뉴"` 안의 일반 링크로 구성하고 현재 route에만 `aria-current="page"`를 제공하며, `siteId`를 포함한 query와 hash를 모든 탭 이동에서 보존한다.
- dirty 맵 편집 중 설정 상단 탭을 선택하면 기존 dirty navigation guard를 그대로 통과한다. 취소하면 editor·draft와 현재 탭 focus를 유지하고, 확인하면 선택한 설정 route에 동일한 `siteId`와 hash를 보존해 이동하며 draft를 폐기한다. 390px/320px 실제 브라우저 회귀는 real draft 변경, cancel/confirm, 승인 직후와 editor 복귀 뒤 history state의 sentinel 제거, back/forward 왕복 및 추가 clean logout이 폐기 확인 없이 완료되는 계약을 검증한다.
- 설정·맵 편집 화면은 1440×900, 1024×768, 390×844, 320×740에서 overflow와 패널 배치를 고정한다. 1024px 및 390px/320px의 설정 개요·admin 비밀번호 화면과 viewer security guard, 모바일 floor asset·속성 필드·revision action을 실제 route에서 검증한다. 설정 상단 탭은 모바일에서 가로 스크롤하며 직접 URL로 진입해도 현재 탭을 자동으로 화면 안에 노출한다. 760px 이하의 공통 helper는 root 아래 interactive element 중 disabled/hidden, `.sr-only`/`aria-hidden`, `display`/`visibility`/`opacity`로 숨긴 조상을 제외하고 현재 viewport 및 실제 overflow clip과 교차하는 effective target을 검사한다. usable intersection을 1 CSS px 이하 cell로 나누고 각 cell 중앙 hit sample이 target 또는 그 descendant인 연속 44×44px 후보가 하나 이상일 때만 통과하며, 부분·완전 occlusion은 정상 peer가 있어도 실패한다. checkbox/radio는 모든 associated label과 input fallback 중 이 조건을 만족하는 후보를 사용한다. viewport-fixed target은 transform/filter/perspective 등 fixed containing block을 만드는 조상이 있을 때만 ancestor overflow clip을 적용한다.
- 주 메뉴의 설정 항목은 입력 방식과 화면 크기에 관계없이 query string과 hash를 유지한 `/settings` 개요로 이동한다. 하위 화면 전환은 설정 본문의 상단 탭에서 수행한다.
- 설정 본문의 내부 `설정 메뉴` 사이드바를 제거하고 현장 선택기를 수평 context row에 유지했다. 기존 현장 전환 dirty 확인 및 editor store 폐기, 상세 route와 `siteId` query 보존 계약은 그대로 유지한다.
- 설정 탭에는 역할별로 승인된 화면만 노출한다. admin은 `설정 개요`, `현장 관리`, `유저 관리`, `조명 등록`, `맵 관리`, `계정 보안`을 사용하고 viewer는 `설정 개요`, `맵 관리`, `계정 보안`을 사용한다. viewer의 맵 관리는 읽기 전용이다. 기존 미구현 placeholder 메뉴와 customer 설정의 operator 노출은 제거했다.
- Scene 24 설정 개요는 현재 dashboard/role/route 데이터만 사용해 `현장 정보`, `층·도면`, `Gateway 상태`, admin 전용 `계정·보안` 카드를 표시한다. 맵 관리와 계정 보안 action은 실제 route 링크이고 현재 `siteId` query와 hash fragment를 보존한다. firmware와 마지막 변경 시각처럼 현재 API가 반환하지 않는 값은 표시하지 않는다.
- operator가 만든 pending Site는 assigned admin이 customer route에서 `/settings?siteId=...`로 replace된 최초 설치 UI에서 address, tariff, timeZone, floors로 완성한다. CustomerShell은 installationStatus 확인 전 child route를 fail-closed하고, `POST /setup/initial-site`에는 `{ siteId, address, tariffKwhRate, timeZone?, floors }`만 전송한다. 성공하면 정확한 dashboard key를 갱신하고 dashboard prefix를 invalidate한다. Task 9 격리 실백엔드 E2E는 이 흐름과 password 교체 후 이전 비밀번호 실패/새 비밀번호 로그인을 검증했다. 재설치와 모바일은 범위 밖이고 Raspberry Pi/ESP32-H2 HIL은 미실행이다.
- 설치 완료 뒤 admin은 admin 전용 `/settings/registration`에서 Gateway claim 또는 조명 등록을 수행할 수 있다. 모니터링은 등록 0개 상태에서도 이 mutation UI를 렌더링하지 않는다. viewer는 claim, registration, setup mutation UI를 보지 않고 operator는 전용 shell 때문에 customer 설정에 진입하지 않는다.
- Scene 04~09 설치·Gateway claim·조명 검색·일괄/개별 등록·상태 확인 화면은 공통 `Card`, `Button`, `StatusBadge`, `FeedbackState`, `ProgressSteps`로 정보 위계를 표시한다. 초기 설치는 현장 정보부터 운영 시작까지, 등록은 검색·등록 정보·장비 등록·상태 확인 단계를 실제 session 상태로 표현한다.
- 설치·claim·registration UI는 기존 실제 setup/claim/registration API payload, query key, mutation, active session polling·복구와 cache invalidation을 그대로 사용한다. `reconcile_required` 노드는 기존 명시적 확인·제외·상태 재조회 흐름을 유지하며 viewer와 operator에는 mutation UI를 노출하지 않는다.
- Ethernet, mTLS, 장비 online 같은 prototype 전용 사전 점검은 현재 API가 제공하지 않아 구현하지 않았다. `calm-operations-commissioning.spec.ts`의 browser fixture는 화면·API route 계약 검증일 뿐 Raspberry Pi/ESP32-H2 hardware-in-the-loop 증거가 아니다.
- Scene 26 비밀번호 변경은 현재/새/확인 비밀번호, 기존 최소 8자 검증, 확인 불일치, 정확한 현재 비밀번호 오류, 일반 오류와 중복 제출 차단을 공통 danger/success feedback으로 표시한다. 평문 비밀번호는 React Query mutation/cache에 넣지 않고 component-local state와 요청 본문에만 두며, 성공 또는 화면 이탈 시 제거하고 실패 시 재시도 입력을 유지한다. 성공 시 모든 기존 세션을 폐기하고 현재 접속은 새 토큰으로 회전해 화면 흐름을 유지한다. 웹은 회전 직후 해당 principal의 세션 목록을 다시 조회한다.
- `/settings/security`는 기존 비밀번호 변경과 operator/admin의 MFA 상태·등록·확인·해제, 모든 역할의 활성 세션 조회·개별 종료·다른 세션 전체 종료를 실제 인증 API에 연결한다. operator는 기존 현장 관리자 화면과 분리된 `/operator/security`에서 같은 `AccountSecurityView`를 사용한다. 현재 세션을 표시하고 종료 전 확인하며 loading/empty/success/error와 `aria-live` 피드백을 제공한다.
- 현재 세션 종료는 먼저 principal query를 취소한 뒤 서버 상태를 재확인하고 인증·tenant cache를 모두 제거한다. 이미 회전돼 폐기된 쿠키로 로그아웃해도 서버는 같은 세션 계열의 활성 후속 세션을 폐기하고 쿠키를 지운다.
- MFA 비밀키·TOTP·복구 코드·비밀번호는 component-local state와 요청 본문에만 두고 React Query cache에 저장하지 않는다. MFA와 세션 query key에는 `userId:organizationId` principal을 포함하며 계정 전환 시 보안 입력 화면을 remount한다. mutation 응답도 요청 당시 principal과 현재 `auth/me`가 일치할 때만 해당 principal key를 갱신해 이전 계정의 지연 응답이 새 인증 cache를 변경하지 못한다.
- Scene 25~26 도면 목록과 편집 route의 편집 가능 역할은 assigned admin만이다. admin은 등록/편집 action을 사용하고 viewer는 neutral `읽기 전용` 상태와 저장된 도면만 보며, operator는 customer shell을 mount하지 않는다. 편집기는 도구 rail·canvas·속성·버전 region을 유지하고 lease 상실은 읽기 전용 warning, `409`는 강제 덮어쓰기 없이 `최신 버전 다시 불러오기`만 제공한다.
- 맵 editor의 lease token/fence heartbeat와 fail-closed deadline, atomic save, dirty confirm/cancel 및 browser history sentinel, revision 조회·복구, asset upload 중 save/restore lock은 기존 상태와 callback을 그대로 사용한다.
- `POST /setup/initial-site`는 assigned active customer `admin`만 `{ siteId, address, tariffKwhRate, timeZone?, floors }`로 호출할 수 있다. transaction 안에서 target Site row를 `FOR UPDATE`로 잠그고 assigned admin 및 pending 상태를 재검증한 뒤 기존 Site와 Floors/FloorPlan만 갱신한다.
- 최초 설치는 Organization, Site, SiteMembership을 새로 만들지 않으며 주소·단가·층 중 하나라도 없으면 `pending`, 모두 있으면 `installed`다. 재호출과 Serializable 충돌은 `409`로 반환한다.
- `POST /setup/floors`도 assigned admin의 `commission` capability를 요구한다. 기존 floor 이름·level 중복과 floorPlan 생성 검증은 유지한다.
- `POST /gateways/claim`과 모든 `registration-sessions` route는 `admin` controller role 및 service의 active customer admin + 대상 Site `commission` 검사를 함께 적용한다. registration mutation은 create body 또는 저장된 session의 `siteId`를 권위 데이터로 사용해 transaction 첫 단계에서 Site를 잠그고 권한을 재검증하며, 이후 공통 `Floor -> Gateway -> Session -> Node -> DeviceOutbox/EventLedger` 순서로 필요한 행을 잠근다. Publisher의 `SKIP LOCKED` lease claim은 별도 짧은 transaction에서 끝내고 domain mutation은 lease CAS와 공통 순서로 다시 검증해 outbox-first deadlock을 만들지 않는다. get은 read-only service 권한 검사만 수행한다. 등록 전 identify는 빈 body만 허용하고 같은 transaction에서 active session, 완료된 최신 scan, 같은 Site의 healthy Gateway와 발견 node를 다시 검증한다.
- Gateway firmware version은 사용자 입력이 아니라 heartbeat로 자동 갱신한다.
- 현장 일반 유저 영구 삭제는 관계형 요청자 FK만 익명화하지 않고, 해당 사용자의 command-dispatch MQTT outbox에서 legacy `requestedBy`를 같은 transaction으로 제거한다. 초대 가입 계정은 조직·현장·정규화 이메일이 일치하는 수락 완료 Invitation도 함께 삭제하며, 미수락·다른 범위 초대와 이메일이 없는 admin 직접 생성 계정은 보존한다. 실제 PostgreSQL 회귀는 pending outbox의 requester 부재와 후속 발행, 초대 PII 범위 삭제를 검증한다.
- 설정 개요에 현장 정보, 층·도면, Gateway 상태, admin 계정·보안을 구분한 실제 데이터 카드와 route action을 제공한다.
- Gateway 이름, 시리얼과 온라인·오프라인 상태를 실제 dashboard 응답으로 표시한다.
- 현재 BIO 실험 Gateway는 DHCP로 받은 자기 IP를 서버에 고정 저장하지 않고 outbound MQTT를 1초 주기로 재연결하므로, 같은 endpoint에 도달할 수 있는 Ethernet 포트/IP 변경은 자동 복구할 수 있다. 2026-09-15 Lab 망 이동에서는 서버 `172.30.1.89`, Pi Ethernet `172.30.1.25`로 API/MQTT service certificate IP SAN, Pi hosts, 저장 assignment와 bootstrap URL을 갱신하고 기존 claim·device/MQTT identity·BIO mapping을 유지한 채 runtime을 재생성했다. Gateway `healthy`, 연속 heartbeat와 Web 70%·0%·100%·30% 제어 read-back을 확인했다. 현재 Lab endpoint는 DHCP IP이므로 공유기 예약이 없으면 다음 주소 변경 때 같은 복구가 필요하며, 현장망 이동을 상시 지원하려면 공인 DNS/TLS endpoint 또는 VPN 주소를 사용해야 한다.
- 등록 패널은 층과 Gateway를 명시적으로 선택해 `siteId`, `floorId`, `gatewayId`를 전송하고 BLE Mesh 후보·provisioning 요청을 제공한다. 설치 완료 assigned admin에게만 노출되며 viewer와 operator는 볼 수 없다. Task 9 격리 실백엔드 E2E는 0건 검색, 재검색, 자사 node 2개 일괄 등록을 검증했다. API는 Gateway heartbeat가 정확히 90초 전인 경우까지 fresh로 허용한다.
- provisioning 완료 이벤트로 `MeshNode`와 `Fixture`를 만들고 실패 이벤트의 사유를 저장한다. 일반 BLE Mesh의 새 Fixture는 `offline + provisioning_waiting_state`로 만들며 첫 실제 fixture-state 전에는 online/fault, 밝기, lastSeenAt을 확정하지 않는다. BIO의 `completed` terminal은 Gateway adapter가 동일 `bio:<12-hex>` UUID를 새 주소에서 다시 발견한 뒤에만 만들 수 있으므로, BIO Fixture에 한해 그 완료 시각과 RSSI/hop count를 마지막 통신 증거로 저장하고 즉시 `online`으로 전환한다. sensor 모드의 순간 출력은 terminal에 없으므로 `brightness=0`, `powerOn=null`을 유지하며 첫 수동 제어의 SET/GET read-back이 실제 출력 상태를 갱신한다. 다른 현장 UUID 재사용 또는 `MeshNode.deviceUuid` unique 경쟁만 해당 node 실패로 기록하며, 다른 unique/transaction 오류는 재전파한다.
- BIO 최초 등록에서 모듈의 기존 logical address와 서버가 예약한 unicast address가 같으면 주소 SET을 다시 보내지 않는다. Gateway는 fresh scan에서 정확한 UUID가 그 주소를 단독 점유하고 다른 UUID 충돌이 없을 때만 같은 주소를 `confirmed`로 수렴한다. 장치 미발견·주소 공유는 기존대로 `unknown` 또는 충돌로 거부한다. 이는 DB를 초기화해도 모듈의 비휘발성 주소는 남을 수 있는 현장 조건을 지원하면서 불필요한 제조사 주소 write를 피하기 위한 예외다.
- direct USB 등록이 끝난 BIO 조명은 제조사 앱이 필요 없다. Gateway mapping journal의 `confirmed` UUID/native UUID/logical address 조합만 주기 polling 대상이며, 단순 scan 결과나 미확정·주소 불일치 mapping에는 GET도 보내지 않는다. 한 pass는 scan 뒤 high-brightness GET과 control-mode GET만 보내고 `assignAddress`, 밝기·모드 SET, identify 또는 sensor 복원을 호출하지 않는다. BIO의 0x12 report에는 독립 transaction ID가 없으므로 scan 시작 ACK부터 discovery 수집 window와 stop ACK까지 전역 operation queue 소유권을 유지한다. 전체 polling과 targeted 재조회가 겹쳐도 다른 GET/SET은 stop ACK 뒤에만 wire로 나가며, scan 내부에서는 queue 재진입 대신 소유된 direct send를 사용한다. 실패 report에는 공개 가능한 안정된 error code별 건수만 선택적으로 포함하고 UUID·주소·raw packet·exception message/stack은 넣지 않는다. GET 응답 실패와 USB transport 폐기 실패가 `AggregateError`로 함께 전달된 경우에도 내부의 안정된 code를 재귀적으로 각각 집계해 바깥 generic 오류가 실제 `TIMEOUT` 등을 가리지 않는다. code가 없는 native 오류는 원문 대신 `BIO_RESYNC_DISCOVERY_FAILED`, `BIO_RESYNC_BRIGHTNESS_READ_FAILED`, `BIO_RESYNC_MODE_READ_FAILED`처럼 실패한 최소 단계만 표시한다. 따라서 현장 health 로그로 원인을 구분하면서 장치 식별 정보와 vendor frame 노출은 피한다.
- BIO Mesh 설정에서 API가 사용하는 MeshNode ID는 등록 후보에서 이어진 Fixture ID와 별도 UUID다. Gateway는 이 둘을 동일 ID로 합치거나 별도 alias DB를 만들지 않고, confirmed BIO logical address를 공통 하드웨어 키로 사용해 층·구역 virtual membership의 Fixture ID를 복원한다. `bio_mapping_not_confirmed`는 해당 주소에 confirmed mapping이 없을 때만 반환하며, 다른 Fixture를 대상으로 한 그룹 제어는 membership 검사에서 RF 전송 전에 거부한다. 실제 ID가 다른 software 회귀를 추가했고, 2026-09-14 Raspberry Pi에서 기존 실패 그룹을 재동기화한 뒤 층·구역 제어가 실제 BIO 조명에 모두 반영되는 HIL을 완료했다.
- 제조 장비 원장 기반 `POST /gateways/claim`은 assigned active customer admin만 수행한다. claim은 serial trim 정규화 뒤 serial별 PostgreSQL transaction advisory lock으로 같은 serial 시도를 직렬화하고, 같은 transaction에서 Site 잠금 재검증, 15분 실패 횟수 판정, terminal audit, inventory 잠금과 단회 claim-code 소비를 완료한다. invalid·unavailable·already-consumed·rate-limited·success를 모두 commit한 뒤 기존 정제된 `401/409/429`로 변환하며 claim code와 내부 reason을 응답에 노출하지 않는다. 다른 serial은 전역 잠금을 공유하지 않는다. device-certificate 기반 `POST /gateway-bootstrap`과 manufacturing enrollment 경계는 바꾸지 않았다.
- `POST /gateway-inventories/:inventoryId/disable`은 제조 보안 동작으로 active service-provider `operator`만 수행하며 customer SiteAccess를 요구하지 않는다. 최초 device 발급·MQTT 발급·renewal·activation과 공통 inventory 잠금을 사용하고, 같은 commit에 disabled 상태·인증서 `revocation_pending`·두 device pointer 제거·영속 폐기 원장을 저장한다. commit 뒤 CA/CRL worker가 폐기하며 외부 장애에도 원장을 재시도한다. Site 삭제도 같은 staging을 거쳐 Gateway cascade 뒤 폐기 의무를 유지한다. 별도 disposable PostgreSQL 16에서 양방향 경쟁 16개와 기존 manufacturing → claim → bootstrap → MQTT 및 revoked/disabled E2E 2개를 통과했다. PostgreSQL lock·transaction·원장 저장은 실제이고 CA·CSR·CRL 파일 배포는 fixture다. 이번 변경은 software/API 신뢰성 보완이며 설정 화면이나 사용자 action을 새로 추가하지 않았다. 사용자 DB migration, 실제 Vault/CRL 배포와 장비/HIL 검증은 미실행이다.
- Claim 성공과 invalid·unavailable·already-consumed·rate-limited terminal 결과를 모두 감사하며, 병렬 invalid 요청도 serial별 선형화 경계에서 최대 5회의 비싼 claim-code 검증만 수행한다.
- 업그레이드 전 이미 `revoked`이지만 CRL 완료 원장이 없는 인증서도 inventory disable/revoke 재시도에서 회수한다. 기존 상태·폐기 시각은 보존하고, CA/CRL 정리가 실패하면 같은 영속 원장을 재시도하며 완료 뒤 중복 작업을 만들지 않는다. 실제 lifecycle·reconciliation과 전용 PostgreSQL을 연결한 legacy 회귀를 포함해 통합 17개와 기존 PKI E2E 2개를 통과했다. 사용자 DB backfill이나 실제 CA/CRL 배포는 수행하지 않았다.
- Raspberry Pi appliance가 실제 BlueZ scan/provisioning adapter와 영속 Mesh identity를 사용한다.
- 실제 Gateway MQTT scan 이벤트만 후보로 저장하며 런타임 mock 검색 경로는 제거했다.
- 실제 Gateway scan은 shared DFK product identity 계약을 통과한 ESP32-H2 UUID만 등록 후보로 반환한다. UUID 필터는 제품 식별용이며 제조 원장, claim과 Gateway mTLS 인증을 대체하지 않는다.
- 검색된 BIO 조명의 `식별`은 주소를 예약하거나 `MeshNode`/`Fixture`/mapping을 만들지 않고 전용 durable outbox에 정확히 한 번 접수한다. Gateway가 vendor BIO 명령으로 약 2초간 force-on한 뒤 sensor mode 복원을 확인해야만 `confirmed`가 되며, 복원 미확인·장비 오류·15초 결과 timeout은 발견 행의 명시적 실패 사유로 표시한다. 중복 클릭/재전송은 같은 operation을 반환한다. Web은 mutation의 `operationId`를 보존하고 node의 `identifyOperationId`/`identifyOperationStartedAt`/`updatedAt`로 현재 요청과 최신 revision의 terminal만 수용한다. 이전 요청의 지연 `confirmed|failed`는 새 retry를 완료하지 못하며 polling을 계속한다. API는 node와 최신 outbox 소유권을 같은 읽기 snapshot에서 조회한다. timeout 뒤 정상 등록·주소 배정이 끝나도 이전의 정확한 terminal은 ledger/ACK만 기록하고 node/session/Fixture/mapping을 변경하지 않는다. 식별 진행 중에는 재검색·주소 예약/등록·세션 완료·취소를 거부해 terminal과 lifecycle 변경을 직렬화한다. 표준 BlueZ adapter는 provisioning 전 식별을 지원하지 않아 명시적 실패가 정상이며, 실제 BIO HIL 재검증은 배포 후 후속이다.
- identify 결과 timeout의 cutoff는 Prisma가 바인딩하는 `TIMESTAMPTZ`를 UTC `TIMESTAMP WITHOUT TIME ZONE`으로 명시 변환한 뒤 `publishedAt`과 비교한다. DB 세션이 `Asia/Seoul`이어도 방금 발행한 명령을 9시간 지난 것으로 오판하지 않는다. 2026-09-14 실제 BIO HIL에서 수정 전에는 발행 약 1초 뒤 실패했지만 Gateway 저널에는 `completed/restoreConfirmed=true`가 남았고, 수정 후 같은 2초 점등·sensor 복원 실행이 Web `식별 완료`와 DB `identifyState=confirmed`로 수렴함을 확인했다.
- 층별 자동 조명 이름 순번과 게이트웨이별 Mesh unicast 주소를 PostgreSQL 소유 행 잠금으로 원자 예약하는 기반을 구현했다. Mesh 주소는 `0x0001~0x7fff` 범위를 벗어나면 등록을 거부한다.
- 일괄·개별 조명 등록 API는 유효한 node만 원자 예약하고 node별 검증 실패를 분리한다. 신규 조명은 지도 공간과 무관하게 미배치로 등록한다. 구버전 placement 입력은 호환 수신하되 좌표로 적용하지 않는다. 불명확한 provisioning 결과는 `reconcile_required`로 격리한다.
- 조명 등록 화면의 검색 node 개별/전체 선택, 일괄·개별 설정 전환과 선택 조명 등록은 설치 완료 assigned admin의 commissioning UI로 노출된다. viewer와 operator에는 mutation UI를 노출하지 않는다. Task 9 software E2E는 production API와 test-support MQTT publisher 경로를 검증했고 shared `parseDfkDeviceUuid`로 invalid/타사 UUID 1개가 scan-found에서 제외됨을 확인했다. 실제 BlueZ/RF Gateway scan과 Raspberry Pi/ESP32-H2 HIL은 미실행이다.
- 검색 결과는 서버가 `deviceUuid` 기준으로 미등록, 같은 현장 등록, 다른 현장 등록 상태를 분류한다. 미등록 장치만 기본 후보와 전체 선택·등록 payload에 포함하고, 이미 등록된 장치는 접힌 `기존 등록 조명` 영역으로 분리한다. 같은 현장 장치는 조명명·층 정보를 표시하지만 다른 현장 장치는 수량과 일반 안내만 표시해 타 현장 식별 정보를 노출하지 않는다. 구버전 또는 알 수 없는 분류값은 등록 대상에서 fail-closed로 제외하되 진행 중이거나 복구가 필요한 node는 식별 정보를 숨긴 복구 행으로 유지한다.
- 등록 API는 화면 필터를 신뢰하지 않고 provisioning 예약 직전에 동일 `deviceUuid`의 기존 `MeshNode`를 다시 확인한다. batch 등록과 provisioning terminal 완료가 같은 PostgreSQL advisory lock을 사용해 동시 요청도 하나만 성공하며, 같은 현장과 다른 현장 중복은 각각 안정된 오류로 거부한다. 이번 변경에는 DB schema/migration이 없고 실제 Raspberry Pi/ESP32-H2 재검색 HIL은 후속 검증이다.
- Konva 에디터의 사각형·삼각형·선·텍스트, 색상, 이동, 크기 변경, 조명 정보·위치 편집과 확대·축소를 유지한다. 신규 도면은 DWG/DXF CAD 가져오기만 제공하며 PNG/JPG 업로드·교체·연결 제거 패널은 제거했다. 기존 ready image/PDF/rendered SVG 자산의 인증 조회 호환은 유지한다.
- 맵 편집기 toolbar와 revision 복구 icon action은 desktop과 760px 이하 layout에서 표시·동작을 검증한다. 760px 이하에서는 선택 fixture의 조명명·정격 전력·X/Y·크기 property input과 revision 복구를 포함해 위 helper 정의에 해당하는 control의 실제 usable intersection이 최소 44×44px를 유지한다. 360px 이하 toolbar는 3열로 wrap해 마지막 action이 가로 clip에 걸리지 않게 한다.
- 설정 에디터와 모니터링 읽기 전용 지도는 `FloorMapObjectNode`의 사각형·삼각형·선·텍스트 geometry를 공유한다. Transformer, drag와 변경 callback은 설정 에디터에서만 활성화한다.
- DWG/DXF CAD 원본을 S3 호환 저장소에 저장하고 worker가 만든 rendered SVG의 인증 접근 경로를 도면에 연결한다. 기존 ready image/PDF/rendered SVG ledger row는 인증 조회·다운로드 호환을 유지하지만 image/PDF 신규 upload intent는 API에서 거부한다.
- `owner`를 제거하고 `operator/admin/viewer` 3단계 역할과 서비스 운영사/고객사 Organization 유형을 Prisma schema에 적용했다. legacy migration은 현장 유무로 서비스 운영사를 추론하지 않으며 기존 Organization을 모두 customer로, legacy owner/operator와 invitation을 admin으로 유지한다.
- 기존 viewer가 고객사 현장 조회 권한을 유지하도록 `SiteMembership`을 비파괴 migration에서 backfill한다.
- invitation signup은 viewer 초대 전용 호환 API다. `{ token, loginId, email, name, password }`에서 `Invitation.email`은 연락 이메일과만 비교하고 정규화한 `loginId`를 별도 로그인 식별자로 저장한다. 공개 signup UI는 Task 6에서 제거했으며 API 호환만 유지한다. operator/admin invitation signup은 거부하며 viewer는 자기 고객사 Organization에 속한 유효한 `Invitation.siteId`의 membership을 transaction으로 생성한다.
- operator site-admin 관리 API는 `GET/POST /operator/site-admins`, `POST /operator/sites/:siteId/admin`, `PATCH /operator/site-admins/:userId`, `POST /operator/site-admins/:userId/reset-password`, `DELETE /operator/site-admins/:userId`를 제공한다. 생성·교체·수정·비밀번호 재설정·삭제는 active service-provider operator만 호출할 수 있다. 삭제 command와 dialog는 관리자 삭제가 아니라 `현장 전체 삭제`로 표시하며, body의 `confirmationSiteName`이 현재 현장명과 정확히 일치해야 한다. 서버는 같은 DB transaction에서 GatewayInventory를 비활성화하고 `SiteDeletionCleanup` 작업을 생성한 뒤 Site 소유 데이터 전체를 cascade 삭제한다. 고객사에 남은 현장이 없으면 admin·viewer 세션, 사용자, 초대와 customer Organization도 삭제한다. 삭제할 사용자를 먼저 잠가 동시 로그인 세션 생성을 차단한다. 커밋 뒤 cleanup worker가 Gateway 인증서를 즉시 폐기하고, 기존 presigned upload URL이 만료된 뒤 도면 원본 파일을 삭제한다. 외부 정리 실패는 lease와 지수 backoff로 재시도한다. 다른 Gateway에 claim된 인증서 inventory가 연결된 비정상 데이터는 `409`로 중단해 타 현장 장비를 보호한다. 제조 장비·인증서 원장, 완료된 cleanup 작업과 service-provider 감사 로그 `operator.site_deleted`는 보존한다. 비밀번호와 hash는 응답 및 audit metadata에 포함하지 않는다. operator 전용 웹 목록은 이 여섯 endpoint를 소비한다. create/assign/reset의 평문 비밀번호는 React Query cache, API response 또는 완료 안내에 저장하지 않고, 성공 또는 사용자가 dialog를 닫을 때 component input state에서 제거한다. 실패 뒤 열린 dialog의 입력은 재시도를 위해 유지한다. `ApiError.body.message`가 정확히 `loginId already exists`인 409만 loginId field 오류와 focus로 연결하고, serialization 등 다른 409는 재시도 alert로 표시한다.
- operator 초기/reset 비밀번호 입력은 서버와 같은 최소 8자를 client에서 검사하고 서버의 password-policy `400`도 field alert로 표시한다. 현장 삭제 dialog는 현장명을 정확히 입력하기 전 `영구 삭제` 버튼을 비활성화하고, 성공 뒤 제거된 행 대신 안정적인 `현장 및 관리자 생성` command로 focus를 복원한다. API/Web 단위 테스트와 실제 PostgreSQL 통합 테스트로 고객사·현장·계정·세션 삭제를 검증한다.
- `PUT /floors/:floorId/editor-state`는 `Floor.mapRevision` optimistic update, normalized row 변경, canonical `FloorMapRevision` snapshot/SHA-256과 `floor_editor.saved` 감사를 하나의 Serializable Prisma transaction으로 저장한다. fixture/object의 층 소속, 중복 ID와 준비되지 않은 asset은 optimistic mutation 전에 거부한다.
- `GET /floors/:floorId/editor-revisions`는 현장 `read`, `POST /floors/:floorId/editor-revisions/:revision/restore`는 `manage` 권한을 요구한다. 복구는 `expectedRevision` 충돌을 `409`로 처리하고, 사라진 fixture를 생성하지 않고 `skippedFixtureIds`로 반환하며 새 revision과 `floor_editor.restored` 감사를 같은 transaction에 남긴다.
- atomic save의 `floorPlan: null`만 배경 삭제를 뜻한다. non-null image/pdf는 source type, ready asset을 가리키는 non-empty `imageUrl`/`originalFileUrl`/`renderedImageUrl`, 양수 INT4 width/height를 모두 포함해야 하며 부분 create/default 값 우회는 `400`으로 거부한다.
- legacy `PATCH /floors/:floorId/floor-plan`은 partial request를 기존 row와 merge해 검증한 complete `effective` 전체 상태를 기록한다. 동시 PATCH도 마지막 writer가 검증한 `none` 또는 complete ready image/pdf 상태로 끝나며 row lock이나 별도 transaction에 의존하지 않는다.
- atomic write schema와 persisted snapshot v1 parser를 분리했다. snapshot parser는 기존 `sourceType: none`, nullable floor-plan URL, nullable geometry와 bounded legacy object type을 canonical shape 그대로 읽고 복구하며, 상한 초과 문자열이나 좌표 배열이 아닌 points 같은 위험 데이터는 `400`으로 거부한다.
- shared editor schema는 fixture update 1,000개와 map object mutation 합계 2,000개를 상한으로 두고 ID/이름/URL/text/color/points 크기, INT4 revision/zIndex와 rectangle/triangle/line/text별 dimensions/points 형태를 제한한다. trim, decimal과 object type 의미 정규화는 optimistic update 전에 끝난다.
- object update는 현재 type/width/height/points를 같은 층에서 먼저 조회하고 patch를 merge한 완성 geometry를 type별 schema로 검증한 뒤에만 optimistic revision을 증가시킨다. restore는 floor `manage` SiteAccess의 opaque `404`를 먼저 적용하고, 권한 확인 뒤 service에서 path revision을 positive INT4로 검증해 authorized invalid path만 `400`으로 반환한다.
- revision 목록은 `cursor`와 `limit`(기본 20, 최대 100)을 사용한다. 응답 actor는 같은 고객사 이름 또는 교차 조직의 `서비스 운영자` display name만 포함하며 user/revision 내부 ID와 email을 노출하지 않는다.
- revision snapshot/hash는 ID canonical order를 유지하지만 GET/save/restore editor state의 object 배열은 canvas 계약에 맞게 `zIndex`, `createdAt`, ID 순으로 안정 정렬한다.
- bootstrap은 기존 customer 사용자가 있어도 `auth:bootstrap-operator`로 최초 service-provider operator를 만들 수 있다. `BOOTSTRAP_OPERATOR_LOGIN_ID`는 필수이며 잘못된 기존 email 환경 변수로 fallback하지 않는다. PostgreSQL advisory lock, 기존 service provider/operator 검사, `service_provider` partial Unique index로 둘 이상의 서비스 운영사를 차단하며, 로그인/session 응답은 `loginId`와 Organization 유형을 포함한다.
- `POST /auth/login`은 `{ loginId, password, rememberMe }`만 받고 public/session 응답은 연락 이메일 없이 `loginId`만 계정 식별자로 포함한다. `POST /auth/change-password`는 현재 session cookie를 기준으로 현재 세션을 유지하면서 동일 사용자의 다른 활성 세션을 revoke하고, 공백을 포함한 비밀번호 원문을 trim하지 않는다. login/signup/change-password body는 누락·non-string 값을 controller에서 명시적으로 거부해 500으로 흘리지 않는다. 성공 감사 `auth.password_changed` metadata에는 비밀번호 또는 hash 계열 값을 기록하지 않는다.
- login은 User row를 `FOR UPDATE`로 잠근 transaction 안에서 status, organization과 password hash를 다시 읽고 검증한 뒤 Session을 생성한다. operator reset과 self change는 같은 User lock 순서를 사용하고 이후 활성 세션을 revoke하며, 실제 PostgreSQL barrier 회귀가 old credential session이 reset/change commit 뒤 남지 않음을 검증한다. Web login은 React Query mutation을 사용하지 않고 성공 직전에 이전 principal의 Query/Mutation cache를 비운 뒤 반환된 `auth/me`를 직접 설정한다. 강제 session revoke는 tenant cache를 제거한 뒤 로그인 화면으로 전환하고, 다른 탭의 로그인으로 `auth/me`가 A에서 B로 성공 전환되면 고객 shell 렌더 전에 이전 Query/Mutation cache를 제거한다.
- 일반 admin 영속 write는 외부 SiteAccess precheck를 UX 최적화로만 사용한다. dimming command create, fixture-group create/update/delete/resync와 floor-editor save/restore는 transaction 첫 단계에서 Site row를 잠그고 assigned active customer admin을 다시 확인하며, reassignment/disable race는 실제 PostgreSQL 회귀로 차단한다.
- 수정 전 legacy migration을 적용한 로컬 개발 DB는 checksum 충돌이 발생할 수 있다. 데이터가 불필요한 경우에만 reset을 선택하고, 보존이 필요하면 감사 후 수동 보정 migration을 사용한다. 설정 기능은 자동 reset이나 파괴적 DB 명령을 실행하지 않는다.
- **폐기된 Task 4 시점 기록:** 당시 registration session 생성·조회·identify·register·complete는 operator controller 계약이라 새 SiteAccess 완료 경로로 사용할 수 없었다. 현재 Task 5 API는 assigned admin controller/service 이중 검사와 mutation transaction 내부 재검증까지 완료했고, Task 8에서 설치 완료 admin의 웹 commissioning 진입점을 연결했다.
- `GET /floors/:floorId/assets`와 content redirect는 현장 `read` 권한, upload intent와 complete는 `manage` 권한을 확인한다. private bucket의 장기 URL은 응답하지 않고 안정적인 API 경로가 300초 signed GET으로 연결된다. upload intent는 pending 원장을 먼저 커밋하며, 만료된 미완료 자산은 60초 주기 bounded sweeper가 저장소 삭제 실패를 재시도한다. 현장 삭제와 intent 생성은 같은 Site 잠금으로 직렬화한다.
- 주 메뉴를 `/monitoring`, `/control`, `/statistics`, `/settings` URL route와 링크 navigation으로 전환했다. 이 고객 shell은 admin/viewer만 mount하며 선택 현장의 `siteId` query는 주 메뉴와 설정 하위 메뉴 이동에도 유지된다.
- operator는 전용 `OperatorShell`만 mount한다. `/settings`와 하위 경로를 포함한 operator 직접 URL/새로고침은 history replace로 `/operator/site-admins`에 수렴하고 `/sites` 또는 dashboard query를 실행하지 않는다. 현재 route는 header, 로그인 아이디, 로그아웃과 현장 관리자 운영 테이블을 제공한다. dialog는 `role="dialog"`, `aria-modal`, Escape/취소, 최초 focus와 trigger focus 복원을 지원한다. assign/delete 성공처럼 기존 trigger가 목록 refetch에서 제거될 수 있는 경우에는 안정적인 `현장 및 관리자 생성` command로 focus를 복원하며, 작은 화면에서는 표를 가로 스크롤한다.
- `/settings/floor-plans`는 admin/viewer가 새로고침과 직접 진입할 수 있는 층별 도면 목록을 제공한다. assigned admin만 서버 SiteAccess에 따라 실제 편집할 수 있다.
- `/settings/floor-plans/:floorId/edit`는 route param으로 `GET /floors/:floorId/editor-state`를 조회한다. viewer의 직접 edit URL은 목록으로 redirect되고 assigned admin은 편집할 수 있다.
- 웹 에디터는 shared `SaveEditorStateInput` 계약으로 baseline과 현재 상태를 O(n) 비교한다. 1,000개 fixture에서도 실제 변경된 fixture와 floor plan, object create/update/delete만 중복 없이 `PUT /floors/:floorId/editor-state` 한 번으로 전송한다. floor plan의 `null`/`none`, 기본 source type과 fallback asset URL은 API 의미 형태로 정규화해 unchanged 저장을 만들지 않으며 draft object ID는 UUID로 생성한다.
- atomic save와 revision 복구는 하나의 동기 ref lock으로 상호 배제한다. 요청 중 도구, 캔버스, 배경 입력과 속성 입력을 disabled/read-only로 유지하고, 이미 시작된 배경 asset upload가 끝날 때까지 save/restore도 막아 요청 이후 로컬 수정이 성공 응답에 덮이지 않게 한다. 성공 응답은 새 baseline과 `mapRevision`으로 채택하고, 같은 현장/층의 모니터링 `floor-map`·`floor-fixtures` 및 dashboard 캐시에 저장된 배경·맵 크기·도형·조명 배치를 즉시 병합한 뒤 scoped query를 invalidate한다. 네트워크 오류는 현재 편집 상태를 유지하며, `409`는 강제 덮어쓰기 없이 최신 버전 다시 불러오기만 제공한다.
- 버전 패널은 cursor pagination으로 수정자 display name, 시각과 숫자 변경 수 및 `floorPlanChanged`를 합산해 표시한다. loading/error/empty 상태를 구분하고 오류에는 announcement와 재시도를 제공한다. 복구와 편집 UI는 assigned admin만 노출한다. 요청은 baseline의 `mapRevision`을 `expectedRevision`으로 전송하고, 현재 존재하지 않아 건너뛴 조명 안내는 같은 floor query refetch 뒤에도 유지한다.
- dirty 상태에서는 앱 내부 링크 이동, 현장 전환, 브라우저 뒤로 가기, 저장하지 않은 취소와 `beforeunload`를 확인한다. dirty 진입 시 현재 URL과 같은 history sentinel을 추가해 첫 back이 editor route를 벗어나기 전에 확인하며, 취소는 sentinel을 복원한다. 저장 또는 승인된 내부 이동·현장 전환·취소는 sentinel entry를 목적지로 replace하고, 같은 editor에서 clean 상태가 되거나 unmount되면 sentinel을 소비해 back stack에 editor가 중복으로 남지 않는다. listener는 unmount에서 정리하고 저장 후 back에는 폐기 확인을 표시하지 않는다.
- `POST /floors/:floorId/editor-lease`는 Redis key `floor-editor:lease:{floorId}`를 캐시·경합 완화에 사용하지만, 실제 편집 권한의 정본은 PostgreSQL `Floor.editorLease*` 컬럼이다. 획득은 같은 transaction에서 만료 여부를 확인하고 monotonic `editorLeaseFence`를 증가시키며, `editorLeaseTokenHash`, `editorLeaseHolderId`, `editorLeaseHolderName`, `editorLeaseAcquiredAt`, `editorLeaseExpiresAt`를 함께 기록한다. 같은 token의 POST는 이 정본을 연장한 뒤 Redis를 best-effort로 갱신하고, `DELETE`와 강제 해제는 fence를 다시 증가시켜 이전 토큰을 무효화한다.
- assigned admin의 강제 해제는 먼저 durable `floor_editor.lease_force_release_requested`/`attempted` audit을 기록한 뒤, PostgreSQL 정본의 token hash와 fence를 기준으로 successor를 덮지 않도록 무효화한다. operator는 현재 고객 Site capability가 없어 이 API를 사용할 수 없으며, 웹의 operator 노출은 후속 정리 대상이다. Redis 삭제는 후속 cache cleanup일 뿐 성공 조건이 아니며 stale predecessor를 되살릴 수 없다.
- `PUT /floors/:floorId/editor-state`와 `POST /floors/:floorId/editor-revisions/:revision/restore`는 `leaseToken`, `leaseFence`, `expectedRevision`을 모두 요구한다. 저장·복구 transaction 안에서 현재 `Floor` row의 token hash, fence, 만료 시각을 다시 검증해 lease가 만료되었거나 강제 해제된 stale client를 `409 floor editor lease is no longer active`로 거부하고, 그 뒤 `mapRevision`을 최종 optimistic guard로 검사한다.
- 맵 편집 route는 진입 시 lease를 얻고 editable token이면 30초마다 single-flight heartbeat로 갱신한다. 클라이언트는 `performance.now()` 기반 80초 local deadline watchdog으로 fail-closed 동작을 유지하고, 서버는 PostgreSQL 만료 시각과 fence를 authoritative source로 사용한다. 충돌, 갱신 실패, token 상실, deadline 만료, lease 획득 실패와 floor 전환 중에는 저장/복구/도구/캔버스/배경/속성 변경을 막는 읽기 전용으로 전환한다. 정상 route 이탈은 아직 보유한 token의 release를 요청하고, 브라우저 종료 같은 비정상 종료의 회수는 서버 만료 시각과 Redis TTL에 맡긴다.
- 새로고침에서 이전 문서의 `pagehide` lease 반납과 새 문서의 lease 획득이 동시에 같은 Floor를 갱신할 수 있다. 획득·heartbeat 갱신의 Serializable transaction은 PostgreSQL `40001`/deadlock 및 Prisma `P2034`를 최대 2회 전체 재실행하고, 모두 충돌하면 현재 PostgreSQL 정본을 읽어 안전한 읽기 전용 상태로 수렴한다. 실제 API의 release/acquire 경쟁 100회에서 5xx 없이 재획득 또는 bounded read-only 응답으로 끝나는 것을 확인했다.
- Task 11 완료 후 legacy `PATCH /floors/:floorId/floor-plan`, `PATCH /fixtures/:fixtureId`, `POST/PATCH/DELETE /floor-map-objects` 경로와 웹 export를 제거했다. 이제 도면 변경은 revision·audit·lease fence가 모두 걸린 atomic save/restore 경로로만 가능하며, stale legacy client가 `mapRevision`을 우회해 normalized row를 덮어쓸 경로는 없다.
- Playwright browser 회귀는 operator의 customer 설정 직접 URL이 `/operator/site-admins`로 수렴하고 `/sites`를 호출하지 않는 것, admin의 설정 도면 이동/atomic save/모니터링 좌표 반영, viewer edit URL의 사전 redirect와 mutation `403`을 검증한다. Task 9 격리 실백엔드 journey도 map save와 모니터링 좌표 반영을 검증했다. 1,000 fixture editor는 navigation 시작부터 marker 색상 표시와 Konva hit selection까지 8초 이내여야 한다. fixture route는 `apps/web/e2e/support`에만 있으며 assigned `site-1` 밖의 `404`는 test-fixture isolation 검증일 뿐 production tenant E2E 증거는 아니다.
- Playwright route fixture는 설정 에디터에서 새 도형을 atomic save한 뒤 모니터링으로 이동하면 저장 응답으로 발급된 도형 ID가 실제 Konva scene에 즉시 표시되는 계약을 검증한다. 이 검증은 브라우저/API fixture 범위이며 Raspberry Pi/ESP32-H2 실장비 연동 완료를 의미하지 않는다.
- operator는 고객 설정 shell을 mount하지 않으며 고객 Site 목록과 capability를 갖지 않는다. assigned admin과 viewer만 허용된 범위의 Site API를 사용한다. Task 8은 pending admin 최초 설치 UI와 설치 완료 admin의 Gateway/registration 역할 노출을 연결했다.
- 현장 선택기는 `GET /sites` 응답의 `customerName`과 `name`을 함께 사용하고 URL의 `siteId`를 갱신하며 일반 설정 route의 pathname, 다른 query parameter와 hash fragment를 유지한다. operator에게 배정 현장을 표시하던 설명은 폐기됐으며 현재 `GET /sites`는 operator에게 고객 Site를 반환하지 않는다. floor 편집 route에서 승인된 현장 전환은 current draft를 baseline으로 되돌려 dirty를 해제하고 이전 floorId를 버린 뒤 새 현장의 `/settings/floor-plans`로 이동한다. 취소 시 draft와 URL을 유지하며, 승인 후 다음 현장 전환에는 폐기 확인을 반복하지 않는다. dashboard, floor fixture, statistics query key는 모두 `siteId`를 포함하며, 선택된 현장은 `/sites/:siteId/dashboard`, `/sites/:siteId/floors/:floorId/fixtures`, `/energy/sites/:siteId/estimate`를 호출해 다른 고객 현장의 캐시를 재사용하지 않는다.
- dirty editor에서 상단 `로그아웃` 버튼을 눌러도 동일한 폐기 확인을 거친다. 취소하면 session과 draft를 유지하고, 승인한 뒤에만 draft를 버리고 `/auth/logout` 후 auth query를 로그인 화면으로 전환한다.
- 설정 상단 탭은 admin에게 `설정 개요`, `현장 관리`, `유저 관리`, `조명 등록`, `맵 관리`, `계정 보안`을, viewer에게 `설정 개요`, `맵 관리`, `계정 보안`을 제공한다. `현장 관리`는 admin 전용 `/settings/site`에서 현장·층·조명 메타데이터와 구역 보관을 제공한다. `계정 보안`은 비밀번호 변경, operator/admin MFA·복구 코드, 모든 역할의 활성 세션 관리를 제공한다. `조명 등록` UI는 설정 개요에서 분리한 admin 전용 `/settings/registration`에서만 제공한다. 등록할 Gateway가 없으면 같은 화면에서 Gateway 등록을 먼저 안내하고, Gateway가 있으면 기존 검색·식별·등록 workflow를 그대로 사용한다. viewer가 관리 URL로 직접 접근하면 query string을 유지한 설정 개요로 replace하며 허용되지 않은 설정 하위 URL도 설정 개요로 수렴한다.
- 웹 Dockerfile은 production API 요청을 same-origin `/api`로 빌드한다. nginx official template entrypoint가 `API_UPSTREAM`(기본 `http://api:4000`)을 주입하고 `/api/*`를 reverse proxy하며, SPA fallback으로 `/settings/floor-plans` 같은 deep route 새로고침을 `index.html`로 응답한다. Vite 개발 서버는 `/api`를 기본 `http://localhost:4000` upstream으로 proxy해 로컬 API 개발 동작을 유지한다.

## 확정 구현 설계

### 화면과 라우팅

- 주 메뉴를 `/monitoring`, `/control`, `/statistics`, `/settings` URL로 표현한다.
- 이전 정보 구조에 있던 `/settings/floors`, `/settings/fixtures`, `/settings/gateways`, `/settings/commissioning`은 현재 구현 route가 아니다. 현장·층·조명 메타데이터와 구역 목록·보관은 `/settings/site`로 통합했다. 구역 생성·수정, Gateway 진단, 정책, 알림, 펌웨어, 외부 연동과 장비 상태 상세 workflow는 현재 미구현/후속으로 유지한다.
- 맵 편집기는 `/settings/floor-plans/:floorId/edit` 전체 작업 화면으로 연다.
- `MonitoringView`는 에디터 조회 상태와 `맵 편집` 버튼 없이 읽기 전용 도면만 표시한다. 설정 에디터 route가 실제 state 조회와 저장·취소 navigation을 소유한다.
- 모니터링 empty state는 등록 UI를 직접 렌더링하지 않고 admin에게 `/settings/registration` 이동 경로를 안내한다.

### 맵 편집기 저장과 버전

- 기존 여러 개별 API의 `Promise.all` 저장을 변경 항목 기반 단일 저장 API로 교체한다.
- `PUT /floors/:floorId/editor-state`가 도면, 도형, 조명 배치를 하나의 Prisma transaction으로 저장한다.
- 요청은 `expectedRevision`, 도면 변경, 조명 변경, 객체 생성·수정·삭제 목록을 포함한다.
- 서버는 조직·현장·역할, 모든 대상의 층 소속, asset 준비 상태와 현재 revision을 검증한다.
- 하나라도 실패하면 전체 변경을 rollback하고 부분 저장을 허용하지 않는다.
- `Floor.mapRevision`은 배경뿐 아니라 층 전체 편집 상태의 optimistic concurrency token이다.
- `FloorMapRevision`은 수정자, 버전, 변경 요약, 복구 원본과 전체 복구 스냅숏을 보관한다.
- 과거 버전 복구는 기존 버전을 덮어쓰지 않고 새 버전을 생성한다.
- 복구는 배경, 도형, 기존 조명의 표시 정보만 대상으로 하며 Mesh 주소나 장비 등록 상태를 생성·삭제하지 않는다.
- 실존하지 않는 과거 조명은 건너뛰고 복구 결과에 경고를 포함한다.
- 호환용 개별 변경 API는 최종 fix wave에서 제거했다. 현재 제품 경로에서 도면 관련 변경은 atomic save/restore만 허용한다.

### 편집 충돌과 파일 보안

- Redis에 층별 90초 cache lease를 두고 편집 화면이 30초마다 갱신한다.
- 다른 사용자가 편집 중이면 읽기 전용으로 열고 수정자와 시작 시각을 표시한다.
- `REDIS_URL`은 API 실행에 필수이며 Redis provider는 최초 lease 요청까지 client 생성을 지연한다. API bootstrap은 Nest shutdown hook을 활성화해 SIGTERM/SIGINT에도 생성된 Redis client의 `quit()`을 호출한다. Redis에는 `{ userId, userName, token, acquiredAt, fence }`를 저장하지만 authoritative validation은 PostgreSQL `Floor.editorLease*` 정본이 담당한다.
- assigned admin의 강제 lease 해제는 requested/attempted 감사 기록을 성공적으로 남긴 뒤 PostgreSQL fence를 증가시켜 이전 holder를 무효화하고, Redis delete 결과를 success 또는 stale_token 감사로 별도 기록한다.
- lease와 별도로 revision 불일치 시 `409 Conflict`를 반환하고 강제 덮어쓰기를 허용하지 않는다. save/restore는 lease fence와 `mapRevision`을 모두 통과해야 한다.
- 변경사항이 있으면 화면 이탈을 확인하고 네트워크 오류 시 클라이언트 편집 상태를 유지한다.
- 도면 저장소는 비공개로 전환하고 만료 시간이 짧은 서명 URL로 업로드·조회한다.
- 확장자에 의존하지 않고 선언한 MIME, 크기와 SHA-256 checksum을 upload intent와 S3 HEAD에서 검증한다. 신규 `original` upload intent는 공유 `cadImportMimeTypeSchema`의 DWG/DXF MIME만 허용하고 PNG/JPG/PDF는 API 경계에서 거부한다.
- 기존 ready image/PDF/rendered SVG는 인증 조회·다운로드 호환만 유지한다. image/PDF는 신규 업로드 대상으로 사용하지 않고 rendered SVG 저장은 worker 전용 경로가 소유한다.

### 현장과 층

- 현장명, 주소, 시간대와 kWh 요금을 수정한다. 주소와 단가는 필수이고 통화는 현재 통계 계약에 맞춰 `KRW`로 고정한다. 시간대·단가 변경 전 기존 조건으로 열린 에너지 구간을 정산한다.
- 층 이름, level, 표시 순서와 활성 상태를 관리한다.
- 층은 hard delete 대신 archive하며 조명, 활성 구역 또는 진행 중인 등록 작업이 남아 있으면 archive를 차단한다. 보관 뒤에는 기존 편집 token이 있어도 맵·자산·lease mutation을 거부한다.
- `Site.timeZone`, `Site.currency`, `Floor.status`, `Floor.displayOrder`를 명시적 필드로 사용한다.

### 조명과 그룹

- 현장 관리 탭은 선택 층의 조명과 제조 식별 정보를 200개 단위 cursor로 조회한다. 상태, 그룹, 통신 품질 필터는 후속 범위다.
- assigned admin은 현장 관리 탭에서 조명 이름과 정격전력을 수정하고, 도면 좌표와 표시 크기는 맵 관리에서 수정한다. viewer는 저장된 도면과 조명 정보를 읽기 전용으로 본다.
- 제품 serial, Mesh 주소, 펌웨어, 인증 관련 값은 읽기 전용이다.
- 현장 관리 탭은 기존 그룹 목록 조회와 확인 후 archive 전환만 지원한다. 그룹 생성·수정과 구성원 일괄 추가·제외는 후속 범위다.
- 장비 교체는 논리 Fixture와 전력 이력을 유지하고 연결된 MeshNode만 교체하는 별도 workflow로 구현한다.

### Gateway와 시운전

- 다중 Gateway 목록에서 이름, serial, heartbeat, 펌웨어, 인증서 만료, Mesh 품질과 담당 범위를 표시한다.
- `GatewayFloorCoverage`로 층별 주·보조 Gateway를 지정한다.
- 설치 완료 assigned admin은 admin 전용 `/settings/registration`에서 Gateway claim 또는 `RegistrationPanel`을 사용할 수 있다. 모니터링은 등록 조명 0개 상태에서도 등록 mutation UI를 제공하지 않는다. 순서형 시운전 보고서와 품질 검사 화면은 현재 미구현/후속이다. Task 9 software E2E는 완료했고 Raspberry Pi/ESP32-H2 HIL은 아직 실행하지 않았다.
- 완료 시 등록 성공·실패, Mesh 주소, 펌웨어, RSSI, hop count, 명령 성공률과 작업자를 보고서로 보존한다.
- claim code, private key와 Mesh key는 UI, DB 원문과 감사 로그에 노출하지 않는다.

### 운영 정책과 알림

- `SiteOperationPolicy`에 Gateway offline, Fixture stale, 명령 ACK·완료 제한 시간, 디밍 범위와 정전 복구 동작을 저장한다.
- API와 MQTT 처리기가 고정 상수 대신 현장 정책을 사용한다.
- `AlertRule`, `NotificationChannel`, `NotificationRecipient`, `NotificationDelivery`로 조건, 수신자와 결과를 분리한다.
- 반복 장애에는 지연과 cooldown을 적용하고 점검 시간에는 지정 알림을 억제한다.

### 사용자, 보안과 감사

- `SiteMembership`은 customer `viewer`의 현장 `read | control` capability에 사용한다. assigned `admin`은 `Site.adminUserId`로 직접 연결되고 operator는 고객 Site capability를 갖지 않는다.
- 이메일 초대, 역할 변경, 비활성화, 세션 강제 종료와 operator/admin MFA를 제공한다.
- 서비스 운영사 Organization과 고객사 Organization을 구분한다. operator는 Task 3 관리 API로 customer Organization, pending Site와 assigned admin 계정을 provision하지만 해당 고객 Site에 접근 권한을 얻지 않는다.
- 최초 서비스 계정은 `auth:bootstrap-operator`로 서비스 운영사 Organization에 생성한다.
- operator의 Task 3 API는 customer Organization, Floor가 없는 pending Site와 assigned admin을 원자 생성하며 operator SiteMembership을 만들지 않는다. assigned admin이 Task 4 API로 주소·단가·시간대·Floor/FloorPlan을 완료한다.
- operator는 Task 3 API로 assigned admin 계정을 직접 생성·교체한다. 공개 operator/admin signup은 거부하고, 현재 invitation signup은 viewer membership 생성에만 사용한다.
- 공통 `AuditLog`에 작업자, 현장, action, 대상, 변경 요약, 결과, IP, User-Agent와 관련 revision을 기록한다.
- 비밀번호, claim code, private key와 인증서 원문은 감사 로그에 저장하지 않는다.

### 펌웨어와 유지보수

- 서명된 OTA package에 대상 제품, hardware revision, firmware version과 SHA-256을 기록한다.
- 시험 장비, 일부 층, 전체 현장 순서의 단계 배포와 유지보수 시간을 지원한다.
- Gateway와 ESP32-H2가 서명과 hash를 검증하며 웹은 바이너리를 장비에 직접 전달하지 않는다.
- 배포 진행률, fixture별 실패, 중단, rollback과 인증서 갱신·폐기 상태를 관리한다.

## API와 데이터 모델 변경 예정

### 주요 API

- `GET/PATCH /sites/:siteId/settings`
- `POST /sites/:siteId/floors`
- `PATCH /sites/:siteId/floors/:floorId`
- `POST /sites/:siteId/floors/:floorId/archive`
- `PUT /sites/:siteId/floors/order`
- `GET/PUT /floors/:floorId/editor-state`
- `GET /floors/:floorId/editor-revisions?cursor={revision}&limit={1..100}`
- `POST /floors/:floorId/editor-revisions/:revision/restore`
- `POST/DELETE /floors/:floorId/editor-lease`
- `GET /sites/:siteId/floors/:floorId/fixtures/settings?cursor={fixtureId}&limit={1..200}`
- `PATCH /sites/:siteId/floors/:floorId/fixtures/:fixtureId`
- `POST/PATCH /sites/:siteId/groups`
- `PUT /fixture-groups/:groupId/fixtures`
- `GET/PATCH /sites/:siteId/operation-policy`
- `GET /sites/:siteId/audit-logs`

### 주요 신규·확장 모델

- `SiteMembership`
- `Organization.type`: `service_provider`, `customer`
- `FloorMapRevision`
- `GatewayFloorCoverage`
- `SiteOperationPolicy`
- `AlertRule`, `NotificationChannel`, `NotificationRecipient`, `NotificationDelivery`
- `AuditLog`
- OTA package, deployment, target와 result 모델
- `Site.timeZone`, `Site.currency`
- `Floor.status`, `Floor.displayOrder`, `Floor.mapRevision`

DB 모델이 실제 변경되는 작업에서는 `docs/database-schema.md`를 같은 커밋에서 갱신한다.

## 구현 순서

1. 현장 접근 범위와 역할 Guard
2. URL 기반 설정 shell과 역할별 navigation
3. 현장·층 CRUD와 archive
4. 맵 편집기를 모니터링에서 설정으로 이동
5. 단일 transaction 저장, revision과 복구
6. Redis 편집 lease와 비공개 asset pipeline
7. 조명 정보와 그룹 관리
8. 다중 Gateway coverage와 시운전 화면 정리
9. 운영 정책과 알림
10. 사용자, MFA, 세션과 공통 감사 로그
11. 서명된 OTA와 유지보수

- 각 단계는 실패 테스트, 최소 구현, 관련 테스트 통과, 메뉴·DB 문서 갱신과 독립 커밋으로 완료한다.
- API를 먼저 배포해 이전 웹과 호환한 뒤 웹을 전환하고, 사용되지 않는 개별 에디터 변경 API를 제거한다.
- 기존 Floor, FloorPlan, Fixture와 FloorMapObject는 삭제하거나 재생성하지 않는 비파괴 migration을 사용한다.
- legacy migration은 기존 Organization을 모두 customer로 유지하고, 현장 유무로 service provider를 추론하지 않는다. service_provider Organization은 배포 권한이 있는 bootstrap CLI로만 명시 생성한다.
- 기존 `owner`/`operator`와 Invitation은 모두 admin으로 변환하고 viewer는 viewer로 유지한다. 기존 customer viewer의 SiteMembership backfill은 유지한다.
- 수정된 legacy migration을 이미 적용한 로컬 개발 DB는 Prisma checksum 충돌이 날 수 있다. 데이터 보존 여부에 따라 reset 또는 감사 기반 수동 보정 migration을 선택하며, 이 기능은 파괴적 DB 명령을 자동 실행하지 않는다.

## 테스트와 완료 기준

- 백엔드 단위 테스트: 역할, 현장 범위, 입력 검증, 층 archive 조건, revision 충돌
- DB 통합 테스트: 원자 저장 rollback, revision 생성·복구, 다른 조직 격리
- 프론트 테스트: 역할별 메뉴, 읽기 전용, 편집 dirty state, API 오류와 충돌 UI
- 웹 E2E: operator의 Task 3 pending Site/admin provision, assigned admin 최초 설치와 후속 맵 편집, 모니터링 반영, viewer 변경 차단
- 동시성 테스트: 동일 층의 두 사용자, lease 만료, 강제 해제와 `409`
- 성능 테스트: 조명 1,000개 로딩·이동·선택·변경분 저장
- 보안 테스트: 다른 조직 IDOR, 직접 API 호출, 악성 파일, private asset URL 만료
- Hardware E2E: Raspberry Pi와 ESP32-H2의 Claim, provisioning, 상태 수신, 제어와 OTA
- 실제 Pi/ESP32-H2 반복 로그와 firmware hash가 없으면 Hardware E2E 또는 양산 검증 완료로 표시하지 않는다.

## 미구현

- Scene 04~09와 24~26의 자동 Web/Chromium 검증은 완료했지만 Raspberry Pi/BlueZ/ESP32-H2 HIL과 실제 모바일 WebView safe-area 검증은 미실행이다.

- 초대 링크 발급·전달 방식의 일반 유저 onboarding UI. admin이 직접 계정과 임시 비밀번호를 발급하는 현장 유저 CRUD는 구현 완료했다.
- 구역 생성·수정과 구성원 관리 화면. 기존 구역 목록·보관 전환은 구현 완료했다.
- 기존 PDF 첫 페이지 렌더·다중 페이지 선택은 보류한다. 신규 PDF upload/import는 지원하지 않으며 기존 PDF 읽기 호환만 유지한다.
- 샘플별 사람이 판정한 조명 ground truth. `몰드바등` 후보 1,302개는 review pool일 뿐이며 `xx4`, 익명 dynamic block은 geometry·attribute·주변 문자 근거와 라벨 없이 자동 등록하지 않는다.
- 승인된 실제 DWG converter/sample을 production image의 read-only 외부 bundle mount로 주입한 운영 호스트 HIL. 상시 synthetic smoke는 실제 768 MiB cgroup의 parent+converter+core와 memory bomb/malformed 생존을 검증하지만, 현장 샘플의 최신 승인 binary HIL을 대신하지 않는다.
- 다중 Gateway와 층 coverage
- ESP32-H2 factory reset과 장비 교체 workflow
- 시운전 보고서
- 운영 정책과 알림
- 공통 설정 감사 로그
- 서명된 OTA package, 단계 배포, 중단과 rollback
- 외부 API·Webhook·BMS 연동 설정
- 스케줄·센서·이벤트·장면 설정은 제어 메뉴의 후속 범위로 유지한다.

## 작업 재개 지점

- **폐기된 이전 계약:** 2026-07-21 Task 1~5는 operator SiteMembership과 operator 설치·시운전을 전제로 검증했다. 현재 Task 1~4 계정 전환의 구현 완료 증거로 사용하지 않는다.
- Gateway claim·조명 registration API controller와 service는 assigned admin commissioning 계약으로 전환됐고, Task 8 웹 UI와 Task 9 격리 실백엔드 E2E까지 완료했다.
- 이전 통합 보안 리뷰의 Floor editor, invitation 원자 소비, legacy migration과 bootstrap 증거는 유지하지만 operator 고객 현장 접근 증거는 폐기됐다.
- Task 6 URL 기반 설정 shell과 현장 선택은 `b5a92bd`, `8b53420`, `7e75f1f`로 완료하고 재리뷰 APPROVED를 받았다.
- Task 8 atomic save/revision API는 `d8d42f1`, `edde0a8`, `8d7aa2e`, `a3aa1b7`, `669be7e`, `d8041f6`, `63cd6fd`, `45336dc`, `f786d3f`에서 단계적으로 보정했다.
- Task 9 웹 변경분 생성, atomic save 전환, 충돌·revision 복구 UI와 dirty navigation guard는 `c43ff85`, `7b1fae0`, `f103f7c`, `d67e27e`, `f0c9e3a`, `3c8bd02`, `1a8bce3`에서 보정했다.
- Task 10/11의 원래 완료 선언 이후 whole-branch final fix wave에서 invitation membership lifecycle, selected-site statistics, viewer read-only control, PostgreSQL authoritative lease fence, legacy mutation 제거, dirty logout guard, Docker shared build 계약, customerName site selector를 추가 보정했다. 승인 여부는 이 문서가 아니라 scoped final re-review가 결정한다.
- 상세 커밋, 테스트 증거와 재개 순서는 `.superpowers/sdd/progress.md`에 유지한다.

## 부족하거나 개선이 필요한 기능

- BIO full runtime 배포는 독립 `compose.bio-runtime.yml`과 `scripts/gateway-bio-runtime.sh`로 BlueZ appliance와 격리한다. 기존 `gateway-appliance-deploy.sh --adapter bio-usb` overlay 경로는 원격 변경 전에 차단한다. 새 runtime은 exact USB와 전용 상태 root를 확인한 뒤 UID 999·capability 0으로 시작한다. 실제 Pi의 재배포에서는 Docker가 중첩 bind mount 연결을 위해 `$DATA_ROOT/gateway/identity`에 남긴 빈 `root:root/0755` directory만 명시적 mountpoint artifact로 인정한다. canonical exact path·directory 종류·소유자·mode·비어 있음을 모두 재검증한 뒤 그 한 경로만 ownership scan에서 prune하며, symlink·내용 존재·다른 owner/mode/type 또는 그 밖의 root 소유 runtime 파일은 기존처럼 old container 정지 전에 거부한다. identify image의 healthy heartbeat와 실제 2초 점등/센서 모드 복원은 확인했으며, 동일 주소 등록 수렴 image의 재배포와 Fixture 생성 검증은 진행 중이다.
- `bootstrap-only` 설치 CLI는 조명 하드웨어를 시작하지 않고 Gateway assignment와 MQTT identity만 준비한다. 새 admin/site 초기 설정에서 제조사 앱 없이 인증을 완료하기 위한 경계이며, claim 성공을 조명 검색·등록 성공으로 확대하지 않는다. 발급 원장 확인과 실제 adapter 기동은 [설치 runbook](../runbooks/device-lab-first-install.md#81-하드웨어-없는-인증-전용-bootstrap)을 따른다.

- 과거 scan은 raw 원장에 session scope/전체 hash가 없어 terminal identity를 추정 backfill하지 않는다. scope/hash 또는 필요한 현재 상태가 부족한 legacy 원장과 알 수 없는 이벤트 유형은 자동 정리에서도 보존한다. 삭제된 조명의 상태 원장처럼 안전 조건을 더 이상 증명할 수 없는 데이터도 남을 수 있다. 사용자 DB migration 적용·운영 배포와 실장비 검증은 실행하지 않았다.
- 도면 정리 이후 보존 범위 밖의 revision은 복구할 수 없으며 외부 이력 보관·archive 기능은 없다. `AuditLog`, `GatewayClaimAudit`, 인증서 이력은 이번 자동 삭제 대상에 포함하지 않는다.
- `AuditLog` 3년 hot retention은 회사·법무 승인 전 제안이다. `GatewayClaimAudit`와 폐기된 인증서 chain의 7년 또는 별도 승인 전 보존은 설계 기준이며, 이번 worker가 해당 시점에 삭제하는 기능은 없다. Session 자동 정리는 만료·폐기 후 30일이 지난 행만 대상으로 하며 보안 감사 보존 정책과 구분한다. 전체 보존 조건과 migration 적용 순서는 [DB 문서](../database-schema.md#운영-데이터-보존과-복구-범위)를 따른다.
- 플랫폼 운영 배포 절차는 [API·Web runbook](../runbooks/production-api-web-deployment.md)을 따른다. 단일 호스트 Compose, 외부 Vault·공개 MQTT/Object Storage 연결, 장비 mTLS 공개 SAN, CRL 갱신 후 수동 broker SIGHUP, API 교체 후 nginx upstream 재해석·재시작이 운영 조건이다. Process-local 지표만 제공하며 외부 metrics/dashboard/alert/log shipping은 구성하지 않았다. 운영 배포·사용자 DB 적용·실장비 HIL과 native WebView·수동 시각 QA는 이번 자동 검증에 포함하지 않는다.

- 1440/390/320px 결과는 Chromium 자동 브라우저 software 증거다. 실제 iOS/Android native WebView, 수동 in-app 시각 QA, WebView safe-area 실측 또는 Raspberry Pi/ESP32-H2 HIL을 수행한 결과가 아니다. Lazy chunk 실패의 복구 UI는 플랫폼 Task 3에서 구현했으며, prefetch/offline cache는 후속 범위다. Task 3 오류 주입은 Vite에서 실제 앱 셸의 동적 import 요청을 차단한 deterministic Chromium 결과이며, 운영 CDN/container 배포나 실제 backend 장애·HIL 검증을 의미하지 않는다.
- 맵 편집 우측 패널의 공통 overflow 계약은 Chromium 1440/1024/390/320px route fixture로 검증했으며 실제 모바일 WebView safe-area와 브라우저별 scrollbar 표현은 별도 실측이 필요하다.
- 테스트 데이터 도구는 개발·검증용 대량 데이터 준비 기능으로, 기본 off이며 실제 장비/MQTT 시뮬레이션이나 실장비 검증을 대체하지 않는다. 생성 직후에도 실제 heartbeat가 없으면 freshness 정책으로 offline 전환될 수 있다. DB schema/migration 변경은 없다.
- 비밀번호 변경과 setup/commissioning visibility는 Web 회귀와 기존 격리 실백엔드 E2E로 검증했다. Scene 24~26 레이아웃은 1440×900, 1024×768, 390×844, 320×740 자동 Chromium으로 검증했지만 재설치, 수동 in-app Browser 시각 QA와 Raspberry Pi/ESP32-H2 HIL은 아직 실행하지 않았다.
- 설정 shell은 역할별 navigation, 설치 wizard, 설정 개요, 현장·층·조명 메타데이터 운영, 구역 목록·보관, 도면 목록/편집과 계정 보안을 제공한다. 계정 보안에는 비밀번호 변경, operator/admin MFA·복구 코드, 모든 역할의 활성 세션 관리가 포함된다. 현재 미구현/후속인 구역 생성·수정, Gateway 진단, 정책, 알림, 펌웨어, 외부 연동과 장비 상태 상세 workflow는 route placeholder가 아니라 아직 제공하지 않는 범위다.
- 평탄화된 설정 콘텐츠와 에디터 workbench의 시각 계층만 정리했으며, pending setup/Gateway claim/registration 흐름과 맵 editor lease·dirty guard·atomic save/restore·단축키·map bounds의 기존 제약 및 후속 실장비 검증 범위는 변경하지 않았다.
- 설정 상단 탭은 공통 밑줄형 navigation의 44px 포커스·가로 스크롤 계약을 사용한다. 실제 모바일 WebView safe-area와 네이티브 navigation 통합 검증은 후속 작업이다.
- dirty 내부 이동 guard는 링크, 현장 전환과 same-URL sentinel 기반 브라우저 history 이동을 확인한다. Task 10 이후 추가되는 programmatic navigation 경로도 같은 discard/guard 계약에 연결해야 한다.
- Gateway claim과 registration API 및 웹 UI는 assigned admin commissioning으로 전환됐고 Task 9 software E2E를 통과했다. inventory disable은 제조 보안 경계로 active service-provider operator 전용을 유지한다. 실제 장비 검증은 미실행이다.
- 도면 asset의 private 조회, DB-first 업로드 원장, 만료 pending 회수와 24시간 지난 미참조 ready 자산 회수는 유지한다. JPG/PNG 선택·업로드·교체·연결 제거 UI는 제거하고 CAD 가져오기만 신규 원본 업로드를 사용한다. 기존 ready image/PDF/rendered SVG 조회와 현재 맵·모든 과거 revision의 자산 보존은 유지하며, 맵 저장과 cleanup 경합도 Floor 잠금으로 직렬화한다. ready 삭제 실패는 2분 backoff로 뒤 후보를 먼저 진행한다. 이번 변경에는 DB schema/migration이 없고 실제 운영 object storage 장애 주입 검증은 후속 Task다.
- PKI 폐기 대기·재시도 원장의 전용 운영 UI는 아직 없다. CA 서명 응답 뒤 원장을 commit하기 전 process crash 또는 원장 저장과 즉시 폐기가 모두 실패하는 이중 장애는 CA 측 발급 감사/재조회 없이는 완전히 회수할 수 없다. CRL의 15분은 네트워크·인증 토큰/파일 I/O·DB 작업을 합친 transaction 예산이지 개별 filesystem 호출의 엄격한 상한이 아니며, 누적 예산 초과나 DB session 유실 뒤 이미 시작한 publish가 계속될 수 있어 실제 Vault/CRL 운영 검증이 필요하다.
- 다중 Gateway coverage와 층별 radio 품질 진단은 아직 제공하지 않으므로, 사용자가 선택한 Gateway가 해당 층을 실제로 커버하는지는 설치 검증 절차로 확인해야 한다.
- 실제 ESP32-H2 검색·provisioning·model bind, RF 품질과 전체 OTA는 실기 검증 증거가 아직 부족하다.
- 저장 구역 생성·수정 UI/API는 제어 메뉴에서 제공한다. 전체 suite에서 opt-in DB URL 부재로 skip된 PostgreSQL 구역 생성 rollback 통합 회귀는 로컬 개발 PostgreSQL URL을 명시한 별도 실행에서 1/1 통과했다. Raspberry Pi/BlueZ/ESP32-H2를 연결한 zone 제어 Gate는 `not_executed`이며 자동 단위·브라우저 fixture나 DB rollback 회귀를 실장비 완료 증거로 간주하지 않는다.
- 등록 패널의 물리 provisioning 상태는 1.5초 polling으로 반영하고, 검색·등록·상태 확인의 display-only 진행 단계를 제공한다. `reconcile_required` 장비의 실제 현장 복구 판단과 자동 질의는 아직 제공하지 않는다.
- 로컬 MinIO에서 signed PUT, HEAD checksum, 익명 GET 거부와 300초 signed GET 통합 테스트를 통과했다. 브라우저가 접근할 public bucket base와 API 내부 endpoint는 별도 설정하고, 번들 MinIO CORS origin은 `WEB_PUBLIC_URL`에서 주입한다. 실제 운영 object storage 장애 주입은 후속이다.
- 기존 ready image/PDF/rendered SVG는 비공개 자산의 읽기 호환을 유지한다. image/PDF의 신규 연결·업로드 UI는 제공하지 않는다.
- 조명 다중 선택·일괄 이동, 도형 개별 삭제, Undo/Redo, 격자 스냅과 조명 키보드 미세 조정을 제공한다. 다중 도형 동시 편집과 전용 회전 도구는 후속 범위다.
- DWG/DXF import의 소프트웨어 경로와 샘플 제품 pipeline은 구현했지만 사람이 판정한 ground truth가 없어 검출 precision/recall/F1은 미확정이다. 현장 profile의 `몰드바등` review 후보 1,302개를 자동 등록 품질로 확대 해석하지 않는다.
- AI는 I/O를 수행하지 않는 `disabled` adapter뿐이다. 향후 provider 교체 가능성은 유지하되 외부 전송 승인과 좌표 비생성 계약을 통과하기 전에는 활성화하지 않는다.

## 경쟁 서비스 참고 근거

- Emblaze: Planner의 도면·그룹·센서, Autopilot의 시운전, Dashboard의 모니터링·유지보수 분리
  - https://emblaze.co.kr/support/faq/
- Silvair: 웹 planning과 모바일 commissioning, area·zone·scene·schedule·mesh quality·보고서
  - https://silvair.com/support/faq/
- Casambi Pro: PC planning, tablet commissioning, project·layout·group·cloud gateway 관리
  - https://support.casambi.com/support/solutions/articles/12000102096-introduction-to-casambi-pro
- Signify Interact: Expert와 User의 그룹·zone·firmware·schedule 관리 권한 분리
  - https://sme.interact-lighting.com/web/help/interact-pro/2.7/system-guide/access-per-role.html
- Lutron Vive: schedule, occupancy, daylight, load shed와 energy·health 운영 기능
  - https://www.lutron.com/us/en/controls/systems/vive

## 관련 파일

- `scripts/analyze-cad-import.mjs`
- `scripts/analyze-cad-import.test.mjs`
- `.superpowers/sdd/2026-07-06-floor-editor-implementation/task-19.5-implementation.md`
- `apps/api/src/floor-import/dxf-document-parser.ts`
- `apps/api/src/floor-import/rule-based-lighting-symbol-detector.ts`
- `apps/api/src/floor-import/disabled-ai-lighting-symbol-detector.ts`
- `apps/api/src/floor-import/cad-converter.ts`
- `apps/api/src/floor-import/floor-import-worker.service.ts`
- `apps/api/prisma/migrations/20260917145000_cad_profile_upgrade_preflight/migration.sql`
- `apps/api/prisma/migrations/20260917160000_cad_upgrade_safety/migration.sql`
- `docker-compose.production.yml`
- `scripts/production-compose-smoke.sh`
- `docs/runbooks/production-api-web-deployment.md`

- `apps/gateway/src/bootstrap-only.ts`, `apps/gateway/src/identity/ensure-mqtt-identity.ts`, `apps/gateway/compose.bootstrap.yml`
- `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`
- `apps/gateway/src/adapters/bio-sensor-capability-unavailable-port.ts`
- `apps/gateway/src/adapters/adapter-factory.ts`
- `apps/gateway/src/bio/bio-device-mapping-store.ts`
- `apps/gateway/compose.bio-runtime.yml`
- `scripts/gateway-bio-runtime.sh`
- `apps/gateway/src/health/appliance-health.ts`
- `apps/gateway/src/state/provisioning-device-journal.ts`

- `apps/api/src/retention/data-retention.service.ts`, `apps/api/src/retention/retention.module.ts`
- `apps/api/src/retention/data-retention.service.spec.ts`, `apps/api/src/retention/data-retention.integration.spec.ts`

- `apps/api/src/retention/gateway-event-watermark.ts`, `apps/api/prisma/migrations/20260915_statistics_operations_retention/migration.sql`
- [API·Web 운영 배포와 장애 대응](../runbooks/production-api-web-deployment.md)

- `apps/web/src/components/ui/AppRecoveryState.tsx`
- `apps/web/src/components/ui/AppErrorBoundary.tsx`
- `apps/web/src/AppRoot.tsx`
- `apps/web/src/App.recovery.test.tsx`
- `apps/web/e2e/app-shell-recovery.spec.ts`

- `apps/web/src/features/settings/users/SiteUsersView.tsx`
- `apps/web/src/features/settings/users/SiteUsersView.test.tsx`
- `apps/web/src/api/site-users.ts`
- `apps/web/e2e/site-user-management.spec.ts`
- `apps/web/e2e/site-user-management-real.spec.ts`
- `apps/api/src/site-users`
- `apps/api/src/access/site-access.service.ts`
- `apps/web/src/components/ui/SidePanel.tsx`
- `apps/web/src/features/transport-copy.ts`
- `apps/web/src/features/transport-copy.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/components/ui/RouteLoadingState.tsx`
- `apps/web/src/api/queries.ts`
- `apps/web/src/features/settings/SettingsShell.tsx`
- `apps/web/src/features/settings/settings-sections.ts`
- `apps/web/src/features/shells/CustomerShell.tsx`
- `apps/web/src/features/shells/SettingsNavigationItem.tsx`
- `apps/web/src/features/sites/SiteSwitcher.tsx`
- `apps/web/Dockerfile`
- `apps/web/scripts/audit-schedule-bundle.mjs`
- `apps/web/nginx.conf.template`
- `apps/web/src/features/settings/SettingsView.tsx`
- `apps/web/src/features/settings/registration/RegistrationSettingsView.tsx`
- `apps/web/src/features/settings/SettingsShell.test.tsx`
- `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`
- `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.test.tsx`
- `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`
- `apps/web/src/features/settings/security/PasswordSettingsView.tsx`
- `apps/web/src/features/settings/security/PasswordSettingsView.test.tsx`
- `apps/web/src/features/settings/site/SiteOperationsView.tsx`
- `apps/web/src/features/settings/site/SiteOperationsView.test.tsx`
- `apps/web/src/api/site-settings.ts`
- `apps/web/e2e/settings-operations.spec.ts`
- `apps/web/src/features/settings/TestDataToolsPanel.tsx`
- `apps/web/src/features/settings/TestDataToolsPanel.test.tsx`
- `apps/web/src/api/test-data.ts`
- `apps/web/src/api/test-data.test.ts`
- `apps/web/vite.config.ts`
- `apps/web/vite.config.test.ts`
- `apps/api/src/test-data`
- `apps/api/src/energy/energy-dimension-history.service.ts`
- `.env.example`
- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/floor-editor`
- `apps/web/src/features/floor-editor/editor-monitoring-cache.ts`
- `apps/web/src/styles.css`
- `apps/web/src/features/floor-map/FloorScene.tsx`
- `apps/web/e2e/settings-floor-editor.spec.ts`
- `apps/web/e2e/floor-editor-layout.spec.ts`
- `apps/web/e2e/layout-assertions.spec.ts`
- `apps/web/e2e/support/layout-assertions.ts`
- `apps/web/e2e/support/settings-api.ts`
- `apps/web/playwright.config.ts`
- `apps/web/src/features/floor-editor/editor-diff.ts`
- `apps/web/src/features/floor-editor/editor-store.ts`
- `apps/web/src/features/setup`
- `apps/web/src/features/registration`
- `apps/web/src/features/setup/SetupWizard.test.tsx`
- `apps/web/src/features/setup/GatewayClaimPanel.test.tsx`
- `apps/web/src/features/registration/RegistrationPanel.test.tsx`
- `apps/web/e2e/calm-operations-commissioning.spec.ts`
- `apps/api/src/floor-editor/floor-editor.controller.ts`
- `apps/api/src/floor-editor/editor-lease.service.ts`
- `apps/api/src/floor-editor/floor-editor.service.ts`
- `apps/api/src/floor-editor/floor-editor-snapshot.ts`
- `apps/api/src/floor-editor/floor-editor.integration.spec.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/product-identity.ts`
- `apps/web/src/api/floor-editor.ts`
- `apps/api/src/floor-editor`
- `apps/api/src/redis`
- `apps/api/src/setup`
- `apps/api/src/setup/setup.integration.spec.ts`
- `apps/api/src/access/site-access.service.ts`
- `apps/api/src/gateway-onboarding`
- `apps/api/src/registration`
- `apps/api/prisma/schema.prisma`
- `packages/shared/src/schemas.ts`
- `docs/database-schema.md`
- `docs/menus/monitoring.md`
- `docs/menus/control.md`

## 갱신 규칙

- 설정 메뉴의 현장, 층, 도면, 조명, 그룹, Gateway, 시운전, 운영 정책, 알림, 사용자, 보안, OTA와 연동 기능을 구현·수정·삭제할 때 이 문서를 같은 작업에서 갱신한다.
- 맵 편집기 또는 등록 진입점이 바뀌면 `docs/menus/monitoring.md`도 같은 작업에서 갱신한다.
- DB schema가 바뀌면 `docs/database-schema.md`를 같은 작업에서 갱신한다.
- 자동 테스트 완료, 코드 완료, Raspberry Pi 검증과 ESP32-H2 Hardware E2E를 별도 상태로 기록한다.
- route-backed action을 추가하거나 제거할 때 role filtering, `siteId` query와 hash fragment 보존, dirty navigation guard 회귀를 함께 갱신한다.
- 테스트 데이터 도구의 활성화 플래그, 설치 완료 assigned admin 노출 조건, marker 기반 생성·삭제 범위가 바뀌면 이 문서와 모니터링 문서를 함께 갱신한다. DB schema/migration 변경이 없는지도 명시한다.
- CAD 분석 결과를 갱신할 때 원본 SHA256, analyzer/converter/DXF/profile 버전과 digest, model/paper layer·block·entity·직접/nested INSERT·world 좌표·후보 통계, 제품 pipeline 자원 실측과 동일 출력 재현성을 함께 기록한다. 직접 INSERT 이름+유한 원점 비율, 지원 entity 기준 맵 기하 재현 예상, ground truth 기반 검출 지표, BLE identity 매핑을 서로 대체하지 않는다.
