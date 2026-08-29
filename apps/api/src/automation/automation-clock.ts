import { Injectable } from "@nestjs/common";

@Injectable()
export class AutomationClock {
  now() {
    return new Date();
  }
}
