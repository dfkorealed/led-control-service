import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshGroupResyncPublisher, MeshGroupResyncStore } from "./group-resync-store";

const directories: string[] = [];
const scope = {
  siteId: "00000000-0000-4000-8000-000000000003",
  gatewayId: "00000000-0000-4000-8000-000000000004"
};
const requestId = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MeshGroupResyncStore", () => {
  it("keeps one durable request after broker PUBACK and across restart until the API acknowledges it", async () => {
    const path = await storePath();
    const store = createStore(path);
    await store.initialize("state_missing");
    const publish = vi.fn().mockResolvedValue(undefined);
    const publisher = new MeshGroupResyncPublisher(scope, store);

    await publisher.publishPending(publish);
    await publisher.publishPending(publish);

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][1]).toEqual(publish.mock.calls[1][1]);
    const restarted = createStore(path);
    await restarted.initialize("startup");
    expect(await restarted.pending()).toMatchObject({ eventId: requestId, reason: "state_missing" });
  });

  it("ignores wrong or stale acknowledgements and durably clears only the matching scoped request", async () => {
    const path = await storePath();
    const store = createStore(path);
    await store.initialize("state_corrupt");

    await expect(store.acknowledge(ack({ gatewayId: "00000000-0000-4000-8000-000000000099" }))).resolves.toBe(false);
    await expect(store.acknowledge(ack({ requestEventId: "22222222-2222-4222-8222-222222222222" }))).resolves.toBe(false);
    await expect(store.acknowledge(ack())).resolves.toBe(true);

    const restarted = createStore(path);
    await restarted.initialize("startup");
    await expect(restarted.pending()).resolves.toBeNull();
  });

  it("creates no request for a normal first startup but fails safe after initialized state is missing", async () => {
    const path = await storePath();
    const initial = createStore(path);
    await initial.initialize("startup");
    await expect(initial.pending()).resolves.toBeNull();

    await rm(path);
    const missing = createStore(path);
    await missing.initialize("startup");
    await expect(missing.pending()).resolves.toMatchObject({ reason: "state_missing" });
  });

  it("replaces corrupt initialized state with a durable fail-safe request", async () => {
    const path = await storePath();
    const initial = createStore(path);
    await initial.initialize("startup");
    await writeFile(path, "{broken", "utf8");

    const corrupted = createStore(path);
    await corrupted.initialize("startup");
    await expect(corrupted.pending()).resolves.toMatchObject({ reason: "state_corrupt" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pending: { reason: "state_corrupt" } });
  });
});

function createStore(path: string) {
  return new MeshGroupResyncStore(
    path,
    scope,
    () => "2026-08-23T00:00:00.000Z",
    () => requestId
  );
}

function ack(overrides: Record<string, unknown> = {}) {
  return {
    ...scope,
    eventId: "33333333-3333-4333-8333-333333333333",
    requestEventId: requestId,
    occurredAt: "2026-08-23T00:01:00.000Z",
    ...overrides
  };
}

async function storePath() {
  const directory = await mkdtemp(join(tmpdir(), "group-resync-store-"));
  directories.push(directory);
  return join(directory, "resync.json");
}
