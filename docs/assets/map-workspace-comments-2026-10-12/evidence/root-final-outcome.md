# 모니터링·수동 제어 신규8건 결과

현재 UI 제품 `e35c0c209fab13f9be17ed3dcda079d8de642efd`는 한정 검증과 독립 검토를 통과했다. 설정 담당자의 CAD 작업은 별도 브랜치/작업 폴더로 분리됐고 MAIN의 해당 변경이 빠진 것을 확인했다. 최신 committed MAIN a844는 UI 브랜치에만 7d48로 보존 통합했고 fresh 타입 검증을 통과했다. 제어 ea0019b1·모니터링 867a0c13은 제품 변경 없는 최종 메뉴 증거 갱신이다. MAIN에 남은 독립 배포 문서의 안전한 커밋 경계를 사용자 승인대로 원 배포 담당자와 협의 중이며, 아직 실제 MAIN 머지·정리 완료 기록이 아니다.

## 반영한 동작

- 모니터링과 수동 제어가 PC 중간 버튼 드래그 이동·좌클릭 선택, 모바일 swipe 이동/tap 선택 방식을 공유한다. 모니터링 영역 선택은 추가하지 않는다.
- 순수 snapshot60초 지연은 알람센터 현재 화면 상태로 안내한다. visible 모니터링 제목 제거/접근성 제목 유지, 층·검색/목록·시각·갱신 한 행과 좁은 화면 icon label을 유지한다.
- 모니터링 상세를 지도 하단 약 절반 nonmodal reader로 통일한다. maprect/camera/renderer 유지, 내부 scroll·닫기·Escape·실제 opener focus 복귀를 보존한다.
- PC 선택 패널은 empty도 전체 높이, 모바일은 선택 수→전체 보기와 단일 지도 하단 목록/More reader다. 두 reader는 동시에 열지 않고 지도 크기를 유지한다.
- 모바일 manual 전용 finite shell에서 지도 우선, floor/scope/list 및 숫자/slider/Apply/More 각각44px 한 행을 구성한다. 중요한 상태와 permission/UUID/raw invalid/첫 적용 차단/explicit 적용/query 수명은 유지한다.
- 실측 중 map0/62px·연속44 corner clip·slider endpoint 겹침을 원 담당자가 수리했다. 사용자 승인한 단일 보조 패널 표현을 적용했고 운영 인사이트는 변경하지 않았다.

## 최종 한정 실제 증거

| 고유 case | 마지막 실제 PASS source | 내용 |
| --- | --- | --- |
| 1 | 2290a877 | 모니터링PC1194×1227: 이동/선택·하단 상세·재열기/초점·지도 불변 |
| 2 | 2290a877 | 모니터링390×600 dark: 한 행/아이콘44·시각·상세 끝/native문서wheel |
| 3 | e35c0c20 | 수동320×600 light: 지도240+,0/1008hit·toolbar44·raw31·단일aux/끝/초점·invalid첫Apply0POST |
| 4 | 2290a877 | 수동390×600 dark/touch60: marker swipe/tap·60목록끝·aux전환·finite |
| 5 | f28ea638 | 수동717×1227→390×844: raw31/초점/renderer/camera·aux전환·resize |
| 6 | 4093ff53 | 수동PC1194×1227 dark60: empty전체높이·긴목록 내부끝·이력wrap |

이는 서로 다른 source의6고유 시나리오와 최소 후속 source delta를 결합한 판정이다. 새 e35 여섯 개 일괄PASS가 아니다. 독립 reviewer는 Monitoring/gesture/resize/PCfalse 경로 불변과 직접 회귀를 대조해 이 carry를 승인된 LEAN 범위에 충분하다고 판단했다.

e35 case3 최신 run은1PASS/0FAIL/exit0/20.149886s.11geometry/11PNG를 UX 담당자가 직접 확인했고 root는11geometry·대표PNG4개를 읽었다. 기본map302×251, 정상선택/reader302×269, invalid복원안내 후302×247로240 목표를 유지한다. aux중maprect/camera/canvas가 불변이며 docoverflow0. mapbox와 별도로 실제 기하 노출은 closed67722/list38052/More20309.5px²다. More끝229=384−155·Escape 실제opener 복귀·101첫클릭31복원/명령전송0을 확인했다.

## 직접·정적·독립 검토

- 기존 모니터링 owner 직접2suite127PASS(소프트웨어); 최신 제어 owner 직접5files81PASS/242비선택(exit0/wall23.927s/Vitest21.29s), 타입0/UIexisting0-new0. App-only69PASS 및 후속 타입0은 별도 test-only cohort다. 수를 합산하지 않는다.
- root e35 UI policy79PASS/0FAIL(exit0/39.088830584s), 타입 포함 buildexit0/Vite18.26s. main932.47KB chunkwarning은 원 상태로 유지한다.
- 같은 reviewer 최소delta/원raw/geometry/대표PNG 검토 새confirmedC/I/M0, UI source scopedReadyYes. MAIN 통합/backup/cleanup은 별도 미래 관문이다.
- 원 config-load/각actual FAIL·부분도달·각source 원로그/JSON/PNG/실행4source snapshot을 유지했다. 기준44/240·실제hit알고리즘·timeout·안전 assertion을 완화하지 않았다.

## 한계와 보존

Fake GET API와 native Chromium 입력을 사용했고 nonGET/POST0이다. 유효장비명령/실제history복구/liveAPI/실장비·Gateway/Mesh/HIL·물리OSkeyboard·pointerSliderdrag·전체Web/모든viewport/theme/모바일기기matrix는 실행하지 않았다. 마지막 recovery action별도bbox·invalidfeedback후새camera44 검사는 미첨부/미실행으로 명시한다. 모니터링 모바일은 수동 제어와 달리 문서wheel83px을 사용한 관측이며 finite무스크롤로 확대하지 않는다.

사용자 AGENTS와 독립 CAD/배포 작업·기존서비스5173/4000/63200은 유지한다. QA전용15188은 run후자연해제했다. remote/push/PR/deploy/DB 변경은 이 UI 작업의 범위가 아니다.

## 기존 세 가지 Ruling과 비용

1. 변경 직접검증·최종정적·한정actual·기존reviewer만 사용했다. 비용: 변경 밖 회귀를 놓칠 수 있어 미실행 범위를 명시했다.
2. source selector 확정 전에는 공통 수집부만 준비했다. 비용: 최종 연결 전 준비본은 실행 가능한 suite가 아니었다.
3. 사용자 실행 금지를 우선해 최종sourcegrant까지 대기했다. 비용: 대기 중 준비문법/runtime는 미검증이며 승인 후 별도로 확인했다.
