#include "device_identity.h"

#include <string.h>

#include "esp_err.h"
#include "esp_mac.h"
#include "sdkconfig.h"

#define DFK_DEVICE_UUID_FORMAT_VERSION 0x01

void device_identity_build(uint8_t output[16]) {
  static const uint8_t prefix[6] = {'D', 'F', 'K', 'L', 'E', 'D'};

  ESP_ERROR_CHECK(output == NULL ? ESP_ERR_INVALID_ARG : ESP_OK);
  memcpy(output, prefix, sizeof(prefix));
  output[6] = DFK_DEVICE_UUID_FORMAT_VERSION;
  output[7] = (uint8_t)CONFIG_DFK_PRODUCT_FAMILY;
  output[8] = (uint8_t)CONFIG_DFK_MODEL_CODE;
  output[9] = (uint8_t)CONFIG_DFK_HARDWARE_REVISION;
  ESP_ERROR_CHECK(esp_read_mac(&output[10], ESP_MAC_BT));
}
