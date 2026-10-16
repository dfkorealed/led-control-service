import { Prisma } from "@prisma/client";
import { closeSiteEnergyForSettingsChange } from "../energy/fixture-state-ingestion.service";
import { FloorEditorService } from "../floor-editor/floor-editor.service";
import { TargetSnapshotService } from "../automation/target-snapshot.service";
import { buildFloorEditorSnapshot } from "../floor-editor/floor-editor-snapshot";

describe("operating registration consumers", () => {
  it("does not reopen retired energy cursors during tariff/timezone change", async () => {
    const raw = jest.fn().mockResolvedValue([]);
    await closeSiteEnergyForSettingsChange({ $queryRaw: raw } as any,
      { siteId: "site", timeZone: "Asia/Seoul", tariffKwhRate: new Prisma.Decimal(100) });
    expect(raw.mock.calls[0][0].sql).toContain('f."retiredAt" IS NULL');
  });
  it("uses operating registration eligibility for both map restore formats", async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service: any = new (FloorEditorService as any)();
    await service.existingFixtureIds({ fixture: { findMany: query } }, "floor", ["fixture"]);
    expect(query.mock.calls[0][0].where).toMatchObject({ retiredAt: null,
      registrationRemovals: { none: expect.any(Object) } });
  });
  it("checks automation target admission after selection, before returning a snapshot", async () => {
    const fixture = { id: "fixture", siteId: "site", meshNodeId: "node", gatewayId: "gateway" };
    const tx: any = { fixture: { findMany: async () => [fixture] }, $executeRaw: jest.fn().mockRejectedValue(new Error("removal pending")) };
    await expect(new TargetSnapshotService().resolve(tx, "site", { type: "fixture", fixtureId: "fixture" }))
      .rejects.toThrow("removal pending");
  });
  it("preserves slots but hides assignments excluded from the operating fixture overlay", () => {
    const slot = { id: "00000000-0000-4000-8000-000000000001", sourceImportJobId: "00000000-0000-4000-8000-000000000002",
      sourceCandidateId: "00000000-0000-4000-8000-000000000003", x: 10, y: 20, rotation: 45,
      assignedFixtureId: "00000000-0000-4000-8000-000000000004" };
    const floor = { id: "floor", siteId: "site", name: "floor", level: 1, floorPlan: null,
      fixtures: [], mapObjects: [], lightSlots: [slot] };
    const service: any = new (FloorEditorService as any)();
    expect(service.toEditorState(floor).lightSlots).toEqual([{ id: slot.id, x: 10, y: 20, rotation: 45, assignedFixtureId: null }]);
    expect(buildFloorEditorSnapshot(floor)).toMatchObject({ lightSlots: [{ ...slot, assignedFixtureId: null }] });
    expect(slot.assignedFixtureId).not.toBeNull();
  });
});
