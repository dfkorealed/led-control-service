import { Test } from "@nestjs/testing";
import { AutomationModule } from "./automation.module";

describe("AutomationModule", () => {
  it("resolves the production controller authentication guard", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AutomationModule] }).compile();
    await moduleRef.close();
  });
});
