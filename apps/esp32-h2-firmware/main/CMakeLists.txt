idf_component_register(
  SRCS
    "app_main.c"
    "ble_mesh_node.c"
    "ble_mesh_platform.c"
    "control_state.c"
    "led_driver.c"
    "mesh_state.c"
  INCLUDE_DIRS "."
  REQUIRES bt driver nvs_flash
)
