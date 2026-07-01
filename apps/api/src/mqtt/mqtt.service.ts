import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { commandAckSchema, DimmingCommandPayload, fixtureStateSchema, mqttTopics } from "@led-control/shared";
import mqtt, { MqttClient } from "mqtt";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private client: MqttClient | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const client = this.getClient();
    client.on("connect", () => {
      client.subscribe(["sites/+/events/fixture-state", "sites/+/events/command-ack"], { qos: 1 });
    });
    client.on("message", (topic, payload) => {
      void this.handleMessage(topic, payload);
    });
  }

  async publishDimmingCommand(payload: DimmingCommandPayload) {
    const topic = mqttTopics.dimmingCommand(payload.siteId);
    await new Promise<void>((resolve, reject) => {
      this.getClient().publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  onModuleDestroy() {
    this.client?.end();
  }

  private getClient() {
    if (!this.client) {
      this.client = mqtt.connect(process.env.MQTT_URL ?? "mqtt://localhost:1883");
    }
    return this.client;
  }

  async handleMessage(topic: string, payload: Buffer) {
    if (topic.endsWith("/events/fixture-state")) {
      const state = fixtureStateSchema.parse(JSON.parse(payload.toString()));
      await this.prisma.fixture.update({
        where: { id: state.fixtureId },
        data: {
          brightness: state.brightness,
          status: state.status,
          lastSeenAt: new Date(state.lastSeenAt)
        }
      });
      return;
    }

    if (topic.endsWith("/events/command-ack")) {
      const ack = commandAckSchema.parse(JSON.parse(payload.toString()));
      await this.prisma.command.update({
        where: { id: ack.commandId },
        data: {
          status: ack.status,
          errorMessage: ack.errorMessage ?? null
        }
      });
    }
  }
}
