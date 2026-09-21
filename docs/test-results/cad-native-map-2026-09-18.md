# CAD 네이티브 맵 실제 DWG 검증

## 2026-09-20 카메라/raster 회귀 검증

- `FloorEditorCanvas` 팬/휠 입력과 `MapSceneCanvas` imperative camera 경로를 검증했다. 이벤트마다 Zustand를 갱신하지 않고 팬은 pointer RAF, 휠은 120ms settle 후 한 번 커밋한다.
- ordered raster는 카메라 이동 중 기존 baked cell을 유지하고 settle 후 fractional phase/zoom이 달라질 때만 재-bake한다. destroy 시 pending render가 셀 메모리를 남기거나 되살리지 않는다.
- 집중 결과: 3개 파일 25 tests PASS. 웹 전체 결과: 152 files, 2,130 tests PASS, 3 skipped. 웹 typecheck와 build PASS.
- 이 결과는 일반적인 성능/수명주기 회귀 근거이며 50만 요소, 실제 모바일 GPU, Raspberry Pi 양산 cgroup의 완료 근거가 아니다.

## 2026-09-21 Surface 안정성·원자 raster 교체 검증

- `MapSceneCanvas`는 동일 인증 scope에서 source/readOnly callback이 바뀌어도 Canvas/Pixi renderer를 다시 만들지 않고 ref-backed 최신 source를 사용한다. scope 변경만 이전 renderer를 dispose한다.
- 설정 에디터는 pointer RAF 기반 touch pinch, cancel camera 복구와 settled commit을 사용하고, 모니터링·제어의 공통 `FloorMapViewport`는 wheel/pinch 중 live DOM camera를 유지한 뒤 120ms 정지 또는 pointer 종료에 한 번만 parent zoom을 동기화한다.
- `MapRasterBackend`의 지연 `loadTile` 회귀는 새 cell decode가 멈춘 동안 `removeTile`이 호출되지 않으며 decode/paint/최종 allocation 뒤 한 동기 publish 구간에서만 old/new cell을 바꾸는 것을 확인한다. `destroy`의 staging·active memory 반환은 기존 수명주기 회귀로 함께 검사했다.
- 실행 결과: typecheck PASS, 집중 5 files/98 tests PASS, 전체 Web Vitest 152 files/2,135 passed/3 skipped, production build PASS, `git diff --check` PASS. build는 500kB 초과 chunk 경고만 출력했다.
- in-app localhost는 API 연결 실패 상태여서 실제 로그인 데이터 기반의 수동 GPU/gesture QA는 이 실행에서 하지 못했다. 500k element, 실제 RN WebView GPU와 Linux cgroup은 보류다.

## 공통 맵 전환 검증 현황 (2026-09-19)

### 최신 마무리 결과

- 최종 독립 검토: `6325ef16`의 사용자 조정 일반 사용 범위 PASS, 열린 P1/P2 없음. 대형 성능·보류 검증의 완료를 뜻하지 않는다.
- 사용자 요청: 50만 요소 테스트 제외, 남은 검증 신속 마무리. 두 번째 DWG 약498,838개 및 합성500k는 보류이며 기존 시간 초과를 PASS로 변경하지 않았다.
- 최종 실제 백엔드 `common-map-real.spec.ts`: HEAD `6325ef16` 전후 동일,1 PASS/1.2분. 로그인·일반 도형 저장·실제 DXF 업로드/변환/적용·이동/수정/삭제/실행 취소·재저장/재조회·맵 크기 checkpoint·모니터링 픽셀 통과. 실제 HTTP200 apply 응답을 `floorImportApplyResultSchema`로 즉시 검증하므로 완료 상태 재조회로 잘못된 ACK를 가리지 않는다.
- 소비 소스13개 SHA 동일, 준비 작업2개 committed, fixture ID 유지, pageErrors/serverFailures/evidenceErrors 모두0. 소유 프로세스·DB·저장소·socket/port 정리 확인. 스크린샷4개 및 HTTP/SHA/정리 증거: `/tmp/u14b-real-20260919-final-current`.
- `e31ef469` 저장 통합3건 독립 Web7/API9 PASS, 작성자 실제PG2 PASS. 생산자 `06a3b52e`/`6a3e980f`/`a68cab58` 독립44 PASS. 렌더러 `6325ef16` 집중32·독립21·타입·일반 브라우저2 PASS. 브라우저 fractional 경계26픽셀 차이는 기존0.05% 기준 이내이며0차이라고 주장하지 않는다.
- root lint/typecheck 및 후속 renderer 집중 타입 검사에 이어 사용자 요청으로 루트 전체 테스트·빌드를 재실행했다. 최종 `npm_config_workspace_concurrency=1 pnpm test` 종료0: 루트 스크립트141/모바일6/shared395/자동화28/Web2,128/API2,547/Gateway1,246/UI 정책56개 통과, 합계6,547 PASS·실패0. 기존 opt-in 제외는 루트2/Web3/API631개이며 실제 장비 검증으로 확대하지 않는다. UI 정책 위반0, 전체 `pnpm build`도 종료0이다. 500k·추가 성능 계측·실제 RN·양산 Linux cgroup은 보류 상태를 유지한다.
- 전체 검사에서 발견한 문제를 보완했다: 인증/제어 mock의 `apiRequest` 누락, `.local` 진단 파일의 정식 테스트 수집, 실제 제조 인증 통합 검사의5초 한도(해당 검사만30초), 공통 UI 토큰 위반10건, 장치 없는 신호 테스트 자식의 조기 종료와 반복 신호 경쟁, undo 조회 완료를 일부 좌표만으로 판단한 테스트. 신호 검사는10회 연속, 맵 UI 집중168개·undo6개·정책56개를 별도로 확인했다. 제품 보안·크기·성능 기준이나 정식 테스트를 완화하지 않았다.
- 최종 로그는 `.superpowers/sdd/2026-09-18-cad-native-map-rendering/final-full-test-r7.log`와 `final-full-build-r2.log`다. 빌드의 일부 Web 청크500kB 초과 경고는 남아 있지만 오류는 아니다. 앞선 `6325ef16` 브라우저 E2E와 이번 전체 자동 테스트는 별도 실행 증거다.

### 이전 단계별 증거

아래 이전 native 전용 경로의 결과와 현재 공통 요소 경로를 구분한다. 현재 정본은 수동 도형과 CAD 변환 도형이 같은8종 일반 요소이며, 표시 캐시는 편집 정본이 아니다.

