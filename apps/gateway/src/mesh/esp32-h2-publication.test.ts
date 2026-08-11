import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ESP32-H2 periodic publication callback", () => {
  it("refreshes OnOff and Lightness publication buffers without scheduling duplicate publishes", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../../../esp32-h2-firmware/main/ble_mesh_node.c"), "utf8");
    const callback = source.slice(source.indexOf("static void model_publish_cb"), source.indexOf("esp_err_t ble_mesh_node_init"));

    expect(callback).toContain("net_buf_simple_reset");
    expect(callback).toContain("net_buf_simple_add_u8");
    expect(callback).not.toContain("esp_ble_mesh_model_publish");
    expect(callback).not.toContain("esp_ble_mesh_health_server_fault_update");
  });
});
