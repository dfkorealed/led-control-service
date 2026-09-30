import { assertNoActiveBioSourceTarget } from "./bio-source-target-policy";

it.each(["manual", "schedule", "event", "identify", "group"] as const)("queries exact active BIO source membership for %s", async operation => {
  const tx = { vehicleEventSource: { findFirst: jest.fn().mockResolvedValue(null) } };
  await expect(assertNoActiveBioSourceTarget(tx as never, "site", ["B", "B"], operation)).resolves.toBeUndefined();
  expect(tx.vehicleEventSource.findFirst).toHaveBeenCalledWith({ where: { siteId: "site", fixtureId: { in: ["B"] },
    rule: { status: "enabled", sensorProtocol: "bio_usb_pulse" } }, select: { fixtureId: true } });
});
