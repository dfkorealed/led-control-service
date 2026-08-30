#include "vehicle_sensor_model.h"

#include <limits.h>
#include <string.h>

#ifdef ESP_PLATFORM
#include "esp_ble_mesh_sensor_model_api.h"
#include "mesh/device_property.h"

_Static_assert(BLE_MESH_PRESENCE_DETECTED_LEN == 1, "Presence Detected must be one byte");
#define VEHICLE_SENSOR_PRESENCE_MPID() \
  ESP_BLE_MESH_SENSOR_DATA_FORMAT_A_MPID(0, BLE_MESH_PRESENCE_DETECTED)
#else
#define VEHICLE_SENSOR_PRESENCE_PROPERTY_ID 0x004DU
#define VEHICLE_SENSOR_PRESENCE_MPID() (VEHICLE_SENSOR_PRESENCE_PROPERTY_ID << 5U)
#endif

static const uint32_t retry_delays_ms[VEHICLE_SENSOR_MAX_RETRIES] = {
    250U, 500U, 1000U, 2000U, 4000U, 8000U,
};

static void increment_saturating(uint32_t *value) {
  if (*value != UINT32_MAX) {
    (*value)++;
  }
}

static void write_le32(uint8_t *output, uint32_t value) {
  output[0] = (uint8_t)value;
  output[1] = (uint8_t)(value >> 8U);
  output[2] = (uint8_t)(value >> 16U);
  output[3] = (uint8_t)(value >> 24U);
}

static uint32_t read_le32(const uint8_t *input) {
  return (uint32_t)input[0] |
         ((uint32_t)input[1] << 8U) |
         ((uint32_t)input[2] << 16U) |
         ((uint32_t)input[3] << 24U);
}

static bool event_is_valid(vehicle_sensor_event_kind_t kind, bool level) {
  return (kind == VEHICLE_SENSOR_DETECTED && level) ||
         (kind == VEHICLE_SENSOR_CLEARED && !level);
}

static void record_send_result(vehicle_sensor_model_t *model, vehicle_sensor_send_result_t result) {
  if (result == VEHICLE_SENSOR_SEND_ERROR) {
    increment_saturating(&model->send_error_count);
  } else if (result == VEHICLE_SENSOR_SEND_UNCONFIGURED) {
    increment_saturating(&model->unconfigured_send_count);
  }
}

static void send_pending(vehicle_sensor_model_t *model, vehicle_sensor_pending_t *pending) {
  uint8_t payload[VEHICLE_SENSOR_PACKET_SIZE];
  if (vehicle_sensor_packet_encode(&pending->packet, payload, sizeof(payload)) != sizeof(payload)) {
    increment_saturating(&model->send_error_count);
    return;
  }
  if (model->send == NULL) {
    increment_saturating(&model->unconfigured_send_count);
    return;
  }
  record_send_result(model, model->send(payload, model->send_context));
}

vehicle_sensor_packet_t vehicle_sensor_packet_make(
    uint32_t boot_id,
    uint32_t sequence,
    vehicle_sensor_event_kind_t kind,
    bool level) {
  return (vehicle_sensor_packet_t){
      .boot_id = boot_id,
      .sequence = sequence,
      .kind = kind,
      .level = level,
  };
}

size_t vehicle_sensor_packet_encode(
    const vehicle_sensor_packet_t *packet,
    uint8_t *output,
    size_t output_size) {
  if (packet == NULL || output == NULL || output_size < VEHICLE_SENSOR_PACKET_SIZE ||
      !event_is_valid(packet->kind, packet->level)) {
    return 0;
  }
  output[0] = VEHICLE_SENSOR_PROTOCOL_VERSION;
  write_le32(output + 1, packet->boot_id);
  write_le32(output + 5, packet->sequence);
  output[9] = packet->kind == VEHICLE_SENSOR_DETECTED ? 1U : 2U;
  output[10] = packet->level ? 1U : 0U;
  return VEHICLE_SENSOR_PACKET_SIZE;
}

