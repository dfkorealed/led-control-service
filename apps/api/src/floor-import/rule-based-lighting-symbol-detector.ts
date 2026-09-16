import { iterateCadDocumentExpansion, iterateCadInsertExpansion, transformPoint } from "./cad-geometry";
import type { NormalizedCadDocument } from "./cad-types";
import type { DetectedLightingSymbol, LightingDetectionOptions, LightingSymbolDetector } from "./lighting-symbol-detector";

export interface LightingDetectionProfile {
  layerNameTokens: readonly string[];
  blockNameTokens: readonly string[];
  minimumBlockOccurrences: number;
  confidence: number;
  maxCandidates: number;
  maxExpandedInserts: number;
  attributeValueTokens: readonly string[];
  nearbyTextTokens: readonly string[];
  denyLayerNameTokens: readonly string[];
  denyBlockNameTokens: readonly string[];
  denyAttributeValueTokens: readonly string[];
  denyNearbyTextTokens: readonly string[];
  nearbyTextDistance: number;
  maxDurationMs: number;
  cooperativeYieldInterval: number;
}

const DEFAULT_PROFILE: LightingDetectionProfile = {
  layerNameTokens: ["조명", "전등", "LIGHT", "LIGHTING", "LAMP", "LED"],
  blockNameTokens: ["조명", "전등", "LIGHT", "LAMP", "LED", "FIXTURE", "LUMINAIRE"],
  minimumBlockOccurrences: 2,
  confidence: 0.95,
  maxCandidates: 10_000,
  maxExpandedInserts: 100_000,
  attributeValueTokens: ["조명", "전등", "LIGHT", "LIGHTING", "LAMP", "LED", "FIXTURE", "LUMINAIRE"],
  nearbyTextTokens: ["조명", "전등", "LIGHT", "LIGHTING", "LAMP", "LED", "FIXTURE", "LUMINAIRE"],
  denyLayerNameTokens: ["LEDGER", "SCHEDULE", "NOTE", "DECOR", "TITLE BLOCK"],
  denyBlockNameTokens: ["LEDGER", "SCHEDULE", "SCHEDULED NOTE", "NOTE", "DECOR", "TITLE BLOCK"],
  denyAttributeValueTokens: ["NOT LIGHT", "NON LIGHTING", "DECOR", "IGNORE"],
  denyNearbyTextTokens: ["NOT LIGHT", "NON LIGHTING", "DECOR", "DO NOT IMPORT", "IGNORE"],
  nearbyTextDistance: 5,
  maxDurationMs: 5_000,
  cooperativeYieldInterval: 256
};

const MAX_COOPERATIVE_YIELD_INTERVAL = 1024;

