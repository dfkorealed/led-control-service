#include "ble_mesh_platform.h"

#include <assert.h>
#include <string.h>

#include "esp_log.h"
#include "sdkconfig.h"

#ifdef CONFIG_BT_BLUEDROID_ENABLED
#include "esp_bt.h"
#include "esp_bt_device.h"
#include "esp_bt_main.h"
#endif

#ifdef CONFIG_BT_NIMBLE_ENABLED
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#endif

static const char *TAG = "ble_mesh_platform";
static uint8_t ble_addr[6] = {0};

#ifdef CONFIG_BT_NIMBLE_ENABLED
static SemaphoreHandle_t mesh_ready_sem;
static uint8_t own_addr_type;
void ble_store_config_init(void);

static void mesh_on_reset(int reason) {
  ESP_LOGW(TAG, "NimBLE reset, reason=%d", reason);
}

static void mesh_on_sync(void) {
  int rc = ble_hs_util_ensure_addr(0);
  assert(rc == 0);

  rc = ble_hs_id_infer_auto(0, &own_addr_type);
  if (rc != 0) {
    ESP_LOGE(TAG, "Failed to infer BLE address type, rc=%d", rc);
    return;
  }

  rc = ble_hs_id_copy_addr(own_addr_type, ble_addr, NULL);
  if (rc != 0) {
    ESP_LOGE(TAG, "Failed to copy BLE address, rc=%d", rc);
    return;
  }

  xSemaphoreGive(mesh_ready_sem);
}

static void mesh_host_task(void *param) {
  (void)param;
  ESP_LOGI(TAG, "NimBLE host task started");
  nimble_port_run();
  nimble_port_freertos_deinit();
}
#endif

esp_err_t ble_mesh_platform_bluetooth_init(void) {
#ifdef CONFIG_BT_BLUEDROID_ENABLED
  ESP_ERROR_CHECK(esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT));

  esp_bt_controller_config_t bt_cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
  esp_err_t ret = esp_bt_controller_init(&bt_cfg);
  if (ret != ESP_OK) {
    return ret;
  }

  ret = esp_bt_controller_enable(ESP_BT_MODE_BLE);
  if (ret != ESP_OK) {
    return ret;
  }

  ret = esp_bluedroid_init();
  if (ret != ESP_OK) {
    return ret;
  }

  ret = esp_bluedroid_enable();
  if (ret == ESP_OK) {
    memcpy(ble_addr, esp_bt_dev_get_address(), sizeof(ble_addr));
  }
  return ret;
#elif defined(CONFIG_BT_NIMBLE_ENABLED)
  mesh_ready_sem = xSemaphoreCreateBinary();
  if (mesh_ready_sem == NULL) {
    return ESP_ERR_NO_MEM;
  }

  esp_err_t ret = nimble_port_init();
  if (ret != ESP_OK) {
    return ret;
  }

  ble_hs_cfg.reset_cb = mesh_on_reset;
  ble_hs_cfg.sync_cb = mesh_on_sync;
  ble_hs_cfg.store_status_cb = ble_store_util_status_rr;
  ble_store_config_init();

#if CONFIG_BLE_MESH_USE_BLE_50
  extern void bt_mesh_gatts_svcs_add(void);
  bt_mesh_gatts_svcs_add();
#endif

  nimble_port_freertos_init(mesh_host_task);
  xSemaphoreTake(mesh_ready_sem, portMAX_DELAY);
  return ESP_OK;
#else
  ESP_LOGE(TAG, "No supported Bluetooth host is enabled");
  return ESP_ERR_NOT_SUPPORTED;
#endif
}

void ble_mesh_platform_get_device_uuid(uint8_t dev_uuid[16]) {
  if (dev_uuid == NULL) {
    return;
  }

  memset(dev_uuid, 0, 16);
  dev_uuid[0] = 0x4c;
  dev_uuid[1] = 0x45;
  memcpy(dev_uuid + 2, ble_addr, sizeof(ble_addr));
}