bool vehicle_sensor_packet_decode(
    const uint8_t *payload,
    size_t payload_size,
    vehicle_sensor_packet_t *packet) {
  if (payload == NULL || packet == NULL || payload_size != VEHICLE_SENSOR_PACKET_SIZE ||
      payload[0] != VEHICLE_SENSOR_PROTOCOL_VERSION ||
      (payload[9] != 1U && payload[9] != 2U) || payload[10] > 1U) {
    return false;
  }
  vehicle_sensor_event_kind_t kind = payload[9] == 1U ?
      VEHICLE_SENSOR_DETECTED : VEHICLE_SENSOR_CLEARED;
  bool level = payload[10] != 0;
  if (!event_is_valid(kind, level)) {
    return false;
  }
  *packet = vehicle_sensor_packet_make(
      read_le32(payload + 1), read_le32(payload + 5), kind, level);
  return true;
}

bool vehicle_sensor_ack_decode(
    const uint8_t *payload,
    size_t payload_size,
    uint32_t *boot_id,
    uint32_t *sequence) {
  if (payload == NULL || boot_id == NULL || sequence == NULL ||
      payload_size != VEHICLE_SENSOR_ACK_SIZE ||
      payload[0] != VEHICLE_SENSOR_PROTOCOL_VERSION) {
    return false;
  }
  *boot_id = read_le32(payload + 1);
  *sequence = read_le32(payload + 5);
  return true;
}

size_t vehicle_sensor_presence_status_encode(bool level, uint8_t *output, size_t output_size) {
  if (output == NULL || output_size < VEHICLE_SENSOR_STATUS_SIZE) {
    return 0;
  }
  uint16_t mpid = (uint16_t)VEHICLE_SENSOR_PRESENCE_MPID();
  output[0] = (uint8_t)mpid;
  output[1] = (uint8_t)(mpid >> 8U);
  output[2] = level ? 1U : 0U;
  return VEHICLE_SENSOR_STATUS_SIZE;
}

uint32_t vehicle_sensor_publication_interval_ms(uint16_t primary_unicast) {
  uint32_t hash = 2166136261U;
  hash = (hash ^ (uint8_t)primary_unicast) * 16777619U;
  hash = (hash ^ (uint8_t)(primary_unicast >> 8U)) * 16777619U;
  return VEHICLE_SENSOR_PUBLICATION_BASE_MS + (hash % VEHICLE_SENSOR_PUBLICATION_JITTER_MS);
}

void vehicle_sensor_model_init(
    vehicle_sensor_model_t *model,
    uint32_t boot_id,
    vehicle_sensor_send_fn_t send,
    void *send_context) {
  if (model == NULL) {
    return;
  }
  memset(model, 0, sizeof(*model));
  model->boot_id = boot_id;
  model->next_sequence = 1;
  model->send = send;
  model->send_context = send_context;
}

vehicle_sensor_submit_result_t vehicle_sensor_model_submit_event(
    vehicle_sensor_model_t *model,
    vehicle_sensor_event_kind_t kind,
    bool level,
    uint64_t now_ms,
    uint32_t *sequence) {
  if (model == NULL || !event_is_valid(kind, level)) {
    return VEHICLE_SENSOR_SUBMIT_INVALID;
  }
  model->current_level_valid = true;
  model->current_level = level;

  vehicle_sensor_pending_t *available = NULL;
  for (size_t index = 0; index < VEHICLE_SENSOR_PENDING_CAPACITY; index++) {
    if (!model->pending[index].occupied) {
      available = &model->pending[index];
      break;
    }
  }
  if (available == NULL) {
    increment_saturating(&model->pending_full_count);
    return VEHICLE_SENSOR_SUBMIT_PENDING_FULL;
  }
  if (model->sequence_exhausted) {
    increment_saturating(&model->sequence_exhausted_count);
    return VEHICLE_SENSOR_SUBMIT_SEQUENCE_EXHAUSTED;
  }

  uint32_t assigned_sequence = model->next_sequence;
  if (assigned_sequence == UINT32_MAX) {
    model->sequence_exhausted = true;
  } else {
    model->next_sequence = assigned_sequence + 1U;
  }
  available->occupied = true;
  available->packet = vehicle_sensor_packet_make(model->boot_id, assigned_sequence, kind, level);
  available->retry_due_ms = now_ms + retry_delays_ms[0];
  available->retries_sent = 0;
  if (sequence != NULL) {
    *sequence = assigned_sequence;
  }
  send_pending(model, available);
  return VEHICLE_SENSOR_SUBMIT_OK;
}

