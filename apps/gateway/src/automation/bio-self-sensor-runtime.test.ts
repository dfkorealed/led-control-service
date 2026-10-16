import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bioEnvelopeHash as canonicalPayloadHash } from '../bio/bio-sensor-profile-catalog';
import type { AutomationSnapshotV3 } from '@led-control/shared';
import { BioSelfSensorRuntime } from './bio-self-sensor-runtime';
import { buildSelfSensorConfiguration, sameSelfSensorConfiguration } from '../bio/bio-self-sensor-configuration';
import type { BioSelfSensorConfigurationObservation } from '../bio/bio-dongle-client';
const scope = { siteId: '00000000-0000-4000-8000-000000000001', gatewayId: '00000000-0000-4000-8000-000000000002', assignmentVersion: 1 };
const fixtureId = '00000000-0000-4000-8000-000000000003', ruleId = '00000000-0000-4000-8000-000000000004';
const initial = { highBrightnessPercent: 70, standbyBrightnessPercent: 10, holdSeconds: 5, standbySeconds: 5, delayMode: 0 as const, bioMode: 'sensor' as const, rawHoldInterval: 10, rawStandbyInterval: 10 };
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true }); });
function snapshot(revision = 1, enabled = true, holdSeconds = 1): AutomationSnapshotV3 {
    const body = { schemaVersion: 3 as const, ...{ siteId: scope.siteId, gatewayId: scope.gatewayId }, revision, timeZone: 'Asia/Seoul', schedules: [], holidayDatasets: [], vehicleEventRules: enabled ? [{ id: ruleId, name: 'self', status: 'enabled' as const, sensorProtocol: 'bio-usb-pulse' as const, selfControlEnabled: true, sourceFixtureIds: [fixtureId], targetFixtureIds: [], action: { dimmingEnabled: true, brightnessPercent: 100 }, holdSeconds }] : [], generatedAt: '2026-10-16T00:00:00.000Z' };
    return { ...body, payloadHash: canonicalPayloadHash(body) };
}
async function harness() {
    const dir = await mkdtemp(join(tmpdir(), 'bio-self-runtime-'));
    dirs.push(dir);
    const path = join(dir, 'native.json');
    let physical: BioSelfSensorConfigurationObservation = { ...initial };
    let writes = 0, fail = false, foreign = false;
    const identity = { fixtureId, assignmentVersion: 1, binding: { sourceFixtureId: fixtureId, nativeUuid: '001122334455', logicalAddress: 260, networkId: 0, capabilityRevision: 1, snapshotRevision: 1, profileId: 'qualified', firmwareFingerprint: 'fw', sensorFingerprint: 'sensor' } };
    const port = { identity, read: async () => ({ ...physical }), configure: async (desired: any, before: any) => {
            const intended = buildSelfSensorConfiguration(physical, desired);
            await before({ original: physical, desired: intended, stage: 'hold_interval' });
            const saved = JSON.parse(await readFile(path, 'utf8'));
            expect(saved.rows[fixtureId].phase).toBe('applying');
            expect(saved.rows[fixtureId].original).toEqual(initial);
            if (fail) {
                physical = { ...physical, rawHoldInterval: 2, holdSeconds: 1 };
                writes++;
                throw Error('readback_failed');
            }
            physical = intended;
            writes++;
            return { ...physical };
        }, restore: async (original: any, expected: any, before: any) => { if (foreign || !sameSelfSensorConfiguration(physical, expected))
            throw Error('ownership_changed'); await before({ original: physical, desired: original, stage: 'mode' }); physical = { ...original }; writes++; return { ...physical }; } };
    const options = { path, scope, resolve: async () => port };
    return { path, options, port, get physical() { return physical; }, get writes() { return writes; }, set fail(v: boolean) { fail = v; }, set foreign(v: boolean) { foreign = v; } };
}
describe('native BIO self configuration durable owner', () => {
    it('captures originals before RF and restores exact values on disable', async () => { const h = await harness(), r = new BioSelfSensorRuntime(h.options); await r.reconcile(snapshot()); expect(h.physical).toMatchObject({ highBrightnessPercent: 100, holdSeconds: 1, standbyBrightnessPercent: 10, bioMode: 'sensor' }); await r.reconcile(snapshot(2, false)); expect(h.physical).toEqual(initial); expect(JSON.parse(await readFile(h.path, 'utf8')).rows).toEqual({}); });
    it('keeps the first original across edits and performs no SET for exact replay', async () => { const h = await harness(), r = new BioSelfSensorRuntime(h.options); await r.reconcile(snapshot()); await r.reconcile(snapshot()); expect(h.writes).toBe(1); await r.reconcile(snapshot(2, true, 10)); expect(h.physical.holdSeconds).toBe(10); await r.reconcile(snapshot(3, false)); expect(h.physical).toEqual(initial); });
    it('retains a partial intent across restart without blindly retrying RF', async () => { const h = await harness(); h.fail = true; const runtime = new BioSelfSensorRuntime(h.options); await expect(runtime.reconcile(snapshot())).rejects.toMatchObject({ message: 'bio_self_configuration_pending', cause: { message: 'readback_failed' } }); await runtime.rollback(null); expect(runtime.protectedFixtureIds()).toEqual([fixtureId]); h.fail = false; await expect(new BioSelfSensorRuntime(h.options).reconcile(snapshot())).rejects.toThrow('bio_self_configuration_pending'); expect(h.writes).toBe(1); expect(JSON.parse(await readFile(h.path, 'utf8')).rows[fixtureId].phase).toBe('applying'); });
    it('never overwrites an externally changed configuration during restore', async () => { const h = await harness(), r = new BioSelfSensorRuntime(h.options); await r.reconcile(snapshot()); h.foreign = true; await expect(r.reconcile(snapshot(2, false))).rejects.toThrow('ownership_changed'); expect(h.writes).toBe(1); expect(JSON.parse(await readFile(h.path, 'utf8')).rows[fixtureId].original).toEqual(initial); });
    it('rejects a different assignment before any subsequent write', async () => { const h = await harness(), r = new BioSelfSensorRuntime(h.options); await r.reconcile(snapshot()); h.port.identity.assignmentVersion = 2; await expect(r.reconcile(snapshot(2, false))).rejects.toThrow('bio_self_identity_changed'); expect(h.writes).toBe(1); });
});
