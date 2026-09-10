import { NotFoundException } from "@nestjs/common";
import { TestDataEnabledGuard } from "./test-data-enabled.guard";

describe("TestDataEnabledGuard", () => {
  const previousFlag = process.env.VITE_TEST_DATA_TOOLS_ENABLED;

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.VITE_TEST_DATA_TOOLS_ENABLED;
    else process.env.VITE_TEST_DATA_TOOLS_ENABLED = previousFlag;
  });

  it("returns 404 before authentication when test data tools are disabled", () => {
    delete process.env.VITE_TEST_DATA_TOOLS_ENABLED;
    const guard = new TestDataEnabledGuard();

    expect(() => guard.canActivate({} as never)).toThrow(NotFoundException);
  });

  it("allows the request to continue only when the exact flag value is true", () => {
    process.env.VITE_TEST_DATA_TOOLS_ENABLED = "true";
    expect(new TestDataEnabledGuard().canActivate({} as never)).toBe(true);
  });
});