void vehicle_sensor_model_process_time(vehicle_sensor_model_t *model, uint64_t now_ms) {
  if (model == NULL) {
    return;
  }
  for (size_t index = 0; index < VEHICLE_SENSOR_PENDING_CAPACITY; index++) {
    vehicle_sensor_pending_t *pending = &model->pending[index];
    if (!pending->occupied || now_ms < pending->retry_due_ms) {
      continue;
    }
    if (pending->retries_sent == VEHICLE_SENSOR_MAX_RETRIES) {
      pending->occupied = false;
      increment_saturating(&model->retry_exhausted_count);
      continue;
    }
    send_pending(model, pending);
    pending->retries_sent++;
    uint8_t delay_index = pending->retries_sent < VEHICLE_SENSOR_MAX_RETRIES ?
        pending->retries_sent : VEHICLE_SENSOR_MAX_RETRIES - 1U;
    pending->retry_due_ms = now_ms + retry_delays_ms[delay_index];
  }
}

bool vehicle_sensor_model_on_ack(vehicle_sensor_model_t *model, uint32_t boot_id, uint32_t sequence) {
  if (model == NULL || boot_id != model->boot_id) {
    return false;
  }
  for (size_t index = 0; index < VEHICLE_SENSOR_PENDING_CAPACITY; index++) {
    vehicle_sensor_pending_t *pending = &model->pending[index];
    if (pending->occupied && pending->packet.boot_id == boot_id &&
        pending->packet.sequence == sequence) {
      pending->occupied = false;
      return true;
    }
  }
  return false;
}

void vehicle_sensor_model_record_send_error(vehicle_sensor_model_t *model) {
  if (model != NULL) {
    increment_saturating(&model->send_error_count);
  }
}

void vehicle_sensor_model_reset_pending(vehicle_sensor_model_t *model) {
  if (model != NULL) {
    memset(model->pending, 0, sizeof(model->pending));
  }
}

size_t vehicle_sensor_model_pending_count(const vehicle_sensor_model_t *model) {
  size_t count = 0;
  if (model != NULL) {
    for (size_t index = 0; index < VEHICLE_SENSOR_PENDING_CAPACITY; index++) {
      count += model->pending[index].occupied ? 1U : 0U;
    }
  }
  return count;
}

bool vehicle_sensor_model_current_level(const vehicle_sensor_model_t *model) {
  return model != NULL && model->current_level;
}

bool vehicle_sensor_model_current_level_valid(const vehicle_sensor_model_t *model) {
  return model != NULL && model->current_level_valid;
}

uint64_t vehicle_sensor_model_next_deadline_ms(const vehicle_sensor_model_t *model) {
  uint64_t deadline = UINT64_MAX;
  if (model != NULL) {
    for (size_t index = 0; index < VEHICLE_SENSOR_PENDING_CAPACITY; index++) {
      if (model->pending[index].occupied && model->pending[index].retry_due_ms < deadline) {
        deadline = model->pending[index].retry_due_ms;
      }
    }
  }
  return deadline;
}

uint32_t vehicle_sensor_model_pending_full_count(const vehicle_sensor_model_t *model) {
  return model == NULL ? 0 : model->pending_full_count;
}

uint32_t vehicle_sensor_model_retry_exhausted_count(const vehicle_sensor_model_t *model) {
  return model == NULL ? 0 : model->retry_exhausted_count;
}

uint32_t vehicle_sensor_model_send_error_count(const vehicle_sensor_model_t *model) {
  return model == NULL ? 0 : model->send_error_count;
}

uint32_t vehicle_sensor_model_unconfigured_send_count(const vehicle_sensor_model_t *model) {
  return model == NULL ? 0 : model->unconfigured_send_count;
}

uint32_t vehicle_sensor_model_sequence_exhausted_count(const vehicle_sensor_model_t *model) {
  return model == NULL ? 0 : model->sequence_exhausted_count;
}
