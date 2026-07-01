export const mqttTopics = {
  dimmingCommand: (siteId: string) => `sites/${siteId}/commands/dimming`,
  fixtureState: (siteId: string) => `sites/${siteId}/events/fixture-state`,
  commandAck: (siteId: string) => `sites/${siteId}/events/command-ack`,
  gatewayHeartbeat: (siteId: string) => `sites/${siteId}/events/gateway-heartbeat`
} as const;
