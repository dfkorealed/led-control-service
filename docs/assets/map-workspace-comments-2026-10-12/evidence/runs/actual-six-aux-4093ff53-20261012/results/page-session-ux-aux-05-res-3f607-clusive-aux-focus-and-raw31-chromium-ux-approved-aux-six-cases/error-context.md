# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux-aux.spec.ts >> 05 resize without remount/reset >> 717x1227 to 390x844 light: exclusive aux, focus and raw31
- Location: .superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux-aux.spec.ts:427:7

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
                        - button "UX 조명 01 정상 70%" [ref=e86] [cursor=pointer]
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
                    - heading "선택 조명 0개" [level=3] [ref=e105]
                    - button "전체 보기" [ref=e106] [cursor=pointer]
          - complementary "밝기 실행" [ref=e107]:
            - region "제어 대상" [ref=e108]:
              - heading "제어 대상" [level=3] [ref=e110]
              - generic [ref=e111]:
                - strong [ref=e112]: 0개 선택
                - generic [ref=e113]:
                  - img [ref=e114]
                  - generic [ref=e116]: 제어 불가
            - generic [ref=e117]:
              - generic [ref=e118]:
                - generic [ref=e119]:
                  - generic [ref=e120]: 밝기
                  - generic [ref=e121]:
                    - textbox "밝기 수치" [ref=e124]: "70"
                    - generic [ref=e125]: "%"
                - group "밝기" [ref=e126]:
                  - slider "밝기" [ref=e134]: "70"
                - button "밝기 적용" [disabled] [ref=e136]: 적용
                - button "더보기" [ref=e137] [cursor=pointer]
              - status "제어 중요 상태" [ref=e139]: 제어 대상을 하나 이상 선택해 주세요.
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