import { describe, expect, it } from "vitest";
import { DbClockProof } from "./db-clock-proof";
import { LinuxBootClock } from "./linux-boot-clock";

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
  it("distinguishes proven expiry from unavailable or mismatched epoch evidence", () => {
    expect(proven().evaluate(7, "2026-09-26T00:00:02.200Z", sample(1100))).toBe("expired");
    expect(proven().evaluate(7, "2026-09-26T00:00:02.201Z", sample(1100))).toBe("allowed");
    expect(proven().evaluate(8, "2026-09-26T00:00:00.000Z", sample(1100))).toBe("clock_untrusted");
    expect(new DbClockProof(scope).evaluate(7, expiry, sample(1100))).toBe("clock_untrusted");
    expect(proven().evaluate(7, expiry, sample(11_001))).toBe("clock_untrusted");
  });
  it.each([[900, true], [901, false], [1000, false], [1001, false]])("bounds RTT including its 100ms error budget for observed %ims", (rtt, expected) => {
    expect(proven(rtt).allows(7, expiry, sample(1000 + rtt))).toBe(expected);
  });
  it.each([[9900, true], [9901, false], [10000, false], [10001, false]])("bounds sample age including its 100ms error budget for observed %ims", (age, expected) => {
    expect(proven().allows(7, expiry, sample(1100 + age))).toBe(expected);
  });
  it.each([
    ["1.00 0.00", "1.90 0.00", true],
    ["1.00 0.00", "1.91 0.00", false],
    ["1.00 0.00", "2.00 0.00", false]
  ])("bounds quantized Linux RTT from %s to %s", (startUptime, endUptime, expected) => {
    // An actual request at 1000ms and response at 2009ms appear as 1.00 and
    // 2.00 in proc. The observed 1000ms must not admit that >1000ms RTT.
    let uptime = startUptime;
    const clock = new LinuxBootClock({ platform: "linux", read: (path) => path.endsWith("boot_id") ? bootId : uptime });
    const proof = new DbClockProof(scope);
    const start = clock.sample();
    proof.begin(request, start);
    uptime = endUptime;
    const end = clock.sample();
    expect(proof.observe(request, response, start, end)).toBe(expected);
    expect(proof.allows(7, expiry, end)).toBe(expected);
  });
  it.each([["11.00 0.00", true], ["11.01 0.00", false], ["11.10 0.00", false]])("bounds quantized Linux sample age at %s", (nowUptime, expected) => {
    // An actual receipt at 1100ms and check at 11109ms appear as 1.10 and
    // 11.10: the observed 10000ms cannot prove age <=10000ms.
    let uptime = "1.00 0.00";
    const clock = new LinuxBootClock({ platform: "linux", read: (path) => path.endsWith("boot_id") ? bootId : uptime });
    const proof = new DbClockProof(scope);
    const start = clock.sample();
    proof.begin(request, start);
    uptime = "1.10 0.00";
    expect(proof.observe(request, response, start, clock.sample())).toBe(true);
    uptime = nowUptime;
    expect(proof.allows(7, expiry, clock.sample())).toBe(expected);
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
