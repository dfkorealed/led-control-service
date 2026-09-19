import { decodeStageOperations } from "./map-document-stage-decoder";

async function* parts(bytes: Buffer, size = 7) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}
async function collect(input: string | Buffer, options = {}) {
  const result = [];
  for await (const operation of decodeStageOperations(parts(Buffer.isBuffer(input) ? input : Buffer.from(input)), options)) result.push(operation);
  return result;
}
describe("bounded stage operation stream", () => {
  it("decodes UTF8 and escaped JSON strings across arbitrary part boundaries", async () => {
    const operations = [{ kind: "delete", id: '한글"\\[]{}' }, { kind: "group.delete", id: "two" }];
    expect(await collect(JSON.stringify(operations))).toEqual(operations);
    expect(await collect(" \n[ ]\r\n")).toEqual([]);
  });
  it.each(["", "{}", "[", "[,{}]", '[{"kind":"delete","id":"x"},]',
    '[{"kind":"delete","id":"x"}] true', '[{"kind":"delete","id":"x"}{"kind":"delete","id":"y"}]',
    '[{"kind":"unknown"}]', '[{"kind":"delete","id":"x","extra":1}]'])
  ("rejects incomplete or invalid streams without accepting a prefix: %s", async input => {
    await expect(collect(input)).rejects.toThrow();
  });
  it("rejects invalid UTF8 rather than replacing bytes", async () => {
    await expect(collect(Buffer.concat([Buffer.from('[{"kind":"delete","id":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}]')]))).rejects.toThrow();
  });
  it("enforces operation/total/count/depth limits before unbounded parsing", async () => {
    const one = '[{"kind":"delete","id":"one"}]';
    await expect(collect(one, { operationBytes: 8 })).rejects.toThrow(/operation byte/);
    await expect(collect(one, { totalBytes: 10 })).rejects.toThrow(/total byte/);
    await expect(collect('[{"kind":"delete","id":"one"},{"kind":"delete","id":"two"}]', { maxOperations: 1 })).rejects.toThrow(/operation count/);
    await expect(collect("[" + '{"x":'.repeat(65) + "0" + "}".repeat(65) + "]")).rejects.toThrow(/depth/);
  });
  it("honors cancellation and deadline without reading more input", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(collect("[]", { signal: controller.signal })).rejects.toThrow();
    await expect(collect("[]", { deadline: Date.now() - 1 })).rejects.toThrow(/deadline/);
  });
  it("yields one operation at a time before requesting the next part", async () => {
    let nextRead = false;
    async function* source() {
      yield Buffer.from('[{"kind":"delete","id":"one"}');
      nextRead = true; yield Buffer.from(',{"kind":"delete","id":"two"}]');
    }
    const iterator = decodeStageOperations(source());
    expect((await iterator.next()).value).toEqual({ kind: "delete", id: "one" });
    expect(nextRead).toBe(false);
    await iterator.return(undefined);
  });
});
