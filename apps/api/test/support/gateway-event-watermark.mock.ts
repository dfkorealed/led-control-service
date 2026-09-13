/** Default DB delegate for consumer unit tests; persistence/concurrency use PostgreSQL tests. */
export function gatewayEventWatermarkMock() {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    gatewayEventWatermark: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined)
    }
  };
}
