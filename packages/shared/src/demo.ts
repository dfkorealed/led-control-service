export const demoIds = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  siteId: "00000000-0000-4000-8000-000000000003",
  gatewayId: "00000000-0000-4000-8000-000000000004",
  floorId: "00000000-0000-4000-8000-000000000005",
  groupId: "00000000-0000-4000-8000-000000000006",
  fixtureIds: Array.from({ length: 12 }, (_, index) =>
    `00000000-0000-4000-8000-${(2001 + index).toString().padStart(12, "0")}`
  ),
  meshNodeIds: Array.from({ length: 12 }, (_, index) =>
    `00000000-0000-4000-8000-${(1001 + index).toString().padStart(12, "0")}`
  )
} as const;
