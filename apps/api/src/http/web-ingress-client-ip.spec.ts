import { trustedWebClientIp } from "./web-ingress-client-ip";

describe("trustedWebClientIp", () => {
  const secret = "a".repeat(64);

  it.each(["198.51.100.20", "2001:db8::20"])("trusts one valid authenticated Web ingress address: %s", (ip) => {
    expect(trustedWebClientIp({
      ip: "10.0.0.2",
      headers: { "x-web-ingress-secret": secret, "x-web-client-ip": ip, "x-forwarded-for": "203.0.113.9" }
    }, { LANDING_INGRESS_SECRET: secret })).toBe(ip);
  });

  it.each([
    {},
    { "x-web-client-ip": "198.51.100.20" },
    { "x-web-ingress-secret": "b".repeat(64), "x-web-client-ip": "198.51.100.20" },
    { "x-web-ingress-secret": secret, "x-web-client-ip": "198.51.100.20, 203.0.113.9" },
    { "x-web-ingress-secret": secret, "x-web-client-ip": ["198.51.100.20"] },
    { "x-web-ingress-secret": [secret], "x-web-client-ip": "198.51.100.20" },
    { "x-web-ingress-secret": `${secret}\n`, "x-web-client-ip": "198.51.100.20" },
    { "x-web-ingress-secret": secret, "x-web-client-ip": "not-an-ip" }
  ])("rejects missing, wrong, duplicate, or malformed ingress identity", (headers) => {
    expect(trustedWebClientIp({ ip: "10.0.0.2", headers }, { LANDING_INGRESS_SECRET: secret })).toBeNull();
  });

  it("fails closed when the configured shared secret is absent or noncanonical", () => {
    const request = { headers: { "x-web-ingress-secret": secret, "x-web-client-ip": "198.51.100.20" } };
    for (const configured of [undefined, "", "a".repeat(63), "A".repeat(64), `${secret}\n`]) {
      expect(trustedWebClientIp(request, { LANDING_INGRESS_SECRET: configured })).toBeNull();
    }
  });
});
