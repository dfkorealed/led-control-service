import { expect, test } from "@playwright/test";
import { applicationProvisioningDeviceTerminalIngestedAckV2Schema, provisioningDeviceCommandV2Schema,
  provisioningDeviceTerminalV2Schema } from "@led-control/shared";
import { RealBackendLab, countCompletedProvisioningDeviceExchanges } from "./support/real-backend-lab";

// 서버를 시작하지 않고 opt-in 환경 경계만 검사한다. private introspection은
// 기존 Lab support 테스트 패턴을 따르며 실제 journey에는 사용하지 않는다.
const configuration = (lab: RealBackendLab) => lab as unknown as {
  storagePort?: number;
  apiEnv(): Record<string, string>;
};

test("CAD Lab opt-in은 기존 기본 환경을 변경하지 않는다", () => {
  const lab = new RealBackendLab();
  expect(lab.isolatedCadStorage).toBe(false);
  const env = configuration(lab).apiEnv();
  expect(env.NODE_ENV).toBe("test");
  expect(Object.keys(env).filter(key => key.startsWith("OBJECT_STORAGE_") || key.startsWith("CAD_IMPORT_"))).toEqual([]);
});

test("CAD Lab은 소유 storage가 없으면 거부하고 완전한 전용 환경을 생성한다", () => {
  const first = new RealBackendLab({ isolatedCadStorage: true });
  const second = new RealBackendLab({ isolatedCadStorage: true });
  expect(() => configuration(first).apiEnv()).toThrow("Owned CAD storage must start");
  configuration(first).storagePort = 19001;
  configuration(second).storagePort = 19002;
  const env = configuration(first).apiEnv(), other = configuration(second).apiEnv();
  expect(env.OBJECT_STORAGE_ENDPOINT).toBe("http://127.0.0.1:19001");
  expect(env.OBJECT_STORAGE_PUBLIC_URL).toBe(`${env.OBJECT_STORAGE_ENDPOINT}/${env.OBJECT_STORAGE_BUCKET}`);
  expect(env.OBJECT_STORAGE_BUCKET).not.toBe(other.OBJECT_STORAGE_BUCKET);
  expect(env.OBJECT_STORAGE_REPORT_BUCKET).not.toBe(env.OBJECT_STORAGE_BUCKET);
  expect(env.OBJECT_STORAGE_ACCESS_KEY).not.toBe(other.OBJECT_STORAGE_ACCESS_KEY);
  expect(env.OBJECT_STORAGE_SECRET_KEY).not.toBe(other.OBJECT_STORAGE_SECRET_KEY);
  expect(env.CAD_IMPORT_CONVERTER_MODE).toBe("local-dxf-copy");
  expect(env.CAD_IMPORT_TEMP_ROOT).toMatch(/\/\.local\/e2e-real-backend\/task9-[^/]+\/cad$/);
  expect(env.NODE_ENV).toBe("development");
  expect(env.PKI_PROVIDER).toBe("unavailable");
  for (const key of ["PKI_API_CA_BUNDLE_PATH", "PKI_MQTT_CA_BUNDLE_PATH", "PKI_ROOT_CRL_PATH",
    "MQTT_CLIENT_CRL_PATH", "API_MANUFACTURING_CLIENT_CA_PATH", "API_MANUFACTURING_CRL_PATH",
    "VAULT_ADDR", "VAULT_TOKEN", "VAULT_TOKEN_FILE", "VAULT_NAMESPACE", "VAULT_CA_CERT_PATH",
    "VAULT_PKI_DEVICE_MOUNT", "VAULT_PKI_DEVICE_ROLE", "VAULT_PKI_MQTT_MOUNT", "VAULT_PKI_MQTT_ROLE",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(env[key], key).toBe("");
});

test("identify 교환은 provision-device 완료 개수에 포함하지 않는다", () => {
  const identity = { siteId: "00000000-0000-4000-8000-000000000001", gatewayId: "00000000-0000-4000-8000-000000000002",
    nodeId: "00000000-0000-4000-8000-000000000003", sessionId: "00000000-0000-4000-8000-000000000004",
    commandId: "00000000-0000-4000-8000-000000000005", operation: "identify", deviceUuid: "44464b4c454401010101000000000001" };
  const event = { eventId: "00000000-0000-4000-8000-000000000006", sequence: 1 };
  const date = new Date().toISOString();
  const entries = [
    { direction: "command", topic: "/commands/provisioning/provision-device", payload: { ...identity, requestedAt: date } },
    { direction: "gateway-event", topic: "/events/provisioning/device-terminal", payload: { ...identity, ...event, occurredAt: date, status: "completed", restoreConfirmed: true } },
    { direction: "application-ack", topic: "/acks/provisioning/device-terminal-ingested", payload: { ...identity, ...event, ingestedAt: date } }
  ];
  provisioningDeviceCommandV2Schema.parse(entries[0].payload);
  provisioningDeviceTerminalV2Schema.parse(entries[1].payload);
  applicationProvisioningDeviceTerminalIngestedAckV2Schema.parse(entries[2].payload);
  expect(countCompletedProvisioningDeviceExchanges(entries)).toBe(0);
});

test("부분 시작 실패에서도 소유 mc helper를 먼저 정리하고 타 소유 container는 거부한다", async () => {
  const lab = new RealBackendLab({ isolatedCadStorage: true });
  const internal = lab as unknown as { runId: string; storageName: string;
    docker(args: string[]): string; stopCadStorage(): Promise<void> };
  const removed: string[] = [];
  internal.docker = args => {
    if (args[0] === "ps") return removed.length === 2 ? "" : [
      { ID: "server", Names: internal.storageName }, { ID: "helper", Names: `${internal.storageName}-setup` }
    ].map(value => JSON.stringify(value)).join("\n");
    if (args[0] === "inspect") return internal.runId;
    if (args[0] === "rm") { removed.push(args.at(-1)!); return ""; }
    throw new Error("Unexpected Docker command");
  };
  await internal.stopCadStorage();
  expect(removed).toEqual(["helper", "server"]);
  expect(lab.cadStorageEvidence().cleanupVerified).toBe(true);

  internal.docker = args => {
    if (args[0] === "ps") return JSON.stringify({ ID: "foreign", Names: internal.storageName });
    if (args[0] === "inspect") return "another-owner";
    throw new Error("Must not remove foreign container");
  };
  await expect(internal.stopCadStorage()).rejects.toThrow("Refusing to remove unowned MinIO");
});
