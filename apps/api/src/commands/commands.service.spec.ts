import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "../mqtt/mqtt.service";
import { CommandsService } from "./commands.service";

describe("CommandsService", () => {
  it("creates a pending dimming command and publishes MQTT payload", async () => {
    const createdCommand = {
      id: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      targetType: "fixture",
      targetId: "33333333-3333-4333-8333-333333333333",
      brightness: 75,
      requestedBy: "44444444-4444-4444-8444-444444444444",
      createdAt: new Date("2026-07-01T00:00:00.000Z")
    };

    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: createdCommand.requestedBy, organizationId: "organization-1", role: "operator" })
      },
      fixture: {
        findFirst: jest.fn().mockResolvedValue({
          id: createdCommand.targetId,
          floor: {
            site: {
              id: createdCommand.siteId,
              organizationId: "organization-1"
            }
          }
        })
      },
      fixtureGroup: {
        findFirst: jest.fn()
      },
      command: {
        create: jest.fn().mockResolvedValue(createdCommand)
      }
    };
    const mqtt = { publishDimmingCommand: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CommandsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MqttService, useValue: mqtt }
      ]
    }).compile();

    const service = moduleRef.get(CommandsService);
    const result = await service.createDimmingCommand({
      siteId: createdCommand.siteId,
      targetType: "fixture",
      targetId: createdCommand.targetId,
      brightness: 75,
      requestedBy: createdCommand.requestedBy
    });

    expect(result.id).toBe(createdCommand.id);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: createdCommand.requestedBy } });
    expect(prisma.fixture.findFirst).toHaveBeenCalledWith({
      where: {
        id: createdCommand.targetId,
        floor: { siteId: createdCommand.siteId, site: { organizationId: "organization-1" } }
      }
    });
    expect(mqtt.publishDimmingCommand).toHaveBeenCalledWith({
      commandId: createdCommand.id,
      siteId: createdCommand.siteId,
      targetType: "fixture",
      targetId: createdCommand.targetId,
      targetFixtureIds: [createdCommand.targetId],
      brightness: 75,
      requestedBy: createdCommand.requestedBy,
      requestedAt: "2026-07-01T00:00:00.000Z"
    });
  });

  it("rejects commands when requestedBy does not match an existing user", async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null)
      },
      fixture: {
        findFirst: jest.fn()
      },
      fixtureGroup: {
        findFirst: jest.fn()
      },
      command: {
        create: jest.fn()
      }
    };
    const mqtt = { publishDimmingCommand: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CommandsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MqttService, useValue: mqtt }
      ]
    }).compile();

    const service = moduleRef.get(CommandsService);
    await expect(
      service.createDimmingCommand({
        siteId: "22222222-2222-4222-8222-222222222222",
        targetType: "fixture",
        targetId: "33333333-3333-4333-8333-333333333333",
        brightness: 75,
        requestedBy: "99999999-9999-4999-8999-999999999999"
      })
    ).rejects.toThrow("requestedBy must reference an existing user id");
    expect(prisma.command.create).not.toHaveBeenCalled();
    expect(mqtt.publishDimmingCommand).not.toHaveBeenCalled();
  });

  it("publishes group dimming commands with the group fixture ids", async () => {
    const createdCommand = {
      id: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      targetType: "group",
      targetId: "33333333-3333-4333-8333-333333333333",
      brightness: 40,
      requestedBy: "44444444-4444-4444-8444-444444444444",
      createdAt: new Date("2026-07-01T00:00:00.000Z")
    };
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: createdCommand.requestedBy, organizationId: "organization-1", role: "admin" })
      },
      fixture: {
        findFirst: jest.fn()
      },
      fixtureGroup: {
        findFirst: jest.fn().mockResolvedValue({
          id: createdCommand.targetId,
          siteId: createdCommand.siteId,
          groupFixtures: [{ fixtureId: "fixture-1" }, { fixtureId: "fixture-2" }]
        })
      },
      command: {
        create: jest.fn().mockResolvedValue(createdCommand)
      }
    };
    const mqtt = { publishDimmingCommand: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CommandsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MqttService, useValue: mqtt }
      ]
    }).compile();

    const service = moduleRef.get(CommandsService);
    await service.createDimmingCommand({
      siteId: createdCommand.siteId,
      targetType: "group",
      targetId: createdCommand.targetId,
      brightness: 40,
      requestedBy: createdCommand.requestedBy
    });

    expect(prisma.fixtureGroup.findFirst).toHaveBeenCalledWith({
      where: {
        id: createdCommand.targetId,
        siteId: createdCommand.siteId,
        site: { organizationId: "organization-1" }
      },
      include: { groupFixtures: true }
    });
    expect(mqtt.publishDimmingCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: "group",
        targetId: createdCommand.targetId,
        targetFixtureIds: ["fixture-1", "fixture-2"],
        brightness: 40
      })
    );
  });

  it("rejects fixture commands outside the user's organization", async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: "user-1", organizationId: "organization-1", role: "operator" })
      },
      fixture: {
        findFirst: jest.fn().mockResolvedValue(null)
      },
      fixtureGroup: {
        findFirst: jest.fn()
      },
      command: {
        create: jest.fn()
      }
    };
    const mqtt = { publishDimmingCommand: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CommandsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MqttService, useValue: mqtt }
      ]
    }).compile();

    const service = moduleRef.get(CommandsService);
    await expect(
      service.createDimmingCommand({
        siteId: "22222222-2222-4222-8222-222222222222",
        targetType: "fixture",
        targetId: "33333333-3333-4333-8333-333333333333",
        brightness: 75,
        requestedBy: "user-1"
      })
    ).rejects.toThrow("control target not found in the user's site");
    expect(prisma.command.create).not.toHaveBeenCalled();
    expect(mqtt.publishDimmingCommand).not.toHaveBeenCalled();
  });

  it("rejects viewer users from creating dimming commands", async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: "user-1", organizationId: "organization-1", role: "viewer" })
      },
      fixture: {
        findFirst: jest.fn()
      },
      fixtureGroup: {
        findFirst: jest.fn()
      },
      command: {
        create: jest.fn()
      }
    };
    const mqtt = { publishDimmingCommand: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CommandsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MqttService, useValue: mqtt }
      ]
    }).compile();

    const service = moduleRef.get(CommandsService);
    await expect(
      service.createDimmingCommand({
        siteId: "22222222-2222-4222-8222-222222222222",
        targetType: "fixture",
        targetId: "33333333-3333-4333-8333-333333333333",
        brightness: 75,
        requestedBy: "user-1"
      })
    ).rejects.toThrow("viewer users cannot control lights");
    expect(prisma.command.create).not.toHaveBeenCalled();
    expect(mqtt.publishDimmingCommand).not.toHaveBeenCalled();
  });
});