- 기존 맵 초기화: 사용자 승인으로 로컬3개 층의 맵·슬롯·맵 이력을 초기화했다. 계정/현장/층/게이트웨이/등록 조명6개/제어 그룹/자동화/명령 ID는 보존했고 조명만 미배치로 변경했다. 직전 DB 백업을 보관했다.
- 실제 사용자 Chrome: 일반 사각형 생성·저장20→삭제 저장21→undo/재저장22, 초안 인증 범위 보완 후 삭제 저장23→undo/재저장24가 성공했다. 마지막 저장은 초안 경고가 없고102% 카메라를 유지했다. 현재 B1은 검증용 사각형1개/리비전24이며 편집 잠금은 반납했다.
- 격리 실제 백엔드: `common-map-real.spec.ts` r6은 PostgreSQL/Redis/MQTT/MinIO/API/Web을 별도 실행하여 로그인/lease/초기화, 일반 도형·텍스트 저장/reload, 실제 DXF 업로드/worker/검토/적용, 가져온 텍스트 이동/수정/삭제/undo/재저장, 맵 크기/격자 checkpoint 저장·복구, 모니터링 픽셀을 통과했다. stage2개 committed, fixture1개 ID 유지, 브라우저 오류0/5xx0, 소유 프로세스·DB·저장소 정리 확인. 원본 DWG나 실제 장비 E2E로 확대하지 않는다.
- 실제 두 DWG 변환(`5ecaf26f`): 킨다129,920개/2단지498,838개 정본과 표시 ID가 양방향 전수 일치했다. 원본 SHA/mtime/bytes 유지, 기본500,000개/512MiB temp/384MiB heap/60초 제한 유지. 내부 임시 타일 무손실 압축으로 최종 임시 공간146,091,263/260,398,408bytes, 선택 처리24.46/51.75초였다. 미지원 원본 요소 진단은 유지되므로 원본 충실도100% 수치가 아니다.
- 선 경계 보완(`9c2af7e2`): 원래 닫힌 경로와 선 두께의 인접 타일 범위를 유지한다. 소스 독립 검토14+3 통과, 실제 HATCH 0/1/2개 구멍·DPR1/2의 기본 배율/분수 줌은6개 시각 테스트 통과했다. 최소 줌의 추가 표시 범위와 최신 두 원본의 실제 브라우저 메모리 검증은 진행 중이다.
- 대량 편집 독립 검토3건은 `b248cb82`에 보완했다. 작성자 집중129/원래 재현4/Chromium6/타입0과 독립 재검토4+12/Chromium2 PASS다. 이후 전체 연결 검토의 중첩 그룹 해제·활성화 실패 재시도·잔여 초안 이탈 경고3건은 별도 보완 중이며, 전체 기능 완료 판정은 아니다.
- 순서 페이지 생산자 `9916c1bc`: 킨다는129,920 ID/727자산/149,177조각/24.88초로 통과했으나 2단지는60초 제한으로 미완료다. 선택 변환 단독 계측은 최종 페이지 생성 진입54.141초,59.931초까지179셀/315part 생성 후 제한에 도달했다. 이전 생산자의 두 원본 성공을 최신 경로 성공으로 확대하지 않는다. 원본·용량·시간 상한을 유지하며 최적화 중이다.

실행 증거: `.superpowers/sdd/2026-09-18-cad-native-map-rendering`의 담당별 보고서, `/tmp/u14a-canonical-dovMvN/results.json`, `/tmp/u14b-real-20260919-r6`. 임시 경로는 실행 증거이며 배포 의존성이 아니다. 최종 전체 검사·대형 도면 브라우저·실제 RN·Linux 양산 cgroup 판정은 각기 별도다.

## 이전 Native 전용 검증 이력

실행일: 2026-09-19 KST. Task 11 중 제공 DWG 두 파일의 실제 서버 변환 경로 검증이다.

## 판정

### 실제 개발 서버 실패 후속 조사(2026-09-19)

이 문서의 기존 pipeline/route fixture 통과 이후, 사용자 웹 작업 `a6b6130c-3819-4947-94fe-fa5d9dfad506`은 35%에서 3회 실패했다. 원본 손상이 아니라 **실행 중인 API와 디스크의 코드 불일치**였다. 당시 API 프로세스는 09:21 KST에 시작했고 API/shared 산출물은 각각 10:20/10:18에 변경되어 있었다. 메모리의 worker 함수는 `regions.length > 100`을 포함했으며 현재 디스크 함수는 공통 상한 16,384개를 사용했다. 구 shared module에는 새 상한 export도 없었다.

업로드 객체 SHA-256 `ddbbecb9795a70b8fd2dfe550c6da7ffeeed10341e16fec1e43e30f13f20c811`과 18,725,834 bytes를 검증한 뒤, 같은 `/tmp` 루트·실행 환경의 기본 converter/core로 새 프로세스에서 재현했다. 변환 2.29초, 분석 25.02초에 1,817개 영역/조명 후보 2개를 정상 반환했다. 구 API가 정상 child 결과를 과거 상한으로 거절하면서 넓은 `parse` 단계의 일반 오류만 남긴 것이다. 진단용 loopback inspector는 PID를 확인하고 함수 해시/공개 상수만 조사한 뒤 종료했다. 근거: `/tmp/cad-runtime-stale-evidence-20260919.json`.

후속 수정은 DXF의 DWG 변환기 우회(검증된 원본을 기존 격리 parser로 전달), 허용 목록 기반 서버 진단 로그, 안전한 단계별 UI 안내다. 구 감시기의 4개 `TS2305`는 과거 shared 계약을 계속 참조한 오류였으며 독립 타입 검사/빌드는 정상 통과했다. 전체 `pnpm dev`를 다시 시작한 12:51 KST에는 watch 오류 0개, 새 API PID 65820의 worker 함수와 디스크 함수 해시 일치, shared 상한 16,384 및 과거 100개 제한 부재를 확인했다. localhost:5173 응답 200, 비로그인 `/api/auth/me`의 정상 401도 확인했다. 진단 포트는 다시 닫았다. 근거: `/tmp/cad-runtime-current-evidence-20260919.log`. 최종 회귀 결과는 Task 12와 상태판에서 추적하며, 실제 사용자 브라우저 로그인 여정 검증과 분리한다.

**지원 범위의 실제 서버 변환·적용과 네이티브 브라우저 표시·편집 검증 통과.** 전체 후보 적용 정상 흐름은 2/2 PASS(285.96초)이며 1,308개/2개 미배정 위치를 생성했다. 실제 geometry의 8개 브라우저 화면, 실제 선 편집·재조회 및 WebView 32 MiB 정책 4개 화면도 통과했다. 원본 전체 충실도 100%나 실제 모바일 기기 성능 검증 완료를 뜻하지 않는다.

Task 12 최종 회귀는 API 177개 suite/2,163개 통과·524개 환경 제외·실패 0(111.154초), Web 1,605개 통과·2개 opt-in 제외, 타입 검사/API 빌드, 실제 PostgreSQL 23개다. 진단 매핑 추가 중 처음 실행한 전체 API는 새 RED 4개를 포함했지만 수정 후 코드를 동결한 최종 전체 재실행에서 모두 통과했다. 증거는 `/tmp/cad-runtime-api-final-20260919.json`이다.

재시작한 서버 환경을 읽어 기본 converter factory와 기본 core constructor(384 MiB/60초)를 사용한 두 DWG도 **2/2 통과**했다. 2단지는 변환 2.29초/분석 25.67초, 197개 영역·미리보기/후보 1,308개, 킨다는 변환 2.24초/분석 25.20초, 1,817개 영역·미리보기/후보 2개다. 두 원본 SHA는 기존 제공 파일과 일치하며 킨다는 실패한 업로드 객체 SHA와 같다. 증거: `/tmp/cad-default-provided-cJBtJz/metrics.json`. 이번 재분석은 사용자 DB에 적용하지 않았다. **실제 사용자 브라우저는 로그인 화면이어서 재업로드→적용 HTTP 여정은 미실행**이며 로그인 후 같은 파일을 다시 가져오는 확인이 남았다.

## 실제 타일 브라우저 검증

실제 제공 파일에서 생성한 manifest/tile을 SHA 검증 후 그대로 사용하고 인증·조회·저장 API 응답만 Playwright route fixture로 제공했다. 따라서 아래 결과는 실제 geometry의 WebGL 및 편집 UI 검증이며 실서버 로그인부터 저장까지 연결한 HTTP E2E 또는 실제 iOS/Android 기기 결과가 아니다. 서버 DB·저장소 적용은 다음 절의 별도 실제 pipeline 결과로 확인한다.

