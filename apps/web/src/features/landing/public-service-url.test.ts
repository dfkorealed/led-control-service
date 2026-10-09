import { describe, expect, it } from "vitest";
import { getPublicServiceUrl } from "./public-service-url";

describe("explicit public service URL", () => {
  it.each([undefined, "", " /login", "/login", "http://control.dfkorealed.com/login", "https://localhost/login", "https://controller.internal/login", "https://controller.lan/login", "https://controller.home/login", "https://control.home.arpa/login", "https://CONTROL.HOME.ARPA/login", "https://control.home.arpa./login", "https://localhost.localdomain/login", "https://127.0.0.1/login", "https://10.0.0.1/login", "https://[::1]/login", "https://service.example.com/login", "https://demo.test/login", "https://demo.ngrok-free.app/login", "https://demo.vercel.app/login", "https://user:password@control.dfkorealed.com/login", "https://control.dfkorealed.com:5173/login"])('fails closed for %s', value => {
    expect(getPublicServiceUrl(value)).toBeNull();
  });
  it("uses the explicit production destination including its path", () => {
    expect(getPublicServiceUrl("https://control.dfkorealed.com/login")).toBe("https://control.dfkorealed.com/login");
  });
});
