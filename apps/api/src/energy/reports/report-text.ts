import { BadRequestException } from "@nestjs/common";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type FontData = { font: ReturnType<typeof fontkit.create>; features: Record<string, boolean>; canonical: Map<number, number> };
let fonts: FontData[] | undefined;
const choices = new Map<number, 0 | 1 | null>();

/** The chosen font must preserve a code point, not merely contain a drawable alias. */
export function reportFontIndex(code: number): 0 | 1 | null {
  if (choices.has(code)) return choices.get(code)!;
  fonts ??= ["NotoSansKR-Regular.ttf", "NotoSansKR-Bold.ttf", "NotoEmoji.ttf"].map(filename => {
    const font = fontkit.create(readFileSync(join(__dirname, "../../assets/fonts", filename)));
    const canonical = new Map<number, number>();
    for (const character of font.characterSet) {
      const glyph = font.glyphForCodePoint(character);
      if (!canonical.has(glyph.id)) canonical.set(glyph.id, character);
    }
    return { font, canonical, features: Object.fromEntries(font.availableFeatures.map(feature => [feature, false])) };
  });
  const preserves = ({ font, features, canonical }: FontData) => {
    if (!font.hasGlyphForCodePoint(code)) return false;
    const glyph = font.glyphForCodePoint(code);
    const shaped = font.layout(String.fromCodePoint(code), features).glyphs;
    return canonical.get(glyph.id) === code && shaped.length === 1 && shaped[0].id === glyph.id;
  };
  const index = preserves(fonts[0]) && preserves(fonts[1]) ? 0 : preserves(fonts[2]) ? 1 : null;
  choices.set(code, index);
  return index;
}

/** Both exports require exact extraction of each input string, not just drawable scalars. */
export function assertReportTextSupported(value: unknown): void {
  if (typeof value === "string") {
    // CR/LF are structural PDF markers. All other text follows exactly the same
    // fallback segmentation as drawing. Scalar cmap checks alone miss mandatory
    // shaping (for example six NFD Hangul Jamo becoming two NFC syllable glyphs).
    for (const paragraph of value.split(/\r\n|\r|\n/)) {
      for (const run of reportFontRuns(paragraph)) {
        for (const data of run.index === 0 ? fonts!.slice(0, 2) : [fonts![2]]) {
          const codes = data.font.layout(run.text, data.features).glyphs.map(glyph => data.canonical.get(glyph.id));
          if (codes.some(code => code === undefined) || codes.map(code => String.fromCodePoint(code!)).join("") !== run.text) {
            throw new BadRequestException("Unsupported report text shaping");
          }
        }
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach(assertReportTextSupported);
  } else if (value && typeof value === "object") {
    Object.values(value).forEach(assertReportTextSupported);
  }
}

/** A target with an unavailable label must not poison the site's other targets. */
export function isReportTextSupported(value: unknown): boolean {
  try { assertReportTextSupported(value); return true; }
  catch (error) { if (error instanceof BadRequestException) return false; throw error; }
}

export function reportFontRuns(text: string): Array<{ text: string; index: 0 | 1 }> {
  const runs: Array<{ text: string; index: 0 | 1 }> = [];
  for (const character of text) {
    const index = reportFontIndex(character.codePointAt(0)!);
    if (index === null) throw new BadRequestException(`Unsupported report character U+${character.codePointAt(0)!.toString(16).toUpperCase()}`);
    const last = runs.at(-1);
    if (last?.index === index) last.text += character;
    else runs.push({ text: character, index });
  }
  return runs;
}

/** Same advance-width calculation as pdf-lib's CustomFontEmbedder, including fallback. */
export function reportTextWidth(text: string, isBold: boolean, size: number): number {
  return reportFontRuns(text).reduce((total, run) => {
    const { font, features } = fonts![run.index === 1 ? 2 : isBold ? 1 : 0];
    const scaled = font.layout(run.text, features).glyphs.reduce((width, glyph) => width + glyph.advanceWidth * (1000 / font.unitsPerEm), 0);
    return total + scaled * (size / 1000);
  }, 0);
}
