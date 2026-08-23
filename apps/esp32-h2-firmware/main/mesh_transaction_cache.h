#pragma once

#include <stdbool.h>
#include <stdint.h>

#define MESH_LIGHTNESS_TRANSACTION_CACHE_CAPACITY 32U
#define MESH_LIGHTNESS_TRANSACTION_WINDOW_MS 6000U

typedef struct {
  uint64_t first_seen_ms;
  uint16_t source;
  uint16_t destination;
  uint8_t tid;
  bool occupied;
} mesh_lightness_transaction_entry_t;

typedef struct {
  mesh_lightness_transaction_entry_t entries[MESH_LIGHTNESS_TRANSACTION_CACHE_CAPACITY];
} mesh_lightness_transaction_cache_t;

bool mesh_lightness_transaction_is_duplicate(
    mesh_lightness_transaction_cache_t *cache,
    uint16_t source,
    uint16_t destination,
    uint8_t tid,
    uint64_t now_ms);
