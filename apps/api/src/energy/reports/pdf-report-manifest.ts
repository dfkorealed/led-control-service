import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ReportVisualManifest } from "./report-pdf-layout";
import type { ReportManifest } from "./report-renderer";
import { physicalPdfManifest, type PdfTextRun, type PdfTokenMapping } from "./pdf-report-order";

/** Decode our marked page text through each embedded font's ToUnicode map.
 * Structural metadata supplies paths and scalar types only, never report values.
 */
export async function extractPdfReportManifest(bytes: Uint8Array): Promise<ReportManifest> {
  const pdf = await PDFDocument.load(bytes);
  const displayMap = pdf.catalog.lookupMaybe(PDFName.of("ReportDisplayMap"), PDFHexString);
  if (displayMap) return extractDisplayManifest(pdf, displayMap);
  // pdf-lib spreads the entire UTF-16 token map onto the call stack. Two full
  // heatmaps exceed that limit; Buffer decoding is bounded by available memory.
  const tokenMap = Buffer.from(pdf.catalog.lookup(PDFName.of("ReportTokenMap"), PDFHexString).asBytes());
  const mapping = JSON.parse(tokenMap.subarray(2).swap16().toString("utf16le")) as PdfTokenMapping[];
  const pages: PdfTextRun[][] = [];
  const cachedFontMaps = new Map<string, Map<string, string>>();
  for (const page of pdf.getPages()) {
    const pageRuns: PdfTextRun[] = [];
    pages.push(pageRuns);
    const fonts = page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    const fontMaps = new Map<string, Map<string, string>>();
    for (const [name, reference] of fonts.entries()) {
      const cached = cachedFontMaps.get(reference.toString());
      if (cached) { fontMaps.set(name.asString().slice(1), cached); continue; }
      const font = pdf.context.lookup(reference, PDFDict);
      const unicodeStream = font.lookup(PDFName.of("ToUnicode"));
      if (!(unicodeStream instanceof PDFRawStream)) throw new Error("Missing embedded font character map");
      const cmap = decodeStream(unicodeStream);
      const characters = new Map<string, string>();
      for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        for (const pair of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) {
          characters.set(pair[1].toUpperCase().padStart(4, "0"), Buffer.from(pair[2], "hex").swap16().toString("utf16le"));
        }
      }
      fontMaps.set(name.asString().slice(1), characters);
      cachedFontMaps.set(reference.toString(), characters);
    }
    const streams = page.node.Contents() as PDFArray;
    for (let index = 0; index < streams.size(); index++) {
      const content = decodeStream(streams.lookup(index, PDFRawStream));
      for (const segment of content.matchAll(/\/R(\d+)H([0-3])S(\d+) BMC([\s\S]*?)EMC/g)) {
        const tokenIndex = Number(segment[1]);
        if (!mapping[tokenIndex]) throw new Error("Unexpected report text token");
        const runs = [...segment[4].matchAll(/\/([^\s/]+) [\d.]+ Tf[\s\S]*?<([0-9a-f]*)> Tj/gi)];
        if (!runs.length) throw new Error("Missing report text operation");
        let value = ["", "\n", "\r", "\r\n"][Number(segment[2])];
        for (const run of runs) {
          const fontName = run[1];
          const characters = fontMaps.get(fontName);
          if (!characters) throw new Error("Missing report font map");
          for (const glyph of run[2].match(/.{4}/g) ?? []) {
            const character = characters.get(glyph.toUpperCase());
            if (character === undefined) throw new Error(`Unmapped report glyph ${glyph} in ${fontName}`);
            value += character;
          }
        }
        const position = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(segment[4]);
        if (!position) throw new Error("Missing physical report text position");
        pageRuns.push({ index: tokenIndex, part: Number(segment[3]), value, x: Number(position[1]), y: Number(position[2]) });
      }
    }
  }
  return physicalPdfManifest(mapping, pages);
}

/** The semantic report maps paths only. Values are decoded from visible glyphs,
 * and their page order is checked after serialization. */
