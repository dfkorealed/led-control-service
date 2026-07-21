# 모니터링 메뉴 기능 현황

기준일: 2026-07-21

## 구현 완료

- `GET /sites`는 로그인 사용자가 SiteAccess 권한으로 접근 가능한 현장의 고객사명과 현장명만 반환한다.
- `GET /sites/default/dashboard`는 접근 가능한 첫 현장을 반환하고, 접근 가능한 현장이 없을 때도 최초 설치 흐름을 위해 기존 빈 dashboard shape를 유지한다.
- `GET /sites/:siteId/dashboard`, 층별 fixture 조회, 기본 에너지 추정은 `AuthenticatedUser + SiteAccessService`로 현장 read 권한을 확인하며 미배정 또는 다른 고객사 현장은 `404`로 숨긴다.
- 현장이 없으면 service-provider `operator`에게 `초기 설치 설정` 마법사를 표시하고 customer `admin/viewer`에게는 `설치 담당자가 현장을 준비 중입니다` 상태를 표시한다.
- 현장은 있으나 등록된 조명이 없으면 `조명 등록` 패널을 표시한다.
- 로컬 실행에는 검색 결과 생성기가 없으며 Raspberry Pi/ESP32-H2가 꺼져 있으면 검색 결과 0개를 유지한다.
- 조명 등록 패널은 gateway scan/provisioning MQTT 흐름과 연결되어, 등록 완료 이벤트 후 dashboard polling으로 새 fixture를 표시할 수 있다.
- 층별 탭으로 지하/지상 층을 전환한다.
- 층별 2D 맵에 도면 이미지와 조명 위치를 표시한다.
- 조명 점은 기본 compact marker로 표시하고, 선택/hover/focus 시 상태, 밝기, 이름 카드로 확장하여 밀집 화면의 겹침을 줄인다.
- 조명 점의 접근성 라벨과 tooltip은 한국어 상태명(정상/오프라인/장애)을 사용한다.
- 선택 조명 상세 패널에 현재 밝기, 정격 전력, 마지막 수신, 해당 조명에 실제 매핑된 게이트웨이 이름/상태, RSSI, hop count, 명령 성공률을 표시한다.
- 선택 층 기준 전체 조명 수, 온라인 수, 장애 수, 평균 밝기를 표시한다.
- 장애 조명과 오프라인 조명을 점검 큐에서 바로 선택할 수 있다.
- 층 탭은 좁은 화면에서 가로 스크롤되고, 모바일 하단 내비게이션은 safe area 여백을 반영한다.
- MQTT `fixture-state` 이벤트가 fixture 최신 상태 snapshot을 갱신한다.
- MQTT `gateway-heartbeat` 이벤트가 gateway online/offline 상태 판단에 반영된다.
- dashboard query는 React Query로 3초마다 polling한다.
- 기본 dashboard는 fixture 본문을 제외한 현장/층/gateway metadata와 DB aggregate summary만 반환한다. 제어 화면만 `includeFixtures=true`를 명시한다.
- 모니터링 fixture snapshot은 `GET /floors/:floorId/fixtures`에서 현장 read 권한을 검증한 뒤 최대 200개씩 ID cursor로 조회하며, 선택 층의 다음 페이지를 연속 병합한다. 존재하지 않는 층과 접근할 수 없는 층은 같은 `floor not found` 404 응답으로 처리한다.
- `Fixture(floorId, id)` 복합 인덱스로 OFFSET 없이 대규모 fixture를 순회한다.
- Playwright deterministic 1,000 fixture/5-page 시나리오가 Chromium에서 1,000개 marker 렌더링을 검증한다.
- `pnpm benchmark:fixtures`는 실제 인증 cookie와 floor ID로 100회 측정해 API p95가 1초를 넘으면 실패한다.
- 모니터링 화면에서 `도면 편집` 버튼으로 선택 층의 전체 화면 에디터에 진입한다.
- 에디터에서 배경 없음, JPG/PNG 이미지, PDF 첫 페이지 렌더링 배경을 선택 등록한다.
- 도면 파일은 브라우저에서 SHA-256을 계산한 뒤 S3 호환 object storage presigned URL로 직접 업로드한다. PDF는 원본과 첫 페이지 PNG를 별도 asset으로 저장한다.
- API는 JPEG/PNG/PDF, 최대 50 MB, checksum을 검증하고 S3 HEAD가 일치한 ready asset URL만 FloorPlan에 저장한다. data URL과 임의 외부 URL은 거부한다.
- floor asset 목록은 현장 `read` 권한으로 조회하며, upload intent와 complete는 `manage` 권한으로 제한한다. 따라서 customer admin은 설치 후 도면을 교체할 수 있고 viewer는 변경할 수 없다.
- 에디터에서 지도 확대, 축소, 100% 복귀, 패닝을 수행한다.
- 에디터 캔버스는 `react-konva`/`Konva` 기반 Stage, Layer, Transformer로 도형과 조명을 렌더링한다.
- 에디터에서 좌측 도구의 네모, 세모, 선, 텍스트 도구를 도면 위로 드래그 앤 드롭해 기본 크기 도형을 추가한다.
- 에디터에서 좌측 도구를 선택한 뒤 도면 위를 드래그하면 사용자가 크기를 지정해 도형을 추가할 수 있다. 단순 클릭만으로는 도형을 생성하지 않는다.
- 에디터에서 도형의 선 색상, 채움 색상, 선 두께, 텍스트, 글자 크기를 수정한다.
- 에디터에서 생성된 도형/텍스트를 단일 선택한 뒤 드래그 이동과 모서리/변 Transformer 핸들 리사이즈를 수행한다.
- 에디터에서 조명 단일 선택, 마우스 포인터 위치를 기준으로 한 드래그 이동, Transformer 리사이즈, 조명명, 정격 전력, X/Y 좌표, 표시 크기 수정을 수행한다.
- 에디터 저장 시 `FloorPlan`, `FloorMapObject`, `Fixture` 변경 사항을 백엔드 API에 반영하고 dashboard query를 갱신한다.
- gateway scoped v2 fixture state와 heartbeat는 topic/payload/DB의 site·gateway 관계가 모두 일치할 때만 반영한다.
- v2 상태 이벤트는 영속 `eventId`와 gateway sequence를 사용하며 QoS 1 중복과 낮은 sequence 역전을 폐기한다.
- gateway는 재시작 후에도 event sequence를 파일 권한 `0600`으로 이어가며, 시작 시 heartbeat와 journal의 마지막 fixture 결과 snapshot을 재발행한다.
- heartbeat가 90초 이상 없으면 연결된 조명을 `gateway_offline`, fixture state가 120초 이상 없으면 해당 조명을 `fixture_stale` 사유로 offline 처리한다.
- dashboard gateway 연결 상태 기준을 서버 TTL과 동일한 90초로 통일하고 fixture의 `statusReason`을 API 응답에 포함한다.
- dashboard fixture 응답에 소유 gateway ID/이름/연결 상태와 `controllable`, `controlBlockReason`을 포함한다.
- Gateway startup resync는 전체 command 이력이 아니라 fixture별 최신 snapshot만 현재 발생 시각과 새 sequence로 발행한다.

