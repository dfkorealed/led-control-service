import { describe, expect, it, vi } from "vitest";
import { SerialTaskQueue } from "./serial-task-queue";

describe("SerialTaskQueue", () => {
  it("does not start the next provisioning operation before the current one settles", async () => {
    const queue = new SerialTaskQueue();
    let releaseFirst!: () => void;
    const first = queue.run(() => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    const secondOperation = vi.fn().mockResolvedValue(undefined);
    const second = queue.run(secondOperation);

    await Promise.resolve();
    expect(secondOperation).not.toHaveBeenCalled();

    releaseFirst();
    await first;
    await second;
    expect(secondOperation).toHaveBeenCalledTimes(1);
  });

  it("continues with the next operation after a provisioning failure", async () => {
    const queue = new SerialTaskQueue();
    const failed = queue.run(async () => {
      throw new Error("provisioning failed");
    });
    const nextOperation = vi.fn().mockResolvedValue("completed");
    const next = queue.run(nextOperation);

    await expect(failed).rejects.toThrow("provisioning failed");
    await expect(next).resolves.toBe("completed");
  });
});
