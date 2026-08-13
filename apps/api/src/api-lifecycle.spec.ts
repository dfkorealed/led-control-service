import { bindLifecycleToServerClose, enableApiShutdownHooks } from "./api-lifecycle";
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
