import { automationExecutionActionResultPayloadV1Schema } from "@led-control/shared/automation-contracts";
import { describe, expect, it } from "vitest";

describe("shared browser automation contracts", () => {
  it("safeParse accepts a production action-result payload at runtime", () => {
    const parsed = automationExecutionActionResultPayloadV1Schema.safeParse({
      sourceType: "schedule",
      sourceId: "11111111-1111-4111-8111-111111111111",
      results: [
        {
          fixtureId: "22222222-2222-4222-8222-222222222222",
          status: "succeeded",
          brightnessPercent: 70,
          faultCode: null,
          errorCode: null,
          occurredAt: "2026-08-31T00:00:00.000Z"
        }
      ]
    });

    expect(parsed.success).toBe(true);
  });

  it("safeParse rejects duplicate fixture results at runtime", () => {
    const fixtureResult = {
      fixtureId: "22222222-2222-4222-8222-222222222222",
      status: "succeeded",
      brightnessPercent: 70,
      faultCode: null,
      errorCode: null,
      occurredAt: "2026-08-31T00:00:00.000Z"
    } as const;

    const parsed = automationExecutionActionResultPayloadV1Schema.safeParse({
      sourceType: "schedule",
      sourceId: "11111111-1111-4111-8111-111111111111",
      results: [fixtureResult, fixtureResult]
    });

    expect(parsed.success).toBe(false);
  });
});