| 실제 렌더링 완료 | 2단지 | 킨다 |
| --- | ---: | ---: |
| PC editor / monitor | 803/803 / 803/803 | 875/875 / 875/875 |
| 390px Chromium editor / monitor | 803/803 / 803/803 | 875/875 / 875/875 |
| PC editor / monitor 완료 시간 | 12.404초 / 13.417초 | 5.860초 / 5.237초 |
| 390px editor / monitor 완료 시간 | 11.070초 / 11.354초 | 4.805초 / 5.194초 |
| editor 집계 메모리 PC / 390px | 24.43 MiB / 20.24 MiB | 2.90 MiB / 1.97 MiB |

8개 화면 모두 실제 renderer active tile 수를 검사했으며 누락·degraded·page/console error가 없고 native canvas pixel을 확인했다. 요청 수만 모두 찬 경우를 통과로 취급하지 않았다. Editor 한도는 32 MiB이며 이 표의 일반 Chromium monitor는 desktop 128 MiB 정책이다. 이 수치는 첫 전체 표시까지의 시간이며 FPS나 실제 모바일 메모리 상한 통과를 뜻하지 않는다. 타일 다운로드·decode가 있기 때문에 최초 표시가 즉시 완료되는 수준은 아니다.

실제 킨다 도면의 그룹 없는 LINE을 **single-click → 색상/선 두께 적용 → 새로고침 → 재선택**한 추가 브라우저 테스트도 통과했다(11.8초 테스트). Reload 후 Konva 선택 오버레이 없이 native canvas에서 변경 색상 픽셀 90개를 확인했고 원본 typed primitive 좌표와 tile SHA는 유지됐다. 저장 API는 이 테스트의 route fixture다. 근거는 `.local/cad-native-qa/provided-native-line-edit-evidence.json` 및 `provided-native-line-after-reload.png`다.

합성 CAD 업로드/영역 선택/적용/편집/모니터링 4개도 통과했다. 1,000 fixture의 ready 측정은 desktop 1.523초, 390px 1.541초이며 pan/zoom 증거 수집은 0.847초/0.674초다. 합성 맵 수치를 44만 요소 실제 CAD 성능으로 대체하지 않는다.

WebShell의 모바일 flag·초기 active AppState·dataset 계약을 함께 적용한 390px Chromium 재검증도 **2/2 PASS**다. Editor와 monitor 모두 32 MiB 한도에서 2단지 803/803(각 21,218,918 bytes), 킨다 875/875(각 2,065,022 bytes)를 실제 렌더링했다. Editor/monitor 완료 시간은 2단지 10.163/10.318초, 킨다 4.762/4.171초였다. 누락·degraded·오류가 없었고 atlas 텍스트 보정 이후 실행한 결과다. 이는 Chromium에서 모바일 정책 분기를 검증한 것이며 실제 RN 기기의 GPU 메모리 실측은 아니다. 처음 flag만 켰던 실패는 AppState를 빠뜨린 테스트 준비 오류였고, renderer 정책을 완화하지 않고 실제 foreground bootstrap을 재현해 재실행했다.

## 전체 후보 적용 재검증

하네스는 선택 후 `listCandidates`가 반환한 모든 candidate ID를 apply한다. 실제 `FloorLightSlot` 개수/좌표/회전/source 참조/미배정 상태, editor state의 slot 좌표, `FloorMapRevision.snapshot`의 slot 좌표를 검증했다. Fixture 및 MeshNode 전체 개수는 적용 전후 동일했다. 읽기 전용 `FloorMapService.getSnapshot`은 기존 계약상 unassigned slot을 노출하지 않으며 placed fixture만 노출하므로 이 응답에 가짜 fixture가 없는 것도 확인했다. Product source와 테스트 예산은 동결했고 typecheck/scoped diff check도 통과했다. 최종 증거: `/tmp/cad-native-task11-5kXlFW/integration-metadata-1789779877854.log`, Jest **2/2 PASS, 285.96초, exit 0**, disposable PG와 전용 bucket 정리 완료. 명령은 동일하게 `node /tmp/cad-native-task11-5kXlFW/run-integration.cjs`다.

| 정상 흐름 항목 | 2단지 | 킨다 |
| --- | ---: | ---: |
| region 수 | 197 | 1,817 |
| accepted 후보 / unassigned slot | 1,308 / 1,308 | 2 / 2 |
| editor 및 map revision slot 좌표/회전/source 검증 | PASS | PASS |
| Fixture / MeshNode 적용 전 → 후 | 0 → 0 / 0 → 0 | 0 → 0 / 0 → 0 |
| native manifest / unique tiled primitive | 447,876 / 447,876 | 29,160 / 29,152 |
| tile 수 / bytes | 803 / 274,348,120 | 875 / 6,459,340 |
| list 시간 / bytes / storage HEAD | 10.71 ms / 82,707 / 0 | 66.04 ms / 766,334 / 0 |
| 첫 / 선택 후 변환 ms | 2,437.01 / 2,355.33 | 2,430.10 / 2,396.69 |
| 첫 / 선택 후 core ms | 26,753.91 / 30,350.23 | 29,116.22 / 20,560.54 |
| 첫 / 선택 후 core RSS bytes | 677,167,104 / 952,631,296 | 600,817,664 / 628,424,704 |
| sample 측정 시간 ms | 169,393.60 | 109,876.47 |
| apply / post-apply editor-map-manifest | completed revision 1 / PASS | completed revision 1 / PASS |

Region/primitive/type/excluded/unsupported counts, map 크기와 manifest bytes는 아래 native-only 실행과 동일했다. 모든 candidate의 reviewStatus가 accepted이고 slot의 assignedFixtureId는 NULL이다. 모든 native tile의 private 다운로드·hash·codec 검증과 canonical manifest sourceBounds/transform 재조회도 그대로 통과했다. 이 하네스의 hardware count는 초기 0인 disposable DB에서 비교했으며, 기존 hardware 관계 보존은 별도 2,000-candidate PG lifecycle 회귀가 검증한다.

조명 후보를 slot으로 받는 것은 실장비 등록이 아니다. 따라서 하드웨어 자동 등록 방지를 위해 `candidateIds: []`를 사용할 필요는 없다. 앞선 실행은 native scene apply/readback만 증명하며, slot 정상 흐름 증거는 이 별도 실행 결과로 판단한다.

## Native-only 1차 PASS

명령: `node /tmp/cad-native-task11-5kXlFW/run-integration.cjs`. 증거: `/tmp/cad-native-task11-5kXlFW/integration-metadata-1789779327871.log`. Pascal의 mirrored-offset INSERT geometry anchor 보완과 exact scene INSERT를 포함한 backend 동결 상태다. 수동 API/shared rebuild 없이 현재 dist를 재사용했다. 기본 child heap 384 MiB, timeout 60초와 기존 테스트 예산을 유지했다. 두 disposable PG 및 실행 전용 MinIO bucket 정리가 끝났고 exit code 0이다.