function extractDisplayManifest(pdf: PDFDocument, displayMap: PDFHexString): ReportManifest {
  const bytes = Buffer.from(displayMap.asBytes());
  const paths = JSON.parse(bytes.subarray(2).swap16().toString("utf16le")) as string[];
  if (!Array.isArray(paths) || paths.some(path => typeof path !== "string")) throw new Error("Invalid PDF display map");
  const values = new Map<number, { nextPart: number; text: string }>();
  let lastIndex = -1;
  for (const page of pdf.getPages()) {
    const fonts = page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    const maps = new Map<string, Map<string, string>>();
    for (const [name, ref] of fonts.entries()) {
      const font = pdf.context.lookup(ref, PDFDict);
      const cmap = decodeStream(font.lookup(PDFName.of("ToUnicode")) as PDFRawStream);
      const characters = new Map<string, string>();
      for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
        for (const pair of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi))
          characters.set(pair[1].toUpperCase().padStart(4, "0"), Buffer.from(pair[2], "hex").swap16().toString("utf16le"));
      maps.set(name.asString().slice(1), characters);
    }
    const streams = page.node.Contents() as PDFArray;
    for (let streamIndex = 0; streamIndex < streams.size(); streamIndex++) {
      const content = decodeStream(streams.lookup(streamIndex, PDFRawStream));
      for (const match of content.matchAll(/\/D(\d+)S(\d+) BMC([\s\S]*?)EMC/g)) {
        const index = Number(match[1]);
        const part = Number(match[2]);
        if (index >= paths.length || index < lastIndex) throw new Error("Invalid PDF display order");
        const state = values.get(index) ?? { nextPart: 0, text: "" };
        if (part !== state.nextPart || (index > lastIndex && part !== 0)) throw new Error("Invalid PDF display continuation");
        const position = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(match[3]);
        if (!position || Number(position[1]) < 44 || Number(position[1]) > 551.28 || Number(position[2]) < 44 || Number(position[2]) > 798)
          throw new Error("PDF display text exceeds page bounds");
        let line = "";
        for (const run of match[3].matchAll(/\/([^\s/]+) [\d.]+ Tf[\s\S]*?<([0-9a-f]*)> Tj/gi)) {
          const characters = maps.get(run[1]);
          if (!characters) throw new Error("Missing PDF display font map");
          for (const glyph of run[2].match(/.{4}/g) ?? []) {
            const character = characters.get(glyph.toUpperCase());
            if (character === undefined) throw new Error("Unmapped PDF display glyph");
            line += character;
          }
        }
        if (!line && match[3].includes(" Tj") === false) throw new Error("Missing PDF display text");
        state.text += line;
        state.nextPart++;
        values.set(index, state);
        lastIndex = index;
      }
    }
  }
  if (values.size !== paths.length) throw new Error("Missing PDF display value");
  return paths.map((path, index) => ({ path, value: values.get(index)!.text }));
}

function decodeStream(stream: PDFRawStream): string { return Buffer.from(decodePDFRawStream(stream).decode()).toString(); }

/** Pixel bytes only prove appearance under a known image interpretation. Accept
 * exactly the pdf-lib PNG profile, plus explicit identity Decode arrays. Reject
 * other entries (Mask, Matte, ImageMask, DecodeParms, Interpolate, nested SMask,
 * etc.) instead of silently ignoring color, transparency or sampling changes. */
function verifyImageDictionary(image: PDFRawStream, width: number, height: number, mask = false): void {
  const allowed = new Set(["/Type", "/Subtype", "/Width", "/Height", "/BitsPerComponent", "/ColorSpace", "/Filter", "/Length", "/Decode", ...(mask ? [] : ["/SMask"])]);
  const value = (key: string) => image.dict.lookup(PDFName.of(key));
  const number = (key: string) => { const entry = value(key); return entry instanceof PDFNumber ? entry.asNumber() : NaN; };
  if (image.dict.keys().some(key => !allowed.has(key.asString())) ||
    value("Type")?.toString() !== "/XObject" || value("Subtype")?.toString() !== "/Image" ||
    value("ColorSpace")?.toString() !== (mask ? "/DeviceGray" : "/DeviceRGB") ||
    value("Filter")?.toString() !== "/FlateDecode" || number("BitsPerComponent") !== 8 ||
    number("Width") !== width || number("Height") !== height || number("Length") !== image.getContents().length) {
    throw new Error("Unsupported report chart image dictionary");
  }
  if (image.dict.has(PDFName.of("Decode"))) {
    const decode = value("Decode");
    if (!(decode instanceof PDFArray) || decode.size() !== (mask ? 2 : 6)) throw new Error("Unsupported report chart image Decode");
    for (let index = 0; index < decode.size(); index++) {
      const entry = decode.lookup(index);
      if (!(entry instanceof PDFNumber) || entry.asNumber() !== index % 2) throw new Error("Unsupported report chart image Decode");
    }
  }
}

/** Verify the PNG container and the displayed PDF image separately: embedPng
 * necessarily decodes the container into RGB plus an optional grayscale mask. */
