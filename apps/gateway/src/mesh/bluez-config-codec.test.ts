import { describe, expect, it } from "vitest";
import {
  CONFIG_OPCODES,
  encodeCompositionDataGet,
  encodeModelAppBind,
  encodeModelSubscriptionAdd,
  encodeModelPublicationSet,
  encodePublicationPeriod,
  parseAppKeyStatus,
  parseCompositionDataStatus,
  parseModelAppStatus,
  parseModelSubscriptionStatus,
  parseModelPublicationStatus,
  parsePrimaryElementCompositionModels
} from "./bluez-config-codec";

describe("BlueZ Config Client codec", () => {
  it("encodes SIG configuration messages in Bluetooth Mesh wire order", () => {
    expect([...encodeCompositionDataGet(0)]).toEqual([0x80, 0x08, 0x00]);
    expect([...encodeModelAppBind(0x1201, 0, 0x1300)]).toEqual([0x80, 0x3d, 0x01, 0x12, 0x00, 0x00, 0x00, 0x13]);
    expect([...encodeModelPublicationSet({ elementAddress: 0x1201, publishAddress: 0x0001, appKeyIndex: 0, ttl: 5, modelId: 0x1300 })]).toEqual([
      0x03, 0x01, 0x12, 0x01, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x13
    ]);
    expect([...encodeModelSubscriptionAdd(0x0100, 0xc000, 0x1300)]).toEqual([
      0x80, 0x1b, 0x00, 0x01, 0x00, 0xc0, 0x00, 0x13
    ]);
  });

  it("encodes a 60 second publication period using the 10 second Mesh resolution", () => {
    expect(encodePublicationPeriod(60_000)).toBe(0x86);
    expect(() => encodePublicationPeriod(60_500)).toThrow("publication period");
  });

  it("encodes and parses vendor model identifiers in Bluetooth Mesh wire order", () => {
    expect([...encodeModelAppBind(0x1201, 0, 0x0000, 0x02e5)]).toEqual([
      0x80, 0x3d, 0x01, 0x12, 0x00, 0x00, 0xe5, 0x02, 0x00, 0x00
    ]);
    expect(parseModelAppStatus(Uint8Array.from([
      0x80, 0x3e, 0x00, 0x01, 0x12, 0x00, 0x00, 0xe5, 0x02, 0x00, 0x00
    ]))).toEqual({ elementAddress: 0x1201, appKeyIndex: 0, companyId: 0x02e5, modelId: 0x0000 });
  });

  it("strictly parses primary element SIG and vendor models from Composition Page 0", () => {
    expect(parsePrimaryElementCompositionModels(Uint8Array.from([
      0xe5, 0x02, 0x01, 0x00, 0x01, 0x00, 0x40, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x01,
      0x00, 0x11,
      0xe5, 0x02, 0x00, 0x00
    ]))).toEqual({
      sigModelIds: [0x1100],
      vendorModels: [{ companyId: 0x02e5, modelId: 0x0000 }]
    });
    expect(() => parsePrimaryElementCompositionModels(Uint8Array.from([
      0xe5, 0x02, 0x01, 0x00, 0x01, 0x00, 0x40, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x01,
      0x00, 0x11
    ]))).toThrow("Malformed Bluetooth Mesh Composition Data");
  });

  it("parses successful status messages and rejects malformed or failed statuses", () => {
    expect(parseCompositionDataStatus(Uint8Array.from([0x02, 0x00, 0x34, 0x12]))).toEqual({ page: 0, data: Uint8Array.from([0x34, 0x12]) });
    expect(parseAppKeyStatus(Uint8Array.from([0x80, 0x03, 0x00, 0x00, 0x00, 0x00]))).toEqual({ netKeyIndex: 0, appKeyIndex: 0 });
    expect(parseModelAppStatus(Uint8Array.from([0x80, 0x3e, 0x00, 0x01, 0x12, 0x00, 0x00, 0x00, 0x13]))).toEqual({
      elementAddress: 0x1201,
      appKeyIndex: 0,
      modelId: 0x1300
    });
    expect(parseModelSubscriptionStatus(Uint8Array.from([0x80, 0x1f, 0x00, 0x00, 0x01, 0x00, 0xc0, 0x00, 0x13]))).toEqual({
      elementAddress: 0x0100,
      groupAddress: 0xc000,
      modelId: 0x1300
    });
    expect(parseModelPublicationStatus(Uint8Array.from([0x80, 0x19, 0x00, 0x01, 0x12, 0x01, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x13]))).toMatchObject({
      elementAddress: 0x1201,
      publishAddress: 0x0001,
      modelId: 0x1300
    });
    expect(() => parseModelAppStatus(Uint8Array.from([0x80, 0x3e, 0x01, 0x01, 0x12, 0, 0, 0, 0x13]))).toThrow("status 0x01");
    expect(() => parseModelSubscriptionStatus(Uint8Array.from([0x80, 0x1f, 0x01, 0x00, 0x01, 0x00, 0xc0, 0x00, 0x13]))).toThrow("status 0x01");
    expect(() => parseAppKeyStatus(Uint8Array.from([CONFIG_OPCODES.appKeyStatus[0]]))).toThrow("Malformed");
  });
});
