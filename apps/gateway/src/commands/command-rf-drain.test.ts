import { describe, expect, it } from "vitest";
import { CommandRfDrain } from "./command-rf-drain";

describe("CommandRfDrain", () => {
  it("keeps submitted work unconfirmed after the software operation finishes", () => {
    const drain = new CommandRfDrain();
    const queued = drain.begin(7);
    const submitted = drain.begin(7);
    submitted.onWriteStarted();
    submitted.onWriteStarted(); // The second BIO phase belongs to the same Set.
    submitted.finish();
    expect(drain.snapshot(7)).toEqual({ queuedCount: 1, submittedCount: 1, unconfirmedCount: 1, physicalCompletionCertified: false });
    queued.finish();
    expect(drain.snapshot(7)).toEqual({ queuedCount: 0, submittedCount: 1, unconfirmedCount: 1, physicalCompletionCertified: false });
    expect(drain.snapshot(8)).toEqual({ queuedCount: 0, submittedCount: 0, unconfirmedCount: 0, physicalCompletionCertified: false });
  });

  it("includes legacy submissions in every epoch and never certifies empty or restarted state", () => {
    const drain = new CommandRfDrain();
    const legacy = drain.begin(undefined);
    legacy.onWriteStarted(); legacy.finish(); legacy.finish();
    expect(drain.snapshot(7)).toMatchObject({ submittedCount: 1, unconfirmedCount: 1, physicalCompletionCertified: false });
    expect(new CommandRfDrain().snapshot(7)).toMatchObject({ physicalCompletionCertified: false });
  });
});
