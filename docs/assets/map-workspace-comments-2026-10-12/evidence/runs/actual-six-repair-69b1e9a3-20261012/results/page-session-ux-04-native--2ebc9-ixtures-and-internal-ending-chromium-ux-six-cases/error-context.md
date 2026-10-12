# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux.spec.ts >> 04 native touch and long inline selection >> 390x600 dark: swipe then tap, 60 fixtures and internal ending
- Location: ../../.superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux.spec.ts:248:7

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

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
        - button "라이트 모드로 변경" [pressed] [ref=e41] [cursor=pointer]:
          - img [ref=e42]
      - region "현장 전체" [ref=e48]:
        - heading "현장 전체" [level=2] [ref=e49]
        - paragraph [ref=e50]: 고객사 B2 현장
        - generic [ref=e51]:
          - generic [ref=e52]:
            - term [ref=e53]: 전체
            - definition [ref=e54]: 60대
          - generic [ref=e55]:
            - term [ref=e56]: 온라인
            - definition [ref=e57]: 60대
          - generic [ref=e58]:
            - term [ref=e59]: 장애
            - definition [ref=e60]: 0대
          - generic [ref=e61]:
            - term [ref=e62]: 오프라인
            - definition [ref=e63]: 0대
    - generic [ref=e65]:
      - heading "조명 제어" [level=1] [ref=e66]
      - tablist "제어 방식" [ref=e67]:
        - generic [ref=e68]:
          - tab "수동 제어" [selected] [ref=e69] [cursor=pointer]:
            - generic [ref=e70]:
              - img [ref=e72]
              - generic [ref=e73]: 수동 제어
          - tab "스케줄 제어" [ref=e74] [cursor=pointer]:
            - generic [ref=e75]:
              - img [ref=e77]
              - generic [ref=e81]: 스케줄 제어
          - tab "이벤트 제어" [ref=e82] [cursor=pointer]:
            - generic [ref=e83]:
              - img [ref=e85]
              - generic [ref=e88]: 이벤트 제어
          - tab "그룹/구역" [ref=e89] [cursor=pointer]:
            - generic [ref=e90]:
              - img [ref=e92]
              - generic [ref=e96]: 그룹/구역
      - tabpanel "수동 제어" [ref=e97]:
        - generic [ref=e98]:
          - region "제어 대상 지도" [ref=e99]:
            - region "공간 대상 선택" [ref=e100]:
              - generic [ref=e102]:
                - generic [ref=e103]:
                  - generic [ref=e104]: 표시 층
                  - generic [ref=e105]:
                    - button "표시 층" [ref=e106]:
                      - generic [ref=e107]: B2
                      - generic [ref=e108]: ▾
                    - combobox [ref=e111]
                - generic [ref=e112]:
                  - generic [ref=e113]: 선택 범위
                  - generic [ref=e114]:
                    - button "선택 범위" [ref=e115]:
                      - generic [ref=e116]: 층 전체
                      - generic [ref=e117]: ▾
                    - combobox [ref=e120]
                - button "조명 목록" [ref=e121] [cursor=pointer]:
                  - img [ref=e122]
              - generic [ref=e123]:
                - generic [ref=e124]:
                  - group "B2 도면 조명 상태" [ref=e127]:
                    - generic [ref=e128]:
                      - generic [ref=e130]: 전체
                      - strong [ref=e131]: "60"
                    - generic [ref=e132]:
                      - generic [ref=e134]: 정상
                      - strong [ref=e135]: "60"
                    - generic [ref=e136]:
                      - generic [ref=e138]: 장애
                      - strong [ref=e139]: "0"
                    - generic [ref=e140]:
                      - generic [ref=e142]: 오프라인
                      - strong [ref=e143]: "0"
                  - generic:
                    - generic:
                      - generic:
                        - region "B2 도면":
                          - generic [ref=e146]:
                            - 'button "UX 조명 01 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e148]'
                            - 'button "UX 조명 02 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e149]'
                            - 'button "UX 조명 03 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e150]'
                            - 'button "UX 조명 04 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e151]'
                            - 'button "UX 조명 05 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e152]'
                            - 'button "UX 조명 06 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e153]'
                            - 'button "UX 조명 07 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e154]'
                            - 'button "UX 조명 08 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e155]'
                            - 'button "UX 조명 09 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e156]'
                            - 'button "UX 조명 10 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e157]'
                            - 'button "UX 조명 11 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e158]'
                            - 'button "UX 조명 12 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e159]'
                            - 'button "UX 조명 13 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e160]'
                            - 'button "UX 조명 14 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e161]'
                            - 'button "UX 조명 15 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e162]'
                            - 'button "UX 조명 16 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e163]'
                            - 'button "UX 조명 17 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e164]'
                            - 'button "UX 조명 18 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e165]'
                            - 'button "UX 조명 19 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e166]'
                            - 'button "UX 조명 20 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e167]'
                            - 'button "UX 조명 21 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e168]'
                            - 'button "UX 조명 22 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e169]'
                            - 'button "UX 조명 23 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e170]'
                            - 'button "UX 조명 24 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e171]'
                            - 'button "UX 조명 25 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e172]'
                            - 'button "UX 조명 26 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e173]'
                            - 'button "UX 조명 27 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e174]'
                            - 'button "UX 조명 28 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e175]'
                            - 'button "UX 조명 29 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e176]'
                            - 'button "UX 조명 30 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e177]'
                            - 'button "UX 조명 31 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e178]'
                            - 'button "UX 조명 32 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e179]'
                            - 'button "UX 조명 33 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e180]'
                            - 'button "UX 조명 34 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e181]'
                            - 'button "UX 조명 35 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e182]'
                            - 'button "UX 조명 36 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e183]'
                            - 'button "UX 조명 37 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e184]'
                            - 'button "UX 조명 38 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e185]'
                            - 'button "UX 조명 39 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e186]'
                            - 'button "UX 조명 40 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e187]'
                            - 'button "UX 조명 41 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e188]'
                            - 'button "UX 조명 42 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e189]'
                            - 'button "UX 조명 43 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e190]'
                            - 'button "UX 조명 44 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e191]'
                            - 'button "UX 조명 45 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e192]'
                            - 'button "UX 조명 46 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e193]'
                            - 'button "UX 조명 47 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e194]'
                            - 'button "UX 조명 48 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e195]'
                            - 'button "UX 조명 49 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e196]'
                            - 'button "UX 조명 50 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e197]'
                            - 'button "UX 조명 51 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e198]'
                            - 'button "UX 조명 52 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e199]'
                            - 'button "UX 조명 53 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e200]'
                            - 'button "UX 조명 54 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e201]'
                            - 'button "UX 조명 55 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e202]'
                            - 'button "UX 조명 56 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e203]'
                            - 'button "UX 조명 57 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e204]'
                            - 'button "UX 조명 58 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e205]'
                            - 'button "UX 조명 59 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e206]'
                            - 'button "UX 조명 60 정상 70% 선택됨 선택 불가: 구성원을 변경하려면 직접 선택으로 전환하세요." [disabled] [pressed] [ref=e207]'
                        - generic [ref=e208]:
                          - generic [ref=e209]:
                            - generic "지도 조명 상태 범례":
                              - generic: 정상
                              - generic: 장애
                              - generic: 오프라인
                              - generic: 선택
                          - group "지도 확대 축소" [ref=e210]:
                            - button "지도 축소" [ref=e211] [cursor=pointer]:
                              - img [ref=e212]
                            - button "지도 배율 180%" [ref=e213] [cursor=pointer]: 180%
                            - button "지도 확대" [ref=e214] [cursor=pointer]:
                              - img [ref=e215]
                            - button "지도 화면 맞춤" [ref=e216] [cursor=pointer]:
                              - img [ref=e217]
                - generic [ref=e222]:
                  - region "선택 대상 목록" [ref=e224]:
                    - generic [ref=e225]:
                      - heading "선택 조명 60개" [level=3] [ref=e226]
                      - button "접기" [expanded] [active] [ref=e227] [cursor=pointer]
                    - generic [ref=e228]:
                      - button "선택 해제" [ref=e229] [cursor=pointer]
                      - list "선택 조명" [ref=e230]:
                        - listitem "45454545-4545-4454-8454-000000000001" [ref=e231]: UX 조명 01
                        - listitem "45454545-4545-4454-8454-000000000002" [ref=e232]: UX 조명 02
                        - listitem "45454545-4545-4454-8454-000000000003" [ref=e233]: UX 조명 03
                        - listitem "45454545-4545-4454-8454-000000000004" [ref=e234]: UX 조명 04
                        - listitem "45454545-4545-4454-8454-000000000005" [ref=e235]: UX 조명 05
                        - listitem "45454545-4545-4454-8454-000000000006" [ref=e236]: UX 조명 06
                        - listitem "45454545-4545-4454-8454-000000000007" [ref=e237]: UX 조명 07
                        - listitem "45454545-4545-4454-8454-000000000008" [ref=e238]: UX 조명 08
                        - listitem "45454545-4545-4454-8454-000000000009" [ref=e239]: UX 조명 09
                        - listitem "45454545-4545-4454-8454-000000000010" [ref=e240]: UX 조명 10
                        - listitem "45454545-4545-4454-8454-000000000011" [ref=e241]: UX 조명 11
                        - listitem "45454545-4545-4454-8454-000000000012" [ref=e242]: UX 조명 12
                        - listitem "45454545-4545-4454-8454-000000000013" [ref=e243]: UX 조명 13
                        - listitem "45454545-4545-4454-8454-000000000014" [ref=e244]: UX 조명 14
                        - listitem "45454545-4545-4454-8454-000000000015" [ref=e245]: UX 조명 15
                        - listitem "45454545-4545-4454-8454-000000000016" [ref=e246]: UX 조명 16
                        - listitem "45454545-4545-4454-8454-000000000017" [ref=e247]: UX 조명 17
                        - listitem "45454545-4545-4454-8454-000000000018" [ref=e248]: UX 조명 18
                        - listitem "45454545-4545-4454-8454-000000000019" [ref=e249]: UX 조명 19
                        - listitem "45454545-4545-4454-8454-000000000020" [ref=e250]: UX 조명 20
                        - listitem "45454545-4545-4454-8454-000000000021" [ref=e251]: UX 조명 21
                        - listitem "45454545-4545-4454-8454-000000000022" [ref=e252]: UX 조명 22
                        - listitem "45454545-4545-4454-8454-000000000023" [ref=e253]: UX 조명 23
                        - listitem "45454545-4545-4454-8454-000000000024" [ref=e254]: UX 조명 24
                        - listitem "45454545-4545-4454-8454-000000000025" [ref=e255]: UX 조명 25
                        - listitem "45454545-4545-4454-8454-000000000026" [ref=e256]: UX 조명 26
                        - listitem "45454545-4545-4454-8454-000000000027" [ref=e257]: UX 조명 27
                        - listitem "45454545-4545-4454-8454-000000000028" [ref=e258]: UX 조명 28
                        - listitem "45454545-4545-4454-8454-000000000029" [ref=e259]: UX 조명 29
                        - listitem "45454545-4545-4454-8454-000000000030" [ref=e260]: UX 조명 30
                        - listitem "45454545-4545-4454-8454-000000000031" [ref=e261]: UX 조명 31
                        - listitem "45454545-4545-4454-8454-000000000032" [ref=e262]: UX 조명 32
                        - listitem "45454545-4545-4454-8454-000000000033" [ref=e263]: UX 조명 33
                        - listitem "45454545-4545-4454-8454-000000000034" [ref=e264]: UX 조명 34
                        - listitem "45454545-4545-4454-8454-000000000035" [ref=e265]: UX 조명 35
                        - listitem "45454545-4545-4454-8454-000000000036" [ref=e266]: UX 조명 36
                        - listitem "45454545-4545-4454-8454-000000000037" [ref=e267]: UX 조명 37
                        - listitem "45454545-4545-4454-8454-000000000038" [ref=e268]: UX 조명 38
                        - listitem "45454545-4545-4454-8454-000000000039" [ref=e269]: UX 조명 39
                        - listitem "45454545-4545-4454-8454-000000000040" [ref=e270]: UX 조명 40
                        - listitem "45454545-4545-4454-8454-000000000041" [ref=e271]: UX 조명 41
                        - listitem "45454545-4545-4454-8454-000000000042" [ref=e272]: UX 조명 42
                        - listitem "45454545-4545-4454-8454-000000000043" [ref=e273]: UX 조명 43
                        - listitem "45454545-4545-4454-8454-000000000044" [ref=e274]: UX 조명 44
                        - listitem "45454545-4545-4454-8454-000000000045" [ref=e275]: UX 조명 45
                        - listitem "45454545-4545-4454-8454-000000000046" [ref=e276]: UX 조명 46
                        - listitem "45454545-4545-4454-8454-000000000047" [ref=e277]: UX 조명 47
                        - listitem "45454545-4545-4454-8454-000000000048" [ref=e278]: UX 조명 48
                        - listitem "45454545-4545-4454-8454-000000000049" [ref=e279]: UX 조명 49
                        - listitem "45454545-4545-4454-8454-000000000050" [ref=e280]: UX 조명 50
                        - listitem "45454545-4545-4454-8454-000000000051" [ref=e281]: UX 조명 51
                        - listitem "45454545-4545-4454-8454-000000000052" [ref=e282]: UX 조명 52
                        - listitem "45454545-4545-4454-8454-000000000053" [ref=e283]: UX 조명 53
                        - listitem "45454545-4545-4454-8454-000000000054" [ref=e284]: UX 조명 54
                        - listitem "45454545-4545-4454-8454-000000000055" [ref=e285]: UX 조명 55
                        - listitem "45454545-4545-4454-8454-000000000056" [ref=e286]: UX 조명 56
                        - listitem "45454545-4545-4454-8454-000000000057" [ref=e287]: UX 조명 57
                        - listitem "45454545-4545-4454-8454-000000000058" [ref=e288]: UX 조명 58
                        - listitem "45454545-4545-4454-8454-000000000059" [ref=e289]: UX 조명 59
                        - listitem "45454545-4545-4454-8454-000000000060" [ref=e290]: UX 조명 60
                  - group "층 목록" [ref=e291]:
                    - generic [ref=e292]:
                      - button "B2" [disabled] [ref=e293]
                      - paragraph [ref=e294]: 게이트웨이 0/1 준비 · Mesh 설정 중
          - complementary "밝기 실행" [ref=e295]:
            - region "제어 대상" [ref=e296]:
              - heading "제어 대상" [level=3] [ref=e298]
              - generic [ref=e299]:
                - strong [ref=e300]: 60개 선택
                - generic [ref=e301]:
                  - img [ref=e302]
                  - generic [ref=e304]: 제어 불가
            - generic [ref=e305]:
              - generic [ref=e306]:
                - generic [ref=e307]:
                  - generic [ref=e308]: 밝기
                  - generic [ref=e309]:
                    - textbox "밝기 수치" [ref=e312]: "70"
                    - generic [ref=e313]: "%"
                - group "밝기" [ref=e314]:
                  - slider "밝기" [ref=e322]: "70"
                - button "60개 조명에 밝기 적용" [disabled] [ref=e324]: 적용
                - button "더보기" [ref=e325] [cursor=pointer]
              - status "제어 중요 상태" [ref=e327]: Gateway 0/1 준비 · Mesh 설정 중
