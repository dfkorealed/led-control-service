import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require=createRequire(import.meta.url);
test("kernel process validator rejects root, HCI capabilities and missing no-new-privileges",()=>{
 const {assertIsolatedProcess}=require("./bio-process-check.cjs");
 const safe="Uid:\t999\t999\t999\t999\nGid:\t999\t999\t999\t999\nGroups:\t999 812\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n";
 assert.doesNotThrow(()=>assertIsolatedProcess(safe,"812"));
 for(const bad of [safe.replace("Uid:\t999","Uid:\t0"),safe.replace("Gid:\t999","Gid:\t0"),safe.replace("CapEff:\t0000000000000000","CapEff:\t0000000000001000"),safe.replace("CapBnd:\t0000000000000000","CapBnd:\t0000000000002000"),safe.replace("NoNewPrivs:\t1","NoNewPrivs:\t0"),safe.replace("Groups:\t999 812","Groups:\t999 0"),safe.replace(/CapAmb[^\n]+\n/,"")])assert.throws(()=>assertIsolatedProcess(bad,"812"));
});
