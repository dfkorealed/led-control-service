import { describe, expect, it, vi } from "vitest";
import { KeyedSerialTaskQueue } from "./keyed-serial-task-queue";

describe("KeyedSerialTaskQueue", () => {
  it("serializes the same key while allowing different keys to run concurrently", async () => {
    const queue = new KeyedSerialTaskQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = queue.run("group-a", async () => {
      events.push("a1:start");
      await gate;
      events.push("a1:end");
    });
    const second = queue.run("group-a", async () => { events.push("a2"); });
    const other = queue.run("group-b", async () => { events.push("b"); });

    await vi.waitFor(() => expect(events).toEqual(["a1:start", "b"]));
    release();
    await Promise.all([first, second, other]);
    expect(events).toEqual(["a1:start", "b", "a1:end", "a2"]);
  });

  it("releases keys after failure", async () => {
    const queue = new KeyedSerialTaskQueue();
    await expect(queue.run("group-a", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(queue.run("group-a", async () => "ready")).resolves.toBe("ready");
  });
});
