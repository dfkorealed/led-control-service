import { createApiHttpsOptions } from "./api-tls-options";

describe("createApiHttpsOptions", () => {
  it("trusts both device and manufacturing client CAs", () => {
    const files: Record<string, Buffer> = {
      "/tls/api.crt": Buffer.from("api-cert"),
      "/tls/api.key": Buffer.from("api-key"),
      "/tls/device-ca.crt": Buffer.from("device-ca"),
      "/tls/manufacturing-ca.crt": Buffer.from("manufacturing-ca")
    };
    const result = createApiHttpsOptions(completeEnvironment(), (path: string) => files[path]);

    expect(result).toEqual({
      httpsOptions: {
        cert: files["/tls/api.crt"],
        key: files["/tls/api.key"],
        ca: [files["/tls/device-ca.crt"], files["/tls/manufacturing-ca.crt"]],
        requestCert: true,
        rejectUnauthorized: false
      }
    });
  });

  it("allows HTTP only when no TLS setting is present outside production", () => {
    expect(createApiHttpsOptions({ NODE_ENV: "test" }, jest.fn())).toEqual({});
  });

  it("rejects partial TLS configuration outside production", () => {
    expect(() =>
      createApiHttpsOptions({ NODE_ENV: "development", API_TLS_CERT_PATH: "/tls/api.crt" }, jest.fn())
    ).toThrow("API TLS configuration must set all certificate paths");
  });

  it.each([
    "API_TLS_CERT_PATH",
    "API_TLS_KEY_PATH",
    "API_DEVICE_CLIENT_CA_PATH",
    "API_MANUFACTURING_CLIENT_CA_PATH"
  ] as const)("fails closed when production %s is missing", (missingKey) => {
    const env = completeEnvironment();
    delete env[missingKey];

    expect(() => createApiHttpsOptions(env, jest.fn())).toThrow(`${missingKey} is required in production`);
  });
});

function completeEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    API_TLS_CERT_PATH: "/tls/api.crt",
    API_TLS_KEY_PATH: "/tls/api.key",
    API_DEVICE_CLIENT_CA_PATH: "/tls/device-ca.crt",
    API_MANUFACTURING_CLIENT_CA_PATH: "/tls/manufacturing-ca.crt"
  };
}
