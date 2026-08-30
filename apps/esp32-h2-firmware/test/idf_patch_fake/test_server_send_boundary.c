#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "btc_ble_mesh_prov.h"

#define MAX_TRACKED_ALLOCATIONS 64
#define MAX_QUEUED_MESSAGES 32

typedef enum {
    FAILURE_NONE = 0,
    FAILURE_FIRST_PAYLOAD,
    FAILURE_CONTEXT,
    FAILURE_ENVELOPE,
    FAILURE_QUEUE_POST,
} failure_point_t;

typedef enum {
    ALLOCATION_MESH = 0,
    ALLOCATION_ENVELOPE,
} allocation_kind_t;

typedef struct {
    void *ptr;
    allocation_kind_t kind;
    bool freed;
} tracked_allocation_t;

typedef struct {
    btc_msg_t *message;
    btc_arg_deep_free_t free_func;
} queued_message_t;

static tracked_allocation_t allocations[MAX_TRACKED_ALLOCATIONS];
static size_t allocation_count;
static size_t mesh_allocation_attempts;
static size_t mesh_allocation_successes;
static size_t mesh_free_count;
static size_t envelope_free_count;
static size_t deep_copy_count;
static size_t handler_count;
static failure_point_t failure_point;
static queued_message_t queue[MAX_QUEUED_MESSAGES];
static size_t queue_count;

static void track_allocation(void *ptr, allocation_kind_t kind)
{
    assert(ptr != NULL);
    assert(allocation_count < MAX_TRACKED_ALLOCATIONS);
    allocations[allocation_count++] = (tracked_allocation_t){
        .ptr = ptr,
        .kind = kind,
        .freed = false,
    };
}

static void track_free(void *ptr, allocation_kind_t kind)
{
    assert(ptr != NULL);
    for (size_t index = 0; index < allocation_count; index++) {
        tracked_allocation_t *allocation = &allocations[index];
        if (allocation->ptr == ptr) {
            assert(allocation->kind == kind);
            assert(!allocation->freed);
            allocation->freed = true;
            free(ptr);
            return;
        }
    }
    assert(false && "free of an unowned pointer");
}

static void *envelope_malloc(size_t size)
{
    if (failure_point == FAILURE_ENVELOPE) {
        return NULL;
    }
    void *ptr = calloc(1, size);
    track_allocation(ptr, ALLOCATION_ENVELOPE);
    return ptr;
}

static void envelope_free(void *ptr)
{
    envelope_free_count++;
    track_free(ptr, ALLOCATION_ENVELOPE);
}

void *bt_mesh_malloc(size_t size)
{
    mesh_allocation_attempts++;
    if ((failure_point == FAILURE_FIRST_PAYLOAD && mesh_allocation_attempts == 1U) ||
        (failure_point == FAILURE_CONTEXT && size == sizeof(esp_ble_mesh_msg_ctx_t))) {
        return NULL;
    }
    void *ptr = malloc(size);
    track_allocation(ptr, ALLOCATION_MESH);
    mesh_allocation_successes++;
    return ptr;
}

void bt_mesh_free(void *ptr)
{
    if (ptr == NULL) {
        return;
    }
    mesh_free_count++;
    track_free(ptr, ALLOCATION_MESH);
}

void net_buf_simple_add_mem(struct net_buf_simple *buf, const void *data, size_t length)
{
    assert(buf != NULL);
    assert(buf->len + length <= buf->size);
    if (length > 0U) {
        assert(data != NULL);
        memcpy(buf->data + buf->len, data, length);
    }
    buf->len = (uint16_t)(buf->len + length);
}

void bt_mesh_model_msg_init(struct net_buf_simple *buf, uint32_t opcode)
{
    assert(buf != NULL);
    buf->len = 0;
    uint8_t encoded[3] = {0};
    size_t length = opcode < 0x100U ? 1U : (opcode < 0x10000U ? 2U : 3U);
    assert(esp_ble_mesh_model_msg_opcode_init(encoded, opcode) == ESP_OK);
    net_buf_simple_add_mem(buf, encoded, length);
}

