import { Test } from "@nestjs/testing";
import { MODULE_METADATA } from "@nestjs/common/constants";
import fs = require("node:fs");
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationRuntimeModule } from "./automation-runtime.module";
import { HOLIDAY_PROVIDER, KasiHolidayProvider } from "./holiday-provider";

// Only generated fixture paths reach the loader; the developer's protected key is never read.
describe("protected server holiday provider configuration", () => {
  let directory: string;
  let keyPath: string;
  let previousPath: string | undefined;
  const key = "fixture-key+/%=._-0123456789";
  const configure = (env: NodeJS.ProcessEnv) => require("./holiday-provider-config").createConfiguredHolidayProvider(env);

  beforeEach(() => {
    previousPath = process.env.KASI_HOLIDAY_SERVICE_KEY_PATH;
    delete process.env.KASI_HOLIDAY_SERVICE_KEY_PATH;
    directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "holiday-provider-config-"));
    fs.chmodSync(directory, 0o700);
    keyPath = join(directory, "service-key");
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previousPath === undefined) delete process.env.KASI_HOLIDAY_SERVICE_KEY_PATH;
    else process.env.KASI_HOLIDAY_SERVICE_KEY_PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each([key, `${key}\n`, "a".repeat(16), "a".repeat(256)])("loads a protected single key without decoding (case %#)", async value => {
    fs.writeFileSync(keyPath, value);
    let receivedKey: string | null = null;
    jest.spyOn(globalThis, "fetch").mockImplementation(async input => {
      receivedKey = new URL(String(input)).searchParams.get("ServiceKey");
      return { ok: true, json: async () => ({ response: { header: { resultCode: "00" },
        body: { items: "", totalCount: 0, pageNo: 1, numOfRows: 100 } } }) } as Response;
    });
    const provider = configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: keyPath });
    expect(provider).toBeInstanceOf(KasiHolidayProvider);
    expect(await provider.fetchMonth({ year: 2026, month: 2, page: 1 }, new AbortController().signal))
      .toMatchObject({ totalCount: 0, items: [] });
    expect(receivedKey).toBe(value.endsWith("\n") ? value.slice(0, -1) : value);
  });

  it.each([undefined, "", "relative/service-key"])("unconfigured or relative path is unavailable: %s", value => {
    expect(configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: value })).toBeUndefined();
  });
  it.each([0o640, 0o604, 0o644, 0o660, 0o400, 0o1600])("rejects non-0600 file mode %i", mode => {
    fs.chmodSync(keyPath, mode);
    expect(configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: keyPath })).toBeUndefined();
  });
  it.each([0o750, 0o705, 0o770, 0o755])("rejects non-0700 parent directory mode %i", mode => {
    fs.chmodSync(directory, mode);
    expect(configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: keyPath })).toBeUndefined();
  });
  it.each(["", "a".repeat(15), "a".repeat(257), "a".repeat(513), `${key} `,
    ` ${key}`, `${key}\t`, `${key}\n\n`, `${key}\ninside`, `${key} inside`, `${key}한글`, `${key}?`])
  ("rejects malformed or oversized fixture key (case %#)", value => {
    fs.writeFileSync(keyPath, value);
    expect(configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: keyPath })).toBeUndefined();
  });

  it("rejects missing files, directories, final symlinks and symlink parents", () => {
    expect(configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: join(directory, "missing") })).toBeUndefined();
    expect(configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: directory })).toBeUndefined();
    const link = join(directory, "link");
    fs.symlinkSync(keyPath, link);
    expect(configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: link })).toBeUndefined();
    const parentLink = join(directory, "parent");
    fs.symlinkSync(directory, parentLink);
    expect(configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: join(parentLink, "service-key") })).toBeUndefined();
  });

  it("rejects files owned by another UID without reading their bytes", () => {
    const actual = fs.fstatSync;
    jest.spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      const stat = actual(...args);
      return stat.isFile() ? Object.assign(stat, { uid: Number(stat.uid) + 1 }) : stat;
    }) as typeof fs.fstatSync);
    const read = jest.spyOn(fs, "readSync");
    expect(configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: keyPath })).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps file errors unavailable and silent without exposing key, path or URL", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(fs, "readSync").mockImplementation(() => { throw new Error(`${keyPath} ${key} https://private.invalid/`); });
    expect(configure({ KASI_HOLIDAY_SERVICE_KEY_PATH: keyPath })).toBeUndefined();
    expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it.each([true, false])("uses the actual runtime HOLIDAY_PROVIDER factory in Nest (configured=%s)", async configured => {
    if (configured) process.env.KASI_HOLIDAY_SERVICE_KEY_PATH = keyPath;
    else delete process.env.KASI_HOLIDAY_SERVICE_KEY_PATH;
    // Consume the registered binding itself, rather than duplicating its factory in the test.
    const binding = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AutomationRuntimeModule)
      .find((provider: any) => provider.provide === HOLIDAY_PROVIDER);
    expect(binding).toBeDefined();
    const module = await Test.createTestingModule({ providers: [binding] }).compile();
    try {
      const provider = module.get(HOLIDAY_PROVIDER);
      if (configured) expect(provider).toBeInstanceOf(KasiHolidayProvider);
      else expect(provider).toBeUndefined();
    } finally { await module.close(); delete process.env.KASI_HOLIDAY_SERVICE_KEY_PATH; }
  });
});