| 항목 | 2단지 | 킨다 |
| --- | ---: | ---: |
| region/preview 수 | 197 | 1,817 |
| region primitive 합계 | 474,834 | 398,210 |
| region text 합계 | 13,834 | 2,745 |
| 전체/선택 조명 후보 | 1,308 / 1,308 | 2 / 2 |
| 제외 region primitive | 0 | 47 |
| parser excluded entity | 0 | 0 |
| unsupported occurrence | 32,488 | 1,271 |
| native manifest primitive (pre-clipping count) | 447,876 | 29,160 |
| 모든 tile의 unique element ID | 447,876 | 29,152 |
| native tile 수 | 803 | 875 |
| 중복 tile fragment 수 | 1,758,748 | 33,721 |
| tile bytes | 274,348,120 | 6,459,340 |
| manifest bytes | 260,904 | 281,623 |
| 논리 맵 크기 | 16,384 × 3,824 | 16,384 × 13,222 |
| list 시간 / bytes / storage HEAD | 9.94 ms / 82,707 / 0 | 62.20 ms / 766,334 / 0 |
| 첫 변환 / 선택 후 변환 | 2,365.51 / 2,501.01 ms | 2,275.76 / 2,307.41 ms |
| 첫 core / 선택 후 core | 27,028.26 / 30,036.62 ms | 26,427.56 / 21,851.79 ms |
| 첫 core / 선택 후 core 최대 RSS bytes | 670,105,600 / 952,631,296 | 632,553,472 / 589,529,088 |
| sample 측정 시간 | 166,155.97 ms | 112,168.02 ms |
| apply 및 editor/map/manifest 재조회 | PASS, revision 1 | PASS, revision 1 |

Native type 집계는 tile 전체에서 element ID를 deduplicate한 결과다.

| type | 2단지 | 킨다 |
| --- | ---: | ---: |
| line | 273,268 | 19,438 |
| rectangle | 15,619 | 102 |
| arc | 32,836 | 8,563 |
| ellipse | 6,803 | 593 |
| triangle | 703 | 2 |
| polyline | 104,870 | 114 |
| text | 13,777 | 340 |

모든 1,678개 tile의 private content 응답을 다운로드해 bytes/hash/codec/bounds를 검증했다. Manifest와 selected region은 정확한 bounds로 연결되며, apply 이후 실제 `FloorEditorService.getEditorState`와 `FloorMapService.getSnapshot/getCadSceneState` descriptor가 동일하다. Descriptor의 manifest content를 다시 조회해 JSON sourceBounds/transform equality를 확인했다. Raster preview만을 확인한 결과가 아니다. 후보 수는 review 목록 검증값이며 이번 native-map apply는 `candidateIds: []`로 수행해 후보 조명/하드웨어를 등록하지 않았다.

킨다의 manifest 29,160개와 tile unique ID 29,152개의 **8개 차이는 pre-clipping count와 실제 tile geometry의 차이**다. Pascal의 read-only 실제2 재실행 계측은 unfilled LWPOLYLINE rectangle 7개와 unfilled closed ARCH polyline 1개가 선택 영역과 AABB만 겹치고 실제 모든 외곽선은 map 밖에 있어 append 결과가 0임을 확인했다. 예: fill 없는 SHEET rectangle bounds `(-7930.936501,-3250.778187) → (22076.859757,17233.173519)`가 16,384 × 13,222 map 전체를 둘러싼다. `cad-scene-builder.ts`에서 AABB filter 이후 `selectedPrimitiveCount++`가 exact tile clipping보다 먼저 실행되는 순서를 본 담당자도 확인했다. 따라서 메모리 drop 또는 보이는 primitive 8개 유실로 해석하지 않는다. 하네스 통과 조건은 발행 tile 무결성과 native apply/readback이며 원본 전체 충실도는 아래 DXF ELLIPSE 등 미지원 때문에 여전히 주장하지 않는다. 384 MiB는 V8 heap 한도이지 RSS 한도가 아니며, 특히 2단지 selected core RSS는 952,631,296 bytes다. 운영 Linux cgroup/HIL 적합성을 이 macOS 실행으로 증명하지 않는다.

전체 region ID/bounds/count/area는 위 증거 로그의 두 `CAD_NATIVE_SAMPLE` JSON에 보존했다. 선택 ID는 아래 이전 실행과 동일하며 파일명 고정값이 아니라 후보 수, primitive 수, region ID 순서로 동적으로 선택했다. 후보 transform 매칭은 각각 1,308/1,308 및 2/2이고 최대 차이 0.00000108524 / 0.000000241813 px였다. 미지원 type별 내역은 아래 표와 동일하다.

8개 exterior-outline 진단은 Pascal의 inline `node --max-old-space-size=384` 계측 보고이며 별도 진단 파일은 보존하지 않았다. 입력은 `/tmp/cad-native-task11-5kXlFW/file-2/source.dxf`와 아래 보존 artifact의 selected region이고, `Module._compile`의 in-memory `appendPrimitiveToTiles` wrapper가 반환값 0인 primitive를 기록했다. 모두 `cad-element-` 접두사인 ID suffix는 `6dbe2cdba040b4da6881b7c2e1d85539`, `af768a8c40dfdc1797f815a6507af260`, `ba9e52b77e5d30d8517af4fb3620b569`, `a837c24fc71ac3fdc149d01aef779423`, `2381bc54c1fc76e5309f3bbb38ab0965`, `f01f4d18700e12ee75bf0ca70f8f7ea9`, `9d1a4a613e9b7960720e033f1c3572b8`, `3916095d6c1997fc78f77a4537b6320d`다. 이 진단은 제품 파일을 수정하지 않았다.

Pascal의 킨다 후보 보완은 block 원점이 자기 geometry 바깥이고 region association이 유일할 때 해당 occurrence의 변환된 geometry center를 사용한다. 원점을 clamp하거나 후보를 drop하거나 region을 확장하지 않는다. 보존된 production executor artifact `/var/folders/sk/rr4yfhkx75s3pxqxww01fqy80000gn/T/cad-anchor-actual-2-dHgr7b/response.json`에서 보고된 source anchor는 `E6EE3=(606511.707141182,-400414.0638758624)`, `E6EFB=(649011.7071411632,-376397.5635342024)`이며 selected map 좌표는 각각 `(3254.310214227866,6424.157228395881)`, `(11255.134184172712,1902.9386023293628)`다. 최종 full harness는 이 보완 이후 같은 region의 두 후보가 bounded executor 검증을 통과함을 확인했다.

## Scene Apply 보완

- `FloorCadScene` 신규 row는 source bounds와 transform 8개 값을 모두 parameterized string → double precision cast로 한 번에 INSERT한다. create-then-update, constraint 완화, 기존 데이터 rewrite는 없다. 같은 apply transaction 안에서 tile을 250개씩 저장한다.
- RED: 실제 fractional 1,817-region PG 회귀를 apply까지 확장하자 `floor CAD scene scope invariant violated`를 재현했다. Exact INSERT 후 constraint는 통과했으나 실제 `FloorMapService.getSnapshot`은 CAD plan의 raster imageUrl 때문에 schema 거부했다. 신규 native apply plan은 imageUrl 빈 문자열, renderedImageUrl NULL로 저장해 기존 scene-only 계약을 따른다. preview asset은 별도 보존한다.
- GREEN: disposable PostgreSQL lifecycle + import service + map service **57/57**, API typecheck 통과. Apply 후 SQL scene/region bounds exact equality, 실제 `FloorEditorService.getEditorState`, `FloorMapService.getSnapshot/getCadSceneState` descriptor 일치, private manifest JSON 재조회 후 sourceBounds/transform 일치까지 검증했다. Descriptor 자체는 bounds float를 싣지 않으며 canonical manifest content 경로를 제공한다.
- 실제 하네스에도 동일한 post-apply editor/map/manifest 검증과 실패 시 native metrics 보존을 추가했다. 최종 2/2 통과했고 runner 단위 테스트 4/4 및 scoped `git diff --check`도 통과했다. API 전체 회귀는 총괄이 별도 담당하며 이 focused 결과를 최신 전체 API 결과로 확대하지 않는다.

