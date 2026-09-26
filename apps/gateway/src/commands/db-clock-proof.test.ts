import { describe, expect, it } from "vitest";
import { DbClockProof } from "./db-clock-proof";

const scope = { siteId: "11111111-1111-4111-8111-111111111111", gatewayId: "22222222-2222-4222-8222-222222222222" };
const request = { ...scope, nonce: "33333333-3333-4333-8333-333333333333" };
const response = { ...request, publishEpoch: 7, dbNow: "2026-09-26T00:00:00.000Z" };
const bootId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sample = (milliseconds: number, boot = bootId) => ({ bootId: boot, milliseconds });
const expiry = "2026-09-26T00:01:00.000Z";
function proven(rtt = 100) {
  const proof = new DbClockProof(scope);
  proof.begin(request, sample(1000));
  proof.observe(request, response, sample(1000), sample(1000 + rtt));
  return proof;
}

describe("DbClockProof", () => {
  it.each([[1000, true], [1001, false]])("bounds full RTT at %ims", (rtt, expected) => {
    expect(proven(rtt).allows(7, expiry, sample(1000 + rtt))).toBe(expected);
  });
  it.each([[10000, true], [10001, false]])("bounds sample age at %ims including suspension", (age, expected) => {
    expect(proven().allows(7, expiry, sample(1100 + age))).toBe(expected);
  });
  it.each([["2026-09-26T00:00:02.200Z", false], ["2026-09-26T00:00:02.201Z", true], ["2026-09-26T00:00:02.199Z", false]])("adds full RTT and 100ms budget before strict 2s cutoff %s", (expiresAt, expected) => {
    expect(proven().allows(7, expiresAt, sample(1100))).toBe(expected);
  });
  it("advances the DB upper bound using boot elapsed time", () => {
    expect(proven().allows(7, "2026-09-26T00:00:03.200Z", sample(2100))).toBe(false);
  });
  it("denies absent proof and malformed expiry or epoch", () => {
    expect(new DbClockProof(scope).allows(7, expiry, sample(1100))).toBe(false);
    expect(proven().allows(7, "nonsense", sample(1100))).toBe(false);
    expect(proven().allows(NaN, expiry, sample(1100))).toBe(false);
  });
  it.each([
    { nonce: "44444444-4444-4444-8444-444444444444" },
    { siteId: "44444444-4444-4444-8444-444444444444" },
    { gatewayId: "44444444-4444-4444-8444-444444444444" },
    { publishEpoch: 0 }, { dbNow: "invalid" }, { unexpected: true }
  ])("denies invalid response %j", (change) => {
    const proof = new DbClockProof(scope);
    proof.begin(request, sample(1000));
    expect(proof.observe(request, { ...response, ...change }, sample(1000), sample(1100))).toBe(false);
    expect(proof.allows(7, expiry, sample(1100))).toBe(false);
  });
  it("consumes only the current pending nonce and rejects reordered or duplicate responses", () => {
    const proof = new DbClockProof(scope);
    const newer = { ...request, nonce: "44444444-4444-4444-8444-444444444444" };
    proof.begin(request, sample(1000));
    proof.begin(newer, sample(1050));
    expect(proof.observe(request, response, sample(1000), sample(1100))).toBe(false);
    expect(proof.observe(newer, { ...response, ...newer }, sample(1050), sample(1150))).toBe(true);
    expect(proof.observe(newer, { ...response, ...newer }, sample(1050), sample(1200))).toBe(false);
  });
  it("cannot restore a proof with an outstanding response after reconnect invalidation", () => {
    const proof = proven();
    proof.begin(request, sample(1200));
    proof.invalidate();
    expect(proof.observe(request, response, sample(1200), sample(1300))).toBe(false);
    expect(proof.allows(7, expiry, sample(1300))).toBe(false);
  });
  it("invalidates on epoch mismatch and rejects an older epoch after a new epoch", () => {
    const proof = proven();
    expect(proof.allows(8, expiry, sample(1100))).toBe(false);
    expect(proof.allows(7, expiry, sample(1100))).toBe(false);
    proof.begin(request, sample(1200));
    expect(proof.observe(request, { ...response, publishEpoch: 8 }, sample(1200), sample(1300))).toBe(true);
    proof.begin(request, sample(1400));
    expect(proof.observe(request, response, sample(1400), sample(1500))).toBe(false);
    expect(proof.allows(8, expiry, sample(1500))).toBe(false);
  });
  it.each([sample(1099), sample(1200, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), sample(NaN), sample(Infinity), sample(-1)])("invalidates discontinuous samples %j", (now) => {
    const proof = proven();
    expect(proof.allows(7, expiry, now)).toBe(false);
    expect(proof.allows(7, expiry, sample(1300))).toBe(false);
  });
  it("rejects boot changes and regressions within the request round trip", () => {
    for (const end of [sample(999), sample(1100, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")]) {
      const proof = new DbClockProof(scope);
      proof.begin(request, sample(1000));
      expect(proof.observe(request, response, sample(1000), end)).toBe(false);
      expect(proof.allows(7, expiry, sample(1100))).toBe(false);
    }
  });
});