export async function extractPdfReportVisuals(bytes: Uint8Array): Promise<ReportVisualManifest> {
  const pdf = await PDFDocument.load(bytes);
  const mapping = pdf.catalog.lookupMaybe(PDFName.of("ReportVisuals"), PDFArray);
  const drawn: Array<{ index: number; ref: string }> = [];
  let imageOperations = 0;
  for (const page of pdf.getPages()) {
    const streams = page.node.Contents() as PDFArray;
    for (let offset = 0; offset < streams.size(); offset++) {
      const text = decodeStream(streams.lookup(offset, PDFRawStream));
      imageOperations += [...text.matchAll(/\/Image[^\s]+ Do/g)].length;
      for (const match of text.matchAll(/\/ReportVisual(\d+) BMC([\s\S]*?)EMC/g)) {
        // This renderer emits translation, identity rotation, size, identity
        // skew, then the draw. Reject changed transforms and hidden images.
        const draw = /^\s*q\s+1 0 0 1 ([\d.]+) ([\d.]+) cm\s+1 0 0 1 0 0 cm\s+([\d.]+) 0 0 ([\d.]+) 0 0 cm\s+1 0 0 1 0 0 cm\s+\/([^\s]+) Do\s+Q\s*$/.exec(match[2]);
        if (!draw) throw new Error("Invalid report chart drawing");
        const [, sx, sy, sw, sh, name] = draw;
        const [x, y, width, height] = [sx, sy, sw, sh].map(Number);
        if (x < 36 || y < 44 || width <= 0 || height <= 0 || x + width > 559.280001 || y + height > 798 || Math.abs(width / height - 1000 / 560) > 0.000001) throw new Error("Report chart exceeds page bounds");
        const resources = page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
        drawn.push({ index: Number(match[1]), ref: resources.get(PDFName.of(name))!.toString() });
      }
    }
  }
  if (imageOperations !== drawn.length || drawn.length !== (mapping?.size() ?? 0)) throw new Error("Missing or unexpected report chart drawing");
  const result: ReportVisualManifest = [];
  for (const [index, drawing] of drawn.entries()) {
    const entry = mapping!.lookup(index, PDFDict);
    if (drawing.index !== index || drawing.ref !== entry.get(PDFName.of("Image"))!.toString()) throw new Error("Invalid report chart order or reference");
    const source = entry.lookup(PDFName.of("Source"));
    if (!(source instanceof PDFRawStream)) throw new Error("Missing report PNG source stream");
    const png = Buffer.from(decodePDFRawStream(source).decode());
    const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const image = entry.lookup(PDFName.of("Image"));
    if (!(image instanceof PDFRawStream)) throw new Error("Missing report image stream");
    const { width, height, channels } = decoded.info;
    if (channels !== 4) throw new Error("Invalid report chart image dimensions");
    verifyImageDictionary(image, width, height);
    const rgb = decodePDFRawStream(image).decode();
    const mask = image.dict.lookup(PDFName.of("SMask"));
    if (mask && !(mask instanceof PDFRawStream)) throw new Error("Invalid report image alpha mask");
    if (mask) verifyImageDictionary(mask, width, height, true);
    const alpha = mask ? decodePDFRawStream(mask).decode() : undefined;
    if (rgb.length !== width * height * 3 || (alpha && alpha.length !== width * height)) throw new Error("Invalid report chart pixels");
    for (let pixel = 0; pixel < width * height; pixel++) {
      if (rgb[pixel * 3] !== decoded.data[pixel * 4] || rgb[pixel * 3 + 1] !== decoded.data[pixel * 4 + 1] || rgb[pixel * 3 + 2] !== decoded.data[pixel * 4 + 2] || (alpha?.[pixel] ?? 255) !== decoded.data[pixel * 4 + 3]) throw new Error("Report chart pixels differ from source PNG");
    }
    result.push({ id: entry.lookup(PDFName.of("Id"), PDFHexString).decodeText(), sha256: createHash("sha256").update(png).digest("hex"), width, height });
  }
  if (new Set(result.map(image => image.id)).size !== result.length) throw new Error("Duplicate report chart ID");
  return result;
}

/** Read the visible caption glyphs via ToUnicode, not metadata/ActualText. */
export async function extractPdfVisualCaptions(bytes: Uint8Array): Promise<Array<{ title: string; altText: string }>> {
  const pdf = await PDFDocument.load(bytes);
  const captions: Array<{ title: string; altText: string }> = [];
  const maps = new Map<string, Map<string, string>>();
  for (const page of pdf.getPages()) {
    const streams = page.node.Contents() as PDFArray;
    const fonts = page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
    for (let offset = 0; offset < streams.size(); offset++) {
      const text = decodeStream(streams.lookup(offset, PDFRawStream));
      for (const caption of text.matchAll(/\/V(\d+)(Title|Alt)H([0-3]) BMC([\s\S]*?)EMC/g)) {
        let value = ["", "\n", "\r", "\r\n"][Number(caption[3])];
        for (const run of caption[4].matchAll(/\/([^\s/]+) [\d.]+ Tf[\s\S]*?<([0-9a-f]*)> Tj/gi)) {
          const ref = fonts.get(PDFName.of(run[1]))!;
          let characters = maps.get(ref.toString());
          if (!characters) {
            characters = new Map();
            const cmap = decodeStream(pdf.context.lookup(ref, PDFDict).lookup(PDFName.of("ToUnicode")) as PDFRawStream);
            for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const pair of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>/gi)) characters.set(pair[1].toUpperCase().padStart(4, "0"), Buffer.from(pair[2], "hex").swap16().toString("utf16le"));
            maps.set(ref.toString(), characters);
          }
          for (const glyph of run[2].match(/.{4}/g) ?? []) {
            const character = characters.get(glyph.toUpperCase());
            if (character === undefined) throw new Error("Unmapped report caption glyph");
            value += character;
          }
        }
        const index = Number(caption[1]);
        captions[index] ??= { title: "", altText: "" };
        captions[index][caption[2] === "Title" ? "title" : "altText"] += value;
      }
    }
  }
  return captions;
}
