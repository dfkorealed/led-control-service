import { enableApiShutdownHooks } from "./api-lifecycle";

describe("API lifecycle", () => {
  it("enables Nest shutdown hooks so provider destroy handlers run for process signals", () => {
    const app = { enableShutdownHooks: jest.fn() };

    enableApiShutdownHooks(app as never);

    expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
  });
});
