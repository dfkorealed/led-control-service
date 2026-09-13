import { execFile as callback } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { KeyMaterialStore } from "./identity/key-material-store";
import { createMtlsBootstrapRequest } from "./config/bootstrap-client";
const exec = promisify(callback);
const siteId="11111111-1111-4111-8111-111111111111";
const gatewayId="22222222-2222-4222-8222-222222222222";
const serial="NEW-GATEWAY";
let directory:string, artifact:string;
let env:NodeJS.ProcessEnv;
let api:ReturnType<typeof createServer>, broker:ReturnType<typeof createTlsServer>;
let mode="assigned";
let events:string[];
let sockets:Set<TLSSocket>;
let run: typeof import("./bootstrap-only").runBootstrapOnly;

beforeAll(async()=>{
  // This assertion is the initial RED when the dedicated product CLI is absent.
  await expect(readFile(join(import.meta.dirname,"bootstrap-only.ts"),"utf8")).resolves.toContain("runBootstrapOnly");
  run=(await import("./bootstrap-only")).runBootstrapOnly;
  artifact=await mkdtemp(join(process.cwd(),".bootstrap-test-"));
  await build({entryPoints:[join(import.meta.dirname,"bootstrap-only.ts")],bundle:true,platform:"node",format:"esm",packages:"external",outfile:join(artifact,"cli.mjs")});
});
afterAll(async()=>{if(artifact)await rm(artifact,{recursive:true,force:true});});
beforeEach(async()=>{
  directory=await realpath(await mkdtemp(join(tmpdir(),"bootstrap-only-")));
  mode="assigned";events=[];sockets=new Set();
  await exec("openssl",["req","-x509","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-keyout",join(directory,"ca.key"),"-out",join(directory,"ca.crt"),"-subj","/CN=Disposable CA","-days","1"]);
  await exec("openssl",["req","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-keyout",join(directory,"server.key"),"-out",join(directory,"server.csr"),"-subj","/CN=localhost"]);
  await writeFile(join(directory,"server.ext"),"subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n");
  await exec("openssl",["x509","-req","-in",join(directory,"server.csr"),"-CA",join(directory,"ca.crt"),"-CAkey",join(directory,"ca.key"),"-CAcreateserial","-out",join(directory,"server.crt"),"-days","1","-extfile",join(directory,"server.ext")]);
  const ca=await readFile(join(directory,"ca.crt"),"utf8");
  await mkdir(join(directory,"identity"),{mode:0o750});
  await mkdir(join(directory,"gateway"),{mode:0o700});
  const store=new KeyMaterialStore({identityRoot:join(directory,"identity/device")});
  const {csrPem}=await store.generateDeviceIdentity(serial);
  const cert=await sign(csrPem,"device");
  await store.installIdentityBundle({deviceCertificatePem:cert,deviceCaBundlePem:ca,apiCaBundlePem:ca,mqttCaBundlePem:ca});
  const tls={key:await readFile(join(directory,"server.key")),cert:await readFile(join(directory,"server.crt")),ca,requestCert:true,rejectUnauthorized:true};
  broker=createTlsServer(tls,socket=>{
    sockets.add(socket);socket.on("close",()=>sockets.delete(socket));socket.on("error",()=>{});
    socket.on("data",data=>{
      const kind=data[0]>>4;
      events.push(kind===1?"connect":`forbidden-mqtt-${kind}`);
      // A disposable external broker boundary, not a fake Gateway runtime.
      if(kind===1)socket.write(Buffer.from([0x20,0x02,0x00,mode==="broker-reject"?0x05:0x00]));
    });
  });
  await new Promise<void>(resolve=>broker.listen(0,"127.0.0.1",resolve));
  const mqttUrl=`mqtts://127.0.0.1:${(broker.address() as {port:number}).port}`;
  api=createServer(tls,async(request,response)=>{
    try {
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if(request.url==="/gateway-bootstrap") {
        events.push("bootstrap");expect(body).toEqual({serialNumber:serial});
        if(mode==="hang")return;
        if(mode==="oversize"){response.end(JSON.stringify({status:"unclaimed",padding:"x".repeat(300_000)}));return;}
        if(mode==="http-error"){response.writeHead(503);response.end("PRIVATE KEY secret-test");return;}
        response.end(JSON.stringify(mode==="unclaimed"?{status:"unclaimed"}:{status:"assigned",assignment:{siteId,gatewayId:mode==="scope-mismatch"?siteId:gatewayId,serialNumber:serial,mqttUrl,configVersion:1}}));
      } else if(request.url==="/gateway-certificates/mqtt") {
        events.push("issue");expect(Object.keys(body)).toEqual(["csrPem"]);expect(body.csrPem).not.toContain("PRIVATE KEY");
        expect(JSON.parse(await readFile(join(directory,"gateway/assignment.json"),"utf8")).gatewayId).toBe(gatewayId);
        const certificatePem=await sign(body.csrPem,"mqtt");
        response.end(JSON.stringify({gatewayId,certificatePem,caChainPem:ca,notAfter:new Date(new X509Certificate(certificatePem).validTo).toISOString()}));
      } else {response.writeHead(404);response.end();}
    } catch {response.writeHead(500);response.end();}
  });
  await new Promise<void>(resolve=>api.listen(0,"127.0.0.1",resolve));
  env={GATEWAY_SERIAL:serial,GATEWAY_EXPECTED_SITE_ID:siteId,GATEWAY_EXPECTED_GATEWAY_ID:gatewayId,
    GATEWAY_BOOTSTRAP_URL:`https://127.0.0.1:${(api.address() as {port:number}).port}/gateway-bootstrap`,
    GATEWAY_BOOTSTRAP_IDENTITY_DIR:join(directory,"identity"),GATEWAY_BOOTSTRAP_STATE_DIR:join(directory,"gateway")};
});
afterEach(async()=>{
  vi.restoreAllMocks();api?.closeAllConnections();
  for(const socket of sockets??[])socket.destroy();
  if(api)await new Promise<void>(resolve=>api.close(()=>resolve()));
  if(broker)await new Promise<void>(resolve=>broker.close(()=>resolve()));
  if(directory)await rm(directory,{recursive:true,force:true});
});

