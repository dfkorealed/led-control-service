#include <assert.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "driver/ledc.h"
#include "esp_timer.h"
#include "freertos/semphr.h"
#include "identify.h"
#include "led_driver.h"

struct fake_timer {
  esp_timer_create_args_t args;
  bool running;
};
static struct fake_timer timer;
static int64_t now_us;
static uint32_t pending_duty, output_duty;
static unsigned writes, timer_starts;
static bool fail_update, fail_set, fail_timer_create, fail_timer_start;
static _Thread_local bool owns_driver_lock;
static _Thread_local bool delay_lock;
static pthread_mutex_t barrier_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t barrier_cond = PTHREAD_COND_INITIALIZER;
static bool callback_waiting, callback_released;

SemaphoreHandle_t xSemaphoreCreateMutexStatic(StaticSemaphore_t *storage) {
  assert(pthread_mutex_init(storage, NULL) == 0);
  return storage;
}
BaseType_t xSemaphoreTake(SemaphoreHandle_t mutex, TickType_t wait) {
  (void)wait;
  if (delay_lock) {
    assert(pthread_mutex_lock(&barrier_mutex) == 0);
    callback_waiting = true;
    assert(pthread_cond_broadcast(&barrier_cond) == 0);
    while (!callback_released) {
      assert(pthread_cond_wait(&barrier_cond, &barrier_mutex) == 0);
    }
    assert(pthread_mutex_unlock(&barrier_mutex) == 0);
  }
  assert(pthread_mutex_lock(mutex) == 0);
  owns_driver_lock = true;
  return pdTRUE;
}
BaseType_t xSemaphoreGive(SemaphoreHandle_t mutex) {
  owns_driver_lock = false;
  assert(pthread_mutex_unlock(mutex) == 0);
  return pdTRUE;
}
int64_t esp_timer_get_time(void) {
  assert(owns_driver_lock);
  return now_us;
}
esp_err_t esp_timer_create(const esp_timer_create_args_t *args, esp_timer_handle_t *handle) {
  if (fail_timer_create) return ESP_ERR_NO_MEM;
  timer.args = *args;
  assert(args->dispatch_method == ESP_TIMER_TASK);
  assert(args->skip_unhandled_events);
  *handle = &timer;
  return ESP_OK;
}
esp_err_t esp_timer_start_periodic(esp_timer_handle_t handle, uint64_t interval) {
  assert(handle == &timer && interval > 0);
  if (fail_timer_start) return ESP_FAIL;
  if (timer.running) return ESP_ERR_INVALID_STATE;
  timer.running = true;
  timer_starts++;
  return ESP_OK;
}
esp_err_t esp_timer_stop(esp_timer_handle_t handle) {
  assert(handle == &timer);
  if (!timer.running) return ESP_ERR_INVALID_STATE;
  timer.running = false;
  return ESP_OK;
}
esp_err_t esp_timer_delete(esp_timer_handle_t handle) {
  assert(handle == &timer && !timer.running);
  return ESP_OK;
}
esp_err_t ledc_timer_config(const ledc_timer_config_t *config) {
  assert(config->freq_hz == 5000);
  return ESP_OK;
}
esp_err_t ledc_channel_config(const ledc_channel_config_t *config) {
  output_duty = (uint32_t)config->duty;
  return ESP_OK;
}
esp_err_t ledc_set_duty(int mode, int channel, uint32_t duty) {
  (void)mode;
  (void)channel;
  assert(owns_driver_lock);
  if (fail_set) return ESP_FAIL;
  pending_duty = duty;
  writes++;
  return ESP_OK;
}
esp_err_t ledc_update_duty(int mode, int channel) {
  (void)mode;
  (void)channel;
  assert(owns_driver_lock);
  if (fail_update) return ESP_FAIL;
  output_duty = pending_duty;
  return ESP_OK;
}
static uint32_t duty(unsigned percent) { return percent * 1023 / 100; }
static void tick_at(int64_t time) {
  now_us = time;
  /* Explicitly dispatch even after stop to represent an already queued callback. */
  timer.args.callback(timer.args.arg);
}

static void *delayed_callback(void *arg) {
  (void)arg;
  delay_lock = true;
  timer.args.callback(timer.args.arg);
  return NULL;
}

static pthread_t queue_delayed_callback(void) {
  pthread_t thread;
  assert(pthread_create(&thread, NULL, delayed_callback, NULL) == 0);
  assert(pthread_mutex_lock(&barrier_mutex) == 0);
  while (!callback_waiting) {
    assert(pthread_cond_wait(&barrier_cond, &barrier_mutex) == 0);
  }
  assert(pthread_mutex_unlock(&barrier_mutex) == 0);
  return thread;
}

static void release_callback(pthread_t thread) {
  assert(pthread_mutex_lock(&barrier_mutex) == 0);
  callback_released = true;
  assert(pthread_cond_broadcast(&barrier_cond) == 0);
  assert(pthread_mutex_unlock(&barrier_mutex) == 0);
  assert(pthread_join(thread, NULL) == 0);
}

