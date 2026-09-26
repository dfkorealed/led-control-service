import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { commandDrainRequestSchema, commandDrainResponseSchema, mqttTopicsV2,
  type CommandDrainRequest } from "@led-control/shared";

export type GatewayScope = { siteId: string; gatewayId: string };
export type GatewayDrainInventory = { generation: number; revision: string; complete: boolean;
  gateways: (GatewayScope & { gatewayVersion: string; bootId: string; online: boolean;
    oldSessionRevoked: boolean; physicallyIsolated: boolean })[] };
export type GatewayPhysicalCertificate = { scope: "disposable"; generation: number;
  inventoryRevision: string; certificateId: string; submitToRfUpperBoundMs: number;
  gateways: (GatewayScope & { gatewayVersion: string; bootId: string; physicalRfComplete: boolean })[] };
export type GatewaySafetyReleaseRegistry = { scope: "disposable"; revision: string;
  releases: { gatewayVersion: string; certificateId: string; dbClockProofVersion: number;
    perSubmitExpiryRecheck: boolean; conservativeRfDrainVersion: number }[] };
export type GatewayDrainEvidence = { status: "unavailable"; reason: string; productionPurgeAllowed: false }
  | { status: "verified"; generation: number; digest: string; inventoryRevision: string;
    submitToRfUpperBoundMs: number; verifiedAtMonotonicMs: number; expiresAtMonotonicMs: number;
    productionPurgeAllowed: false };
export interface GatewayDrainOptions {
  /** Query every active DB Gateway, including offline devices; never just responders. */
  activeScopes?: () => Promise<GatewayScope[]>;
  inventory?: (generation: number) => Promise<GatewayDrainInventory>;
  physicalCertificate?: (generation: number) => Promise<GatewayPhysicalCertificate>;
  /** Independent release authority, never inferred from inventory/HIL/wire
   * agreement. Versions identify immutable certified builds. There is no
   * production registry adapter or default certified version. */
  safetyReleases?: () => Promise<GatewaySafetyReleaseRegistry>;
  request?: (topic: string, payload: CommandDrainRequest) => Promise<{ topic: string; payload: unknown }>;
  monotonicNow?: () => number;
}