void btc_ble_mesh_model_arg_deep_copy(btc_msg_t *msg, void *dst_ptr, void *src_ptr)
{
    btc_ble_mesh_model_args_t *dst = dst_ptr;
    btc_ble_mesh_model_args_t *src = src_ptr;
    deep_copy_count++;
    if (msg->act != BTC_BLE_MESH_ACT_SERVER_MODEL_SEND &&
        msg->act != BTC_BLE_MESH_ACT_CLIENT_MODEL_SEND) {
        return;
    }

    dst->model_send.data = src->model_send.length > 0U ?
        bt_mesh_malloc(src->model_send.length) : NULL;
    dst->model_send.ctx = bt_mesh_malloc(sizeof(esp_ble_mesh_msg_ctx_t));
    if (dst->model_send.data != NULL) {
        memcpy(dst->model_send.data, src->model_send.data, src->model_send.length);
    }
    if (dst->model_send.ctx != NULL) {
        memcpy(dst->model_send.ctx, src->model_send.ctx, sizeof(esp_ble_mesh_msg_ctx_t));
    }
}

void btc_ble_mesh_model_arg_deep_free(btc_msg_t *msg)
{
    btc_ble_mesh_model_args_t *arg = (btc_ble_mesh_model_args_t *)msg->arg;
    if (msg->act == BTC_BLE_MESH_ACT_SERVER_MODEL_SEND ||
        msg->act == BTC_BLE_MESH_ACT_CLIENT_MODEL_SEND) {
        bt_mesh_free(arg->model_send.data);
        bt_mesh_free(arg->model_send.ctx);
    }
}

bt_status_t btc_transfer_context(btc_msg_t *msg, void *arg, int arg_len,
                                 btc_arg_deep_copy_t copy_func,
                                 btc_arg_deep_free_t free_func)
{
    if (msg == NULL || ((arg == NULL) == (arg_len != 0))) {
        return BT_STATUS_PARM_INVALID;
    }
    btc_msg_t *queued = envelope_malloc(sizeof(*queued) + (size_t)arg_len);
    if (queued == NULL) {
        return BT_STATUS_NOMEM;
    }
    memcpy(queued, msg, sizeof(*queued));
    if (arg != NULL) {
        memset(queued->arg, 0, (size_t)arg_len);
        memcpy(queued->arg, arg, (size_t)arg_len);
        if (copy_func != NULL) {
            copy_func(queued, queued->arg, arg);
        }
    }

    if (failure_point == FAILURE_QUEUE_POST) {
        if (copy_func != NULL && free_func != NULL) {
            free_func(queued);
        }
        envelope_free(queued);
        return BT_STATUS_BUSY;
    }

    assert(queue_count < MAX_QUEUED_MESSAGES);
    queue[queue_count++] = (queued_message_t){
        .message = queued,
        .free_func = free_func,
    };
    return BT_STATUS_SUCCESS;
}

int btc_profile_cb_set(uint8_t pid, void *callback)
{
    (void)pid;
    (void)callback;
    return 0;
}

esp_err_t btc_ble_mesh_client_model_init(esp_ble_mesh_model_t *model)
{
    return model == NULL ? ESP_ERR_INVALID_ARG : ESP_OK;
}

static void reset_fixture(failure_point_t point)
{
    memset(allocations, 0, sizeof(allocations));
    memset(queue, 0, sizeof(queue));
    allocation_count = 0;
    mesh_allocation_attempts = 0;
    mesh_allocation_successes = 0;
    mesh_free_count = 0;
    envelope_free_count = 0;
    deep_copy_count = 0;
    handler_count = 0;
    failure_point = point;
    queue_count = 0;
}

