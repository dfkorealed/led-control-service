import { identifyCoordinationDeadline } from "./fixture-identify-deadline";

afterEach(() => jest.useRealTimers());
it("fails closed when Redis waits forever for reconnect", async () => {
  jest.useFakeTimers();
  const request = identifyCoordinationDeadline(new Promise(() => {}));
  const assertion = expect(request).rejects.toThrow("identify_coordination_unavailable");
  await jest.advanceTimersByTimeAsync(500);
  await assertion;
});
