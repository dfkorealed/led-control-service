// Reserved for tests. Production validation must reject this identifier.
export const TEST_BLUETOOTH_COMPANY_ID = 0xfffe;
export const TEST_BLUETOOTH_COMPANY_ID_LE = [
  TEST_BLUETOOTH_COMPANY_ID & 0xff,
  TEST_BLUETOOTH_COMPANY_ID >> 8
] as const;