## 이전 동결 재실행 실패

최신 Pascal code와 exact-float region INSERT/read fix를 사용하고 backend 변경·API rebuild 없이 실행했다. 명령은 `node /tmp/cad-native-task11-5kXlFW/run-integration.cjs`, 전체 Jest 236.535초, **2 failed**다. 증거: `/tmp/cad-native-task11-5kXlFW/integration-metadata-1789778438182.log`. 두 전용 bucket과 disposable PG는 finally 정리를 마쳤다. 실제 사용자 DB는 이 하네스가 접근하지 않는다.

| 항목 | 2단지 | 킨다 |
| --- | ---: | ---: |
| region 수 | 197 | 1,817 |
| region list 시간 | 11.18 ms | 61.50 ms |
| region list JSON bytes | 82,707 | 766,334 |
| region list storage HEAD | 0 | 0 |
| 첫 core | 28,173.36 ms | 24,786.18 ms |
| 선택 후 core | 32,052.81 ms | 21,011.12 ms 후 거부 |
| 선택 region | `region-6f58e066398bb30039d8b292` | `region-2623d63be502a5bc0d356e2d` |
| 마지막 worker 상태 | `review_required` | `queued` (재시도 대상 오류) |
| apply | DB transaction rollback | 미도달 |

2단지는 private manifest와 **803개 native tile 전부** 다운로드·크기/hash·codec/bounds 검증을 통과한 뒤 `FloorImportService.apply` transaction commit에서 `floor CAD scene scope invariant violated`를 반환했다. Region precision은 해결됐지만 scene 생성의 `FloorCadScene.sourceMinX/sourceMinY/sourceMaxX/sourceMaxY`는 아직 Prisma Float create 경로를 사용하며 SQL invariant는 region bounds와 정확한 equality를 요구한다. 이는 동일 1-ULP 문제의 유력한 잔여 경계이며 아직 수정·재검증하지 않았다. 실패 로그 구조상 native primitive/type 집계는 apply 성공 전 보존되지 않았으므로 별도 Pascal 수치를 이 실행의 직접 측정값으로 대체하지 않는다.

킨다는 목록·선택 이후 executor가 `CAD core child process returned an invalid bounded manifest`를 반환했다. Pascal의 read-only 진단에서 `assertCoreManifest`는 통과하지만 `assertCoreArtifactContract`의 selected candidate 좌표 검증이 실패했다. 보존 artifact `/var/folders/sk/rr4yfhkx75s3pxqxww01fqy80000gn/T/cad-region-final-2-DeOtAL/response.json`을 직접 읽어 scene **16,384×13,222**에 대해 `E6EE3=(17748.7574571733,21719.64674626173)`, `E6EFB=(25749.58142712171,17198.428120319455)`가 범위 밖임을 확인했다. Related INSERT association에 따른 region 귀속과 candidate anchor/frame 정책이 일치하지 않는 문제이며 RSS·preview byte limit·DXF ELLIPSE·frontend renderer 실패가 아니다. Clamp/drop/검증 완화로 숨기지 않고 backend 동결을 유지했다. 별도 direct-core artifact 생성 성공은 executor 계약 통과나 실제 native apply 성공으로 해석하지 않는다.

따라서 metadata migration 준비/로컬 적용 및 API 회귀 통과와 **실제 native apply 실패**를 분리한다. 새 ELLIPSE 구현, backend LOD 변경, 한도/timeout 증가는 수행하지 않았다.

## 2026-09-19 재개 결과

승인된 metadata 보완은 `20260919160000_add_floor_import_region_preview_metadata` migration과 Prisma nullable counts/viewport, worker atomic persistence, storage-free 목록, 요청한 preview 한 개의 무결성 확인이다. 이 검증 담당자는 사용자 DB migration을 수행하지 않았다. 이후 총괄이 승인된 local `localhost/led_control`에 해당 migration을 적용했고 전체 93개, 기존 backup·사용자 데이터 보존·하드웨어 미변경을 보고했다. 이 사실은 총괄 보고이며 본 하네스는 계속 disposable PostgreSQL/전용 MinIO bucket만 사용한다. 기존 dirty edits를 보존했고 commit은 없다.

- 공통 region 상한 16,384개, 응답 UTF-8 JSON 16 MiB. 초과 시 잘라내지 않고 거부한다.
- Worker가 모든 PUT/HEAD 검증을 끝낸 뒤 ready assets·counts·preview dimensions·job 상태를 같은 transaction으로 저장한다. ID Map으로 선형 매칭한다.
- Legacy metadata NULL은 명시적 409/re-import이며 0으로 대체하지 않는다. 잘못된 선택 응답이면 selection transaction도 rollback한다.
- 실제 도면에서 Prisma 일반 Float write/read가 한 ULP를 바꾸는 문제를 확인했다. 예: `2961649.2519802507` → `2961649.251980251`. 250행 단위 parameterized INSERT의 string→float8 cast와 bounded SQL `float8::text` reader로 정확한 bounds를 보존한다. 비교 허용오차를 늘리지 않았다. 독립 재현: `/tmp/cad-native-task11-5kXlFW/float-probe.ts`.
- 검증: shared CAD contracts **32/32**, API focused service/assets/preview/SVG **91/91**, worker **8/8**, disposable PostgreSQL lifecycle **23/23**, API typecheck 통과. PG 회귀는 fractional bounds 1,817개 실제 worker persistence, 마지막 region 선택, storage HEAD 0회 목록, content 한 개 HEAD, 8개 손상 거부, legacy NULL rollback, SQL CHECK, 선택 후 scene 재실행을 포함한다.
- API 전체 실행은 **2,146 통과 / 523 환경 skip / 1 실패**였다. 227.419초 실행 중 Pascal의 POINT-preview 변경과 겹친 한 기대값 실패이며 최신 focused preview/SVG 23/23 재실행은 통과했다. 이것을 전체 API fresh green으로 확대하지 않는다.
- 이후 backend 동결 상태의 최종 전체 API 재실행은 **176 suites / 2,147 tests 통과, 523 환경 skip, 실패 0**, 113.96초로 통과했다. 명령: `pnpm --filter @led-control/api exec jest --maxWorkers=2 --silent --json --outputFile=/tmp/cad-native-task11-5kXlFW/api-final-regression.json`. Opt-in 실제 DWG 하네스 결과는 이 수치와 별도다.

실제 두 DWG 통합 1차 재실행 증거: `/tmp/cad-native-task11-5kXlFW/integration-metadata-1789777787537.log`. 원본 NFD 경로, 실제 dwgread, 기본 384 MiB child/60초, 실제 MinIO private bucket 및 disposable PG를 사용했다. **두 파일 모두 region_selection_required까지 도달했으나 위 Float 정밀도 assertion에서 중단**했다. 아래 수치는 scene/native primitive 수가 아닌 최초 region 단계의 실측이다.

| 항목 | 2단지 | 킨다 |
| --- | ---: | ---: |
| 영속화된 region/preview | 197 | 1,817 |
| region primitive 합계 | 474,834 | 398,210 |
| region text 합계 | 13,834 | 2,745 |
| 조명 후보 | 1,308 | 2 |
| 제외 region primitive | 0 | 47 |
| unsupported occurrence | 32,488 | 1,271 |
| DWG 변환 | 2,463.10 ms | 2,271.52 ms |
| 첫 core | 26,075.70 ms | 26,614.11 ms |
| child 관측 최대 RSS | 656,850,944 bytes | 604,454,912 bytes |
| 중단 전 하네스 | 31,078.51 ms | 39,516.99 ms |

