import { createHash } from "node:crypto";
import { bioSensorCatalogV1Schema, bioSensorCatalogAckV1Schema, bioSensorCatalogCanonicalJson,
  canonicalBioSensorFingerprint, bioFirmwareFingerprint, bioProfileKey,
  type BioSensorCatalogV1, type BioSensorProfileV1 } from "@led-control/shared";
import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";
import type { BioSensorPulseProfile } from "./bio-sensor-pulse-intake";

export type BioSensorScope = { siteId: string; gatewayId: string; assignmentVersion: number };
export interface BioPulseCatalogPort {
  snapshot(): BioSensorCatalogV1 | null;
  onChange(listener: () => void): () => void;
}
export function bioEnvelopeHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bioSensorCatalogCanonicalJson(value)).digest("hex")}`;
}
export function approvedBioProfile(catalog: BioSensorCatalogV1 | null, fingerprint: unknown): BioSensorProfileV1 | null {
  if (!catalog || !fingerprint) return null;
  const key = canonicalBioSensorFingerprint(fingerprint);
  const matches = catalog.profiles.filter(p => p.status === "approved" && canonicalBioSensorFingerprint(p.fingerprint) === key);
  // Ambiguous approvals cannot choose semantics by array order.
  return matches.length === 1 ? structuredClone(matches[0]!) : null;
}
export function pulseProfiles(catalog: BioSensorCatalogV1 | null): BioSensorPulseProfile[] {
  return (catalog?.profiles ?? []).filter(p => p.status === "approved").flatMap(p => p.bodyHexes.map(bodyHex => ({
    id: bioProfileKey(p), firmwareFingerprint: bioFirmwareFingerprint(p.fingerprint), sensorFingerprint: canonicalBioSensorFingerprint(p.fingerprint), bodyHex
  })));
}
/** Durable catalog is approval data only: no health is recovered from disk. */
export class FileBioSensorProfileCatalog implements BioPulseCatalogPort {
  private value: BioSensorCatalogV1 | null = null;
  private fenced = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly path: string, readonly scope: BioSensorScope) {}
  async initialize() {
    const stored = await readJsonFile(this.path);
    if (stored === null) return;
    const record = stored as { catalog: unknown; hash: string };
    const parsed = bioSensorCatalogV1Schema.parse(record.catalog);
    if (!this.matchesScope(parsed) || record.hash !== bioEnvelopeHash(parsed)) throw new Error("BIO_CATALOG_INVALID");
    this.value = parsed;
  }
  snapshot() { return structuredClone(this.value); }
  onChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  apply(raw: unknown) {
    const task = this.queue.then(async () => {
      const next = bioSensorCatalogV1Schema.parse(raw), hash = bioEnvelopeHash(next);
      if (this.fenced) throw new Error("BIO_CATALOG_COMMIT_UNCERTAIN");
      let status: "applied" | "duplicate" | "stale" | "rejected" = "rejected";
      if (this.matchesScope(next)) {
        if (this.value && next.catalogRevision < this.value.catalogRevision) status = "stale";
        else if (this.value && next.catalogRevision === this.value.catalogRevision) status = hash === bioEnvelopeHash(this.value) ? "duplicate" : "rejected";
        else {
          // Revocation precedes awaits; an uncertain disk commit never keeps old authority.
          this.value = null; this.notify();
          try { await writeJsonAtomic(this.path, { catalog: next, hash }); }
          catch (error) { this.fenced = true; throw error; }
          this.value = next; this.notify(); status = "applied";
        }
      }
      return bioSensorCatalogAckV1Schema.parse({ schemaVersion: 1, siteId: next.siteId, gatewayId: next.gatewayId,
        assignmentVersion: next.assignmentVersion, eventId: next.eventId, catalogRevision: next.catalogRevision,
        deliveryPayloadHash: hash, status, occurredAt: new Date().toISOString() });
    });
    this.queue = task.catch(() => undefined); return task;
  }
  private matchesScope(value: BioSensorCatalogV1) { return value.siteId === this.scope.siteId && value.gatewayId === this.scope.gatewayId && value.assignmentVersion === this.scope.assignmentVersion; }
  private notify() { for (const listener of this.listeners) { try { listener(); } catch { /* Durable approval cannot grant authority through a failed observer. */ } } }
}
