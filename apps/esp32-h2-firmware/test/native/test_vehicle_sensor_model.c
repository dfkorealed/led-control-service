#include "vehicle_sensor_model.h"

#include <assert.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
  vehicle_sensor_send_result_t result;
  uint8_t payloads[64][VEHICLE_SENSOR_PACKET_SIZE];
  size_t count;
} fake_transport_t;

static vehicle_sensor_send_result_t fake_send(
    const uint8_t payload[VEHICLE_SENSOR_PACKET_SIZE],
    void *context) {
  fake_transport_t *transport = context;
  assert(transport->count < 64);
  memcpy(transport->payloads[transport->count], payload, VEHICLE_SENSOR_PACKET_SIZE);
  transport->count++;
  return transport->result;
}

static void test_task14_wire_contract(void) {
  const uint8_t expected_event[] = {
      0x01,
      0x44, 0x33, 0x22, 0x11,
      0x88, 0x77, 0x66, 0x55,
      0x01,
      0x01,
  };
  const uint8_t expected_ack[] = {
      0x01,
      0x44, 0x33, 0x22, 0x11,
      0x88, 0x77, 0x66, 0x55,
  };
  uint8_t bytes[VEHICLE_SENSOR_PACKET_SIZE];
  vehicle_sensor_packet_t decoded;
  uint32_t boot_id = 0;
  uint32_t sequence = 0;
  vehicle_sensor_packet_t packet = vehicle_sensor_packet_make(
      0x11223344U,
      0x55667788U,
      VEHICLE_SENSOR_DETECTED,
      true);

  assert(vehicle_sensor_packet_encode(&packet, bytes, sizeof(bytes)) == VEHICLE_SENSOR_PACKET_SIZE);
  assert(memcmp(bytes, expected_event, sizeof(expected_event)) == 0);
  assert(vehicle_sensor_packet_decode(bytes, sizeof(bytes), &decoded));
  assert(decoded.boot_id == packet.boot_id);
  assert(decoded.sequence == packet.sequence);
  assert(decoded.kind == VEHICLE_SENSOR_DETECTED);
  assert(decoded.level);

  packet.kind = VEHICLE_SENSOR_CLEARED;
  assert(vehicle_sensor_packet_encode(&packet, bytes, sizeof(bytes)) == 0);
  assert(!vehicle_sensor_packet_decode(expected_event, sizeof(expected_event) - 1, &decoded));

  assert(vehicle_sensor_ack_decode(expected_ack, sizeof(expected_ack), &boot_id, &sequence));
  assert(boot_id == 0x11223344U);
  assert(sequence == 0x55667788U);
  bytes[0] = 0x02;
  memcpy(bytes + 1, expected_ack + 1, sizeof(expected_ack) - 1);
  assert(!vehicle_sensor_ack_decode(bytes, sizeof(expected_ack), &boot_id, &sequence));
}

static void test_presence_status_and_publication_interval(void) {
  uint8_t status[VEHICLE_SENSOR_STATUS_SIZE];

  assert(vehicle_sensor_presence_status_encode(true, status, sizeof(status)) == VEHICLE_SENSOR_STATUS_SIZE);
  assert(memcmp(status, (uint8_t[]){0xa0, 0x09, 0x01}, sizeof(status)) == 0);
  assert(vehicle_sensor_presence_status_encode(false, status, sizeof(status)) == VEHICLE_SENSOR_STATUS_SIZE);
  assert(memcmp(status, (uint8_t[]){0xa0, 0x09, 0x00}, sizeof(status)) == 0);
  assert(vehicle_sensor_presence_status_encode(false, status, sizeof(status) - 1) == 0);

  uint32_t first = vehicle_sensor_publication_interval_ms(0x1201);
  assert(first >= VEHICLE_SENSOR_PUBLICATION_BASE_MS);
  assert(first < VEHICLE_SENSOR_PUBLICATION_BASE_MS + VEHICLE_SENSOR_PUBLICATION_JITTER_MS);
  assert(vehicle_sensor_publication_interval_ms(0x1201) == first);
  assert(vehicle_sensor_publication_interval_ms(0x1202) != first);
}

static void test_submit_and_exact_ack(void) {
  const uint8_t expected_cleared[] = {
      0x01,
      0x04, 0x03, 0x02, 0x01,
      0x02, 0x00, 0x00, 0x00,
      0x02,
      0x00,
  };
  fake_transport_t transport = {.result = VEHICLE_SENSOR_SEND_OK};
  vehicle_sensor_model_t model;
  uint32_t sequence = 0;

  vehicle_sensor_model_init(&model, 0x01020304U, fake_send, &transport);
  assert(vehicle_sensor_model_submit_event(
             &model, VEHICLE_SENSOR_DETECTED, true, 100, &sequence) == VEHICLE_SENSOR_SUBMIT_OK);
  assert(sequence == 1);
  assert(transport.count == 1);
  assert(vehicle_sensor_model_pending_count(&model) == 1);
  assert(vehicle_sensor_model_current_level(&model));

  assert(!vehicle_sensor_model_on_ack(&model, 0x01020305U, 1));
  assert(!vehicle_sensor_model_on_ack(&model, 0x01020304U, 2));
  assert(vehicle_sensor_model_pending_count(&model) == 1);
  assert(vehicle_sensor_model_on_ack(&model, 0x01020304U, 1));
  assert(vehicle_sensor_model_pending_count(&model) == 0);
  assert(!vehicle_sensor_model_on_ack(&model, 0x01020304U, 1));

  assert(vehicle_sensor_model_submit_event(
             &model, VEHICLE_SENSOR_CLEARED, false, 200, &sequence) == VEHICLE_SENSOR_SUBMIT_OK);
  assert(sequence == 2);
  assert(memcmp(transport.payloads[1], expected_cleared, sizeof(expected_cleared)) == 0);
  assert(vehicle_sensor_model_current_level_valid(&model));
  assert(!vehicle_sensor_model_current_level(&model));
}