## 미구현

- WebSocket/SSE 기반 push 실시간 업데이트
- 도면 버전 목록, 이전 버전 복원 UI
- 층별/구역별 통신 음영 heatmap
- 장애 이력, 장애 등급, 장애 원인 표시
- 알림 확인, 담당자 배정, 조치 완료 workflow
- 차량 감지 이벤트 표시
- 이벤트 타임라인
- 게이트웨이별 커버리지 표시
- 여러 게이트웨이가 같은 층을 담당할 때의 경로/coverage 시각화
- 조명 등록 중 provisioning 진행률 표시
- 조명 검색 실패 시 gateway offline, ESP32 provisioned 상태, BLE scan adapter 미설정 등 원인별 안내
- 모니터링 화면 내 빠른 밝기 제어
- AI 도면 해석 기반 에디터 객체 자동 생성

## 부족하거나 개선이 필요한 기능

- MinIO 기반 로컬 S3 integration test는 준비됐지만 현재 개발 머신에 Docker CLI가 없어 실제 실행 증거는 아직 없다.
- PDF는 첫 페이지만 배경 이미지로 렌더링한다. 다중 페이지 선택과 원본 PDF 파일 관리 UI는 후속 작업이다.
- 도형 삭제, 조명/도형 다중 선택과 일괄 이동, undo/redo는 아직 없다.
- 도형/조명 리사이즈는 Konva Transformer의 모서리/변 핸들 중심으로 제공한다. 향후 회전, grid snap, 키보드 미세 조정이 필요하다.
- CAD/DWG/DXF import와 AI 도면 해석은 후속 MVP 범위다.
- 현재 실시간성은 3초 polling이므로 대규모 현장에서는 서버 부하와 반응성 조정이 필요하다.
- 조명 등록 완료 후 dashboard 반영은 polling에 의존하므로, 실제 현장에서는 provisioning event 기반 push 업데이트가 필요하다.
- gateway offline 기준은 현재 90초, fixture stale 기준은 120초 고정값이다. 대규모 현장 검증 후 site/gateway별 정책 설정으로 분리해야 한다.
- `lastSeenAt` 상대 시간은 클라이언트 현재 시간 기준이므로 서버 기준 freshness와 완전히 일치하지 않을 수 있다.
- RSSI, hop count, 명령 성공률은 표시만 하며, 품질 등급이나 설치 가이드로 연결되지 않는다.
- 1,000개 marker 조회/렌더링 기준은 자동 검증하지만, 더 큰 현장에는 공간 클러스터링과 검색이 추가로 필요하다.
- 현재 선택 로직은 첫 장애 조명 또는 첫 조명을 자동 선택하므로, 사용자가 이전에 보던 조명을 유지하는 정책을 더 정교하게 만들 수 있다.

## 관련 파일

- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/monitoring/FloorMap.tsx`
- `apps/web/src/features/floor-editor/*`
- `apps/web/src/api/floor-editor.ts`
- `apps/web/src/api/queries.ts`
- `apps/api/src/floor-editor/*`
- `apps/api/src/sites/sites.controller.ts`
- `apps/api/src/sites/sites.service.ts`
- `apps/api/src/fixtures/fixtures.service.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/topic-scope.ts`
- `apps/api/src/fixtures/fixture-freshness.service.ts`
- `apps/gateway/src/state/event-sequence-store.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/mqtt.ts`

## 갱신 규칙

모니터링 메뉴의 UI, API, DB, MQTT, 실제 gateway, 펌웨어 계약이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