static void assert_all_allocations_freed(void)
{
    for (size_t index = 0; index < allocation_count; index++) {
        assert(allocations[index].freed);
    }
}

static void drain_server_queue(const uint8_t *expected, size_t expected_length,
                               const esp_ble_mesh_msg_ctx_t *expected_ctx)
{
    assert(queue_count == 1U);
    btc_msg_t *message = queue[0].message;
    btc_ble_mesh_model_args_t *arg = (btc_ble_mesh_model_args_t *)message->arg;
    assert(message->act == BTC_BLE_MESH_ACT_SERVER_MODEL_SEND);
    assert(arg->model_send.data != NULL);
    assert(arg->model_send.ctx != NULL);
    assert(arg->model_send.length == expected_length);
    assert(memcmp(arg->model_send.data, expected, expected_length) == 0);
    assert(memcmp(arg->model_send.ctx, expected_ctx, sizeof(*expected_ctx)) == 0);
    handler_count++;
    btc_ble_mesh_model_arg_deep_free(message);
    envelope_free(message);
    queue_count = 0;
}

static void test_first_payload_allocation_failure_is_synchronous(void)
{
    reset_fixture(FAILURE_FIRST_PAYLOAD);
    esp_ble_mesh_model_t model = {0};
    esp_ble_mesh_msg_ctx_t context = {.net_idx = 0, .app_idx = 1, .addr = 0x0001};
    uint8_t payload[] = {0x10, 0x20};

    assert(esp_ble_mesh_server_model_send_msg(
        &model, &context, 0xc1ffffU, sizeof(payload), payload) == ESP_ERR_NO_MEM);
    assert(queue_count == 0U);
    assert(handler_count == 0U);
    assert(mesh_allocation_successes == 0U);
    assert_all_allocations_freed();
}

static void test_context_snapshot_failure_is_synchronous(void)
{
    reset_fixture(FAILURE_CONTEXT);
    esp_ble_mesh_model_t model = {0};
    esp_ble_mesh_msg_ctx_t context = {.net_idx = 0, .app_idx = 2, .addr = 0x0001};
    uint8_t payload[] = {0x30, 0x40};

    assert(esp_ble_mesh_server_model_send_msg(
        &model, &context, 0xc1ffffU, sizeof(payload), payload) == ESP_ERR_NO_MEM);
    assert(queue_count == 0U);
    assert(handler_count == 0U);
    assert(mesh_allocation_successes == 1U);
    assert(mesh_free_count == 1U);
    assert_all_allocations_freed();
}

static void test_envelope_allocation_failure_releases_both_snapshots(void)
{
    reset_fixture(FAILURE_ENVELOPE);
    esp_ble_mesh_model_t model = {0};
    esp_ble_mesh_msg_ctx_t context = {.net_idx = 0, .app_idx = 3, .addr = 0x0001};
    uint8_t payload[] = {0x50, 0x60};

    assert(esp_ble_mesh_server_model_send_msg(
        &model, &context, 0xc1ffffU, sizeof(payload), payload) != ESP_OK);
    assert(queue_count == 0U);
    assert(handler_count == 0U);
    assert(mesh_allocation_successes == 2U);
    assert(mesh_free_count == 2U);
    assert_all_allocations_freed();
}

static void test_queue_post_failure_releases_every_owner_without_handler(void)
{
    reset_fixture(FAILURE_QUEUE_POST);
    esp_ble_mesh_model_t model = {0};
    esp_ble_mesh_msg_ctx_t context = {.net_idx = 0, .app_idx = 4, .addr = 0x0001};
    uint8_t payload[] = {0x70, 0x80};

    assert(esp_ble_mesh_server_model_send_msg(
        &model, &context, 0xc1ffffU, sizeof(payload), payload) != ESP_OK);
    assert(queue_count == 0U);
    assert(handler_count == 0U);
    assert(deep_copy_count == 0U);
    assert(mesh_allocation_successes == 2U);
    assert(mesh_free_count == 2U);
    assert(envelope_free_count == 1U);
    assert_all_allocations_freed();
}

