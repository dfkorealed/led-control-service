export const mqttTopics = {
  dimmingCommand: (siteId: string) => `sites/${siteId}/commands/dimming`,
  fixtureState: (siteId: string) => `sites/${siteId}/events/fixture-state`,
  commandAck: (siteId: string) => `sites/${siteId}/events/command-ack`,
  gatewayHeartbeat: (siteId: string) => `sites/${siteId}/events/gateway-heartbeat`,
  provisioningProgress: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning-progress`,
  provisioningCompleted: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning-completed`,
  provisioningFailed: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/provisioning-failed`,
  meshGroupSubscriptionSync: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/commands/mesh-group/subscription-sync`,
  meshGroupSubscriptionResult: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/mesh-group/subscription-result`,
  meshGroupResyncRequest: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/mesh-group/resync-request`,
  meshNodeMetrics: (siteId: string, gatewayId: string) =>
    `sites/${siteId}/gateways/${gatewayId}/events/mesh-node-metrics`
} as const;
