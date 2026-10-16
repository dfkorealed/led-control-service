import type { AutomationSnapshot, VehicleEventRuleSnapshotV3 } from "@led-control/shared";
import { isDeepStrictEqual } from "node:util";
import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import type { BioSelfSensorConfigurationObservation, BioSelfSensorOperationControl } from "../bio/bio-dongle-client";
import { assertRestorableSelfSensorConfiguration, buildSelfSensorConfiguration, sameSelfSensorConfiguration,
  type BioSelfSensorConfiguration } from "../bio/bio-self-sensor-configuration";
import { parseAutomationSnapshot, type AutomationScope } from "./automation-config-store";
import { parseBioSourceBinding, type BioSourceBinding } from "./automation-state-store";
import { isBioSelfSensorErrorCode } from "./bio-self-sensor-errors";

type Configuration = BioSelfSensorConfigurationObservation;
type Intent = Parameters<BioSelfSensorOperationControl["beforeSelfSensorMutation"]>[0];
type BeforeIntent = BioSelfSensorOperationControl["beforeSelfSensorMutation"];
export interface BioSelfSensorIdentity { fixtureId: string; assignmentVersion: number; binding: BioSourceBinding }
export interface BioSelfSensorPort {
  identity: BioSelfSensorIdentity;
  read(): Promise<Configuration>;
  configure(desired: BioSelfSensorConfiguration, beforeIntent: BeforeIntent): Promise<Configuration>;
  restore(original: Configuration, expected: Configuration, beforeIntent: BeforeIntent): Promise<Configuration>;
}
interface Row {
  ruleId: string; revision: number; identity: BioSelfSensorIdentity; original: Configuration; desired: Configuration;
  applied: Configuration | null; phase: "applying" | "applied" | "restoring"; intent: Intent | null;
}
interface Journal { version: 1; scope: AutomationScope & { assignmentVersion: number }; rows: Record<string, Row> }
export interface BioSelfSensorRuntimeOptions {
  path: string;
  scope: Journal["scope"];
  resolve(fixtureId: string, revision: number, release?: BioSelfSensorIdentity): Promise<BioSelfSensorPort>;
}

/** Separate durable native owner: never expands the source into force-on/off
 * targets or lets a pulse timer change its mode. Unknown partial writes remain
 * protected and visible as rejected configuration, not silently retried. */
export class BioSelfSensorRuntime {
  private readonly queue = new SerialTaskQueue();
  private journal: Journal;
  private loading?: Promise<void>;
  private blocked = false;
  constructor(private readonly options: BioSelfSensorRuntimeOptions) {
    this.journal = { version: 1, scope: { ...options.scope }, rows: {} };
  }

  initialize(): Promise<void> {
    return this.loading ??= this.load();
  }

  protectedFixtureIds(): string[] { return Object.keys(this.journal.rows); }

  reconcile(raw: AutomationSnapshot | null): Promise<void> {
    return this.run(raw, false);
  }

  /** Roll back only known applied owners. Partial intents remain protected;
   * ordinary metadata rollback must not erase them or guess an RF restoration. */
  rollback(raw: AutomationSnapshot | null): Promise<void> {
    return this.run(raw, true);
  }

  private run(raw: AutomationSnapshot | null, rollback: boolean): Promise<void> {
    return this.queue.run(async () => {
      await this.initialize();
      if (this.blocked) throw new Error("bio_self_storage_unavailable");
      const snapshot = raw ? parseAutomationSnapshot(raw, this.options.scope) : null;
      const rules = snapshot?.schemaVersion === 3 ? snapshot.vehicleEventRules.filter(rule => rule.status === "enabled" && rule.selfControlEnabled) : [];
      const wanted = new Map<string, VehicleEventRuleSnapshotV3>();
      for (const rule of rules) {
        const fixtureId = rule.sourceFixtureIds[0]!;
        if (wanted.has(fixtureId)) throw new Error("bio_self_control_conflict");
        wanted.set(fixtureId, rule);
      }
      // Restore removed owners first, with their original-bound identity. A new
      // rule must never recapture an old activation's temporary settings as base.
      for (const [fixtureId, row] of Object.entries(this.journal.rows)) {
        if (rollback && row.phase !== "applied") continue;
        if (wanted.get(fixtureId)?.id !== row.ruleId) await this.release(fixtureId, row);
      }
      for (const [fixtureId, rule] of wanted) {
        if (rollback && this.journal.rows[fixtureId]?.phase !== "applied") continue;
        await this.apply(fixtureId, rule, snapshot!.revision);
      }
    });
  }