384 MiB는 V8 heap 한도이며 프로세스 전체 RSS 한도가 아니다. Unsupported 분류는 원본 증거 JSON에 모두 보존했다. Pascal이 별도 selected-core로 보고한 native 447,876/29,160개는 본 담당자의 full apply 성공 증거가 아니다. 최신 지시에 따라 frontend runtime LOD 수정은 기다리지 않고 최종 하네스를 실행한다. Raster preview 성공을 editable native-map 완료로 취급하지 않는다.

### 원본 충실도 한계

실제 source 진단에서 DXF `ELLIPSE` 미지원 occurrence는 2단지 **29,692개**, 킨다 **224개**다. 현재 native `ellipse` primitive에는 `CIRCLE`에서 변환된 도형이 포함될 수 있으며, 이것이 DXF `ELLIPSE` 입력 지원을 증명하지는 않는다. 따라서 native primitive 수와 무결성 검증은 **현재 지원하는 geometry의 보존**에 관한 증거이며, 모든 원본 요소가 편집 가능한 native 요소로 보존됐다는 의미가 아니다. 원본 전체 충실도는 미달/미검증 상태로 남긴다.

DXF `ELLIPSE` 구현은 새 범위로 시작하지 않는다. 후속 후보는 major-axis vector·ratio·start/end parameter 정규화, affine bounds/traversal, sparse detector geometry, SVG preview, native ellipse/arc tessellation·편집 identity 및 회귀/실제 원본 재실행이다. 이는 제안된 후속 작업이며 구현 완료 항목이 아니다. 최신 사용자 지시는 renderer 보완을 frontend-runtime-only로 진행하고 backend LOD를 기다리지 않은 채 현재 Pascal code와 exact-float fix로 최종 native/apply 하네스를 실행하는 것이다.

## 최초 실패 이력

아래는 region detector 보완 전 증거로 현재 재개 결과와 구분한다.

- 기본 child heap 384 MiB에서 파싱·조명 후보 탐지 후 `detectCadRegions` 실행 중 V8 heap OOM, `SIGABRT`를 재현했다.
- 상위 executor 오류는 `CAD core child process returned an invalid response`다. child가 stdout을 쓰기 전에 종료해 실제 OOM이 가려진다.
- 제품 파일을 바꾸지 않고 heap만 1,024 MiB로 확대한 임시 진단에서도 두 파일 모두 `CAD region spatial bucket limit exceeded`로 실패했다. 메모리 상향만으로 해결되지 않는다.
- region 목록/bounds, region 제외 수, native primitive/manifest/tile 수는 **미산출**이다. 지원 geometry occurrence 수를 native primitive 수로 대체하거나 미산출 값을 0으로 보고하지 않는다.
- 실제 DWG native 적용 성공, 브라우저 편집 여정, 1,000 fixture viewport 성능 또는 전체 Task 11 완료로 판정할 수 없다.

## 환경과 안전 경계

- 저장소: `/Users/kim-jh/Documents/led-control-service`.
- 최초 확인 HEAD: `f124bbf1728b126362428591f4dddc5c0cfee564`. 진행 중인 다른 작업의 변경은 보존했다.
- macOS arm64, Node `v24.19.0`, 메모리 32 GiB. 운영 Linux cgroup/sidecar 또는 하드웨어 HIL 결과가 아니다.
- converter: `/opt/homebrew/bin/dwgread`, 출력 버전 `dwgread 0.14`.
- argv: `["-O","DXF","-o","{output}","{input}"]`.
- 실제 `ArgvCadConverter`의 macOS 개발용 output polling, 60초 timeout, DXF 최대 256 MiB를 사용했다.
- 실제 `ChildProcessCadCoreExecutor`와 API dist의 parser/detector/scene builder를 사용했다. 최초 확인한 주요 CAD source 9개의 수정 시각은 dist보다 앞섰다. 이후 승인에 따라 API 단독 `nest build`도 성공했다. shared를 빌드하지 않았다.
- 직접 core 검증은 DB·Redis·MinIO에 접속하지 않았다. 갱신한 통합 하네스는 ambient `DATABASE_URL`을 사용하지 않는 `disposablePostgres()`와 실행마다 새 `cad-native-test-*` MinIO bucket만 사용하며 마지막에 정리한다.
- 사용자 DB migration, 데이터 수정, 장비 연결 및 commit은 수행하지 않았다. 사용자 측에서 별도로 승인·실행한 migration은 이 검증의 작업에 포함하지 않는다.

## 원본 식별

Downloads의 실제 파일명을 `readdir`로 찾고 비교 시에만 NFC로 정규화했다. 입출력에는 원래 NFD 경로를 사용했다.

| 항목 | 2단지지하주차장전등설비합본평면도20260803.dwg | 킨다_도면등록_테스트.dwg |
| --- | ---: | ---: |
| 원본 bytes | 17,887,748 | 18,725,834 |
| 원본 SHA-256 | `01f25d539c20f93663c9183bbf70d83e578ae9990c2eb6dabb543bf39d71854d` | `ddbbecb9795a70b8fd2dfe550c6da7ffeeed10341e16fec1e43e30f13f20c811` |
| 서버 자동 profile | `site-drawing-20260803-v1` | `generic-lighting-v1` |
| DXF bytes | 105,432,404 | 106,680,873 |
| 최초 변환 시간 | 2,477.88 ms | 2,421.86 ms |
| 최초 기본 child 실패 시간 | 10,267.02 ms | 10,305.10 ms |

프로필은 파일명이나 임의 선택이 아니라 현재 `FixedLightingDetectorRegistry.resolve()`가 원본 SHA-256으로 결정했다.

## 실패 전 실제 측정값

아래 수치는 원본 알고리즘을 수정하지 않은 임시 단계 관측 wrapper의 384 MiB 재현에서 수집했다. 최종 API 응답이나 성공한 scene 통계가 아니다.

| 항목 | 2단지 | 킨다 |
| --- | ---: | ---: |
| 정규화된 model entity | 26,849 | 1,457 |
| block 정의 | 11,243 | 378 |
| 지원 geometry expanded occurrence | 474,834 | 398,257 |
| 조명 후보 | 1,308 | 2 |
| 후보 block | 몰드바등 | LED직부등 |
| parser primary-bounds 제외 occurrence | 0 | 0 |
| 도달 가능한 미지원 occurrence | 32,488 | 1,271 |
| 미지원 occurrence 비율 | 6.403822% | 0.318125% |
| 파싱 시간 | 7,127.13 ms | 7,332.88 ms |
| 후보 탐지 시간 | 1,070.44 ms | 557.44 ms |
| 관측 wrapper child 실패 시간 | 10,060.52 ms | 8,968.35 ms |
| region 목록과 bounds | 미산출 | 미산출 |
| excludedRegionPrimitiveCount | 미산출 | 미산출 |
| native primitive/manifest/tile | 미산출 | 미산출 |

비율의 분모는 `지원 expanded occurrence + 도달 가능한 미지원 occurrence`다. model entity 개수와 block 확장 occurrence는 서로 다른 단위다. 이 비율은 도면 전체 원시 레코드의 손실률, native builder 손실률, 또는 사람 ground truth 기준 정확도가 아니다. off/frozen/paper-space 및 정의 없는 INSERT 등 모든 제외 사유를 완전히 집계하는 값도 아니다. 후보의 precision/recall은 미검증이다.

### 파서 전체 bounds

다음은 **region bounds가 아니라** 파서의 전체 도면 bounds다.

