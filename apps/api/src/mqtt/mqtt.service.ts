import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { DimmingCommandPayload, mqttTopics } from "@led-control/shared";
import mqtt, { MqttClient } from "mqtt";

@Injectable()
export class MqttService implements OnModuleDestroy {
  private readonly client: MqttClient;

  constructor() {
    this.client = mqtt.connect(process.env.MQTT_URL ?? "mqtt://localhost:1883");
  }

  async publishDimmingCommand(payload: DimmingCommandPayload) {
    const topic = mqttTopics.dimmingCommand(payload.siteId);
    await new Promise<void>((resolve, reject) => {
      this.client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  onModuleDestroy() {
    this.client.end();
  }
}