it("real CLI bootstraps, atomically persists assignment, issues/validates/probes MQTT, then exits without publish",async()=>{
  const {stdout,stderr}=await exec(process.execPath,[join(artifact,"cli.mjs")],{env:{...process.env,...env},timeout:10000});
  expect(JSON.parse(stdout)).toEqual({status:"complete",operation:"bootstrap-only"});expect(stderr).toBe("");
  expect(events).toEqual(["bootstrap","issue","connect"]);
  expect((await stat(join(directory,"gateway/assignment.json"))).mode&0o777).toBe(0o600);
  expect((await stat(join(directory,"identity/mqtt/current/gateway.key"))).mode&0o777).toBe(0o600);
  const certificate=new X509Certificate(await readFile(join(directory,"identity/mqtt/current/gateway.crt")));
  expect(certificate.subject).toBe(`CN=${gatewayId}`);
});

it.each(["unclaimed","scope-mismatch","http-error"])("%s terminates after one bootstrap and never issues or leaks native details",async(failure)=>{
  mode=failure;
  expect(await run(env)).toEqual({status:"failed",operation:"bootstrap-only",stage:"assignment"});
  expect(events).toEqual(["bootstrap"]);
  await expect(stat(join(directory,"identity/mqtt"))).rejects.toMatchObject({code:"ENOENT"});
});

it("broker rejection fails without retry, publish, or activating its pending identity",async()=>{
  mode="broker-reject";
  expect(await run(env)).toEqual({status:"failed",operation:"bootstrap-only",stage:"mqtt"});
  expect(events).toEqual(["bootstrap","issue","connect"]);
  await expect(stat(join(directory,"identity/mqtt/current"))).rejects.toMatchObject({code:"ENOENT"});
});

