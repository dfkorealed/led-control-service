import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSelfSensorConfiguration, encodeExactBioHoldInterval } from "./bio-self-sensor-configuration";
import type { BioSelfSensorConfigurationObservation } from "./bio-dongle-client";
import { decodeBioResponse } from "./bio-command-codec";

const original: BioSelfSensorConfigurationObservation = { highBrightnessPercent: 30, standbyBrightnessPercent: 10,
  holdSeconds: 5, standbySeconds: 5, rawHoldInterval: 10, rawStandbyInterval: 10, delayMode: 0, bioMode: "force-on" };
describe("exact native self-sensor configuration", () => {
  it("decodes the six normalized device readbacks without inventing missing configuration", () => {
    const fixture=JSON.parse(readFileSync(new URL("../../test/fixtures/bio-self-sensor-configuration.json",import.meta.url),"utf8")) as {
      normalizedReports:Array<{payloadHex:string;kind:string;brightnessPercent?:number;delayMode?:number;rawInterval?:number;seconds?:number;mode?:string}>
    };
    for(const {payloadHex,...expected} of fixture.normalizedReports){
      expect(decodeBioResponse({protocol:"crc16",command:0x12,payload:Buffer.from(payloadHex,"hex")})).toMatchObject({
        ...expected,deviceUuid:"bio:001122334455",logicalAddress:0x1234,networkId:0
      });
    }
  });
  it.each([[1,2],[5,10],[127,254],[180,7],[1800,61]])("encodes %i seconds without rounding", (seconds,raw) => {
    expect(encodeExactBioHoldInterval(seconds)).toBe(raw);
  });
  it.each([0,1.5,128,179,1801,NaN,Infinity])("rejects unsupported new duration %s before SET", seconds => {
    expect(()=>encodeExactBioHoldInterval(seconds)).toThrow();
  });
  it("preserves the observed phase/standby interval and prepares sensor mode, never force-on", () => {
    expect(buildSelfSensorConfiguration(original,{highBrightnessPercent:100,standbyBrightnessPercent:0,holdSeconds:1})).toEqual({
      highBrightnessPercent:100,standbyBrightnessPercent:0,holdSeconds:1,standbySeconds:5,
      rawHoldInterval:2,rawStandbyInterval:10,delayMode:0,bioMode:"sensor"
    });
    expect(original.bioMode).toBe("force-on");
  });
  it("does not normalize the original zero/long standby interval into the UI range", () => {
    const stored={...original,standbySeconds:7620,rawStandbyInterval:255};
    expect(buildSelfSensorConfiguration(stored,{highBrightnessPercent:70,standbyBrightnessPercent:10,holdSeconds:60}).rawStandbyInterval).toBe(255);
  });
  it("does not let extra desired fields overwrite phase or original raw settings", () => {
    const desired={highBrightnessPercent:100,standbyBrightnessPercent:0,holdSeconds:1,delayMode:1,rawStandbyInterval:255};
    expect(buildSelfSensorConfiguration(original,desired)).toMatchObject({delayMode:0,rawStandbyInterval:10,standbySeconds:5});
  });
  it.each([
    [{...original,delayMode:1},{highBrightnessPercent:100,standbyBrightnessPercent:0,holdSeconds:1}],
    [{...original,highBrightnessPercent:0},{highBrightnessPercent:100,standbyBrightnessPercent:0,holdSeconds:1}],
    [original,{highBrightnessPercent:0,standbyBrightnessPercent:0,holdSeconds:1}],
    [original,{highBrightnessPercent:100,standbyBrightnessPercent:101,holdSeconds:1}],
    [{...original,rawHoldInterval:2},{highBrightnessPercent:100,standbyBrightnessPercent:0,holdSeconds:1}]
  ] as const)("rejects unsupported phase, unrestorable baseline or invalid desired settings", (stored,desired) => {
    expect(()=>buildSelfSensorConfiguration(stored as BioSelfSensorConfigurationObservation,desired)).toThrow();
  });
});
