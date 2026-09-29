import { Agent } from "node:https";
import { describe, expect, it, vi } from "vitest";
import { createViteApiProxyOptions } from "./vite-api-proxy";

describe("Vite API proxy TLS identity", () => {
  it("connects to loopback while verifying the existing Lab API DNS identity", () => {
    const readFile = vi.fn(() => Buffer.from("lab-api-ca"));
    const proxy = createViteApiProxyOptions({
      DEV_LOCAL_APP_ONLY: "1",
      VITE_API_PROXY_TARGET: "https://127.0.0.1:4000",
      LAB_API_DNS: "api.led.lan",
      PKI_API_CA_BUNDLE_PATH: "/lab/api-ca.crt"
    }, readFile);

    expect(proxy.target).toBe("https://127.0.0.1:4000");
    expect(proxy.secure).toBe(true);
    expect(proxy.agent).toBeInstanceOf(Agent);
    expect((proxy.agent as Agent).options).toMatchObject({
      servername: "api.led.lan",
      rejectUnauthorized: true,
      ca: Buffer.from("lab-api-ca")
    });
    expect(readFile).toHaveBeenCalledWith("/lab/api-ca.crt");
  });

  it("leaves the target hostname as the TLS identity outside exact local-app mode", () => {
    for (const value of [undefined, "0", "false", "true", "yes", " 1 "]) {
      const proxy = createViteApiProxyOptions({
        DEV_LOCAL_APP_ONLY: value,
        VITE_API_PROXY_TARGET: "https://api.example.com:4000"
      }, vi.fn());

      expect(proxy.target).toBe("https://api.example.com:4000");
      expect(proxy.agent).toBeUndefined();
      expect(proxy.secure).toBe(true);
    }
  });

  it.each(["https://localhost:4000", "http://127.0.0.1:4000", "https://127.0.0.1:4001"])(
    "rejects a non-canonical local-app proxy target: %s",
    (VITE_API_PROXY_TARGET) => {
      expect(() => createViteApiProxyOptions({
        DEV_LOCAL_APP_ONLY: "1",
        VITE_API_PROXY_TARGET,
        LAB_API_DNS: "api.led.lan",
        PKI_API_CA_BUNDLE_PATH: "/lab/api-ca.crt"
      }, vi.fn(() => Buffer.from("ca")))).toThrow(/VITE_API_PROXY_TARGET/);
    }
  );

  it.each([undefined, "", "localhost", "127.0.0.1", "bad name", "-api.led.lan", "api.led.lan."])(
    "rejects missing or invalid local-app Lab API DNS identity: %s",
    (LAB_API_DNS) => {
      expect(() => createViteApiProxyOptions({
        DEV_LOCAL_APP_ONLY: "1",
        VITE_API_PROXY_TARGET: "https://127.0.0.1:4000",
        LAB_API_DNS,
        PKI_API_CA_BUNDLE_PATH: "/lab/api-ca.crt"
      }, vi.fn(() => Buffer.from("ca")))).toThrow(/LAB_API_DNS/);
    }
  );
});
