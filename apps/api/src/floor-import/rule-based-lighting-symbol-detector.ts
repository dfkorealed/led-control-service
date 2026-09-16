import { expandCadDocument, expandCadInserts, transformPoint } from "./cad-geometry";
import type { NormalizedCadDocument } from "./cad-types";
import type { DetectedLightingSymbol, LightingSymbolDetector } from "./lighting-symbol-detector";

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
  nearbyTextDistance: 5
};

function tokenize(value: string): string[] {
  return value.normalize("NFKC").toLocaleUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function normalizeMatchers(tokens: readonly string[], label: string, allowEmpty = false): string[][] {
  const normalized = tokens.map(tokenize).filter(tokens => tokens.length > 0);
  if ((!allowEmpty && !normalized.length) || normalized.some(tokens => tokens.join("").length > 128)) throw new Error(`Invalid ${label} tokens`);
  return normalized;
}

function matches(value: string, matchers: readonly string[][]): boolean {
  const tokens = tokenize(value);
  return matchers.some(matcher => tokens.some((_, index) => matcher.every((token, offset) => tokens[index + offset] === token)));
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
    this.layerTokens = normalizeMatchers(this.profile.layerNameTokens, "layer name");
    this.blockTokens = normalizeMatchers(this.profile.blockNameTokens, "block name");
    this.attributeTokens = normalizeMatchers(this.profile.attributeValueTokens, "attribute value", true);
    this.nearbyTextTokens = normalizeMatchers(this.profile.nearbyTextTokens, "nearby text", true);
    this.denyLayerTokens = normalizeMatchers(this.profile.denyLayerNameTokens, "denied layer name", true);
    this.denyBlockTokens = normalizeMatchers(this.profile.denyBlockNameTokens, "denied block name", true);
    this.denyAttributeTokens = normalizeMatchers(this.profile.denyAttributeValueTokens, "denied attribute value", true);
    this.denyNearbyTextTokens = normalizeMatchers(this.profile.denyNearbyTextTokens, "denied nearby text", true);
  }

  async detect(document: NormalizedCadDocument): Promise<DetectedLightingSymbol[]> {
    const inserts = expandCadInserts(document, { maxExpandedInserts: this.profile.maxExpandedInserts });
    const expandedEntities = expandCadDocument(document, { maxRenderedEntities: this.profile.maxExpandedInserts });
    const texts = expandedEntities.flatMap(item => item.entity.type === "text" || item.entity.type === "mtext"
      ? [{ text: item.entity.text, position: transformPoint(item.matrix, item.entity.position) }]
      : []);
    const frequencies = new Map<string, number>();
    const blockKey = (value: string) => value.normalize("NFKC").toLocaleUpperCase();
    inserts.forEach(insert => frequencies.set(blockKey(insert.blockName), (frequencies.get(blockKey(insert.blockName)) ?? 0) + 1));
    const detected: DetectedLightingSymbol[] = [];

    for (const insert of inserts) {
      const nearbyTexts = texts.filter(text => Math.hypot(text.position.x - insert.position.x, text.position.y - insert.position.y) <= this.profile.nearbyTextDistance);
      const attributeValues = insert.entity.attributes.flatMap(attribute => [attribute.tag, attribute.value]);
      if (matches(insert.layer, this.denyLayerTokens) || matches(insert.blockName, this.denyBlockTokens) ||
          attributeValues.some(value => matches(value, this.denyAttributeTokens)) || nearbyTexts.some(text => matches(text.text, this.denyNearbyTextTokens))) continue;
      if (!matches(insert.layer, this.layerTokens)) continue;
      if (!matches(insert.blockName, this.blockTokens)) continue;
      if ((frequencies.get(blockKey(insert.blockName)) ?? 0) < this.profile.minimumBlockOccurrences) continue;
      const evidence = ["layer_pattern", "block_pattern", "block_frequency"];
      if (attributeValues.some(value => matches(value, this.attributeTokens))) evidence.push("attribute_pattern");
      if (nearbyTexts.some(text => matches(text.text, this.nearbyTextTokens))) evidence.push("nearby_text_pattern");
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
