import { Test } from "@nestjs/testing";
import { FixturesModule } from "./fixtures.module";
import { FixturesService } from "./fixtures.service";

describe("FixturesModule", () => {
  it("provides the energy collaborators required by fixture metadata updates", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FixturesModule] }).compile();

    expect(moduleRef.get(FixturesService)).toBeInstanceOf(FixturesService);
    await moduleRef.close();
  });
});
