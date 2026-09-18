import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";

interface CadFontData {
  font: ReturnType<typeof fontkit.create>;
  features: Record<string, boolean>;
}

export interface CadTextGlyph {
  x: number;
  y: number;
  scale: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  pathByteLength: () => number;
  createPath: () => string;
}

export interface CadTextWalkOptions {
  maxGlyphs?: number;
  consumeGlyph?: () => void;
}

let fonts: CadFontData[] | undefined;
const LAYOUT_CHUNK_CHARACTERS = 128;
const DEFAULT_MAX_GLYPHS = 100_000;
const SVG_PATH_COMMANDS: Record<string, string> = {
  moveTo: "M",
  lineTo: "L",
  quadraticCurveTo: "Q",
  bezierCurveTo: "C",
  closePath: "Z"
};

interface FontPathCommand {
  command: string;
  args: number[];
}

interface InspectableFontPath {
  commands: FontPathCommand[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  toSVG(): string;
}

function svgPathByteLength(path: InspectableFontPath): number {
  let bytes = 0;
  for (const command of path.commands) {
    if (!SVG_PATH_COMMANDS[command.command]) throw new Error("Unsupported bundled CAD glyph path command");
    bytes++;
    command.args.forEach((argument, index) => {
      if (!Number.isFinite(argument)) throw new Error("Non-finite bundled CAD glyph path");
      if (index > 0) bytes++;
      bytes += Buffer.byteLength(String(Math.round(argument * 100) / 100), "utf8");
    });
  }
  return bytes;
}

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

/** Layout is chunked and paths stay lazy so bounds never materialize SVG data. */
export function forEachCadTextGlyph(
  value: string,
  height: number,
  options: CadTextWalkOptions,
  visit: (glyph: CadTextGlyph) => void
): string {
  if (!Number.isFinite(height) || height <= 0) throw new Error("Invalid CAD text height");
  const maxGlyphs = options.maxGlyphs ?? DEFAULT_MAX_GLYPHS;
  if (!Number.isInteger(maxGlyphs) || maxGlyphs < 1) throw new Error("Invalid CAD text glyph limit");
  const text = sanitizeCadText(value);
  const availableFonts = loadFonts();
  let penX = 0;
  let penY = 0;
  let glyphCount = 0;
  let runFontIndex = -1;
  let runCharacters: string[] = [];

  const flush = () => {
    if (!runCharacters.length) return;
    const { font, features } = availableFonts[runFontIndex];
    const scale = height / font.unitsPerEm;
    const layout = font.layout(runCharacters.join(""), features);
    for (let index = 0; index < layout.glyphs.length; index++) {
      glyphCount++;
      if (glyphCount > maxGlyphs) throw new Error("CAD text glyph limit exceeded");
      options.consumeGlyph?.();
      const glyph = layout.glyphs[index];
      const position = layout.positions[index];
      const x = penX + position.xOffset * scale;
      const y = penY + position.yOffset * scale;
      const path = glyph.path as unknown as InspectableFontPath;
      const bounds = path.bbox;
      visit({
        x,
        y,
        scale,
        bounds,
        pathByteLength: () => svgPathByteLength(path),
        createPath: () => path.toSVG()
      });
      penX += position.xAdvance * scale;
      penY += position.yAdvance * scale;
    }
    runCharacters = [];
  };

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
    if (runFontIndex !== fontIndex || runCharacters.length >= LAYOUT_CHUNK_CHARACTERS) {
      flush();
      runFontIndex = fontIndex;
    }
    runCharacters.push(drawableCharacter);
  }
  flush();
  return text;
}

export function measureCadText(value: string, height: number, options: CadTextWalkOptions = {}): {
  text: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const text = forEachCadTextGlyph(value, height, options, glyph => {
    const { bounds } = glyph;
    if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY) || !Number.isFinite(bounds.maxX) || !Number.isFinite(bounds.maxY)) return;
    minX = Math.min(minX, glyph.x + bounds.minX * glyph.scale);
    minY = Math.min(minY, glyph.y + bounds.minY * glyph.scale);
    maxX = Math.max(maxX, glyph.x + bounds.maxX * glyph.scale);
    maxY = Math.max(maxY, glyph.y + bounds.maxY * glyph.scale);
  });
  return {
    text,
    bounds: minX === Number.POSITIVE_INFINITY
      ? { minX: 0, minY: 0, maxX: 0, maxY: 0 }
      : { minX, minY, maxX, maxY }
  };
}
