# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux-aux.spec.ts >> 04 native touch and long exclusive auxiliary selection >> 390x600 dark: swipe0-tap1, long60 ending and list-More switch
- Location: .superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux-aux.spec.ts:380:7

# Error details

```
Error: Touch targets below 44px within [data-operation-map-panel] [role="group"][aria-label="지도 확대 축소"]

expect(received).toEqual(expected) // deep equality

- Expected  -  1
+ Received  + 34

- Array []
+ Array [
+   Object {
+     "geometryHeight": 44,
+     "geometryWidth": 44,
+     "hasMinimumArea": false,
+     "height": 44,
+     "label": "지도 축소",
+     "width": 43,
+   },
+   Object {
+     "geometryHeight": 44,
+     "geometryWidth": 47.625,
+     "hasMinimumArea": false,
+     "height": 44,
+     "label": "지도 배율 100%",
+     "width": 47,
+   },
+   Object {
+     "geometryHeight": 44,
+     "geometryWidth": 44,
+     "hasMinimumArea": false,
+     "height": 44,
+     "label": "지도 확대",
+     "width": 43,
+   },
+   Object {
+     "geometryHeight": 44,
+     "geometryWidth": 44,
+     "hasMinimumArea": false,
+     "height": 44,
+     "label": "지도 화면 맞춤",
+     "width": 44,
+   },
+ ]
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
        - button "라이트 모드로 변경" [active] [pressed] [ref=e41] [cursor=pointer]:
          - img [ref=e42]
    - generic [ref=e49]:
      - heading "조명 제어" [level=1] [ref=e50]
      - paragraph [ref=e51]: 수동 제어
      - tabpanel "수동 제어" [ref=e52]:
        - generic [ref=e53]:
          - region "제어 대상 지도" [ref=e54]:
            - region "공간 대상 선택" [ref=e55]:
              - generic [ref=e57]:
                - generic [ref=e58]:
                  - generic [ref=e60]: 표시 층
                  - generic [ref=e61]:
                    - button "표시 층" [ref=e62]:
                      - generic [ref=e63]: B2
                      - generic [ref=e64]: ▾
                    - combobox [ref=e67]
                - generic [ref=e68]:
                  - generic [ref=e70]: 선택 범위
                  - generic [ref=e71]:
                    - button "선택 범위" [ref=e72]:
                      - generic [ref=e73]: 개별 조명
                      - generic [ref=e74]: ▾
                    - combobox [ref=e77]
                - button "조명 목록" [ref=e78] [cursor=pointer]:
                  - img [ref=e79]
              - generic [ref=e80]:
                - generic [ref=e84]:
                  - region "B2 도면" [ref=e85]:
                    - generic [ref=e87]:
                      - generic:
                        - img
                      - generic [ref=e88]:
                        - button "UX 조명 01 정상 70%" [ref=e90] [cursor=pointer]
                        - button "UX 조명 02 정상 70%" [ref=e91] [cursor=pointer]
                        - button "UX 조명 03 정상 70%" [ref=e92] [cursor=pointer]
                        - button "UX 조명 04 정상 70%" [ref=e93] [cursor=pointer]
                        - button "UX 조명 05 정상 70%" [ref=e94] [cursor=pointer]
                        - button "UX 조명 06 정상 70%" [ref=e95] [cursor=pointer]
                        - button "UX 조명 07 정상 70%" [ref=e96] [cursor=pointer]
                        - button "UX 조명 08 정상 70%" [ref=e97] [cursor=pointer]
                        - button "UX 조명 09 정상 70%" [ref=e98] [cursor=pointer]
                        - button "UX 조명 10 정상 70%" [ref=e99] [cursor=pointer]
                        - button "UX 조명 11 정상 70%" [ref=e100] [cursor=pointer]
                        - button "UX 조명 12 정상 70%" [ref=e101] [cursor=pointer]
                        - button "UX 조명 13 정상 70%" [ref=e102] [cursor=pointer]
                        - button "UX 조명 14 정상 70%" [ref=e103] [cursor=pointer]
                        - button "UX 조명 15 정상 70%" [ref=e104] [cursor=pointer]
                        - button "UX 조명 16 정상 70%" [ref=e105] [cursor=pointer]
                        - button "UX 조명 17 정상 70%" [ref=e106] [cursor=pointer]
                        - button "UX 조명 18 정상 70%" [ref=e107] [cursor=pointer]
                        - button "UX 조명 19 정상 70%" [ref=e108] [cursor=pointer]
                        - button "UX 조명 20 정상 70%" [ref=e109] [cursor=pointer]
                        - button "UX 조명 21 정상 70%" [ref=e110] [cursor=pointer]
                        - button "UX 조명 22 정상 70%" [ref=e111] [cursor=pointer]
                        - button "UX 조명 23 정상 70%" [ref=e112] [cursor=pointer]
                        - button "UX 조명 24 정상 70%" [ref=e113] [cursor=pointer]
                        - button "UX 조명 25 정상 70%" [ref=e114] [cursor=pointer]
                        - button "UX 조명 26 정상 70%" [ref=e115] [cursor=pointer]
                        - button "UX 조명 27 정상 70%" [ref=e116] [cursor=pointer]
                        - button "UX 조명 28 정상 70%" [ref=e117] [cursor=pointer]
                        - button "UX 조명 29 정상 70%" [ref=e118] [cursor=pointer]
                        - button "UX 조명 30 정상 70%" [ref=e119] [cursor=pointer]
                        - button "UX 조명 31 정상 70%" [ref=e120] [cursor=pointer]
                        - button "UX 조명 32 정상 70%" [ref=e121] [cursor=pointer]
                        - button "UX 조명 33 정상 70%" [ref=e122] [cursor=pointer]
                        - button "UX 조명 34 정상 70%" [ref=e123] [cursor=pointer]
                        - button "UX 조명 35 정상 70%" [ref=e124] [cursor=pointer]
                        - button "UX 조명 36 정상 70%" [ref=e125] [cursor=pointer]
                        - button "UX 조명 37 정상 70%" [ref=e126] [cursor=pointer]
                        - button "UX 조명 38 정상 70%" [ref=e127] [cursor=pointer]
                        - button "UX 조명 39 정상 70%" [ref=e128] [cursor=pointer]
                        - button "UX 조명 40 정상 70%" [ref=e129] [cursor=pointer]
                        - button "UX 조명 41 정상 70%" [ref=e130] [cursor=pointer]
                        - button "UX 조명 42 정상 70%" [ref=e131] [cursor=pointer]
                        - button "UX 조명 43 정상 70%" [ref=e132] [cursor=pointer]
                        - button "UX 조명 44 정상 70%" [ref=e133] [cursor=pointer]
                        - button "UX 조명 45 정상 70%" [ref=e134] [cursor=pointer]
                        - button "UX 조명 46 정상 70%" [ref=e135] [cursor=pointer]
                        - button "UX 조명 47 정상 70%" [ref=e136] [cursor=pointer]
                        - button "UX 조명 48 정상 70%" [ref=e137] [cursor=pointer]
                        - button "UX 조명 49 정상 70%" [ref=e138] [cursor=pointer]
                        - button "UX 조명 50 정상 70%" [ref=e139] [cursor=pointer]
                        - button "UX 조명 51 정상 70%" [ref=e140] [cursor=pointer]
                        - button "UX 조명 52 정상 70%" [ref=e141] [cursor=pointer]
                        - button "UX 조명 53 정상 70%" [ref=e142] [cursor=pointer]
                        - button "UX 조명 54 정상 70%" [ref=e143] [cursor=pointer]
                        - button "UX 조명 55 정상 70%" [ref=e144] [cursor=pointer]
                        - button "UX 조명 56 정상 70%" [ref=e145] [cursor=pointer]
                        - button "UX 조명 57 정상 70%" [ref=e146] [cursor=pointer]
                        - button "UX 조명 58 정상 70%" [ref=e147] [cursor=pointer]
                        - button "UX 조명 59 정상 70%" [ref=e148] [cursor=pointer]
                        - button "UX 조명 60 정상 70%" [ref=e149] [cursor=pointer]
                  - group "지도 확대 축소" [ref=e150]:
                    - button "지도 축소" [ref=e151] [cursor=pointer]:
                      - img [ref=e152]
                    - button "지도 배율 100%" [ref=e153] [cursor=pointer]: 100%
                    - button "지도 확대" [ref=e154] [cursor=pointer]:
                      - img [ref=e155]
                    - button "지도 화면 맞춤" [ref=e156] [cursor=pointer]:
                      - img [ref=e157]
                - region "선택 대상 목록" [ref=e164]:
                  - generic [ref=e165]:
                    - heading "선택 조명 0개" [level=3] [ref=e166]
                    - button "전체 보기" [ref=e167] [cursor=pointer]
          - complementary "밝기 실행" [ref=e168]:
            - region "제어 대상" [ref=e169]:
              - heading "제어 대상" [level=3] [ref=e171]
              - generic [ref=e172]:
                - strong [ref=e173]: 0개 선택
                - generic [ref=e174]:
                  - img [ref=e175]
                  - generic [ref=e177]: 제어 불가
            - generic [ref=e178]:
              - generic [ref=e179]:
                - generic [ref=e180]:
                  - generic [ref=e181]: 밝기
                  - generic [ref=e182]:
                    - textbox "밝기 수치" [ref=e185]: "70"
                    - generic [ref=e186]: "%"
                - group "밝기" [ref=e187]:
                  - slider "밝기" [ref=e195]: "70"
                - button "밝기 적용" [disabled] [ref=e197]: 적용
                - button "더보기" [ref=e198] [cursor=pointer]
              - status "제어 중요 상태" [ref=e200]: 제어 대상을 하나 이상 선택해 주세요.
```

