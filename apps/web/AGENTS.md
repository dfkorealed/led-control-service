# 웹 프론트엔드 작업 규칙

## 소유 역할과 범위

- 담당 역할은 `web_frontend`다.
- 기본 수정 범위는 `apps/web`이다. React 화면, React Query, Zustand, 라우팅, Konva 에디터와 브라우저 사용자 흐름을 소유한다.
- 공통 버튼과 카드 등 재사용 UI는 기존 공통 컴포넌트 구조를 사용한다.
- 화면 명세와 디자인 토큰 변경은 `designer`와 합의한다.

## 공유 계약

- `packages/shared`, API 요청·응답, 인증, MQTT, Prisma 스키마는 공유 계약이다.
- 공유 계약을 직접 변경하지 않는다. 필요한 변경과 호환성 영향을 총괄에게 보고해 승인을 받고, `backend` 등 소유 역할의 선행 변경이 완료된 뒤 웹을 순차 적용한다.

## 검증

변경 범위에 맞춰 저장소 루트에서 다음 명령을 실행한다.

```bash
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web test
pnpm --filter @led-control/web build
```

로그인, 등록, 모니터링, 제어, 설정처럼 사용자 흐름이 바뀌면 관련 Playwright 시나리오를 추가하거나 수정하고 다음 명령으로 검증한다.

```bash
pnpm --filter @led-control/web exec playwright test
```

## 문서

- 메뉴 기능 변경과 같은 작업에서 영향받는 `docs/menus/*.md`를 갱신한다.
- mock 또는 브라우저 자동화 결과를 실제 게이트웨이·조명 HIL 완료로 기록하지 않는다.
- DB 구조 변경이 필요하면 직접 수정하지 않고 `backend`에 요청한다.
