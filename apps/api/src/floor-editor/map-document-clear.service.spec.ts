import { BadRequestException } from "@nestjs/common";
import { MapDocumentResetService } from "./map-document-reset.service";

describe("map clear input boundary", () => {
  const valid = { requestId: "clear-one", baseRevision: 0, leaseToken: "lease", leaseFence: 1, mode: "elements_only" };
  it.each([null, [], {}, { ...valid, extra: true }, { ...valid, mode: undefined }, { ...valid, mode: "all" },
    { ...valid, requestId: " " }, { ...valid, requestId: "x".repeat(129) }, { ...valid, baseRevision: -1 },
    { ...valid, baseRevision: 2147483647 }, { ...valid, leaseFence: 0 },
    { ...valid, leaseToken: "" }, { ...valid, leaseToken: "x".repeat(257) }])(
    "rejects malformed input before accessing persistence: %j", async input => {
      const service = new MapDocumentResetService({} as never, {} as never, {} as never, {} as never);
      await expect(service.clear("floor", {} as never, input)).rejects.toBeInstanceOf(BadRequestException);
    });
});