# Test source

```ts
  277 |         const pointerTarget = document.elementFromPoint(column.sample, row.sample);
  278 |         return pointerTarget === element || (pointerTarget ? element.contains(pointerTarget) : false);
  279 |       }));
  280 | 
  281 |       let maximumWidth = 0;
  282 |       for (const row of hitGrid) {
  283 |         let width = 0;
  284 |         row.forEach((reachable, columnIndex) => {
  285 |           width = reachable ? width + columns[columnIndex].size : 0;
  286 |           maximumWidth = Math.max(maximumWidth, width);
  287 |         });
  288 |       }
  289 | 
  290 |       let maximumHeight = 0;
  291 |       columns.forEach((_, columnIndex) => {
  292 |         let height = 0;
  293 |         rows.forEach((row, rowIndex) => {
  294 |           height = hitGrid[rowIndex][columnIndex] ? height + row.size : 0;
  295 |           maximumHeight = Math.max(maximumHeight, height);
  296 |         });
  297 |       });
  298 | 
  299 |       for (let topRow = 0; topRow < rows.length; topRow += 1) {
  300 |         const reachableColumns = columns.map(() => true);
  301 |         let height = 0;
  302 |         for (let bottomRow = topRow; bottomRow < rows.length; bottomRow += 1) {
  303 |           height += rows[bottomRow].size;
  304 |           reachableColumns.forEach((_, columnIndex) => {
  305 |             reachableColumns[columnIndex] &&= hitGrid[bottomRow][columnIndex];
  306 |           });
  307 |           if (height < 44) continue;
  308 | 
  309 |           let width = 0;
  310 |           for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
  311 |             width = reachableColumns[columnIndex] ? width + columns[columnIndex].size : 0;
  312 |             if (width >= 44) {
  313 |               return {
  314 |                 width: maximumWidth,
  315 |                 height: maximumHeight,
  316 |                 hasMinimumArea: true,
  317 |                 geometryWidth: rect.width,
  318 |                 geometryHeight: rect.height
  319 |               };
  320 |             }
  321 |           }
  322 |           // More rows can only remove reachable columns, so this top edge cannot
  323 |           // produce a 44x44 candidate after its first 44px-high slice fails.
  324 |           break;
  325 |         }
  326 |       }
  327 | 
  328 |       return {
  329 |         width: maximumWidth,
  330 |         height: maximumHeight,
  331 |         hasMinimumArea: false,
  332 |         geometryWidth: rect.width,
  333 |         geometryHeight: rect.height
  334 |       };
  335 |     }
  336 | 
  337 |     const targetElements = roots.flatMap((root) => [
  338 |       ...(root.matches(args.interactiveTargetSelector) ? [root] : []),
  339 |       ...root.querySelectorAll(args.interactiveTargetSelector)
  340 |     ]);
  341 | 
  342 |     return [...new Set(targetElements)].flatMap((element) => {
  343 |       if (args.excludeSpatialMapMarkers && element.closest("[data-spatial-map-marker='true']")) return [];
  344 |       if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return [];
  345 |       const sliderThumb = element instanceof HTMLInputElement && element.type === "range"
  346 |         ? element.closest("[data-slider-thumb]")
  347 |         : null;
  348 |       const isNativeChoice = element instanceof HTMLInputElement
  349 |         && (element.type === "checkbox" || element.type === "radio");
  350 |       const associatedLabels = isNativeChoice ? [...(element.labels ?? [])] : [];
  351 |       const hitCandidates = sliderThumb ? [sliderThumb] : isNativeChoice ? [...associatedLabels, element] : [element];
  352 |       const measurements = [...new Set(hitCandidates)].flatMap((hitTarget) => {
  353 |         const hitRect = usableVisibleRect(hitTarget);
  354 |         if (!hitRect) return [];
  355 |         return [measureReachableArea(hitTarget, hitRect)];
  356 |       });
  357 |       if (measurements.length === 0) return [];
  358 |       const passingMeasurement = measurements.find(({ hasMinimumArea }) => hasMinimumArea);
  359 |       const bestMeasurement = passingMeasurement ?? measurements.reduce((best, measurement) => {
  360 |         const bestMinimumDimension = Math.min(best.width, best.height);
  361 |         const measurementMinimumDimension = Math.min(measurement.width, measurement.height);
  362 |         if (measurementMinimumDimension !== bestMinimumDimension) {
  363 |           return measurementMinimumDimension > bestMinimumDimension ? measurement : best;
  364 |         }
  365 |         return measurement.width * measurement.height > best.width * best.height ? measurement : best;
  366 |       });
  367 |       const label = element.getAttribute("aria-label")
  368 |         ?? (isNativeChoice ? associatedLabels.map((labelElement) => labelElement.textContent?.trim()).find(Boolean) : null)
  369 |         ?? element.textContent?.trim()
  370 |         ?? element.tagName;
  371 |       return [{ label, ...bestMeasurement }];
  372 |     });
  373 |   }, { interactiveTargetSelector, excludeSpatialMapMarkers });
  374 | 
  375 |   expect(targets.length, `Expected at least one visible enabled interactive target within ${rootSelector}`).toBeGreaterThan(0);
  376 |   const undersized = targets.filter(({ hasMinimumArea }) => !hasMinimumArea);
> 377 |   expect(undersized, `Touch targets below 44px within ${rootSelector}`).toEqual([]);
      |                                                                         ^ Error: Touch targets below 44px within [data-operation-map-panel] [role="group"][aria-label="지도 확대 축소"]
  378 | }
  379 | 
```