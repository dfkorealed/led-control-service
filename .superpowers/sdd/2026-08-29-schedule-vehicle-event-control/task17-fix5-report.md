# Task 17 Fix Round 5 보고서

기준일: 2026-08-31

## 수정 내용

- Shared artifact logical path는 host OS와 무관하게 POSIX `/` 상대 경로만 허용한다. `:` 또는 `\`가 하나라도 있는 path는 정규화하지 않고 거부하므로 drive absolute/relative, UNC/device namespace, alternate data stream과 mixed separator가 POSIX에서도 fail-closed한다.
- 기존 absolute path, `..`, `.`, empty entry/component, NUL, duplicate와 directory target 거부를 유지한다. Windows에서 별칭이 될 수 있는 terminal dot/space segment도 거부한다.
- Recursive compiler output 목록과 ESM prefix는 `node:path.posix`로 logical path를 만들고 실제 filesystem 접근 시에만 host separator로 변환한다. 따라서 Windows host에서도 정상 generated artifact가 backslash path로 오인되지 않는다.
- 동일한 path 목록 검증을 generated file 수집, preflight, cleanup, copy, generated metadata, manifest read와 manifest write 경계에서 다시 적용한다. Manifest write는 검증된 목록만 직렬화한다.

## TDD RED

`packages/shared/src/package-exports.test.ts`에 13개 portable path case를 `it.each` 표로 먼저 추가했다. 각 case는 build 실패뿐 아니라 기존 `dist/existing.js`와 외부 sentinel이 변경되지 않았는지 함께 검증한다.

기존 `01f90bf` 구현에서 focused 21건 중 8건이 실패했다. Upper/lower drive-relative path, root/nested ADS, 일반 backslash, mixed separator, terminal dot과 terminal space가 POSIX에서 build 성공으로 수락됐다. Drive absolute, UNC와 device prefix는 기존 검사로 이미 거부됐다.

## GREEN 검증

- Focused Shared package export/cleanup: 1파일 21/21 통과
- Shared 전체: 8파일 96/96, build와 typecheck 통과
- Packed isolated consumer: 실제 `pnpm pack` archive의 root/subpath ESM·CJS `safeParse`, declaration와 ESM metadata 확인 통과
- Portable path 표: upper/lower drive absolute/relative, ADS, UNC, Win32 device namespace/path, backslash/mixed separator와 terminal dot/space를 mutation 전에 거부하고 기존 artifact·외부 sentinel 보존
- Web focused: 5파일 80/80, 전체: 32파일 334/334, typecheck와 lint 통과
- Web production build와 bundle audit: 2,370 modules, main `1,028.66 kB / gzip 313.70 kB`, schedule `76.11 kB / gzip 20.12 kB`
- API: typecheck, build, CommonJS root/narrow subpath valid payload import와 built main syntax smoke 통과
- Gateway: typecheck, build, root ESM-to-CJS/narrow ESM valid payload import와 output syntax smoke 통과, bundle `504.9 kB`
- `git diff --check`: 통과

## 호환성과 남은 범위

- 정상 generated path와 manifest는 기존 POSIX ASCII 상대 경로를 그대로 사용한다. CJS `dist`와 executable `dist/esm`, package exports와 packed ESM/CJS consumer 동작은 변경되지 않았다.
- Fix Round 4에 기록한 적대적 concurrent parent-swap TOCTOU 제한은 동일하다. 이번 수정은 path syntax의 host별 해석 차이를 mutation 전에 제거한다.
- Production API/Gateway Chromium software E2E와 실제 Raspberry Pi/BlueZ/ESP32-H2 RF HIL은 이번 build path fix 범위에서 실행하지 않았다.
