#include "mesh_transaction_cache.h"

#include <stddef.h>

_Static_assert(sizeof(mesh_lightness_transaction_cache_t) <= 512U, "transaction cache exceeds RAM budget");

bool mesh_lightness_transaction_is_duplicate(
    mesh_lightness_transaction_cache_t *cache,
    uint16_t source,
    uint16_t destination,
    uint8_t tid,
    uint64_t now_ms) {
  size_t reusable_index = MESH_LIGHTNESS_TRANSACTION_CACHE_CAPACITY;
  size_t oldest_index = 0;
  uint64_t oldest_elapsed_ms = 0;

  for (size_t index = 0; index < MESH_LIGHTNESS_TRANSACTION_CACHE_CAPACITY; index += 1) {
    mesh_lightness_transaction_entry_t *entry = &cache->entries[index];
    if (!entry->occupied) {
      if (reusable_index == MESH_LIGHTNESS_TRANSACTION_CACHE_CAPACITY) {
        reusable_index = index;
      }
      continue;
    }

    uint64_t elapsed_ms = now_ms - entry->first_seen_ms;
    if (entry->source == source && entry->destination == destination && entry->tid == tid) {
      if (elapsed_ms < MESH_LIGHTNESS_TRANSACTION_WINDOW_MS) {
        /* Bluetooth Mesh uses a fixed window from the first message, not a sliding timeout. */
        return true;
      }
      entry->first_seen_ms = now_ms;
      return false;
    }

    if (elapsed_ms >= MESH_LIGHTNESS_TRANSACTION_WINDOW_MS &&
        reusable_index == MESH_LIGHTNESS_TRANSACTION_CACHE_CAPACITY) {
      reusable_index = index;
    }
    if (elapsed_ms > oldest_elapsed_ms) {
      oldest_elapsed_ms = elapsed_ms;
      oldest_index = index;
    }
  }

  size_t target_index = reusable_index == MESH_LIGHTNESS_TRANSACTION_CACHE_CAPACITY
                            ? oldest_index
                            : reusable_index;
  cache->entries[target_index] = (mesh_lightness_transaction_entry_t){
      .source = source,
      .destination = destination,
      .tid = tid,
      .first_seen_ms = now_ms,
      .occupied = true,
  };
  return false;
}
