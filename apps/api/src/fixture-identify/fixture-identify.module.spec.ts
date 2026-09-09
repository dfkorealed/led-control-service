import { Test } from "@nestjs/testing";
import { MqttService } from "../mqtt/mqtt.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { FixtureIdentifyController } from "./fixture-identify.controller";
import { FixtureIdentifyModule } from "./fixture-identify.module";
import { FixtureIdentifyService } from "./fixture-identify.service";

it("assembles the HTTP module with the existing MQTT singleton and registers a removable typed listener", async () => {
  const remove = jest.fn();
  const mqtt = { onFixtureIdentifyResult: jest.fn(() => remove) };
  const module = await Test.createTestingModule({ imports: [FixtureIdentifyModule] })
    .overrideProvider(PrismaService).useValue({})
    .overrideProvider(RedisProvider).useValue({})
    .overrideProvider(MqttService).useValue(mqtt)
    .compile();
  expect(module.get(FixtureIdentifyController)).toBeDefined();
  const service = module.get(FixtureIdentifyService);
  service.onModuleInit();
  expect(mqtt.onFixtureIdentifyResult).toHaveBeenCalledTimes(1);
  service.onModuleDestroy();
  expect(remove).toHaveBeenCalledTimes(1);
});
