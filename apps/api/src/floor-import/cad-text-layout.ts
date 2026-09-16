import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";

interface CadFontData {
  font: ReturnType<typeof fontkit.create>;
  features: Record<string, boolean>;
}

export interface CadTextGlyphPath {
  path: string;
  x: number;
  y: number;
  scale: number;
}

export interface CadTextLayout {
  text: string;
  glyphs: CadTextGlyphPath[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

let fonts: CadFontData[] | undefined;

export function sanitizeCadText(value: string): string {
  return Array.from(value, character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      ? character
      : "\uFFFD";
  }).join("").replace(/[\r\n]/g, " ");
}

function loadFonts(): CadFontData[] {
  fonts ??= ["NotoSansKR-Regular.ttf", "NotoEmoji.ttf"].map(filename => {
    const font = fontkit.create(readFileSync(join(__dirname, "../assets/fonts", filename)));
    return { font, features: Object.fromEntries(font.availableFeatures.map(feature => [feature, false])) };
  });
  return fonts;
}

/** Uses bundled glyph outlines for both layout bounds and SVG drawing. */
export function layoutCadText(value: string, height: number): CadTextLayout {
  if (!Number.isFinite(height) || height <= 0) throw new Error("Invalid CAD text height");
  const text = sanitizeCadText(value);
  const availableFonts = loadFonts();
  const runs: Array<{ fontIndex: number; text: string }> = [];
  for (const character of text) {
    let drawableCharacter = character;
    let fontIndex = availableFonts.findIndex(data => data.font.hasGlyphForCodePoint(character.codePointAt(0)!));
    if (fontIndex < 0) {
      // Keep the sanitized source in aria-label while drawing a deterministic
      // bundled-font replacement box for unsupported or repaired scalars.
      drawableCharacter = "\u25A1";
      fontIndex = availableFonts.findIndex(data => data.font.hasGlyphForCodePoint(drawableCharacter.codePointAt(0)!));
      if (fontIndex < 0) throw new Error("Bundled CAD replacement glyph is unavailable");
    }
    const previous = runs.at(-1);
    if (previous?.fontIndex === fontIndex) previous.text += drawableCharacter;
    else runs.push({ fontIndex, text: drawableCharacter });
  }

  const glyphs: CadTextGlyphPath[] = [];
  let penX = 0;
  let penY = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    const { font, features } = availableFonts[run.fontIndex];
    const scale = height / font.unitsPerEm;
    const layout = font.layout(run.text, features);
    layout.glyphs.forEach((glyph, index) => {
      const position = layout.positions[index];
      const x = penX + position.xOffset * scale;
      const y = penY + position.yOffset * scale;
      const path = glyph.path.toSVG();
      const bounds = glyph.bbox;
      if (path && Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY) && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.maxY)) {
        glyphs.push({ path, x, y, scale });
        minX = Math.min(minX, x + bounds.minX * scale);
        minY = Math.min(minY, y + bounds.minY * scale);
        maxX = Math.max(maxX, x + bounds.maxX * scale);
        maxY = Math.max(maxY, y + bounds.maxY * scale);
      }
      penX += position.xAdvance * scale;
      penY += position.yAdvance * scale;
    });
  }

  return {
    text,
    glyphs,
    bounds: minX === Number.POSITIVE_INFINITY
      ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      : { minX, minY, maxX, maxY }
  };
}
