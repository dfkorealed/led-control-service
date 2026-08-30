#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "vehicle_sensor_driver.h"

#define VEHICLE_SENSOR_PROTOCOL_VERSION 1U
#define VEHICLE_SENSOR_PACKET_SIZE 11U
#define VEHICLE_SENSOR_ACK_SIZE 9U
#define VEHICLE_SENSOR_STATUS_SIZE 3U
#define VEHICLE_SENSOR_PENDING_CAPACITY 16U
#define VEHICLE_SENSOR_MAX_RETRIES 6U
#define VEHICLE_SENSOR_PUBLICATION_BASE_MS 60000U
#define VEHICLE_SENSOR_PUBLICATION_JITTER_MS 5000U
#define VEHICLE_SENSOR_VENDOR_SERVER_MODEL_ID 0x0000U
#define VEHICLE_SENSOR_VENDOR_CLIENT_MODEL_ID 0x0001U
#define VEHICLE_SENSOR_VENDOR_EVENT_OPCODE_BYTE 0xC1U
#define VEHICLE_SENSOR_VENDOR_ACK_OPCODE_BYTE 0xC2U

typedef struct {
  uint32_t boot_id;
  uint32_t sequence;
  vehicle_sensor_event_kind_t kind;
  bool level;
} vehicle_sensor_packet_t;

typedef enum {
  VEHICLE_SENSOR_SEND_OK = 0,
  VEHICLE_SENSOR_SEND_ERROR,
  VEHICLE_SENSOR_SEND_UNCONFIGURED,
} vehicle_sensor_send_result_t;

typedef vehicle_sensor_send_result_t (*vehicle_sensor_send_fn_t)(
    const uint8_t payload[VEHICLE_SENSOR_PACKET_SIZE],
    void *context);

typedef struct {
  bool occupied;
  vehicle_sensor_packet_t packet;
  uint64_t retry_due_ms;
  uint8_t retries_sent;
} vehicle_sensor_pending_t;

typedef struct {
  uint32_t boot_id;
  uint32_t next_sequence;
  bool sequence_exhausted;
  bool current_level_valid;
  bool current_level;
  vehicle_sensor_send_fn_t send;
  void *send_context;
  vehicle_sensor_pending_t pending[VEHICLE_SENSOR_PENDING_CAPACITY];
  uint32_t pending_full_count;
  uint32_t retry_exhausted_count;
  uint32_t send_error_count;
  uint32_t unconfigured_send_count;
  uint32_t sequence_exhausted_count;
} vehicle_sensor_model_t;

typedef enum {
  VEHICLE_SENSOR_SUBMIT_OK = 0,
  VEHICLE_SENSOR_SUBMIT_INVALID,
  VEHICLE_SENSOR_SUBMIT_PENDING_FULL,
  VEHICLE_SENSOR_SUBMIT_SEQUENCE_EXHAUSTED,
} vehicle_sensor_submit_result_t;

vehicle_sensor_packet_t vehicle_sensor_packet_make(
    uint32_t boot_id,
    uint32_t sequence,
    vehicle_sensor_event_kind_t kind,
    bool level);
size_t vehicle_sensor_packet_encode(
    const vehicle_sensor_packet_t *packet,
    uint8_t *output,
    size_t output_size);
bool vehicle_sensor_packet_decode(
    const uint8_t *payload,
    size_t payload_size,
    vehicle_sensor_packet_t *packet);
bool vehicle_sensor_ack_decode(
    const uint8_t *payload,
    size_t payload_size,
    uint32_t *boot_id,
    uint32_t *sequence);
size_t vehicle_sensor_presence_status_encode(bool level, uint8_t *output, size_t output_size);
uint32_t vehicle_sensor_publication_interval_ms(uint16_t primary_unicast);

void vehicle_sensor_model_init(
    vehicle_sensor_model_t *model,
    uint32_t boot_id,
    vehicle_sensor_send_fn_t send,
    void *send_context);
vehicle_sensor_submit_result_t vehicle_sensor_model_submit_event(
    vehicle_sensor_model_t *model,
    vehicle_sensor_event_kind_t kind,
    bool level,
    uint64_t now_ms,
    uint32_t *sequence);
void vehicle_sensor_model_process_time(vehicle_sensor_model_t *model, uint64_t now_ms);
bool vehicle_sensor_model_on_ack(vehicle_sensor_model_t *model, uint32_t boot_id, uint32_t sequence);
void vehicle_sensor_model_record_send_error(vehicle_sensor_model_t *model);
void vehicle_sensor_model_reset_pending(vehicle_sensor_model_t *model);
size_t vehicle_sensor_model_pending_count(const vehicle_sensor_model_t *model);
bool vehicle_sensor_model_current_level(const vehicle_sensor_model_t *model);
bool vehicle_sensor_model_current_level_valid(const vehicle_sensor_model_t *model);
uint64_t vehicle_sensor_model_next_deadline_ms(const vehicle_sensor_model_t *model);
uint32_t vehicle_sensor_model_pending_full_count(const vehicle_sensor_model_t *model);
uint32_t vehicle_sensor_model_retry_exhausted_count(const vehicle_sensor_model_t *model);
uint32_t vehicle_sensor_model_send_error_count(const vehicle_sensor_model_t *model);
uint32_t vehicle_sensor_model_unconfigured_send_count(const vehicle_sensor_model_t *model);
uint32_t vehicle_sensor_model_sequence_exhausted_count(const vehicle_sensor_model_t *model);
