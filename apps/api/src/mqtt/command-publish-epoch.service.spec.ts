import { CommandPublishEpochService } from "./command-publish-epoch.service";

describe("CommandPublishEpochService input safety", () => {
  it.each([0, -1, 1.5, NaN, Infinity, 2147483648])("rejects invalid generation %s", async generation => {
    await expect(new CommandPublishEpochService().maxUnsettledExpiry({} as never, generation))
      .rejects.toThrow(/generation/);
  });
});
