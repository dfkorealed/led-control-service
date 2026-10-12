# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux-aux.spec.ts >> 03 narrow finite manual workspace >> 320x600 light: map240, native0/100, first Apply and exclusive auxiliaries
- Location: .superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux-aux.spec.ts:344:7

# Error details

```
Error: Actual target must contain a reachable continuous44 square: {"target":{"tag":"INPUT","role":null,"ariaLabel":"밝기 수치","name":"밝기 수치","bounds":{"x":8,"y":480,"width":48,"height":44,"right":56,"bottom":524}},"width":48,"height":44,"continuous44":false}

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - navigation "모바일 주 메뉴" [ref=e4]:
    - link "모니터링" [ref=e6] [cursor=pointer]:
      - /url: /monitoring?siteId=12121212-1212-4121-8121-121212121212&mode=manual
      - img [ref=e7]
      - generic [ref=e9]: 모니터링
    - link "제어" [ref=e11] [cursor=pointer]:
      - /url: /control?siteId=12121212-1212-4121-8121-121212121212&mode=manual
      - img [ref=e12]
      - generic [ref=e13]: 제어
    - link "통계" [ref=e15] [cursor=pointer]:
      - /url: /statistics/overview?siteId=12121212-1212-4121-8121-121212121212&mode=manual
      - img [ref=e16]
      - generic [ref=e18]: 통계
    - link "설정" [ref=e20] [cursor=pointer]:
      - /url: /settings?siteId=12121212-1212-4121-8121-121212121212&mode=manual
      - img [ref=e21]
      - generic [ref=e24]: 설정
  - main [ref=e25]:
    - generic [ref=e26]:
      - generic [ref=e27]: 제어
      - generic "현장 정보" [ref=e28]:
        - img "킨다" [ref=e29]:
          - img [ref=e30]
          - strong [ref=e31]: 킨다
        - paragraph [ref=e32]: 고객사 B2 현장
        - generic [ref=e33]: 고객사 B2 현장
      - generic [ref=e34]:
        - button "알람센터, 확인 불가" [ref=e36] [cursor=pointer]:
          - img [ref=e37]
          - generic [ref=e40]: "?"
        - button "다크 모드로 변경" [ref=e41] [cursor=pointer]:
          - img [ref=e42]
    - generic [ref=e45]:
      - heading "조명 제어" [level=1] [ref=e46]
      - paragraph [ref=e47]: 수동 제어
      - tabpanel "수동 제어" [ref=e48]:
        - generic [ref=e49]:
          - region "제어 대상 지도" [ref=e50]:
            - region "공간 대상 선택" [ref=e51]:
              - generic [ref=e53]:
                - generic [ref=e54]:
                  - generic [ref=e56]: 표시 층
                  - generic [ref=e57]:
                    - button "표시 층" [ref=e58]:
                      - generic [ref=e59]: B2
                      - generic [ref=e60]: ▾
                    - combobox [ref=e63]
                - generic [ref=e64]:
                  - generic [ref=e66]: 선택 범위
                  - generic [ref=e67]:
                    - button "선택 범위" [ref=e68]:
                      - generic [ref=e69]: 개별 조명
                      - generic [ref=e70]: ▾
                    - combobox [ref=e73]
                - button "조명 목록" [ref=e74] [cursor=pointer]:
                  - img [ref=e75]
              - generic [ref=e76]:
                - generic [ref=e80]:
                  - region "B2 도면" [ref=e81]:
                    - generic [ref=e83]:
                      - generic:
                        - img
                      - generic [ref=e84]:
                        - button "UX 조명 01 정상 70% 선택됨" [pressed] [ref=e86] [cursor=pointer]
                        - button "UX 조명 02 정상 70%" [ref=e87] [cursor=pointer]
                        - button "UX 조명 03 정상 70%" [ref=e88] [cursor=pointer]
                  - group "지도 확대 축소" [ref=e89]:
                    - button "지도 축소" [ref=e90] [cursor=pointer]:
                      - img [ref=e91]
                    - button "지도 배율 100%" [ref=e92] [cursor=pointer]: 100%
                    - button "지도 확대" [ref=e93] [cursor=pointer]:
                      - img [ref=e94]
                    - button "지도 화면 맞춤" [ref=e95] [cursor=pointer]:
                      - img [ref=e96]
                - region "선택 대상 목록" [ref=e103]:
                  - generic [ref=e104]:
                    - heading "선택 조명 1개" [level=3] [ref=e105]
                    - button "전체 보기" [ref=e106] [cursor=pointer]
          - complementary "밝기 실행" [ref=e107]:
            - region "제어 대상" [ref=e108]:
              - heading "제어 대상" [level=3] [ref=e110]
              - generic [ref=e111]:
                - strong [ref=e112]: 1개 선택
                - generic [ref=e113]:
                  - img [ref=e114]
                  - generic [ref=e117]: 전송 가능
            - generic [ref=e118]:
              - generic [ref=e119]:
                - generic [ref=e120]:
                  - generic [ref=e121]: 밝기
                  - generic [ref=e122]:
                    - textbox "밝기 수치" [ref=e125]: "0"
                    - generic [ref=e126]: "%"
                - group "밝기" [ref=e127]:
                  - slider "밝기" [active] [ref=e134]: "0"
                - button "1개 조명에 밝기 적용" [ref=e136] [cursor=pointer]: 적용
                - button "더보기" [ref=e137] [cursor=pointer]
              - generic:
                - status "제어 중요 상태"
```