| 파일 | minX | minY | maxX | maxY |
| --- | ---: | ---: | ---: | ---: |
| 2단지 | 2960965.095138 | -8179170.835789 | 10474248.359469 | 1096246.963231 |
| 킨다 | -12564019.344658 | -809012.421223 | 2523091.257263 | -321768.462658 |

### 미지원 항목

| 원본 type | 2단지 occurrence | 킨다 occurrence |
| --- | ---: | ---: |
| ATTDEF | 480 | 117 |
| ELLIPSE | 29,692 | 224 |
| HATCH | 0 | 28 |
| OLE2FRAME | 0 | 2 |
| RAY | 2 | 0 |
| REGION | 2 | 0 |
| SOLID | 826 | 658 |
| SPLINE | 1,482 | 242 |
| TRACE | 4 | 0 |

일부 SPLINE/HATCH는 지원 조건을 충족한 경우 별도로 정상 정규화되므로 이 표는 type 전체를 일괄 미지원이라고 뜻하지 않는다.

## 독립 진단

1,024 MiB 실행은 기본 제품 계약을 벗어난 **원인 분리용 진단**이다. 제품 설정이나 기본 executor 상한을 수정하지 않았고 이를 제품 통과 증거로 사용하지 않는다.

| 항목 | 2단지 | 킨다 |
| --- | ---: | ---: |
| child 전체 시간 | 10,011.97 ms | 9,348.73 ms |
| region 단계 실패 시간 | 1,381.64 ms | 1,020.19 ms |
| 오류 시 관측 RSS | 830,275,584 bytes | 744,603,648 bytes |
| 오류 | `CAD region spatial bucket limit exceeded` | 동일 |

관련 코드: `apps/api/src/floor-import/cad-runtime-contract.ts`의 384 MiB 상한, `cad-region-detector.ts`의 전체 expanded record 보관 및 기본 `maxSpatialBuckets=200000`, `addBucket` 초과 거부. 특정 도면의 수치에 맞춰 한도를 늘리거나 실패를 skip하지 않았다. 실제 대형 도면에 맞는 bounded region 탐지 개선 및 두 원본 회귀 검증이 필요하다.

## 반복 가능한 하네스

승인된 범위에서 기존 `cad-sample-pipeline.integration.spec.ts`, `scripts/run-cad-sample-pipeline.mjs`와 해당 runner 회귀 테스트를 갱신했다.

- 단일 `CAD_SAMPLE_DWG_PATH` 또는 다중 `CAD_SAMPLE_DWG_PATHS_JSON`을 받는다. 두 설정 동시 사용은 거부한다.
- `CAD_SAMPLE_REUSE_API_DIST=true`이면 dist 삭제, workspace/shared 준비, Prisma generate와 API rebuild를 모두 생략한다.
- 고정 원본 해시/1,308개/SVG-only 성공 기대값을 제거했다. 실제 서버 profile, region 목록, 후보 수와 선택된 region을 사용한다.
- 다중 region이면 조명 후보 수, primitive 수, region ID 순으로 결정한 하나를 선택한 후 worker를 다시 실행한다.
- 실제 private manifest/tile 다운로드, schema/크기/SHA-256/codec/bounds, 격리 DB native apply 및 `FloorCadScene`/`FloorPlan`을 검증한다. 인가 helper는 기존 테스트 방식의 stub이며 HTTP/브라우저 인증 검증이 아니다.
- 성공/실패 시 `CAD_NATIVE_SAMPLE` JSON으로 원본 식별, 변환·core 시간, worker 상태를 출력한다. 성공한 경우 실제 region/native/unsupported 통계를 추가한다.
- bucket과 임시 PostgreSQL은 실패해도 정리한다. 기존 사용자 bucket/DB에는 쓰지 않는다.

현재 두 NFD 파일을 찾아 실행하는 명령:

```bash
cd /Users/kim-jh/Documents/led-control-service
node /tmp/cad-native-task11-5kXlFW/run-integration.cjs
```

동일 runner를 일반적으로 사용할 때는 다음 환경변수를 설정한다. argv와 경로 외 자격 증명은 출력하지 않는다.

```bash
CAD_SAMPLE_DWG_PATHS_JSON='["<실제 첫 번째 경로>","<실제 두 번째 경로>"]' \
CAD_SAMPLE_CONVERTER_PATH=/opt/homebrew/bin/dwgread \
CAD_SAMPLE_CONVERTER_ARGV_JSON='["-O","DXF","-o","{output}","{input}"]' \
CAD_SAMPLE_REUSE_API_DIST=true RUN_OBJECT_STORAGE_INTEGRATION=true \
node scripts/run-cad-sample-pipeline.mjs
```

임시 증거 디렉터리: `/tmp/cad-native-task11-5kXlFW`.
`file-{1,2}/report.json`은 최초 제품 core 실행, `diagnostic-{384,1024}/stages.jsonl`·`execution.json`·`stderr.log`는 관측 재현, `integration.log`는 갱신한 통합 테스트 출력이다. 원본 DWG는 복사·수정하지 않았고 변환 DXF만 임시로 보관했다.

### 기존 DXF로 빠른 격리 재현

아래 명령은 DWG 변환, DB/MinIO 접속, 빌드를 생략한다. 현재 API dist의 실제 executor/child와 기본 heap/timeout을 그대로 사용한다. Watch build 완료 후 실행한다.

```bash
node /tmp/cad-native-task11-5kXlFW/core-existing.cjs /tmp/cad-native-task11-5kXlFW/file-1/source.dxf site-drawing-20260803-v1
node /tmp/cad-native-task11-5kXlFW/core-existing.cjs /tmp/cad-native-task11-5kXlFW/file-2/source.dxf generic-lighting-v1
```

각 실행은 `existing-core-*`에 `metrics.json` 및 성공한 경우 `detected.json`/`selected.json`과 native artifacts를 보관한다. 실패는 exit 1이며 child 종료 code/signal과 `FATAL ERROR`를 제한적으로 수집한다. Region 탐지가 성공하면 단일 영역 자동 선택 또는 통합 하네스와 동일한 다중 영역 선택 정책으로 scene 생성까지 실행한다. 이 보조 명령의 tile 전체 무결성/DB apply 검증은 위 통합 하네스가 담당한다.

## 초기 실패 재현 기록 (수정 전)

- API fresh build 후 실제 PostgreSQL/MinIO/worker 통합: **두 실제 DWG 모두 실패**, Jest 2 failed, 32.709초. DXF 변환은 2,456.93/2,256.57 ms, core 실패는 10,619.64/9,293.68 ms다. Worker가 retryable 실패를 `queued`로 되돌렸고 core 오류는 두 파일 모두 `CAD core child process returned an invalid response`였다. 하네스는 재시도 대기나 통과 처리 없이 core 오류를 실패로 보고한다. 생성한 두 PostgreSQL cluster와 MinIO bucket의 정리 과정은 오류 없이 완료됐다.
- runner 회귀: RED 2개 확인 후 **4/4 통과**.
- API 단독 build: **통과**. 이후 테스트 파일 변경에는 추가 product build를 하지 않았다.
- 갱신한 테스트를 포함한 API typecheck: **통과**.
- 기존 소형 DXF native child 통합: **1/1 통과**. 실제 두 DWG 성공을 대신하지 않는다.
- 갱신한 통합 하네스의 성공 경로 대조군: `valid-mixed-layout.dxf` 333 bytes를 임시 `control.dwg`로 복사하고 `/bin/cp`를 synthetic converter로 사용해 **1/1 통과**했다. 실제 격리 PostgreSQL/MinIO/worker/private manifest/tile/apply를 거쳤으며 region 1개, native primitive 2개, 후보 0개, tile 52개/15,086 bytes, manifest 17,043 bytes, 맵 16,384×9,830, `sourceType=cad`를 확인했다. Core 151.40 ms/최대 RSS 90,144,768 bytes, 하네스 측정 2,449.08 ms, Jest 전체 8.008초다. DWG converter 정확도 검증이나 두 실제 도면의 성공으로 확대하지 않는다.
- 빠른 기존-DXF 보조 명령도 같은 대조군에서 region/native 2개/tile 52개를 확인하고 exit 0으로 종료했다.
- 사용자 전달 API 전체 2,121 통과/520 환경 skip은 이 작업이 직접 실행한 전체 테스트 결과가 아니다.
- 브라우저 업로드/선택/편집/모니터링, desktop/mobile 1,000 fixture benchmark, 전체 lint/test는 이번 담당 범위에서 미실행이다.

