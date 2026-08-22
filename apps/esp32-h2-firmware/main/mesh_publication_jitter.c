#include "mesh_publication_jitter.h"

#define GROUP_PUBLICATION_BASE_DELAY_MS 64U
#define GROUP_PUBLICATION_SLOT_MS 5U
#define GROUP_PUBLICATION_SLOT_MASK 0x03ffU

uint32_t mesh_group_publication_jitter_ms(uint16_t primary_unicast) {
  return GROUP_PUBLICATION_BASE_DELAY_MS +
         ((uint32_t)(primary_unicast & GROUP_PUBLICATION_SLOT_MASK) * GROUP_PUBLICATION_SLOT_MS);
}
