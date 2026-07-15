import { startApiTlsCrlReload } from "./api-tls-reloader";

describe("startApiTlsCrlReload", () => {
  it("reloads the HTTPS context only after a changed CRL is observed", () => {
    const harness = createHarness();
    const server = { setSecureContext: jest.fn() };
    const load = jest.fn()
      .mockReturnValueOnce(options("old"))
      .mockReturnValueOnce(options("new"));

    startApiTlsCrlReload({ crlPath: "/tls/device.crl", initialOptions: load(), load, server, ...harness });
    harness.trigger("change", "device.crl.tmp");
    harness.runPending();
    expect(server.setSecureContext).not.toHaveBeenCalled();

    harness.trigger("rename", "device.crl");
    harness.runPending();
    expect(server.setSecureContext).toHaveBeenCalledWith(options("new"));
  });

  it("retains the current context when the replacement cannot be loaded", () => {
    const harness = createHarness();
    const server = { setSecureContext: jest.fn() };
    const load = jest.fn()
      .mockReturnValueOnce(options("old"))
      .mockImplementationOnce(() => { throw new Error("partial CRL"); })
      .mockReturnValueOnce(options("new"));
    const logger = { error: jest.fn() };

    startApiTlsCrlReload({ crlPath: "/tls/device.crl", initialOptions: load(), load, server, logger, ...harness });
    harness.trigger("change", "device.crl");
    harness.runPending();
    expect(server.setSecureContext).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("[tls] HTTPS secure context reload failed; retaining the existing context.");

    harness.trigger("change", "device.crl");
    harness.runPending();
    expect(server.setSecureContext).toHaveBeenCalledWith(options("new"));
  });

  it("does nothing when the observed CRL checksum is unchanged", () => {
    const harness = createHarness();
    const server = { setSecureContext: jest.fn() };
    const load = jest.fn().mockReturnValue(options("same"));

    startApiTlsCrlReload({ crlPath: "/tls/device.crl", initialOptions: load(), load, server, ...harness });
    harness.trigger("change", "device.crl");
    harness.runPending();
    expect(server.setSecureContext).not.toHaveBeenCalled();
  });
});

function options(crl: string) {
  return { cert: Buffer.from("cert"), key: Buffer.from("key"), ca: [Buffer.from("ca")], crl: Buffer.from(crl) };
}

function createHarness() {
  let callback: ((event: string, filename: string) => void) | undefined;
  let pending: (() => void) | undefined;
  return {
    watch: jest.fn((_path: string, listener: (event: string, filename: string) => void) => {
      callback = listener;
      return { close: jest.fn() };
    }),
    schedule: jest.fn((listener: () => void) => {
      pending = listener;
      return 1 as unknown as NodeJS.Timeout;
    }),
    cancel: jest.fn(),
    trigger(event: string, filename: string) {
      callback?.(event, filename);
    },
    runPending() {
      const listener = pending;
      pending = undefined;
      listener?.();
    }
  };
}
