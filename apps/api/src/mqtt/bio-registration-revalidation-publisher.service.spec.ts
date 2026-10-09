describe("BIO registration revalidation publisher shutdown", () => {
  it("drains manually started publish batches and prevents work after stop", async () => {
    const { BioRegistrationRevalidationPublisherService } = require("./bio-registration-revalidation-publisher.service");
    let release!: () => void; let expired = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const worker = new BioRegistrationRevalidationPublisherService({}, {}, { expire: async () => { expired++; await pending; } }, {});
    const work = worker.processBatch(); let drained = false;
    const drain = worker.stopAndDrain().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(drained).toBe(false);
    release(); await work; await drain; expect(drained).toBe(true);
    await worker.processBatch(); expect(expired).toBe(1);
  });
});