int main(int argc, char **argv) {
  assert(argc == 2);
  assert(led_driver_set_brightness(50) == ESP_ERR_INVALID_STATE);
  assert(led_driver_refresh() == ESP_ERR_INVALID_STATE);
  assert(identify_stop() == ESP_ERR_INVALID_STATE);
  assert(identify_start(1) == ESP_ERR_INVALID_STATE);
  assert(led_driver_init() == ESP_OK);
  if (strcmp(argv[1], "init-retry") == 0) {
    fail_timer_create = true;
    assert(identify_init() == ESP_ERR_NO_MEM);
    assert(identify_start(1) == ESP_ERR_INVALID_STATE);
    fail_timer_create = false;
    fail_timer_start = true;
    assert(identify_init() == ESP_FAIL);
    assert(identify_start(1) == ESP_ERR_INVALID_STATE);
    fail_timer_start = false;
  }
  assert(identify_init() == ESP_OK);
  assert(led_driver_set_brightness(80) == ESP_OK);
  if (strcmp(argv[1], "expiry") == 0) {
    assert(identify_start(1) == ESP_OK);
    tick_at(1000000);
    assert(output_duty == duty(80));
  } else if (strcmp(argv[1], "latest") == 0) {
    assert(identify_start(5) == ESP_OK);
    tick_at(250000);
    assert(led_driver_set_brightness(35) == ESP_OK);
    tick_at(1000000);
    assert(identify_stop() == ESP_OK);
    assert(output_duty == duty(35));
  } else if (strcmp(argv[1], "idle-stop") == 0) {
    assert(identify_stop() == ESP_OK);
    assert(identify_stop() == ESP_OK);
    assert(output_duty == duty(80));
  } else if (strcmp(argv[1], "restart") == 0) {
    assert(identify_start(1) == ESP_OK);
    now_us = 900000;
    assert(identify_start(2) == ESP_OK);
    tick_at(1000000);
    assert(output_duty == duty(56));
    assert(led_driver_set_brightness(35) == ESP_OK);
    assert(output_duty == duty(65));
    tick_at(2900000);
    assert(output_duty == duty(35));
    assert(timer_starts == 1);
  } else if (strcmp(argv[1], "stale-restart") == 0) {
    assert(identify_start(1) == ESP_OK);
    now_us = 1000000;
    pthread_t callback = queue_delayed_callback();
    now_us = 1100000;
    assert(identify_start(2) == ESP_OK);
    release_callback(callback);
    assert(output_duty == duty(56));
    tick_at(2100000);
    assert(output_duty == duty(56));
    tick_at(3100000);
    assert(output_duty == duty(80));
  } else if (strcmp(argv[1], "stale-stop") == 0) {
    assert(identify_start(5) == ESP_OK);
    pthread_t callback = queue_delayed_callback();
    assert(led_driver_set_brightness(35) == ESP_OK);
    assert(identify_stop() == ESP_OK);
    release_callback(callback);
    assert(output_duty == duty(35));
  } else if (strcmp(argv[1], "zero") == 0) {
    assert(identify_start(5) == ESP_OK);
    assert(led_driver_set_brightness(0) == ESP_OK);
    assert(output_duty > 0);
    tick_at(150000);
    assert(output_duty > 0);
    assert(identify_start(0) == ESP_OK);
    tick_at(1000000);
    assert(output_duty == 0);
    assert(identify_stop() == ESP_OK);
    assert(output_duty == 0);
  } else if (strcmp(argv[1], "expiry-latest") == 0) {
    assert(identify_start(1) == ESP_OK);
    assert(led_driver_set_brightness(35) == ESP_OK);
    tick_at(1000000);
    assert(output_duty == duty(35));
    assert(identify_stop() == ESP_OK);
    assert(led_driver_set_brightness(90) == ESP_OK);
    tick_at(2000000);
    assert(output_duty == duty(90));
  } else if (strcmp(argv[1], "output-retry") == 0) {
    fail_set = true;
    assert(identify_start(1) == ESP_FAIL);
    assert(led_driver_set_brightness(35) == ESP_FAIL);
    fail_set = false;
    tick_at(50000);
    assert(output_duty == duty(65));
    tick_at(1000000);
    assert(output_duty == duty(35));
  } else if (strcmp(argv[1], "stop-retry") == 0) {
    assert(identify_start(5) == ESP_OK);
    assert(led_driver_set_brightness(35) == ESP_OK);
    fail_update = true;
    assert(identify_stop() == ESP_FAIL);
    assert(led_driver_set_brightness(90) == ESP_FAIL);
    fail_update = false;
    tick_at(50000);
    assert(output_duty == duty(90));
  } else if (strcmp(argv[1], "repeated") == 0) {
    for (unsigned i = 0; i < 100; i++) {
      assert(identify_init() == ESP_OK);
      assert(identify_start(1) == ESP_OK);
      assert(identify_start(1) == ESP_OK);
      assert(identify_stop() == ESP_OK);
      assert(identify_stop() == ESP_OK);
    }
    assert(timer_starts == 1);
    unsigned previous_writes = writes;
    tick_at(1000000);
    assert(writes == previous_writes);
    assert(output_duty == duty(80));
  } else if (strcmp(argv[1], "init-retry") == 0) {
    assert(identify_start(1) == ESP_OK);
    assert(timer_starts == 1);
    tick_at(1000000);
    assert(output_duty == duty(80));
  } else {
    assert(!"unknown case");
  }
  printf("identify driver: %s passed\n", argv[1]);
  return 0;
}