# Test source

```ts
  25  |     const r = element.getBoundingClientRect();
  26  |     let left = Math.max(0, r.left), top = Math.max(0, r.top);
  27  |     let right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
  28  |     for (let parent = element.parentElement; parent; parent = parent.parentElement) {
  29  |       if (parent === document.body || parent === document.documentElement) continue;
  30  |       const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
  31  |       if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
  32  |         left = Math.max(left, clip.left + parent.clientLeft);
  33  |         right = Math.min(right, clip.left + parent.clientLeft + parent.clientWidth);
  34  |       }
  35  |       if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
  36  |         top = Math.max(top, clip.top + parent.clientTop);
  37  |         bottom = Math.min(bottom, clip.top + parent.clientTop + parent.clientHeight);
  38  |       }
  39  |     }
  40  |     if (right <= left || bottom <= top) throw new Error("Native input target has no exposed geometry");
  41  |     const excluded = '[data-floor-map-surface],[data-testid$="map-viewport"],[data-monitoring-detail-scroll],aside[aria-label="조명 상세"],[data-shell-navigation],button,a,input,select,textarea,[role="button"],[role="dialog"],[role="alertdialog"]';
  42  |     for (const yr of [0.5, 0.1, 0.9, 0.02, 0.25, 0.75]) {
  43  |       for (const xr of [0.5, 0.1, 0.9, 0.25, 0.75, 0.02, 0.98]) {
  44  |         const x = left + (right - left) * xr, y = top + (bottom - top) * yr;
  45  |         const hit = document.elementFromPoint(x, y);
  46  |         if (!hit || !element.contains(hit)) continue;
  47  |         if (forDocument) {
  48  |           if (hit.closest(excluded)) continue;
  49  |           let innerScroll = false;
  50  |           for (let node: Element | null = hit; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
  51  |             if (["auto", "scroll"].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) innerScroll = true;
  52  |           }
  53  |           if (innerScroll) continue;
  54  |         }
  55  |         return { x, y, tag: hit.tagName, label: hit.closest("[aria-label]")?.getAttribute("aria-label") ?? null };
  56  |       }
  57  |     }
  58  |     throw new Error(forDocument ? "No exposed native document-wheel origin" : "No exposed native input point");
  59  |   }, documentWheel);
  60  | }
  61  | 
  62  | /** Direct continuous 44×44 hit proof, including a disabled Apply. The existing
  63  |  * shared helper intentionally skips disabled controls; we must not silently
  64  |  * skip the first-Apply geometry or lower the threshold at slider endpoints. */
  65  | export async function expectContinuous44Hit(target: Locator) {
  66  |   await expect(target).toBeVisible();
  67  |   const result = await target.evaluate(element => {
  68  |     const r = element.getBoundingClientRect();
  69  |     // Diagnostic metadata only: preserve every clipping/sample/44px decision.
  70  |     // A thumb's name can live on its nested native range input; the tag still
  71  |     // identifies the actual outer target rather than substituting that input.
  72  |     const namingElement = element.matches("[aria-label],[aria-labelledby]") ? element : element.querySelector("[aria-label],[aria-labelledby]") ?? element;
  73  |     const labelledName = (namingElement.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)
  74  |       .map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
  75  |     const diagnosticTarget = {
  76  |       tag: element.tagName, role: element.getAttribute("role"), ariaLabel: element.getAttribute("aria-label"),
  77  |       name: namingElement.getAttribute("aria-label") || labelledName || element.textContent?.trim() || null,
  78  |       bounds: { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
  79  |     };
  80  |     let left = Math.max(0, r.left), top = Math.max(0, r.top);
  81  |     let right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
  82  |     for (let parent = element.parentElement; parent; parent = parent.parentElement) {
  83  |       if (parent === document.body || parent === document.documentElement) continue;
  84  |       const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
  85  |       if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
  86  |         left = Math.max(left, clip.left + parent.clientLeft);
  87  |         right = Math.min(right, clip.left + parent.clientLeft + parent.clientWidth);
  88  |       }
  89  |       if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
  90  |         top = Math.max(top, clip.top + parent.clientTop);
  91  |         bottom = Math.min(bottom, clip.top + parent.clientTop + parent.clientHeight);
  92  |       }
  93  |     }
  94  |     const width = right - left, height = bottom - top;
  95  |     if (width < 44 || height < 44) return { target: diagnosticTarget, width, height, continuous44: false };
  96  |     const segments = (start: number, end: number) => {
  97  |       const cells: { size: number; at: number }[] = [];
  98  |       for (let current = start; current < end;) {
  99  |         const next = Math.min(current + 1, end);
  100 |         cells.push({ size: next - current, at: (current + next) / 2 }); current = next;
  101 |       }
  102 |       return cells;
  103 |     };
  104 |     const columns = segments(left, right), rows = segments(top, bottom);
  105 |     const hits = rows.map(row => columns.map(column => {
  106 |       const hit = document.elementFromPoint(column.at, row.at);
  107 |       return hit !== null && element.contains(hit);
  108 |     }));
  109 |     for (let first = 0; first < rows.length; first++) {
  110 |       const reachable = columns.map(() => true); let runHeight = 0;
  111 |       for (let last = first; last < rows.length; last++) {
  112 |         runHeight += rows[last].size;
  113 |         for (let column = 0; column < columns.length; column++) reachable[column] &&= hits[last][column];
  114 |         if (runHeight < 44) continue;
  115 |         let runWidth = 0;
  116 |         for (let column = 0; column < columns.length; column++) {
  117 |           runWidth = reachable[column] ? runWidth + columns[column].size : 0;
  118 |           if (runWidth >= 44) return { target: diagnosticTarget, width, height, continuous44: true };
  119 |         }
  120 |         break;
  121 |       }
  122 |     }
  123 |     return { target: diagnosticTarget, width, height, continuous44: false };
  124 |   });
> 125 |   expect(result.continuous44, `Actual target must contain a reachable continuous44 square: ${JSON.stringify(result)}`).toBe(true);
      |                                                                                                                        ^ Error: Actual target must contain a reachable continuous44 square: {"target":{"tag":"INPUT","role":null,"ariaLabel":"밝기 수치","name":"밝기 수치","bounds":{"x":8,"y":480,"width":48,"height":44,"right":56,"bottom":524}},"width":48,"height":44,"continuous44":false}
  126 |   return result;
  127 | }
  128 | 
```