# Report Korean fonts

Source: Google Fonts, Noto Sans KR, pinned commit
`b38c5c93af322c45f633e17ac440ec1e6c94d489`.

- Font: https://github.com/google/fonts/blob/b38c5c93af322c45f633e17ac440ec1e6c94d489/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf
- License: https://github.com/google/fonts/blob/b38c5c93af322c45f633e17ac440ec1e6c94d489/ofl/notosanskr/OFL.txt
- License wording is retained in `OFL.txt` (SIL Open Font License 1.1); one upstream trailing space is removed.

The upstream variable TTF is instantiated with fonttools 4.61.1 at `wght=400`
and `wght=700`, updating the name table for each weight. A fonttools pass retains
all Unicode characters and removes optional OpenType layout features: fontkit's
context substitutions otherwise select alternate glyphs without a cmap entry,
preventing faithful PDF text extraction. The resulting static TTFs are committed so production requires
neither a network font download nor fonttools. PDF generation embeds both fonts
intact because fontkit 1.1.1 produces damaged glyph outlines when subsetting these
static instances. Nest copies this directory into `dist/src/assets/fonts`.

```sh
fonttools varLib.instancer NotoSansKR-VF.ttf wght=400 --update-name-table --output Regular.ttf
fonttools varLib.instancer NotoSansKR-VF.ttf wght=700 --update-name-table --output Bold.ttf
fonttools subset Regular.ttf --unicodes='*' --layout-features='' --name-IDs='*' --name-languages='*' --name-legacy --output-file=NotoSansKR-Regular.ttf
fonttools subset Bold.ttf --unicodes='*' --layout-features='' --name-IDs='*' --name-languages='*' --name-legacy --output-file=NotoSansKR-Bold.ttf
```

SHA-256:

| Asset | SHA-256 |
| --- | --- |
| Upstream variable TTF | `194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252` |
| NotoSansKR-Regular.ttf | `9b2429cf680dee8bc02c811020b3eabcec9a3ad572d81c670318d92b700c72d0` |
| NotoSansKR-Bold.ttf | `7909d4432a9015a90e13750858f8a2c865a99c2d8caf09b50fef2242d3c2fbcf` |

## Emoji fallback

`NotoEmoji.ttf` is the unmodified monochrome variable font from Google Fonts,
pinned to commit `b979dba422e445492b0eb9951ac52ee0b4d648c3`:

- [Font source](https://github.com/google/fonts/blob/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf)
- [SIL OFL 1.1 license](https://github.com/google/fonts/blob/b979dba422e445492b0eb9951ac52ee0b4d648c3/ofl/notoemoji/OFL.txt), retained as `OFL-NotoEmoji.txt` with trailing whitespace removed.
- SHA-256: `de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551`.

PDF uses the default variation and disables optional substitutions, embeds the
font intact, and selects it when the primary regular/bold fonts cannot preserve
the code point through their glyph-to-Unicode maps.
Each physical text run is extracted using its own ToUnicode map. The common
pre-acceptance/export guard rejects characters outside the shared regular/bold
plus emoji repertoire (CR/LF are explicit structural line breaks), including
non-round-trippable aliases and shaping controls such as NBSP, VS16 and ZWJ,
rather than substituting or dropping text in PDF only. It also compares the
complete shaped run with its original text using the same fallback segmentation,
column width, font size and physical line wrapping as PDF drawing. This includes
NFD Hangul that composes only after a mixed-script line wraps. Runs whose original
text survives remain valid; NFD is not rejected as a blanket character category.
Validation covers the selected document's strings, not unrelated snapshot history.
Font coverage is not all of Unicode;
adding scripts requires updating the pinned fonts and extraction regressions.
