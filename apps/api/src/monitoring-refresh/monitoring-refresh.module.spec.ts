import { Test } from "@nestjs/testing";
import { MonitoringRefreshExpiryService } from "./monitoring-refresh-expiry.service";
import { MonitoringRefreshOutboxService } from "./monitoring-refresh-outbox.service";
import { MonitoringRefreshService } from "./monitoring-refresh.service";
import { MonitoringRefreshModule } from "./monitoring-refresh.module";

describe("MonitoringRefreshModule", () => {
  it("resolves the request service and both bounded workers through Nest dependency injection", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MonitoringRefreshModule] }).compile();

    expect(moduleRef.get(MonitoringRefreshService)).toBeInstanceOf(MonitoringRefreshService);
    expect(moduleRef.get(MonitoringRefreshOutboxService)).toBeInstanceOf(MonitoringRefreshOutboxService);
    expect(moduleRef.get(MonitoringRefreshExpiryService)).toBeInstanceOf(MonitoringRefreshExpiryService);
    await moduleRef.close();
  });
});
