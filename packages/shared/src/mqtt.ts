export const mqttTopics = {
  dimmingCommand: (siteId: string) => `sites/${siteId}/commands/dimming`,
  fixtureState: (siteId: string) => `sites/${siteId}/events/fixture-state`,
  commandAck: (siteId: string) => `sites/${siteId}/events/command-ack`,
  gatewayHeartbeat: (siteId: string) => `sites/${siteId}/events/gateway-heartbeat`,
  provisioningScanStart: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/commands/provisioning-scan-start`,
  provisionDevice: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/commands/provision-device`,
  identifyDevice: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/commands/identify-device`,
  unprovisionedDeviceFound: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/unprovisioned-device-found`,
  provisioningProgress: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning-progress`,
  provisioningCompleted: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning-completed`,
  provisioningFailed: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning-failed`,
  meshNodeMetrics: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/mesh-node-metrics`
} as const;
