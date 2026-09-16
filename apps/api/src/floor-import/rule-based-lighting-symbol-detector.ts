import type { NormalizedCadDocument, NormalizedCadInsert } from "./cad-types";
import type { DetectedLightingSymbol, LightingSymbolDetector } from "./lighting-symbol-detector";

export interface LightingDetectionProfile {
  layerNameTokens: readonly string[];
  blockNameTokens: readonly string[];
  minimumBlockOccurrences: number;
  confidence: number;
  maxCandidates: number;
}

const DEFAULT_PROFILE: LightingDetectionProfile = {
  layerNameTokens: ["조명", "전등", "LIGHT", "LAMP", "LED"],
  blockNameTokens: ["조명", "전등", "LIGHT", "LAMP", "LED", "FIXTURE", "LUMINAIRE"],
  minimumBlockOccurrences: 2,
  confidence: 0.95,
  maxCandidates: 10_000
};

function normalizeTokens(tokens: readonly string[], label: string): string[] {
  const normalized = tokens.map(token => token.trim().toLocaleUpperCase()).filter(Boolean);
  if (!normalized.length || normalized.some(token => token.length > 128)) throw new Error(`Invalid ${label} tokens`);
  return normalized;
}

export class RuleBasedLightingSymbolDetector implements LightingSymbolDetector {
  private readonly profile: LightingDetectionProfile;
  private readonly layerTokens: string[];
  private readonly blockTokens: string[];

  constructor(profile: Partial<LightingDetectionProfile> = {}) {
    this.profile = { ...DEFAULT_PROFILE, ...profile };
    if (!Number.isInteger(this.profile.minimumBlockOccurrences) || this.profile.minimumBlockOccurrences < 1) throw new Error("Invalid minimum block occurrence count");
    if (!Number.isInteger(this.profile.maxCandidates) || this.profile.maxCandidates < 1) throw new Error("Invalid candidate limit");
    if (!Number.isFinite(this.profile.confidence) || this.profile.confidence <= 0 || this.profile.confidence > 1) throw new Error("Invalid detector confidence");
    this.layerTokens = normalizeTokens(this.profile.layerNameTokens, "layer name");
    this.blockTokens = normalizeTokens(this.profile.blockNameTokens, "block name");
  }

  async detect(document: NormalizedCadDocument): Promise<DetectedLightingSymbol[]> {
    const inserts = document.entities.filter((entity): entity is NormalizedCadInsert => entity.type === "insert");
    const frequencies = new Map<string, number>();
    inserts.forEach(entity => frequencies.set(entity.blockName, (frequencies.get(entity.blockName) ?? 0) + 1));
    const matches = (value: string, tokens: readonly string[]) => {
      const normalized = value.toLocaleUpperCase();
      return tokens.some(token => normalized.includes(token));
    };
    const detected: DetectedLightingSymbol[] = [];

    for (const entity of inserts) {
      if (!matches(entity.layer, this.layerTokens)) continue;
      if (!matches(entity.blockName, this.blockTokens)) continue;
      if ((frequencies.get(entity.blockName) ?? 0) < this.profile.minimumBlockOccurrences) continue;
      detected.push({
        sourceEntityId: entity.sourceEntityId,
        layerName: entity.layer,
        blockName: entity.blockName,
        position: { ...entity.position },
        rotation: entity.rotation,
        confidence: this.profile.confidence,
        method: "rule",
        evidence: ["layer_pattern", "block_pattern", "block_frequency"]
      });
      if (detected.length > this.profile.maxCandidates) throw new Error("CAD lighting candidate limit exceeded");
    }
    return detected;
  }
}
