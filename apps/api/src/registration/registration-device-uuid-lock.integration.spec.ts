import { PrismaClient } from "@prisma/client";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { lockRegistrationDeviceUuids } from "./registration-domain-locks";

const enabled = process.env.REGISTRATION_DEVICE_UUID_LOCK_TEST === "1";
jest.setTimeout(30_000);

(enabled ? describe : describe.skip)("registration device UUID locks on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let firstClient: PrismaClient;
  let secondClient: PrismaClient;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const databaseUrl = cluster.database();
    firstClient = new PrismaClient({ datasourceUrl: databaseUrl });
    secondClient = new PrismaClient({ datasourceUrl: databaseUrl });
  });

  afterAll(async () => {
    await firstClient?.$disconnect();
    await secondClient?.$disconnect();
    cluster?.stop();
  });

  it("serializes the same device UUID across independent transactions", async () => {
    const order: string[] = [];
    let signalFirstLocked!: () => void;
    let signalSecondStarted!: () => void;
    let releaseFirst!: () => void;
    const firstLocked = new Promise<void>((resolve) => { signalFirstLocked = resolve; });
    const secondStarted = new Promise<void>((resolve) => { signalSecondStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = firstClient.$transaction(async (tx) => {
      await lockRegistrationDeviceUuids(tx, ["device-b", "device-a"]);
      order.push("first-locked");
      signalFirstLocked();
      await firstRelease;
      order.push("first-releasing");
    });
    await firstLocked;

    const second = secondClient.$transaction(async (tx) => {
      order.push("second-started");
      signalSecondStarted();
      await lockRegistrationDeviceUuids(tx, ["device-a", "device-b", "device-a"]);
      order.push("second-locked");
    });

    await secondStarted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(["first-locked", "second-started"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-locked", "second-started", "first-releasing", "second-locked"]);
  });
});
