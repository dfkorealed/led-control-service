import { describe, expect, it } from "vitest";
import { BioFrameCodec, crc16, encodeCrcFrame, encodeGsFrame, encodeAddress, encodeWord, encodeShort, encodeInt } from "./bio-frame-codec";

const hex = (value: string) => Buffer.from(value, "hex");

describe("BIO frame codec", () => {
  it("uses the MODBUS CRC check vector and little-endian trailer", () => {
    expect(crc16(Buffer.from("123456789"))).toBe(0x4b37);
    // Two zero bytes advance ffff to 40bf then b001.
    expect(encodeCrcFrame(0, Buffer.alloc(0))).toEqual(hex("55aa000001b0"));
  });
  it("folds GS carry before complementing command, length, and payload", () => {
    expect(encodeGsFrame(0x82, hex("fffe"))).toEqual(hex("47538202fffe7c"));
  });
  it("encodes addresses/words big-endian and shorts/ints little-endian", () => {
    expect(encodeAddress(0x1234)).toEqual(hex("1234"));
    expect(encodeWord(0xabcd)).toEqual(hex("abcd"));
    expect(encodeShort(0x1234)).toEqual(hex("3412"));
    expect(encodeInt(0x12345678)).toEqual(hex("78563412"));
  });
  it.each([-1, 65536, 1.5, NaN])("rejects invalid 16-bit integer %s", (value) => {
    expect(() => encodeAddress(value)).toThrow(RangeError);
    expect(() => encodeWord(value)).toThrow(RangeError);
    expect(() => encodeShort(value)).toThrow(RangeError);
  });
  it("rejects invalid commands, ints, and oversized payload before encoding", () => {
    for (const command of [-1, 256, 1.5]) expect(() => encodeGsFrame(command, hex(""))).toThrow();
    for (const value of [-1, 0x100000000, 1.5]) expect(() => encodeInt(value)).toThrow();
    expect(() => encodeGsFrame(0, Buffer.alloc(64))).toThrow();
    expect(() => encodeCrcFrame(0, Buffer.alloc(64))).toThrow();
    expect(encodeGsFrame(0, Buffer.alloc(63))).toHaveLength(68);
  });
  it("parses split headers and coalesced frames after noise", () => {
    const codec = new BioFrameCodec();
    expect(codec.push(hex("010255"))).toEqual([]);
    expect(codec.push(hex("aa000001"))).toEqual([]);
    expect(codec.push(hex("b0475383007c"))).toEqual([
      { type: "frame", frame: { protocol: "crc16", command: 0, payload: hex("") } },
      { type: "frame", frame: { protocol: "gs", command: 0x83, payload: hex("") } }
    ]);
  });
  it.each(["55aa000001b1", "475383007d", "55aa0040", "47530040"])("reports malformed data and recovers after %s", (bad) => {
    const events = new BioFrameCodec().push(hex(`${bad}475383007c`));
    expect(events[0]).toMatchObject({ type: "malformed" });
    expect(events.at(-1)).toEqual({ type: "frame", frame: { protocol: "gs", command: 0x83, payload: hex("") } });
  });
  it("reset discards a partial old generation frame", () => {
    const codec = new BioFrameCodec();
    codec.push(hex("475383"));
    codec.reset();
    expect(codec.push(hex("007c"))).toEqual([]);
    expect(codec.push(hex("475383007c"))).toHaveLength(1);
  });
  it("does not accept exceptional probe literals as checksummed responses", () => {
    expect(new BioFrameCodec().push(hex("55aa82000000"))[0]).toMatchObject({ type: "malformed" });
    expect(new BioFrameCodec().push(hex("4753820000"))[0]).toMatchObject({ type: "malformed" });
  });
});