static void test_success_moves_exact_snapshots_to_delayed_handler(void)
{
    reset_fixture(FAILURE_NONE);
    esp_ble_mesh_model_t model = {0};
    esp_ble_mesh_msg_ctx_t context = {
        .net_idx = 0,
        .app_idx = 5,
        .addr = 0xc123,
        .send_ttl = 7,
        .send_cred = 1,
    };
    const esp_ble_mesh_msg_ctx_t expected_context = context;
    uint8_t payload[] = {0x90, 0xa0, 0xb0};
    uint8_t expected[6] = {0xc1, 0xff, 0xff, 0x90, 0xa0, 0xb0};

    assert(esp_ble_mesh_server_model_send_msg(
        &model, &context, 0xc1ffffU, sizeof(payload), payload) == ESP_OK);
    assert(queue_count == 1U);
    assert(handler_count == 0U);
    assert(deep_copy_count == 0U);
    assert(mesh_allocation_successes == 2U);
    assert(mesh_free_count == 0U);

    memset(payload, 0xee, sizeof(payload));
    memset(&context, 0xee, sizeof(context));
    drain_server_queue(expected, sizeof(expected), &expected_context);

    assert(handler_count == 1U);
    assert(mesh_free_count == 2U);
    assert(envelope_free_count == 1U);
    assert_all_allocations_freed();
}

static void test_client_send_keeps_existing_secondary_deep_copy(void)
{
    reset_fixture(FAILURE_NONE);
    esp_ble_mesh_model_t model = {0};
    esp_ble_mesh_msg_ctx_t context = {
        .net_idx = 0,
        .app_idx = 6,
        .addr = 0x1201,
        .send_ttl = 5,
    };
    const esp_ble_mesh_msg_ctx_t expected_context = context;
    uint8_t payload[] = {0x11, 0x22};
    uint8_t expected[] = {0x82, 0x02, 0x11, 0x22};

    assert(esp_ble_mesh_client_model_send_msg(
        &model, &context, 0x8202U, sizeof(payload), payload,
        1000, true, ROLE_PROVISIONER) == ESP_OK);
    assert(queue_count == 1U);
    assert(deep_copy_count == 1U);
    assert(mesh_allocation_successes == 3U);
    assert(mesh_free_count == 1U);

    memset(payload, 0xee, sizeof(payload));
    memset(&context, 0xee, sizeof(context));
    btc_msg_t *message = queue[0].message;
    btc_ble_mesh_model_args_t *arg = (btc_ble_mesh_model_args_t *)message->arg;
    assert(message->act == BTC_BLE_MESH_ACT_CLIENT_MODEL_SEND);
    assert(arg->model_send.data != NULL);
    assert(arg->model_send.ctx != NULL);
    assert(arg->model_send.length == sizeof(expected));
    assert(memcmp(arg->model_send.data, expected, sizeof(expected)) == 0);
    assert(memcmp(arg->model_send.ctx, &expected_context,
                  sizeof(expected_context)) == 0);
    btc_ble_mesh_model_arg_deep_free(message);
    envelope_free(message);
    queue_count = 0;

    assert(mesh_free_count == 3U);
    assert(envelope_free_count == 1U);
    assert_all_allocations_freed();
}

int main(void)
{
    test_first_payload_allocation_failure_is_synchronous();
    test_context_snapshot_failure_is_synchronous();
    test_envelope_allocation_failure_releases_both_snapshots();
    test_queue_post_failure_releases_every_owner_without_handler();
    test_success_moves_exact_snapshots_to_delayed_handler();
    test_client_send_keeps_existing_secondary_deep_copy();
    puts("ESP-IDF server-send ownership boundary tests passed");
    return 0;
}