export class GatewayCommandDrainService {
  constructor(private readonly options: GatewayDrainOptions = {}) {}
  async verify(generation: number): Promise<GatewayDrainEvidence> {
    const unavailable = (reason: string): GatewayDrainEvidence => ({ status: "unavailable", reason,
      productionPurgeAllowed: false });
    const { activeScopes, inventory, physicalCertificate, safetyReleases, request } = this.options;
    if (!Number.isSafeInteger(generation) || generation <= 0 || !activeScopes || !inventory || !request
      || !physicalCertificate) return unavailable("gateway_census_unavailable");
    if (!safetyReleases) return unavailable("gateway_safety_certification_unavailable");
    const now = this.options.monotonicNow ?? (() => performance.now());
    const started = now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const collect = async (): Promise<GatewayDrainEvidence> => {
        const scopes = structuredClone(await activeScopes());
        const census = structuredClone(await inventory(generation));
        if (!Number.isFinite(started) || started < 0 || census.generation !== generation
          || census.complete !== true || !census.revision || !census.gateways?.length
          || scopeKey(scopes) !== scopeKey(census.gateways)
          || new Set(census.gateways.map(scopeId)).size !== census.gateways.length) {
          return unavailable("gateway_census_unavailable");
        }
        const registry = structuredClone(await safetyReleases());
        // Matching version strings authenticate no capability. The independent
        // authority must certify clock proof, every physical-submit expiry
        // recheck, and conservative RF bookkeeping for every online/offline
        // release. This still does not prove physical completion (separate HIL).
        if (registry.scope !== "disposable" || !registry.revision || !registry.releases?.length
          || new Set(registry.releases.map(release => release.gatewayVersion)).size !== registry.releases.length
          || !census.gateways.every(gateway => registry.releases.some(release =>
            release.gatewayVersion === gateway.gatewayVersion && !!release.certificateId
            && release.dbClockProofVersion === 1 && release.perSubmitExpiryRecheck === true
            && release.conservativeRfDrainVersion === 1))) {
          return unavailable("gateway_safety_version_unsupported");
        }
        const hil = structuredClone(await physicalCertificate(generation));
        // This provider is a disposable model only. There is deliberately no
        // production attestor: a wire counter, reboot or elapsed TTL proves no
        // physical BlueZ/BIO completion. HIL is a separate release authority.
        if (hil.scope !== "disposable" || hil.generation !== generation || !hil.certificateId
          || hil.inventoryRevision !== census.revision || !Number.isFinite(hil.submitToRfUpperBoundMs)
          || hil.submitToRfUpperBoundMs <= 0 || scopeKey(hil.gateways) !== scopeKey(scopes)
          || hil.gateways.length !== scopes.length
          || !census.gateways.every(gateway => hil.gateways.some(proof => scopeId(proof) === scopeId(gateway)
            && proof.bootId === gateway.bootId && proof.gatewayVersion === gateway.gatewayVersion
            && proof.physicalRfComplete === true))) return unavailable("rf_certificate_unavailable");
        const replies = [];
        for (const gateway of census.gateways) {
          if (gateway.oldSessionRevoked !== true) return unavailable("gateway_session_unrevoked");
          if (!gateway.online) {
            if (gateway.physicallyIsolated !== true) return unavailable("offline_gateway_unverified");
            continue;
          }
          const challenge = commandDrainRequestSchema.parse({ siteId: gateway.siteId,
            gatewayId: gateway.gatewayId, nonce: randomUUID(), publishEpoch: generation });
          const received = await request(mqttTopicsV2.commandDrainRequest(gateway.siteId, gateway.gatewayId), challenge);
          const parsed = commandDrainResponseSchema.safeParse(received.payload);
          if (!parsed.success) return unavailable("gateway_response_invalid");
          const response = parsed.data;
          if (received.topic !== mqttTopicsV2.commandDrainResponse(gateway.siteId, gateway.gatewayId)
            || response.siteId !== challenge.siteId || response.gatewayId !== challenge.gatewayId
            || response.nonce !== challenge.nonce || response.publishEpoch !== generation
            || response.bootId !== gateway.bootId || response.gatewayVersion !== gateway.gatewayVersion
            || response.queuedCount !== 0 || response.submittedCount !== 0 || response.unconfirmedCount !== 0) {
            return unavailable("gateway_response_invalid");
          }
          replies.push(response);
        }
        if (JSON.stringify(await inventory(generation)) !== JSON.stringify(census)
          || scopeKey(await activeScopes()) !== scopeKey(scopes)) return unavailable("gateway_census_changed");
        if (JSON.stringify(await safetyReleases()) !== JSON.stringify(registry)) {
          return unavailable("gateway_safety_certification_changed");
        }
        const finished = now();
        if (!Number.isFinite(finished) || finished < started || finished - started >= 1000) {
          return unavailable("gateway_evidence_stale");
        }
        const digest = createHash("sha256").update(JSON.stringify({ census, registry, hil, replies })).digest("hex");
        return Object.freeze({ status: "verified", generation, digest, inventoryRevision: census.revision,
          submitToRfUpperBoundMs: hil.submitToRfUpperBoundMs, verifiedAtMonotonicMs: finished,
          expiresAtMonotonicMs: started + 1000, productionPurgeAllowed: false });
      };
      return await Promise.race([collect(), new Promise<GatewayDrainEvidence>(resolve => {
        timer = setTimeout(() => resolve(unavailable("gateway_verification_timeout")), 1000);
      })]);
    } catch { return unavailable("gateway_evidence_unavailable"); }
    finally { if (timer) clearTimeout(timer); }
  }
}

const scopeId = (scope: GatewayScope) => `${scope.siteId}/${scope.gatewayId}`;
function scopeKey(scopes: GatewayScope[]): string { return scopes.map(scopeId).sort().join(";"); }
