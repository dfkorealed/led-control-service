import { BadRequestException } from "@nestjs/common";
import { MapDocumentResetService } from "./map-document-reset.service";

describe("map reset input boundary", () => {
  const valid = { requestId: "reset-one", baseRevision: 0, leaseToken: "lease", leaseFence: 1 };
  it.each([null, [], {}, { ...valid, extra: true }, { ...valid, requestId: " " },
    { ...valid, requestId: "x".repeat(129) }, { ...valid, baseRevision: -1 },
    { ...valid, baseRevision: 2147483647 }, { ...valid, leaseFence: 0 },
    { ...valid, leaseToken: "" }, { ...valid, leaseToken: "x".repeat(257) }])(
    "rejects malformed input before preparing assets: %j", async input => {
      const service = new MapDocumentResetService({} as never, {} as never, {} as never, {} as never);
      await expect(service.reset("floor", {} as never, input)).rejects.toBeInstanceOf(BadRequestException);
    });
});
