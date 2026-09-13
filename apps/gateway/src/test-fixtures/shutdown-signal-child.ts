import { setTimeout as delay } from "node:timers/promises";
import { registerGatewayShutdownHandlers } from "../index";

registerGatewayShutdownHandlers({
  async stop() {
    console.log("USB_CLEANUP_STARTED");
    await delay(500);
    console.log("USB_CLEANUP_FINISHED");
  }
}, (code) => process.exit(code));

console.log("SIGNAL_HANDLER_READY");
setInterval(() => undefined, 1_000);
