# 설정 자산·운영 데이터 안전성 설계

기준일: 2026-09-12

## 목적

설정 메뉴의 도면 자산을 공개 버킷과 장기 URL에서 분리하고, 업로드 원장을 장애와 현장 삭제 경합에도 회수 가능한 상태로 만든다. 설치 후 관리자가 현장·층·조명·구역의 최소 운영 정보를 직접 관리할 수 있게 하며, 운영자 삭제 UI와 일반 사용자 소속 정책을 서버 의미와 일치시킨다.

## 확정 결정

### 도면 자산 접근

- `floor-assets` 버킷은 anonymous download를 허용하지 않는다.
- DB에는 공개 URL을 저장하지 않고 인증된 same-origin 접근 경로만 저장한다.
- `GET /floors/:floorId/assets/:assetId/content`는 `read` 권한과 floor/asset 소속을 확인한 뒤 300초 signed GET으로 redirect한다.
- 조회 응답은 pending 자산을 제외하며, 다른 현장 사용자와 삭제된 자산은 opaque `404`를 받는다.
- signed URL은 `Cache-Control: private, no-store` 응답으로 전달하고 URL 자체를 DB, 감사 로그, 문서에 보존하지 않는다.

### 업로드 원장과 회수

- API는 MIME, 크기, checksum을 검증하고 object key를 생성한 뒤 PostgreSQL `FloorAsset(pending)`을 먼저 commit한다.
- commit 뒤 PUT URL을 서명한다. 서명 실패 시 pending 원장은 남아 sweeper가 회수한다.
- `FloorAsset.uploadExpiresAt`은 signed PUT의 최장 유효 시각이며, sweeper는 여유 시간 5초 뒤 pending object 삭제와 row 삭제를 재시도한다.
- intent 생성 transaction은 Site/Floor를 잠가 현장 삭제가 새 intent를 놓치지 않게 한다. 현장 삭제는 같은 Site 잠금 뒤 pending·ready object key 전체를 cleanup 원장에 복사한다.
- complete는 floor/asset 소속과 pending 상태를 잠근 뒤 S3 HEAD의 MIME, 길이, SHA-256을 검증하고 ready로 전환한다.

### 업로드 UI

- 맵 편집기 속성 영역에 PDF/JPG/PNG 파일 선택, 업로드, 교체, 제거를 제공한다.
- 브라우저가 SHA-256을 계산하고 intent → signed PUT → complete 순서로 호출한다.
- 업로드 중 저장·복구·층 전환·다른 업로드를 잠근다.
- 실패하면 기존 floor plan과 기존 자산을 그대로 유지하고 재시도할 수 있다.
- 성공한 자산만 편집 draft에 적용하며 최종 `editor-state` 저장 전까지 현재 운영 도면은 바뀌지 않는다.
- PDF는 원본 접근 경로를 보존하고 렌더링 이미지는 별도 ready asset이 있을 때만 배경으로 선택한다. 서버 렌더 worker가 없는 현재 단계에서는 PDF 원본을 업로드할 수 있지만 PDF 자체를 canvas 이미지로 사용하지 않는다.

### 설치 후 운영 데이터 관리

- `/settings/site`를 관리자 전용 운영 설정 화면으로 추가한다.
- 현장: 현장명, 주소, 시간대, 통화(`KRW`), kWh 단가를 수정한다.
- 층: 이름, level, 표시 순서, active/archive 상태를 관리한다. 조명 또는 활성 구역이 남은 층은 archive하지 못한다.
- 조명: 서버 pagination을 유지하며 이름과 정격전력만 수정한다. serial, Mesh 주소, 펌웨어와 인증 정보는 읽기 전용이다. 위치와 크기는 맵 편집기에서만 수정한다.
- 구역: 기존 생성·수정·retiring API를 재사용하고 운영 설정 화면에서 목록과 archive 진입점을 제공한다.
- 모든 write는 외부 capability 확인뿐 아니라 transaction 안의 Site 잠금 재인가를 거친다.

### 계정 소속 정책

- 현재 제품은 일반 사용자를 현장 아래에서 새로 생성하고 기존 계정을 다른 현장에 추가하지 않는다.
- 이 정책을 `SiteMembership.userId` unique index로 강제해 viewer 한 명이 여러 현장에 동시에 소속되는 상태를 금지한다.
- 따라서 `User.status` 비활성화와 영구 삭제는 현장 단위 UI 의미와 일치한다. 기존 DB에 다중 소속 viewer가 있으면 migration은 자동 선택하지 않고 식별 가능한 오류로 중단한다.

### 운영자 삭제 UI

- 운영자 목록의 command 이름을 `관리자 삭제`가 아니라 `현장 전체 삭제`로 표시한다.
- 확인 dialog는 현장, 관리자, 일반 사용자, 장비·자동화·통계 메타데이터 삭제와 외부 자산의 비동기 cleanup을 명시한다.
- 확인 입력은 현장명을 그대로 유지한다.

## 오류와 경합

- signed GET 생성 실패는 `503`으로 반환하며 공개 fallback을 사용하지 않는다.
- 업로드 presign 실패는 `503`이지만 pending 원장은 남는다.
- complete 중 metadata 불일치는 `400`, 다른 tenant나 삭제 경합은 opaque `404` 또는 `409`로 처리한다.
- Site 삭제와 intent 생성은 Site row lock으로 직렬화한다. S3 network call은 DB transaction 밖에서 수행한다.
- 설정 수정의 optimistic 충돌은 `expectedUpdatedAt` 또는 현재 row lock 검증으로 `409`를 반환한다.

## 검증

- Object storage unit/integration: anonymous GET 403, signed GET 200/300초, 만료 후 실패, delete 후 실패.
- API unit/integration: DB-first presign, presign 실패 pending 보존, sweeper 재시도, Site 삭제 경합, tenant/role 차단.
- Web unit/Chromium: PDF/JPG/PNG 선택, 업로드 잠금, 실패 후 기존 자산 보존, 성공 후 draft 적용, 운영 CRUD 정상 경로.
- Migration: clean replay, 다중 membership 없는 upgrade 성공, 다중 membership seed에서 rollback.
- 사용자 로컬 DB에는 migration을 적용하지 않고 disposable PostgreSQL에서만 검증한다.
