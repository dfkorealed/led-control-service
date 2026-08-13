import { bindLifecycleToServerClose, createApiRuntimeLifecycle, enableApiShutdownHooks } from "./api-lifecycle";
import { EventEmitter } from "node:events";

describe("API lifecycle", () => {
  it("enables Nest shutdown hooks so provider destroy handlers run for process signals", () => {
    const app = { enableShutdownHooks: jest.fn() };

    enableApiShutdownHooks(app as never);

    expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
  });
});

it("stops a renewable credential lifecycle when the HTTP server closes", () => {
  const server = new EventEmitter();
  const lifecycle = { stop: jest.fn() };
  bindLifecycleToServerClose(server, lifecycle);

  server.emit("close");

  expect(lifecycle.stop).toHaveBeenCalledTimes(1);
});

it("closes CRL then token lifecycle before fail-closed app shutdown", async () => {
  const order: string[] = [];
  const app = { close: jest.fn(async () => { order.push("app"); }) };
  const runtime = createApiRuntimeLifecycle(app, code => order.push(`exit-${code}`));
  runtime.setToken({ stop: () => order.push("token") });
  runtime.setCrl({ close: () => order.push("crl") });

  await runtime.failClosed();

  expect(order).toEqual(["exit-1", "crl", "token", "app"]);
});

it("cleans every registered lifecycle on normal server close without closing the app twice", () => {
  const order: string[] = [];
  const server = new EventEmitter();
  const app = { close: jest.fn() };
  const runtime = createApiRuntimeLifecycle(app, jest.fn());
  runtime.setToken({ stop: () => order.push("token") });
  runtime.setCrl({ close: () => order.push("crl") });
  runtime.bind(server);

  server.emit("close");
  server.emit("close");

  expect(order).toEqual(["crl", "token"]);
  expect(app.close).not.toHaveBeenCalled();
});