```

# Test source

```ts
  72  | }
  73  | 
  74  | export interface GeometryContract {
  75  |   map: string;
  76  |   regions: Record<string, string>;
  77  |   // Only real opaque overlay/nav selectors from the final source belong here.
  78  |   occluders: string[];
  79  | }
  80  | 
  81  | export async function readGeometry(page: Page, contract: GeometryContract) {
  82  |   return page.evaluate(({ map: mapSelector, regions, occluders }) => {
  83  |     type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
  84  |     const box = (element: Element): Box => {
  85  |       const r = element.getBoundingClientRect();
  86  |       return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  87  |     };
  88  |     const fromEdges = (x: number, y: number, right: number, bottom: number): Box => ({ x, y, right, bottom, width: right - x, height: bottom - y });
  89  |     const intersect = (a: Box, b: Box) => {
  90  |       const result = fromEdges(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.min(a.right, b.right), Math.min(a.bottom, b.bottom));
  91  |       return result.width > 0 && result.height > 0 ? result : null;
  92  |     };
  93  |     const viewport = fromEdges(0, 0, innerWidth, innerHeight);
  94  |     const visible = (element: Element) => {
  95  |       let result = intersect(box(element), viewport);
  96  |       for (let current: Element | null = element; current && result; current = current.parentElement) {
  97  |         const style = getComputedStyle(current);
  98  |         if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0 || current.matches("[hidden],.sr-only")) return null;
  99  |         // Root scrolling boxes clip to the viewport, not their translated document rect.
  100 |         if (current === document.documentElement || current === document.body || current === element) continue;
  101 |         const r = box(current);
  102 |         const xClip = ["auto", "scroll", "hidden", "clip"].includes(style.overflowX);
  103 |         const yClip = ["auto", "scroll", "hidden", "clip"].includes(style.overflowY);
  104 |         const clip = fromEdges(
  105 |           xClip ? r.x + current.clientLeft : result.x,
  106 |           yClip ? r.y + current.clientTop : result.y,
  107 |           xClip ? r.x + current.clientLeft + current.clientWidth : result.right,
  108 |           yClip ? r.y + current.clientTop + current.clientHeight : result.bottom
  109 |         );
  110 |         result = intersect(result, clip);
  111 |       }
  112 |       return result;
  113 |     };
  114 |     const hit = (element: Element, bounds: Box | null) => bounds ? [0.1, 0.5, 0.9].flatMap(y => [0.1, 0.5, 0.9].map(x => {
  115 |       const px = bounds.x + bounds.width * x, py = bounds.y + bounds.height * y;
  116 |       const target = document.elementFromPoint(px, py);
  117 |       return { x: px, y: py, reachesElement: Boolean(target && element.contains(target)), tag: target?.tagName ?? null, label: target?.closest("[aria-label]")?.getAttribute("aria-label") ?? null };
  118 |     })) : [];
  119 |     const measure = (element: Element) => {
  120 |       const bounds = box(element), usable = visible(element), style = getComputedStyle(element);
  121 |       return { bounds, usable, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflowX: style.overflowX, overflowY: style.overflowY, hits: hit(element, usable) };
  122 |     };
  123 |     const maps = document.querySelectorAll(mapSelector);
  124 |     if (maps.length !== 1) throw new Error(`Expected one actual map viewport, found ${maps.length}`);
  125 |     const map = maps[0], mapBox = box(map), mapUsable = visible(map);
  126 |     const blockers = occluders.flatMap(selector => [...document.querySelectorAll(selector)].map(element => ({ selector, bounds: visible(element) }))).filter(item => item.bounds !== null);
  127 |     // Rectangular opaque occlusion estimate. Hit samples remain separate; no 44px PASS is inferred.
  128 |     let exposed: Box[] = mapUsable ? [mapUsable] : [];
  129 |     for (const blocker of blockers) exposed = exposed.flatMap(part => {
  130 |       const cut = intersect(part, blocker.bounds!);
  131 |       if (!cut) return [part];
  132 |       return [
  133 |         fromEdges(part.x, part.y, part.right, cut.y),
  134 |         fromEdges(part.x, cut.bottom, part.right, part.bottom),
  135 |         fromEdges(part.x, cut.y, cut.x, cut.bottom),
  136 |         fromEdges(cut.right, cut.y, part.right, cut.bottom)
  137 |       ].filter(piece => piece.width > 0 && piece.height > 0);
  138 |     });
  139 |     const scrolling = document.scrollingElement;
  140 |     return {
  141 |       sampledAt: new Date().toISOString(), theme: document.documentElement.getAttribute("data-customer-theme"),
  142 |       viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visual: visualViewport && { width: visualViewport.width, height: visualViewport.height, offsetTop: visualViewport.offsetTop, offsetLeft: visualViewport.offsetLeft } },
  143 |       document: { scrollY, scrollX, scrollHeight: scrolling?.scrollHeight ?? null, clientHeight: scrolling?.clientHeight ?? null, scrollWidth: scrolling?.scrollWidth ?? null, clientWidth: scrolling?.clientWidth ?? null },
  144 |       activeElement: { tag: document.activeElement?.tagName ?? null, label: document.activeElement?.getAttribute("aria-label") ?? null },
  145 |       map: { ...measure(map), camera: { x: map.scrollLeft, y: map.scrollTop, zoom: map.getAttribute("data-zoom") ?? map.closest("[data-zoom]")?.getAttribute("data-zoom") ?? null }, canvas: [...map.querySelectorAll("canvas")].map(canvas => ({ bounds: box(canvas), bitmapWidth: canvas.width, bitmapHeight: canvas.height })) },
  146 |       regions: Object.fromEntries(Object.entries(regions).map(([name, selector]) => [name, [...document.querySelectorAll(selector)].map(measure)])),
  147 |       selection: [...map.querySelectorAll("[data-spatial-map-marker]")].map(marker => ({ label: marker.getAttribute("aria-label"), pressed: marker.getAttribute("aria-pressed"), current: marker.getAttribute("aria-current"), dataSelected: marker.getAttribute("data-selected"), ...measure(marker) })),
  148 |       exposedMap: { mapBox, mapUsable, blockers, rectangles: exposed, area: exposed.reduce((sum, part) => sum + part.width * part.height, 0), limitation: "Opaque rectangular selectors only; hit samples are not continuous44 proof or OS-keyboard evidence." }
  149 |     };
  150 |   }, contract);
  151 | }
  152 | 
  153 | export async function savePhase(page: Page, info: TestInfo, phase: string, contract: GeometryContract, extra: unknown) {
  154 |   if (!/^[a-z0-9-]+$/.test(phase)) throw new Error("Evidence phase must be an explicit safe slug");
  155 |   const source = process.env.UX_SOURCE_SHA;
  156 |   if (!source || !/^[a-f0-9]{40}$/.test(source)) throw new Error("Final full source SHA is required; no historical default");
  157 |   const json = info.outputPath(phase + ".json"), png = info.outputPath(phase + ".png");
  158 |   // Preserve geometry even if screenshot capture fails, and propagate either failure.
  159 |   const metrics = await readGeometry(page, contract);
  160 |   await writeFile(json, JSON.stringify({ source, phase, url: page.url(), viewport: page.viewportSize(), metrics, extra }, null, 2));
  161 |   await info.attach(phase + "-geometry", { path: json, contentType: "application/json" });
  162 |   await page.screenshot({ path: png, fullPage: false });
  163 |   await info.attach(phase, { path: png, contentType: "image/png" });
  164 | }
  165 | 
  166 | export async function rememberMapIdentity(map: Locator) {
  167 |   const viewport = await map.elementHandle(), canvas = await map.locator("canvas").first().elementHandle();
  168 |   if (!viewport || !canvas) throw new Error("Actual viewport and renderer must be ready before identity capture");
  169 |   return {
  170 |     assertUnchanged: async () => {
  171 |       expect(await viewport.evaluate(element => element.isConnected)).toBe(true);
> 172 |       expect(await canvas.evaluate(element => element.isConnected)).toBe(true);
      |                                                                     ^ Error: expect(received).toBe(expected) // Object.is equality
  173 |       expect(await map.evaluate((element, previous) => element === previous, viewport)).toBe(true);
  174 |       expect(await map.locator("canvas").first().evaluate((element, previous) => element === previous, canvas)).toBe(true);
  175 |     },
  176 |     dispose: async () => { await viewport.dispose(); await canvas.dispose(); }
  177 |   };
  178 | }
  179 | 
  180 | export async function actualCenter(target: Locator) {
  181 |   await expect(target).toBeVisible();
  182 |   return target.evaluate(element => {
  183 |     const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  184 |     if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !element.contains(document.elementFromPoint(x, y))) throw new Error("Native input target is clipped or covered");
  185 |     return { x, y };
  186 |   });
  187 | }
  188 | 
  189 | /** Chromium native input, not dispatchEvent/fakePointerEvent; cancel and detach on any failure. */
  190 | export async function nativeSwipe(context: BrowserContext, page: Page, target: Locator, delta: { x: number; y: number }) {
  191 |   if (Math.hypot(delta.x, delta.y) < 8) throw new Error("Swipe must exceed the actual pan threshold");
  192 |   const origin = await actualCenter(target), session = await context.newCDPSession(page);
  193 |   const point = (x: number, y: number) => ({ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 });
  194 |   let active = false;
  195 |   try {
  196 |     await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(origin.x, origin.y)] }); active = true;
  197 |     for (let step = 1; step <= 8; step++) {
  198 |       await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(origin.x + delta.x * step / 8, origin.y + delta.y * step / 8)] });
  199 |       await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  200 |     }
  201 |     await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); active = false;
  202 |     return origin;
  203 |   } finally {
  204 |     try { if (active) await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); }
  205 |     finally { await session.detach(); }
  206 |   }
  207 | }
  208 | 
  209 | 
```