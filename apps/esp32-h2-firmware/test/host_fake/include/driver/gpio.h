#pragma once

#include <stdint.h>

#include "esp_err.h"

typedef int gpio_num_t;
typedef void (*gpio_isr_t)(void *argument);

typedef struct {
  uint64_t pin_bit_mask;
  int mode;
  int pull_up_en;
  int pull_down_en;
  int intr_type;
  int hys_ctrl_mode;
} gpio_config_t;

#define GPIO_MODE_INPUT 1
#define GPIO_PULLUP_DISABLE 0
#define GPIO_PULLDOWN_ENABLE 1
#define GPIO_INTR_DISABLE 0
#define GPIO_INTR_ANYEDGE 3
#define GPIO_HYS_SOFT_ENABLE 1

int gpio_get_level(gpio_num_t gpio);
esp_err_t gpio_config(const gpio_config_t *config);
esp_err_t gpio_install_isr_service(int flags);
void gpio_uninstall_isr_service(void);
esp_err_t gpio_isr_handler_add(gpio_num_t gpio, gpio_isr_t handler, void *argument);
esp_err_t gpio_isr_handler_remove(gpio_num_t gpio);
esp_err_t gpio_set_intr_type(gpio_num_t gpio, int type);
esp_err_t gpio_intr_enable(gpio_num_t gpio);
esp_err_t gpio_intr_disable(gpio_num_t gpio);
esp_err_t gpio_reset_pin(gpio_num_t gpio);
