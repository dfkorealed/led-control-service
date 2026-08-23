idf_component_register(
  SRCS
    "app_main.c"
    "ble_mesh_node.c"
    "ble_mesh_platform.c"
    "control_state.c"
    "device_identity.c"
    "factory_reset.c"
    "identify.c"
    "led_driver.c"
    "mesh_state.c"
    "mesh_publication_jitter.c"
    "mesh_transaction_cache.c"
    "persistent_state.c"
  INCLUDE_DIRS "."
  REQUIRES bt driver nvs_flash esp_timer esp_system
)