## 인계 상태

### 2026-09-19 실제 적용 후 표시 실패 수정 (Task 14)

- 실제 사용자 Chrome `http://localhost:5173/settings/floor-plans/0d3a113e-f588-4648-b56e-727f4d6658fc/edit`에서 `CAD 맵을 표시하지 못했습니다`를 재현했다. API 적용과 editor-state/cad-scene은 200이지만 manifest 302 이후 타일 요청이 없었다. 임시 개발 진단으로 05:13:05 UTC의 ZodError `invalid_type` 2건을 확인했으며 진단 코드는 제거했다.
- 원인: 원시 저장 manifest에는 자신의 `byteSize`/`sha256`이 없고 서버 reader가 저장 원장으로 검증·보완한다. 기존 302는 그 결과를 버리고 원시 파일을 브라우저에 전달했다. API는 검증된 DTO를 200 JSON으로 반환하도록 수정했으며 권한·private/no-store·타일 302·무결성·8 MiB 응답 상한을 유지한다. 스키마 완화나 기존 원본 재작성은 없다.
- 실제 저장 데이터 읽기 전용 점검: 맵 리비전 17, scene `63b636c8-462f-5813-8bb9-d1bde4a1d91e`, 16,384×13,222, 고유 primitive 29,160개, 타일 875개, 기존 조명 4개/후보 슬롯 2개. Manifest 281,623 bytes의 크기·digest·저장소 checksum 일치, 876개 자산 ready, 타일 875개 전체 HEAD/GET/digest/codec 통과. 분할 타일의 33,721개 fragment는 고유 요소 수와 다르다. 증거 `/tmp/cad-scene-readonly-evidence-20260919.json`.
- 새 HTTP 회귀는 실제 builder 원시 파일을 실제 storage reader와 controller에 통과시킨다. 수정 전 200 기대/302 수신으로 RED를 확인하고, 수정 후 strict schema/원장 일치/Location 없음/no-store/viewer·admin/401·404/변조 503/타일 302를 검증했다. 집중 **92/92** 통과(격리 PostgreSQL 26개 포함), 타입 검사 통과. `/tmp/cad-manifest-http-focused-20260919.json`.
- 실제 사용자 Chrome에서 수정 후 다시 시도, 페이지 새로고침, 확대, 이동 도구 드래그, 맵 맞춤, 모니터링 표시, 편집기 복귀까지 직접 확인했다. 실제 주차장 선·텍스트·벽체가 보이며 오류 배너가 사라졌다. 화면 전후는 현재 작업의 브라우저 스크린샷에 기록했다. 이는 인증된 실제 API/저장소 조회이며 route fixture로 대체하지 않았다. 새 업로드/재적용/조명 제어는 하지 않았고 저장 리비전 17을 유지했다.
- 최종 API 전체 **2,163 통과/527 환경·opt-in 제외/실패 0**(112.32초), 타입 검사와 API 빌드 통과. 독립 리뷰 P1/P2 없음. `/tmp/cad-manifest-http-api-final-20260919.json`. 프론트 제품 코드는 변경하지 않았으며 사용자 브라우저의 실제 읽기 검증을 수행했다. 실장비·원본별 재변환 전체 여정은 이번 좁은 수정의 완료 조건에 포함하지 않는다.


### 2026-09-19 재적용 500 및 후보 검토 보정

- 실제 층의 첫 native 적용은 200, 두 번째 적용은 500이었으며 실패 작업은 `review_required`를 유지했다. 격리 PostgreSQL에서 `FloorCadScene.version=2` 삽입에 대한 SQL23514를 재현했다. 이 값은 교체 횟수가 아닌 manifest 형식 버전이므로 `manifest.version`을 유지하도록 수정했다. 신규 migration과 사용자 데이터 보정은 필요하지 않다.
- PostgreSQL 포함 집중 회귀 **56/56**: 같은 영역 반복 적용, 다른 크기의 영역, 후보 0개/선택 후보, 기존 슬롯·배정·override·layer·도형 교체와 후반 audit 오류의 전체 rollback을 확인했다. Fixture/MeshNode identity는 보존하며 적용 후 editor/map descriptor도 확인했다. API 전체 **2,163 통과/527 환경 제외/실패 0**, 타입 검사와 빌드 통과. 원시 결과는 `/tmp/cad-replacement-api-final-20260919.json`과 `/tmp/cad-replacement-focused-20260919.json`이다.
- 후보 검토는 전체 원본 SVG 대신 선택 영역 native scene을 중앙 편집 화면에 자동 맞춤으로 표시한다. 실제 적용 좌표의 후보를 클릭하고 확대·이동할 수 있다. 이전 맵과 배치 요소는 검토 중 숨기고 manifest/tile 실패 시 안내와 재시도를 제공한다. 별도 확대 팝업은 사용자 설계 답변 대기로 미구현이다.
- Web 전체 **1,614 통과/2 opt-in 제외**, 타입 검사·빌드 통과. Chromium **2/2** 여정은 기존 legacy 맵 읽기와 native 검토·적용·편집·새로고침·모니터링을 포함한다. 브라우저 API와 geometry는 route fixture이며 실제 사용자 계정 HTTP E2E로 확대하지 않는다. 화면 증거는 `.local/cad-native-qa/native-review-before-apply.png`, 브라우저 결과는 `.local/cad-native-qa/review-final-journeys`다.
- 실제 사용자 계정의 적용 재검증은 내장 브라우저 로그인 대기다. 이번 수정 과정에서는 사용자 맵/배치를 임의 적용·초기화하거나 실장비를 제어하지 않았다.

서버 차단 두 건은 수정 후 실제 두 원본의 모든 후보 적용·editor/map/manifest 재조회까지 통과했다. 로컬 DB는 사용자 승인 아래 백업 후 93개 migration을 적용했고 기존 데이터를 삭제하지 않았다. 개발 서버는 5173/4000에서 실행한다. 초기 실패 기록은 재발 방지 증거로 보존하며 현재 미해결 상태를 뜻하지 않는다.

남은 한계는 원본 DXF `ELLIPSE` 등 미지원 entity, 사람 ground truth에 의한 재현 정확도·조명 후보 precision/recall 미측정, 실제 iOS/Android WebView 성능 및 Linux 양산 컨테이너 실측이다. 새 네이티브 경로가 아닌 과거 가져오기 작업의 metadata는 임의 복구하지 않으므로 필요 시 CAD를 다시 가져온다. 첫 대형 도면 전체 표시는 약 10~13초이며 추가 초기 전송량 최적화 여지가 있다.
