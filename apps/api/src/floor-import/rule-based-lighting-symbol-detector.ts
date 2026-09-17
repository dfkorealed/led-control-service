import { createHash } from "node:crypto";
import { iterateCadDocumentExpansion, iterateCadInsertExpansion, transformPoint } from "./cad-geometry";
import type { NormalizedCadDocument } from "./cad-types";
import type { DetectedLightingSymbol, LightingDetectionOptions, LightingSymbolDetector } from "./lighting-symbol-detector";

export interface LightingDetectionProfile {
  profileId: string;
  profileVersion: string;
  exactBlockAllowlist: readonly string[];
  layerNameTokens: readonly string[];
  blockNameTokens: readonly string[];
  minimumBlockOccurrences: number;
  confidence: number;
  maxCandidates: number;
  maxExpandedInserts: number;
  maxExpandedEntities: number;
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

export const GENERIC_LIGHTING_PROFILE: LightingDetectionProfile = {
  profileId: "generic-lighting-v1",
  profileVersion: "generic-lighting/1",
  exactBlockAllowlist: ["LED직부등"],
  layerNameTokens: ["조명", "전등", "LIGHT", "LIGHTING", "LAMP", "LED"],
  blockNameTokens: ["조명", "전등", "LIGHT", "LAMP", "LED", "FIXTURE", "LUMINAIRE"],
  minimumBlockOccurrences: 2,
  confidence: 0.95,
  maxCandidates: 2_000,
  maxExpandedInserts: 100_000,
  maxExpandedEntities: 1_000_000,
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

export const SITE_DRAWING_20260803_PROFILE: LightingDetectionProfile = {
  ...GENERIC_LIGHTING_PROFILE,
  profileId: "site-drawing-20260803-v1",
  profileVersion: "site-drawing-20260803/1",
  exactBlockAllowlist: ["몰드바등"],
  maxDurationMs: 30_000
};

function profileDigest(profile: LightingDetectionProfile, exactBlockAllowlist: readonly string[]): string {
  const canonical = (values: readonly string[]) => values.map(value => value.normalize("NFKC").toUpperCase().trim()).sort();
  return createHash("sha256").update(JSON.stringify({
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    exactBlockAllowlist: [...exactBlockAllowlist].sort(),
    layerNameTokens: canonical(profile.layerNameTokens),
    blockNameTokens: canonical(profile.blockNameTokens),
    minimumBlockOccurrences: profile.minimumBlockOccurrences,
    confidence: profile.confidence,
    maxCandidates: profile.maxCandidates,
    maxExpandedInserts: profile.maxExpandedInserts,
    maxExpandedEntities: profile.maxExpandedEntities,
    attributeValueTokens: canonical(profile.attributeValueTokens),
    nearbyTextTokens: canonical(profile.nearbyTextTokens),
    denyLayerNameTokens: canonical(profile.denyLayerNameTokens),
    denyBlockNameTokens: canonical(profile.denyBlockNameTokens),
    denyAttributeValueTokens: canonical(profile.denyAttributeValueTokens),
    denyNearbyTextTokens: canonical(profile.denyNearbyTextTokens),
    nearbyTextDistance: profile.nearbyTextDistance,
    maxDurationMs: profile.maxDurationMs,
    cooperativeYieldInterval: profile.cooperativeYieldInterval
  })).digest("hex");
}

export const DEFAULT_LIGHTING_PROFILE_VERSION = GENERIC_LIGHTING_PROFILE.profileVersion;
export const DEFAULT_LIGHTING_PROFILE_DIGEST = profileDigest(
  GENERIC_LIGHTING_PROFILE,
  GENERIC_LIGHTING_PROFILE.exactBlockAllowlist.map(value => value.normalize("NFKC").toUpperCase())
);

const MAX_COOPERATIVE_YIELD_INTERVAL = 1024;
const TOKEN_CHARACTER = /^[\p{L}\p{N}]$/u;

type AfterPrimitiveWork = () => Promise<void> | undefined;

function tokenize(value: string): string[] {
  return value.normalize("NFKC").toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

async function tokenizeCooperatively(value: string, afterWork: AfterPrimitiveWork): Promise<string[]> {
  const normalized = value.normalize("NFKC").toUpperCase();
  const tokens: string[] = [];
  let token = "";
  for (const character of normalized) {
    if (TOKEN_CHARACTER.test(character)) token += character;
    else if (token) {
      tokens.push(token);
      token = "";
    }
    const pause = afterWork();
    if (pause) await pause;
  }
  if (token) tokens.push(token);
  return tokens;
}

async function normalizeCooperatively(value: string, afterWork: AfterPrimitiveWork): Promise<string> {
  const normalized = value.normalize("NFKC").toUpperCase();
  for (const _character of normalized) {
    const pause = afterWork();
    if (pause) await pause;
  }
  return normalized;
}

function normalizeMatchers(tokens: readonly string[], label: string, allowEmpty = false): string[][] {
  const normalized = tokens.map(tokenize).filter(tokens => tokens.length > 0);
  if ((!allowEmpty && !normalized.length) || normalized.some(tokens => tokens.join("").length > 128)) throw new Error(`Invalid ${label} tokens`);
  return normalized;
}

async function matchesTokens(
  tokens: readonly string[], matchers: readonly string[][], afterWork: AfterPrimitiveWork
): Promise<boolean> {
  for (const matcher of matchers) {
    const lastStart = tokens.length - matcher.length;
    let pause = afterWork();
    if (pause) await pause;
    for (let index = 0; index <= lastStart; index++) {
      let matches = true;
      for (let offset = 0; offset < matcher.length; offset++) {
        const equal = tokens[index + offset] === matcher[offset];
        pause = afterWork();
        if (pause) await pause;
        if (!equal) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
  }
  return false;
}

async function someTokensMatch(
  tokenGroups: readonly string[][], matchers: readonly string[][], afterWork: AfterPrimitiveWork
): Promise<boolean> {
  for (const tokens of tokenGroups) {
    if (await matchesTokens(tokens, matchers, afterWork)) return true;
    const pause = afterWork();
    if (pause) await pause;
  }
  return false;
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

  async nearby(
    position: { x: number; y: number }, distance: number, afterWork: AfterPrimitiveWork
  ): Promise<string[][]> {
    const nearbyTokenGroups: string[][] = [];
    const centerX = this.coordinate(position.x);
    const centerY = this.coordinate(position.y);
    const radius = distance === 0 ? 0 : Math.ceil(distance / this.cellSize);
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      for (let y = centerY - radius; y <= centerY + radius; y++) {
        const texts = this.cells.get(this.key(x, y)) ?? [];
        let pause = afterWork();
        if (pause) await pause;
        for (const text of texts) {
          const isNearby = Math.hypot(text.position.x - position.x, text.position.y - position.y) <= distance;
          pause = afterWork();
          if (pause) await pause;
          if (isNearby) nearbyTokenGroups.push(text.tokens);
        }
      }
    }
    return nearbyTokenGroups;
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
  private readonly exactBlockAllowlist: Set<string>;
  readonly profileVersion: string;
  readonly profileDigest: string;
  readonly profileId: string;

  constructor(profile: Partial<LightingDetectionProfile> = {}) {
    this.profile = { ...GENERIC_LIGHTING_PROFILE, ...profile };
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(this.profile.profileId)) throw new Error("Invalid detector profile id");
    if (!this.profile.profileVersion.trim() || this.profile.profileVersion.length > 128) throw new Error("Invalid detector profile version");
    if (!Number.isInteger(this.profile.minimumBlockOccurrences) || this.profile.minimumBlockOccurrences < 1) throw new Error("Invalid minimum block occurrence count");
    if (!Number.isInteger(this.profile.maxCandidates) || this.profile.maxCandidates < 1) throw new Error("Invalid candidate limit");
    if (!Number.isInteger(this.profile.maxExpandedInserts) || this.profile.maxExpandedInserts < 1) throw new Error("Invalid expanded INSERT limit");
    if (!Number.isInteger(this.profile.maxExpandedEntities) || this.profile.maxExpandedEntities < 1) throw new Error("Invalid expanded entity limit");
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
    this.exactBlockAllowlist = new Set(this.profile.exactBlockAllowlist.map(value => value.normalize("NFKC").toUpperCase()));
    if (this.exactBlockAllowlist.size !== this.profile.exactBlockAllowlist.length || [...this.exactBlockAllowlist].some(value => !value || value.length > 512)) {
      throw new Error("Invalid exact block allowlist");
    }
    this.profileVersion = this.profile.profileVersion;
    this.profileId = this.profile.profileId;
    this.profileDigest = profileDigest(this.profile, [...this.exactBlockAllowlist]);
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
    const textGrid = new CadTextGrid(this.profile.nearbyTextDistance);
    for (const item of iterateCadDocumentExpansion(document, { maxRenderedEntities: this.profile.maxExpandedEntities, checkBudget })) {
      if (item && (item.entity.type === "text" || item.entity.type === "mtext")) {
        textGrid.add({
          tokens: await tokenizeCooperatively(item.entity.text, afterWork),
          position: transformPoint(item.matrix, item.entity.position)
        });
      }
      const pause = afterWork();
      if (pause) await pause;
    }
    const frequencies = new Map<string, number>();
    const prepared = [];
    for (const insert of inserts) {
      const key = await normalizeCooperatively(insert.blockName, afterWork);
      frequencies.set(key, (frequencies.get(key) ?? 0) + 1);
      const attributeTokens: string[][] = [];
      for (const attribute of insert.entity.attributes) {
        attributeTokens.push(
          await tokenizeCooperatively(attribute.tag, afterWork),
          await tokenizeCooperatively(attribute.value, afterWork)
        );
        const pause = afterWork();
        if (pause) await pause;
      }
      prepared.push({
        insert,
        blockKey: key,
        layerTokens: await tokenizeCooperatively(insert.layer, afterWork),
        blockTokens: await tokenizeCooperatively(insert.blockName, afterWork),
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
      const nearbyTokenGroups = await textGrid.nearby(insert.position, this.profile.nearbyTextDistance, afterWork);
      if (await matchesTokens(item.layerTokens, this.denyLayerTokens, afterWork) ||
          await matchesTokens(item.blockTokens, this.denyBlockTokens, afterWork) ||
          await someTokensMatch(item.attributeTokens, this.denyAttributeTokens, afterWork) ||
          await someTokensMatch(nearbyTokenGroups, this.denyNearbyTextTokens, afterWork)) {
        checkBudget();
        continue;
      }
      const exactBlockMatch = this.exactBlockAllowlist.has(item.blockKey);
      const layerMatch = await matchesTokens(item.layerTokens, this.layerTokens, afterWork);
      if (!exactBlockMatch && !layerMatch) {
        checkBudget();
        continue;
      }
      if (!exactBlockMatch && !await matchesTokens(item.blockTokens, this.blockTokens, afterWork)) {
        checkBudget();
        continue;
      }
      if ((frequencies.get(item.blockKey) ?? 0) < this.profile.minimumBlockOccurrences) {
        checkBudget();
        continue;
      }
      const evidence = [
        ...(layerMatch ? ["layer_pattern"] : []),
        exactBlockMatch ? "exact_block_allowlist" : "block_pattern",
        "block_frequency"
      ];
      if (await someTokensMatch(item.attributeTokens, this.attributeTokens, afterWork)) evidence.push("attribute_pattern");
      if (await someTokensMatch(nearbyTokenGroups, this.nearbyTextTokens, afterWork)) evidence.push("nearby_text_pattern");
      detected.push({
        sourceEntityId: insert.sourceEntityId,
        layerName: insert.layer,
        blockName: insert.blockName,
        position: { ...insert.position },
        rotation: insert.rotation,
        confidence: this.profile.confidence,
        method: "rule",
        evidence,
        profileVersion: this.profileVersion,
        profileDigest: this.profileDigest
      });
      if (detected.length > this.profile.maxCandidates) throw new Error("CAD lighting candidate limit exceeded");
      checkBudget();
    }
    checkBudget();
    return detected;
  }
}