it("root or overlapping mount roots fail before network/filesystem mutation",async()=>{
  expect(await run({...env,GATEWAY_BOOTSTRAP_STATE_DIR:env.GATEWAY_BOOTSTRAP_IDENTITY_DIR})).toMatchObject({status:"failed",stage:"preflight"});
  vi.spyOn(process as { getuid: () => number },"getuid").mockReturnValue(0);
  expect(await run(env)).toMatchObject({status:"failed",stage:"preflight"});expect(events).toEqual([]);
});

it("a nested directory beginning with two dots is still an overlapping root",async()=>{
  const nested=join(directory,"identity/..state");
  await mkdir(nested,{mode:0o700});
  expect(await run({...env,GATEWAY_BOOTSTRAP_STATE_DIR:nested})).toMatchObject({status:"failed",stage:"preflight"});
  expect(events).toEqual([]);
});

it("wrong stored identity scope cannot issue or overwrite the existing assignment",async()=>{
  const wrong=JSON.stringify({siteId,gatewayId:siteId,serialNumber:serial,mqttUrl:"mqtts://old.invalid:8883",configVersion:1});
  await writeFile(join(directory,"gateway/assignment.json"),wrong,{mode:0o600});
  expect(await run(env)).toMatchObject({status:"failed",stage:"assignment"});
  expect(events).toEqual([]);expect(await readFile(join(directory,"gateway/assignment.json"),"utf8")).toBe(wrong);
});

it("CLI rejects raw override arguments and exits nonzero without echoing secret input",async()=>{
  const result=await exec(process.execPath,[join(artifact,"cli.mjs"),"secret-test"],{env:{...process.env,...env},timeout:10000}).catch(error=>error);
  expect(result.code).toBe(1);expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({status:"failed",operation:"bootstrap-only",stage:"preflight"});
  expect(events).toEqual([]);
});

it("invalid TLS trust exits promptly with a fixed error and no dangling deadline",async()=>{
  await writeFile(join(directory,"identity/device/current/api-ca.crt"),"invalid trust");
  const result=await exec(process.execPath,[join(artifact,"cli.mjs")],{env:{...process.env,...env},timeout:1500}).catch(error=>error);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({status:"failed",operation:"bootstrap-only",stage:"assignment"});
  expect(events).toEqual([]);
});

it.each(["hang","oversize"])("bootstrap HTTP %s is bounded and rejected without retry",async(failure)=>{
  mode=failure;
  const current=join(directory,"identity/device/current");
  const request=await createMtlsBootstrapRequest({url:env.GATEWAY_BOOTSTRAP_URL!,certificatePath:join(current,"device.crt"),privateKeyPath:join(current,"device.key"),caPath:join(current,"api-ca.crt"),timeoutMs:40});
  await expect(Promise.race([request({serialNumber:serial}),new Promise(resolve=>setTimeout(()=>resolve("unbounded request"),200))])).rejects.toThrow("gateway bootstrap request failed");
  expect(events).toEqual(["bootstrap"]);
});

it("a verified rerun probes the existing identity without duplicate issuance",async()=>{
  expect(await run(env)).toMatchObject({status:"complete"});
  expect(await run(env)).toMatchObject({status:"complete"});
  expect(events).toEqual(["bootstrap","issue","connect","connect"]);
});

async function sign(csr:string,name:string) {
  await writeFile(join(directory,`${name}.csr`),csr);
  await exec("openssl",["x509","-req","-in",join(directory,`${name}.csr`),"-CA",join(directory,"ca.crt"),"-CAkey",join(directory,"ca.key"),"-CAcreateserial","-out",join(directory,`${name}.crt`),"-days","1"]);
  return readFile(join(directory,`${name}.crt`),"utf8");
}