function tokenize(value: string): string[] {
  return value.normalize("NFKC").toLocaleUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function normalizeMatchers(tokens: readonly string[], label: string, allowEmpty = false): string[][] {
  const normalized = tokens.map(tokenize).filter(tokens => tokens.length > 0);
  if ((!allowEmpty && !normalized.length) || normalized.some(tokens => tokens.join("").length > 128)) throw new Error(`Invalid ${label} tokens`);
  return normalized;
}

function matchesTokens(tokens: readonly string[], matchers: readonly string[][]): boolean {
  return matchers.some(matcher => tokens.some((_, index) => matcher.every((token, offset) => tokens[index + offset] === token)));
}

interface IndexedCadText {
  position: { x: number; y: number };
  tokens: string[];
}

class CadTextGrid {
  private readonly cells = new Map<string, IndexedCadText[]>();
  private readonly cellSize: number;

  constructor(distance: number) {
    this.cellSize = distance > 0 ? distance : 1;
  }

  private coordinate(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  private key(x: number, y: number): string {
    return `${x},${y}`;
  }

  add(text: IndexedCadText): void {
    const key = this.key(this.coordinate(text.position.x), this.coordinate(text.position.y));
    const cell = this.cells.get(key);
    if (cell) cell.push(text);
    else this.cells.set(key, [text]);
  }

  *nearby(position: { x: number; y: number }, distance: number): Generator<IndexedCadText> {
    const centerX = this.coordinate(position.x);
    const centerY = this.coordinate(position.y);
    const radius = distance === 0 ? 0 : Math.ceil(distance / this.cellSize);
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      for (let y = centerY - radius; y <= centerY + radius; y++) {
        for (const text of this.cells.get(this.key(x, y)) ?? []) {
          if (Math.hypot(text.position.x - position.x, text.position.y - position.y) <= distance) yield text;
        }
      }
    }
  }
}

export class RuleBasedLightingSymbolDetector implements LightingSymbolDetector {
  private readonly profile: LightingDetectionProfile;
  private readonly layerTokens: string[][];
  private readonly blockTokens: string[][];
  private readonly attributeTokens: string[][];
  private readonly nearbyTextTokens: string[][];
  private readonly denyLayerTokens: string[][];
  private readonly denyBlockTokens: string[][];
  private readonly denyAttributeTokens: string[][];
  private readonly denyNearbyTextTokens: string[][];

  constructor(profile: Partial<LightingDetectionProfile> = {}) {
    this.profile = { ...DEFAULT_PROFILE, ...profile };
    if (!Number.isInteger(this.profile.minimumBlockOccurrences) || this.profile.minimumBlockOccurrences < 1) throw new Error("Invalid minimum block occurrence count");
    if (!Number.isInteger(this.profile.maxCandidates) || this.profile.maxCandidates < 1) throw new Error("Invalid candidate limit");
    if (!Number.isInteger(this.profile.maxExpandedInserts) || this.profile.maxExpandedInserts < 1) throw new Error("Invalid expanded INSERT limit");
    if (!Number.isFinite(this.profile.confidence) || this.profile.confidence <= 0 || this.profile.confidence > 1) throw new Error("Invalid detector confidence");
    if (!Number.isFinite(this.profile.nearbyTextDistance) || this.profile.nearbyTextDistance < 0) throw new Error("Invalid nearby text distance");
    if (!Number.isFinite(this.profile.maxDurationMs) || this.profile.maxDurationMs <= 0) throw new Error("Invalid detector time limit");
    if (!Number.isInteger(this.profile.cooperativeYieldInterval) || this.profile.cooperativeYieldInterval < 1 ||
        this.profile.cooperativeYieldInterval > MAX_COOPERATIVE_YIELD_INTERVAL) throw new Error("Invalid detector cooperative yield interval");
    this.layerTokens = normalizeMatchers(this.profile.layerNameTokens, "layer name");
    this.blockTokens = normalizeMatchers(this.profile.blockNameTokens, "block name");
    this.attributeTokens = normalizeMatchers(this.profile.attributeValueTokens, "attribute value", true);
    this.nearbyTextTokens = normalizeMatchers(this.profile.nearbyTextTokens, "nearby text", true);
    this.denyLayerTokens = normalizeMatchers(this.profile.denyLayerNameTokens, "denied layer name", true);
    this.denyBlockTokens = normalizeMatchers(this.profile.denyBlockNameTokens, "denied block name", true);
    this.denyAttributeTokens = normalizeMatchers(this.profile.denyAttributeValueTokens, "denied attribute value", true);
    this.denyNearbyTextTokens = normalizeMatchers(this.profile.denyNearbyTextTokens, "denied nearby text", true);
  }

  async detect(document: NormalizedCadDocument, options: LightingDetectionOptions = {}): Promise<DetectedLightingSymbol[]> {
    const maxDurationMs = options.maxDurationMs ?? this.profile.maxDurationMs;
    const now = options.now ?? (() => performance.now());
    if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new Error("Invalid detector time limit");
    const startedAt = now();
    const checkBudget = () => {
      if (options.abortSignal?.aborted) throw new Error("CAD lighting detection aborted");
      if (now() - startedAt > maxDurationMs) throw new Error("CAD lighting detection time limit exceeded");
    };
    let workSinceYield = 0;
    const afterWork = (): Promise<void> | undefined => {
      checkBudget();
      workSinceYield++;
      if (workSinceYield < this.profile.cooperativeYieldInterval) return undefined;
      workSinceYield = 0;
      return new Promise<void>(resolve => setImmediate(resolve)).then(checkBudget);
    };
    checkBudget();
    const inserts = [];
    for (const item of iterateCadInsertExpansion(document, { maxExpandedInserts: this.profile.maxExpandedInserts, checkBudget })) {
      if (item) inserts.push(item);
      const pause = afterWork();
      if (pause) await pause;
    }
    const expandedEntities = [];
    for (const item of iterateCadDocumentExpansion(document, { maxRenderedEntities: this.profile.maxExpandedInserts, checkBudget })) {
      if (item) expandedEntities.push(item);
      const pause = afterWork();
      if (pause) await pause;
    }
    const textGrid = new CadTextGrid(this.profile.nearbyTextDistance);
    for (const item of expandedEntities) {
      if (item.entity.type === "text" || item.entity.type === "mtext") {
        textGrid.add({ tokens: tokenize(item.entity.text), position: transformPoint(item.matrix, item.entity.position) });
      }
      const pause = afterWork();
      if (pause) await pause;
    }
    const frequencies = new Map<string, number>();
    const blockKey = (value: string) => value.normalize("NFKC").toLocaleUpperCase();
    const prepared = [];
    for (const insert of inserts) {
      const key = blockKey(insert.blockName);
      frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
      const attributeTokens: string[][] = [];
      for (const attribute of insert.entity.attributes) {
        attributeTokens.push(tokenize(attribute.tag), tokenize(attribute.value));
        const pause = afterWork();
        if (pause) await pause;
      }
      prepared.push({
        insert,
        blockKey: key,
        layerTokens: tokenize(insert.layer),
        blockTokens: tokenize(insert.blockName),
        attributeTokens
      });
      const pause = afterWork();
      if (pause) await pause;
    }
    const detected: DetectedLightingSymbol[] = [];

    for (const item of prepared) {
      const candidatePause = afterWork();
      if (candidatePause) await candidatePause;
      const { insert } = item;
      const nearbyTexts: IndexedCadText[] = [];
      for (const text of textGrid.nearby(insert.position, this.profile.nearbyTextDistance)) {
        nearbyTexts.push(text);
        const pause = afterWork();
        if (pause) await pause;
      }
      if (matchesTokens(item.layerTokens, this.denyLayerTokens) || matchesTokens(item.blockTokens, this.denyBlockTokens) ||
          item.attributeTokens.some(tokens => matchesTokens(tokens, this.denyAttributeTokens)) ||
          nearbyTexts.some(text => matchesTokens(text.tokens, this.denyNearbyTextTokens))) continue;
      if (!matchesTokens(item.layerTokens, this.layerTokens)) continue;
      if (!matchesTokens(item.blockTokens, this.blockTokens)) continue;
      if ((frequencies.get(item.blockKey) ?? 0) < this.profile.minimumBlockOccurrences) continue;
      const evidence = ["layer_pattern", "block_pattern", "block_frequency"];
      if (item.attributeTokens.some(tokens => matchesTokens(tokens, this.attributeTokens))) evidence.push("attribute_pattern");
      if (nearbyTexts.some(text => matchesTokens(text.tokens, this.nearbyTextTokens))) evidence.push("nearby_text_pattern");
      detected.push({
        sourceEntityId: insert.sourceEntityId,
        layerName: insert.layer,
        blockName: insert.blockName,
        position: { ...insert.position },
        rotation: insert.rotation,
        confidence: this.profile.confidence,
        method: "rule",
        evidence
      });
      if (detected.length > this.profile.maxCandidates) throw new Error("CAD lighting candidate limit exceeded");
    }
    return detected;
  }
}