static void test_retry_schedule_and_exhaustion(void) {
  const uint64_t retry_times[] = {250, 750, 1750, 3750, 7750, 15750};
  fake_transport_t transport = {.result = VEHICLE_SENSOR_SEND_OK};
  vehicle_sensor_model_t model;

  vehicle_sensor_model_init(&model, 7, fake_send, &transport);
  assert(vehicle_sensor_model_submit_event(
             &model, VEHICLE_SENSOR_DETECTED, true, 0, NULL) == VEHICLE_SENSOR_SUBMIT_OK);
  assert(transport.count == 1);

  for (size_t i = 0; i < sizeof(retry_times) / sizeof(retry_times[0]); i++) {
    vehicle_sensor_model_process_time(&model, retry_times[i] - 1);
    assert(transport.count == i + 1);
    vehicle_sensor_model_process_time(&model, retry_times[i]);
    assert(transport.count == i + 2);
  }

  assert(vehicle_sensor_model_pending_count(&model) == 1);
  vehicle_sensor_model_process_time(&model, 23749);
  assert(vehicle_sensor_model_pending_count(&model) == 1);
  vehicle_sensor_model_process_time(&model, 23750);
  assert(vehicle_sensor_model_pending_count(&model) == 0);
  assert(vehicle_sensor_model_retry_exhausted_count(&model) == 1);
  assert(transport.count == 7);

  assert(vehicle_sensor_model_submit_event(
             &model, VEHICLE_SENSOR_CLEARED, false, 24000, NULL) == VEHICLE_SENSOR_SUBMIT_OK);
  assert(vehicle_sensor_model_pending_count(&model) == 1);
}

static void test_fixed_pending_capacity_and_current_state_recovery(void) {
  fake_transport_t transport = {.result = VEHICLE_SENSOR_SEND_OK};
  vehicle_sensor_model_t model;

  vehicle_sensor_model_init(&model, 9, fake_send, &transport);
  for (uint32_t i = 0; i < VEHICLE_SENSOR_PENDING_CAPACITY; i++) {
    bool level = (i & 1U) == 0;
    assert(vehicle_sensor_model_submit_event(
               &model,
               level ? VEHICLE_SENSOR_DETECTED : VEHICLE_SENSOR_CLEARED,
               level,
               i,
               NULL) == VEHICLE_SENSOR_SUBMIT_OK);
  }
  assert(vehicle_sensor_model_pending_count(&model) == VEHICLE_SENSOR_PENDING_CAPACITY);
  assert(transport.count == VEHICLE_SENSOR_PENDING_CAPACITY);

  assert(vehicle_sensor_model_submit_event(
             &model,
             VEHICLE_SENSOR_DETECTED,
             true,
             99,
             NULL) == VEHICLE_SENSOR_SUBMIT_PENDING_FULL);
  assert(vehicle_sensor_model_pending_count(&model) == VEHICLE_SENSOR_PENDING_CAPACITY);
  assert(vehicle_sensor_model_pending_full_count(&model) == 1);
  assert(vehicle_sensor_model_current_level(&model));

  vehicle_sensor_model_reset_pending(&model);
  assert(vehicle_sensor_model_pending_count(&model) == 0);
  assert(vehicle_sensor_model_submit_event(
             &model,
             VEHICLE_SENSOR_CLEARED,
             false,
             100,
             NULL) == VEHICLE_SENSOR_SUBMIT_OK);
}

static void test_send_faults_and_sequence_overflow_fail_safe(void) {
  fake_transport_t transport = {.result = VEHICLE_SENSOR_SEND_UNCONFIGURED};
  vehicle_sensor_model_t model;

  vehicle_sensor_model_init(&model, UINT32_MAX, fake_send, &transport);
  model.next_sequence = UINT32_MAX;
  assert(vehicle_sensor_model_submit_event(
             &model,
             VEHICLE_SENSOR_DETECTED,
             true,
             0,
             NULL) == VEHICLE_SENSOR_SUBMIT_OK);
  assert(vehicle_sensor_model_unconfigured_send_count(&model) == 1);

  transport.result = VEHICLE_SENSOR_SEND_ERROR;
  vehicle_sensor_model_process_time(&model, 250);
  assert(vehicle_sensor_model_send_error_count(&model) == 1);
  vehicle_sensor_model_record_send_error(&model);
  assert(vehicle_sensor_model_send_error_count(&model) == 2);

  assert(vehicle_sensor_model_submit_event(
             &model,
             VEHICLE_SENSOR_CLEARED,
             false,
             251,
             NULL) == VEHICLE_SENSOR_SUBMIT_SEQUENCE_EXHAUSTED);
  assert(vehicle_sensor_model_sequence_exhausted_count(&model) == 1);
  assert(!vehicle_sensor_model_current_level(&model));
}

int main(void) {
  test_task14_wire_contract();
  test_presence_status_and_publication_interval();
  test_submit_and_exact_ack();
  test_retry_schedule_and_exhaustion();
  test_fixed_pending_capacity_and_current_state_recovery();
  test_send_faults_and_sequence_overflow_fail_safe();
  return 0;
}
