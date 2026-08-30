#include "vehicle_sensor_mesh_adapter.h"

#include <assert.h>
#include <string.h>

static void assert_response(
    vehicle_sensor_request_kind_t kind,
    bool property_id_present,
    uint16_t property_id,
    bool current_available,
    bool current_level,
    uint32_t expected_opcode,
    const uint8_t *expected,
    size_t expected_size) {
  vehicle_sensor_response_t response = {0};
  assert(vehicle_sensor_mesh_encode_response(
             kind,
             property_id_present,
             property_id,
             current_available,
             current_level,
             &response) == VEHICLE_SENSOR_RESPONSE_READY);
  assert(response.opcode == expected_opcode);
  assert(response.size == expected_size);
  assert(memcmp(response.payload, expected, expected_size) == 0);
}

static void test_descriptor_and_unsupported_property_semantics(void) {
  const uint8_t descriptor[] = {0x4d, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00};
  const uint8_t unsupported[] = {0x34, 0x12};

  assert_response(
      VEHICLE_SENSOR_REQUEST_DESCRIPTOR,
      false,
      0,
      false,
      false,
      0x51,
      descriptor,
      sizeof(descriptor));
  assert_response(
      VEHICLE_SENSOR_REQUEST_DESCRIPTOR,
      true,
      0x1234,
      false,
      false,
      0x51,
      unsupported,
      sizeof(unsupported));
}

static void test_sensor_get_uses_current_or_defers(void) {
  const uint8_t high[] = {0xa0, 0x09, 0x01};
  const uint8_t unsupported[] = {0xff, 0x34, 0x12};
  vehicle_sensor_response_t response = {0};

  assert_response(
      VEHICLE_SENSOR_REQUEST_GET,
      true,
      VEHICLE_SENSOR_PRESENCE_PROPERTY_ID,
      true,
      true,
      0x52,
      high,
      sizeof(high));
  assert_response(
      VEHICLE_SENSOR_REQUEST_GET,
      true,
      0x1234,
      false,
      false,
      0x52,
      unsupported,
      sizeof(unsupported));
  assert(vehicle_sensor_mesh_encode_response(
             VEHICLE_SENSOR_REQUEST_GET,
             false,
             0,
             false,
             false,
             &response) == VEHICLE_SENSOR_RESPONSE_DEFER);
  assert(response.size == 0);
}

static void test_column_and_series_return_property_only(void) {
  const uint8_t presence[] = {0x4d, 0x00};
  const uint8_t unsupported[] = {0x34, 0x12};

  assert_response(
      VEHICLE_SENSOR_REQUEST_COLUMN,
      true,
      VEHICLE_SENSOR_PRESENCE_PROPERTY_ID,
      false,
      false,
      0x53,
      presence,
      sizeof(presence));
  assert_response(
      VEHICLE_SENSOR_REQUEST_SERIES,
      true,
      0x1234,
      false,
      false,
      0x54,
      unsupported,
      sizeof(unsupported));
}

int main(void) {
  test_descriptor_and_unsupported_property_semantics();
  test_sensor_get_uses_current_or_defers();
  test_column_and_series_return_property_only();
  return 0;
}
