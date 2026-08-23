#include <assert.h>
#include <stdint.h>

#include "../main/mesh_transaction_cache.h"

static void test_transaction_window_does_not_slide(void) {
  mesh_lightness_transaction_cache_t cache = {0};

  assert(!mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc000, 7, 1000));
  assert(mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc000, 7, 6999));
  assert(!mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc000, 7, 7000));
}

static void test_transaction_key_uses_source_destination_and_tid(void) {
  mesh_lightness_transaction_cache_t cache = {0};

  assert(!mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc000, 7, 1000));
  assert(!mesh_lightness_transaction_is_duplicate(&cache, 0x0002, 0xc000, 7, 1001));
  assert(!mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc001, 7, 1002));
  assert(!mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc000, 8, 1003));
  assert(mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc000, 7, 1004));
}

static void test_elapsed_time_is_wrap_safe(void) {
  mesh_lightness_transaction_cache_t cache = {0};

  assert(!mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc000, 7, UINT64_MAX - 1000U));
  assert(mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc000, 7, 1000));
  assert(!mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc000, 7, 5000));
}

static void test_cache_is_bounded_and_evicts_oldest_entry(void) {
  mesh_lightness_transaction_cache_t cache = {0};

  for (uint16_t index = 0; index < MESH_LIGHTNESS_TRANSACTION_CACHE_CAPACITY; index += 1) {
    assert(!mesh_lightness_transaction_is_duplicate(&cache, (uint16_t)(index + 1U), 0xc000, 7, index));
  }

  assert(!mesh_lightness_transaction_is_duplicate(&cache, 0x0100, 0xc000, 7, 100));
  assert(!mesh_lightness_transaction_is_duplicate(&cache, 0x0001, 0xc000, 7, 101));
}

int main(void) {
  test_transaction_window_does_not_slide();
  test_transaction_key_uses_source_destination_and_tid();
  test_elapsed_time_is_wrap_safe();
  test_cache_is_bounded_and_evicts_oldest_entry();
  return 0;
}
