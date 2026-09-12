import { configureApiTrustProxy } from "./api-trust-proxy";

describe("configureApiTrustProxy", () => {
  function appFixture() {
    return { set: jest.fn() };
  }

  it.each([undefined, "", "   "])("keeps direct-connection semantics by default (%p)", (value) => {
    const app = appFixture();

    configureApiTrustProxy(app as never, { API_TRUST_PROXY: value });

    expect(app.set).not.toHaveBeenCalled();
  });

  it("accepts an explicit proxy hop count", () => {
    const app = appFixture();

    configureApiTrustProxy(app as never, { API_TRUST_PROXY: "1" });

    expect(app.set).toHaveBeenCalledWith("trust proxy", 1);
  });

  it("accepts only explicitly listed proxy IP addresses and CIDRs", () => {
    const app = appFixture();

    configureApiTrustProxy(app as never, {
      API_TRUST_PROXY: "127.0.0.1, 10.20.0.0/16, 2001:db8::/48"
    });

    expect(app.set).toHaveBeenCalledWith("trust proxy", ["127.0.0.1", "10.20.0.0/16", "2001:db8::/48"]);
  });

  it.each(["true", "all", "-1", "1.5", "proxy.internal", "10.0.0.0/33", "2001:db8::/129"])(
    "rejects unsafe or malformed trust proxy configuration %p",
    (value) => {
      expect(() => configureApiTrustProxy(appFixture() as never, { API_TRUST_PROXY: value }))
        .toThrow(`Invalid API_TRUST_PROXY: ${value}`);
    }
  );
});