  private async apply(fixtureId: string, rule: VehicleEventRuleSnapshotV3, revision: number): Promise<void> {
    let row = this.journal.rows[fixtureId];
    const port = await this.options.resolve(fixtureId, revision);
    this.assertIdentity(port.identity, fixtureId, row?.identity);
    const observed = await port.read();
    assertRestorableSelfSensorConfiguration(observed);
    if (row && row.phase !== "applied") {
      // An exact full GET may establish a previously completed write after a
      // crash. A mixed result never authorizes SET replay or automatic rollback.
      if (row.phase === "applying" && sameSelfSensorConfiguration(observed, row.desired)) {
        row.applied = observed; row.phase = "applied"; row.intent = null; await this.persist();
      } else throw new Error("bio_self_configuration_pending");
    }
    if (row && (!row.applied || !sameSelfSensorConfiguration(observed, row.applied))) throw new Error("bio_self_ownership_changed");
    const original = row?.original ?? observed;
    // Preserve the fixture's stored native no-motion brightness. This UI edits
    // detection brightness/hold only; do not invent a new standby or phase value.
    const desired = { highBrightnessPercent: rule.action.dimmingEnabled ? rule.action.brightnessPercent : 100,
      standbyBrightnessPercent: original.standbyBrightnessPercent, holdSeconds: rule.holdSeconds };
    const intended = buildSelfSensorConfiguration(original, desired);
    if (row && sameSelfSensorConfiguration(observed, intended)) {
      row.identity = structuredClone(port.identity); row.revision = revision; await this.persist(); return;
    }
    row = { ruleId: rule.id, revision, identity: structuredClone(port.identity), original: structuredClone(original),
      desired: intended, applied: row?.applied ?? null, phase: "applying", intent: null };
    this.journal.rows[fixtureId] = row;
    await this.persist();
    let applied: Configuration;
    try {
      applied = await port.configure(desired, async intent => { row!.intent = structuredClone(intent); await this.persist(); });
    } catch (cause) {
      // A durable applying row exists, and a failed GET does not prove whether
      // the preceding SET reached the lamp. Keep the owner; never retry blindly.
      if (cause instanceof Error && isBioSelfSensorErrorCode(cause.message)) throw cause;
      throw new Error("bio_self_configuration_pending", { cause });
    }
    if (!sameSelfSensorConfiguration(applied, intended)) throw new Error("bio_self_configuration_pending");
    row.applied = structuredClone(applied); row.phase = "applied"; row.intent = null; await this.persist();
  }

  private async release(fixtureId: string, row: Row): Promise<void> {
    const port = await this.options.resolve(fixtureId, row.revision, row.identity);
    this.assertIdentity(port.identity, fixtureId, row.identity);
    if (row.phase === "restoring") {
      const observed = await port.read();
      if (sameSelfSensorConfiguration(observed, row.original)) {
        delete this.journal.rows[fixtureId]; await this.persist(); return;
      }
      throw new Error("bio_self_configuration_pending");
    }
    if (row.phase !== "applied" || !row.applied) throw new Error("bio_self_configuration_pending");
    row.phase = "restoring"; await this.persist();
    const restored = await port.restore(row.original, row.applied, async intent => { row.intent = structuredClone(intent); await this.persist(); });
    if (!sameSelfSensorConfiguration(restored, row.original)) throw new Error("bio_self_configuration_pending");
    delete this.journal.rows[fixtureId]; await this.persist();
  }

  private assertIdentity(actual: BioSelfSensorIdentity, fixtureId: string, expected?: BioSelfSensorIdentity): void {
    const physical = (value: BioSelfSensorIdentity) => {
      const { capabilityRevision: _capability, snapshotRevision: _revision, ...binding } = value.binding;
      return { fixtureId: value.fixtureId, assignmentVersion: value.assignmentVersion, binding };
    };
    if (actual.fixtureId !== fixtureId || actual.assignmentVersion !== this.options.scope.assignmentVersion
      || (expected && !isDeepStrictEqual(physical(actual), physical(expected)))) throw new Error("bio_self_identity_changed");
  }

  private async persist(): Promise<void> {
    try { await writeJsonAtomic(this.options.path, this.journal); }
    catch (cause) { this.blocked = true; throw new Error("bio_self_storage_unavailable", { cause }); }
  }

  private async load(): Promise<void> {
    const raw = await readJsonFile(this.options.path, { maxBytes: 4 * 1024 * 1024 });
    if (raw === null) return;
    const value = raw as Journal;
    if (!value || Object.keys(value).sort().join() !== "rows,scope,version" || value.version !== 1
      || !isDeepStrictEqual(value.scope, this.options.scope) || !value.rows || typeof value.rows !== "object" || Array.isArray(value.rows)
      || Object.keys(value.rows).length > 10_000) throw new Error("bio_self_journal_invalid");
    for (const [fixtureId, row] of Object.entries(value.rows)) {
      if (!row || Object.keys(row).sort().join() !== "applied,desired,identity,intent,original,phase,revision,ruleId"
        || !/^[0-9a-f-]{36}$/.test(row.ruleId) || !Number.isSafeInteger(row.revision) || row.revision < 0
        || !["applying", "applied", "restoring"].includes(row.phase)) throw new Error("bio_self_journal_invalid");
      row.identity.binding = parseBioSourceBinding(row.identity.binding);
      if (row.identity.binding.sourceFixtureId !== fixtureId) throw new Error("bio_self_journal_invalid");
      this.assertIdentity(row.identity, fixtureId);
      assertRestorableSelfSensorConfiguration(row.original); assertRestorableSelfSensorConfiguration(row.desired);
      if (row.applied !== null) assertRestorableSelfSensorConfiguration(row.applied);
      if (row.phase === "applied" && row.applied === null) throw new Error("bio_self_journal_invalid");
      if (row.intent !== null) {
        if (!["standby_brightness", "hold_interval", "high_brightness", "mode"].includes(row.intent.stage)) throw new Error("bio_self_journal_invalid");
        assertRestorableSelfSensorConfiguration(row.intent.original); assertRestorableSelfSensorConfiguration(row.intent.desired);
      }
    }
    this.journal = value;
  }
}
