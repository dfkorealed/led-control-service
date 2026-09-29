# 모니터링 탐색·시야 개선 — 승인된 수정 설계

2026-09-29 사용자 시안 검토 후 수정사항 반영 및 직접 구현 승인. 기존 디자이너 세션과 협업하며 새 서브에이전트를 사용하지 않는다. 기준 `codex/mvp1-cloud-web` / `0a8dcd52`, 작업 `codex/monitoring-navigation-confidence`.

## 승인 범위

1. 현장 전체 KPI는 읽기 전용, 선택 맵의 전체 조명/정상/점검 필요/오프라인 KPI는 목록 필터와 지도 강조를 연결한다. 목록 선택 시 저장 배치 위치로 이동하고 현재 배율을 유지한다. 미배치/불명 위치는 상세에서 안내하고 가짜 좌표로 이동하지 않는다.
2. 기존 수동 장치 새로고침과 오류 안내는 유지한다. 새로 제안한 상태 확인 결과 기능(버튼·집계·결과 드로어)은 전부 제외한다. 새 API·타이머·DB·장비 변경은 없다.
3. 핀과 상세는 이름·상태·원인·권장 조치·실제 마지막 수신 밝기/시각만 표시한다. 기술 정보 표시 자체를 제거한다(좌표·정격 전력·게이트웨이·RSSI·Hop·Health 세부·명령 성공률·기술 접기 없음). 미관측 밝기는 확인 전, offline은 최근 확인 밝기다. BIO 설정을 실제 관측으로 대체하지 않는다.
4. 전체 보기 모드는 shell chrome·현장 KPI를 접고 맵 선택·상태 필터·검색·새로고침·기존 활동을 남긴다. 진입/종료는 아이콘 전용이며 ‘집중’ 텍스트가 없다. 접근성 이름은 `지도 전체 보기`/`전체 보기 종료`다. 같은 지도/renderer/선택/카메라를 유지한다.
5. 사용자 principal·현장·맵별 최근 중심과 배율을 기억한다. 정규화 중심0~1, 맞춤 상대 배율0.1~4, 30일/사용자50개/300ms debounce/미래5분 초과 거부. common generationId+width/height, legacy revision+width/height로 복원을 검증한다. storage 오류는 메모리 fallback. 선택/필터/전체 보기/장비 상태/인증 자료는 저장하지 않는다.
6. 핀/상세 닫기에서 문서·지도 scroll 및 카메라가 움직이지 않는다. focus 복귀에는 preventScroll을 사용하고 닫기 때문에 map 높이가 변경되지 않는다. 팝업은 공통 경계 충돌 회피를 사용한다. 작은 화면에서도 마커·내용·닫기 대상이 보이며 최소44px 도구를 유지한다.

## 데이터·공통 계약

- KPI는 서버 floor.summary이며 cursor 일부 행으로 역산하지 않는다. 목록 필터는 fixture.status와 동일한 분류다(상태 설명 presenter의 원인 우선순위가 아님).
- 200개 페이지 연속 조회를 유지하고 다음 페이지 실패 시 자동 반복을 중지한다. 로드 중에는 빈 결과를 확정하지 않고 부분 실패/수동 재시도를 제공한다. 전체 조회 후 집계와 목록 수가 다르면 이전 숫자를 덮지 않고 갱신 필요를 안내한다.
- common snapshot.fixtures가 위치 정본이다. runtime-only fallback은 legacy에만 유지한다. 미조회 snapshot 핀은 상태를 offline/0%로 추정하지 않는다.
- 공통 viewport에 카메라 get/restore/center/fit과 opt-in resize 보존, scene에 anchor callback/강조/미관측 표시를 추가한다. 제어·설정 기본 동작은 유지한다.
- 재사용 KPI 버튼·내용은 components/ui에 모으고 기술 정보용 primitive를 만들지 않는다. 모니터링의 큰 View에는 연결 상태만 두며 필터/카메라 저장/상세 표시를 분리한다.
- ‘맵 선택’은 select 옆, 새로고침은 오른쪽 끝, 중복 지도 제목·등록 버튼·인시던트·점검 큐·모니터링 제어는 추가하지 않는다. 20px 네모 마커·밝기10단계·작은 우상단 배지·설정 저장 도형·권한을 유지한다.

## 구현·검증 경계

별도 checkout에서 작업하고 기본 메인의 기존 문서 WIP·실행 중 API/Web을 변경하지 않는다. native worktree 도구는 이 채팅의 비Git 폴더로 인해 사용 불가였으므로 ignored .worktrees 경로에 Git fallback을 사용했다.

실제 React 코드의 TDD와 Chromium에서 1440/1024/390/320px, KPI→뒤쪽 페이지→위치→팝업→상세→닫기, 전체 보기 전후 지도 인스턴스 유지, Escape 우선순위, 카메라 복원/범위 격리, overlay 닫기 scroll 변화0을 검증한다. root lint/typecheck/test/build, Web UI policy를 실행한다. 실패·경고를 숨기지 않는다. 실제 조명 전원 차단/복구와 모바일 WebView HIL은 별도이며 운영 배포·DB 변경·push는 포함하지 않는다. 후속 사용자 지시에 따라 별도 브랜치 검증 뒤 `codex/mvp1-cloud-web`에 로컬 병합한다.
