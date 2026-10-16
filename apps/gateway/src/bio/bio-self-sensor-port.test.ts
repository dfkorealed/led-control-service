import { describe, expect, it } from 'vitest';
import { bioFirmwareFingerprint, canonicalBioSensorFingerprint } from '@led-control/shared';
import { createBioSelfSensorResolver } from './bio-self-sensor-port';
import { buildSelfSensorConfiguration } from './bio-self-sensor-configuration';
import type { BioSelfSensorConfigurationObservation } from './bio-dongle-client';
import type { BioSourceAuthority } from '../automation/bio-pulse-scheduler';
import type { BioDeviceMapping } from './bio-device-mapping-store';
const fixtureId = '00000000-0000-4000-8000-000000000003';
function harness() {
    const fingerprint = { deviceType: 1, firmware: { major: 5, minor: 5, revision: 8, build: 12889 }, sensorType: 2, infraredType: 1, ambientLightType: 0, hardwareType: 3 };
    const binding = { sourceFixtureId: fixtureId, nativeUuid: '001122334455', logicalAddress: 260, networkId: 0, capabilityRevision: 1, snapshotRevision: 1, profileId: 'profile', firmwareFingerprint: bioFirmwareFingerprint(fingerprint), sensorFingerprint: canonicalBioSensorFingerprint(fingerprint) };
    let generation = 1, leased = false, healthy = true;
    let physical: BioSelfSensorConfigurationObservation = { highBrightnessPercent: 70, standbyBrightnessPercent: 10, holdSeconds: 5, standbySeconds: 5, delayMode: 0, bioMode: 'sensor', rawHoldInterval: 10, rawStandbyInterval: 10 };
    const mapping: BioDeviceMapping = { fixtureId, nodeId: 'node', deviceUuid: 'bio:001122334455', nativeUuid: '001122334455', logicalAddress: 260, fingerprint, status: 'confirmed', protocol: 'bio', firmware: '5.5.8.12889', updatedAt: '2026-10-16Z' };
    const authority = (): BioSourceAuthority | null => healthy ? { binding, independentlyQualified: true, observation: { health: 'healthy', reason: 'qualified', connectionEpoch: 'test', connectionGeneration: generation, healthySinceMonotonicMs: 0 }, connection: { epoch: 'test', generation } } : null;
    const client = { sensorSourceSnapshot: () => ({ state: 'ready' as const, generation, ready: true, protocolReady: true, transportConnected: true }), readSelfSensorConfiguration: async (_target: any, c: any) => { await c.beforeWrite(); return { ...physical }; },
        configureSelfSensor: async (_target: any, desired: any, c: any) => { await c.beforeWrite(); const intended = buildSelfSensorConfiguration(physical, desired); await c.beforeSelfSensorMutation({ original: physical, desired: intended, stage: 'hold_interval' }); await c.beforeWrite(); physical = intended; return { ...physical }; },
        restoreSelfSensorConfiguration: async (_target: any, original: any, _expected: any, c: any) => { await c.beforeWrite(); await c.beforeSelfSensorMutation({ original: physical, desired: original, stage: 'hold_interval' }); physical = { ...original }; return { ...physical }; } };
    const resolve = createBioSelfSensorResolver({ client, mappings: { findByFixtureId: async () => mapping }, source: { preflight: async () => authority(), sourceAuthority: authority, preflightRelease: async () => true, releaseIdentityCurrent: () => true }, assignmentVersion: 1, hasLease: () => leased });
    return { resolve, mapping, binding, get physical() { return physical; }, set generation(v: number) { generation = v; }, set leased(v: boolean) { leased = v; }, set healthy(v: boolean) { healthy = v; } };
}
describe('native self sensor production port', () => {
    it('configures and restores a legacy registration using its independently qualified current fingerprint', async () => {
        const h = harness(); delete h.mapping.fingerprint;
        const port = await h.resolve(fixtureId, 1), original = await port.read();
        await port.configure({ highBrightnessPercent: 100, standbyBrightnessPercent: 10, holdSeconds: 1 }, async () => {});
        expect(h.physical).toMatchObject({ highBrightnessPercent: 100, holdSeconds: 1, rawHoldInterval: 2, bioMode: 'sensor' });
        const release = await h.resolve(fixtureId, 1, port.identity);
        await release.restore(original, h.physical, async () => {});
        expect(h.physical).toEqual(original);
        expect(h.mapping.fingerprint).toBeUndefined();
    });
    it('does not infer legacy support from a firmware string without current qualified authority', async () => {
        const h = harness(); delete h.mapping.fingerprint; h.healthy = false;
        await expect(h.resolve(fixtureId, 1)).rejects.toThrow();
        expect(h.physical.holdSeconds).toBe(5);
    });
    it.each(['invalid-json', '{"deviceType":1}', '{"deviceType":1,"firmware":{"major":5,"minor":5,"revision":8,"build":12889},"sensorType":9,"infraredType":1,"ambientLightType":0,"hardwareType":3}'])('rejects unqualified native hardware in a legacy binding: %s', async sensorFingerprint => {
        const h = harness(); delete h.mapping.fingerprint; h.binding.sensorFingerprint = sensorFingerprint;
        await expect(h.resolve(fixtureId, 1)).rejects.toThrow();
        expect(h.physical.holdSeconds).toBe(5);
    });
    it('rejects a firmware conflict between qualified authority and legacy registration', async () => {
        const h = harness(); delete h.mapping.fingerprint; h.mapping.firmware = '5.5.8.999';
        await expect(h.resolve(fixtureId, 1)).rejects.toThrow();
        expect(h.physical.holdSeconds).toBe(5);
    });
    it('resolves any current qualified mapping and uses the same client for native configuration', async () => { const h = harness(), port = await h.resolve(fixtureId, 1); const old = await port.read(); await port.configure({ highBrightnessPercent: 100, standbyBrightnessPercent: 10, holdSeconds: 1 }, async () => { }); expect(h.physical.holdSeconds).toBe(1); await port.restore(old, h.physical, async () => { }); expect(h.physical).toEqual(old); });
    it('revokes an already resolved port after a USB generation change', async () => { const h = harness(), port = await h.resolve(fixtureId, 1); h.generation = 2; await expect(port.configure({ highBrightnessPercent: 100, standbyBrightnessPercent: 10, holdSeconds: 1 }, async () => { })).rejects.toThrow(); expect(h.physical.holdSeconds).toBe(5); });
    it('never writes when the mapping, lease or independent health changes', async () => { for (const change of [(h: ReturnType<typeof harness>) => { h.mapping.nativeUuid = 'aabbccddeeff'; }, (h: ReturnType<typeof harness>) => { h.leased = true; }, (h: ReturnType<typeof harness>) => { h.healthy = false; }]) {
        const h = harness(), port = await h.resolve(fixtureId, 1);
        change(h);
        await expect(port.configure({ highBrightnessPercent: 100, standbyBrightnessPercent: 10, holdSeconds: 1 }, async () => { })).rejects.toThrow();
        expect(h.physical.holdSeconds).toBe(5);
    } });
    it('does not infer native support from an untested firmware or missing authority', async () => { const h = harness(); h.mapping.fingerprint!.firmware.build = 999; await expect(h.resolve(fixtureId, 1)).rejects.toThrow(); const other = harness(); other.healthy = false; await expect(other.resolve(fixtureId, 1)).rejects.toThrow(); });
});
