describe("fixture registration removal lifecycle policy", () => {
  const policy = () => require("./fixture-registration-removal-policy");
  it.each([undefined, null, 0, 2, -1, "1"])("does not infer support from %p", version => {
    expect(policy().supportsFixtureRegistrationRemoval(version)).toBe(false);
  });
  it("requires explicit version 1", () => {
    expect(policy().supportsFixtureRegistrationRemoval(1)).toBe(true);
  });
  it.each(["pending", "gateway_confirmed", "reconcile_required", "future_status"])("blocks %s", status => {
    expect(policy().isFixtureRegistrationRemovalBlocking(status)).toBe(true);
  });
  it.each([null, undefined, "completed", "rejected"])("does not block absent or settled operation %p", status => {
    expect(policy().isFixtureRegistrationRemovalBlocking(status)).toBe(false);
  });
});
