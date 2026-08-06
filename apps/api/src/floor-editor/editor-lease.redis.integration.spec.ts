import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { editorLeaseReleaseScript, editorLeaseRenewScript } from "./editor-lease.service";

const runRedisIntegration = process.env.RUN_REDIS_INTEGRATION === "true" ? describe : describe.skip;

runRedisIntegration("Editor lease Redis scripts", () => {
  const key = `floor-editor:lease:test:${randomUUID()}`;
  let client: Redis;

  beforeAll(() => {
    client = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15");
  });

  afterEach(async () => {
    await client.del(key);
  });

  afterAll(async () => {
    await client.quit();
  });

  it("does not renew or delete a lease when the supplied token is stale", async () => {
    await client.set(key, JSON.stringify({
      userId: "admin-a", userName: "김관리", token: "current-token", acquiredAt: "2026-08-06T00:00:00.000Z"
    }), "EX", 90);

    await expect(client.eval(editorLeaseRenewScript, 1, key, "stale-token", "90")).resolves.toBe(0);
    await expect(client.eval(editorLeaseReleaseScript, 1, key, "stale-token")).resolves.toBe(0);
    await expect(client.get(key)).resolves.toContain('"token":"current-token"');
  });
});
