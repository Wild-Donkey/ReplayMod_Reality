#import <AppKit/AppKit.h>
#include <node_api.h>

static napi_ref callback_ref = nullptr;
static id event_monitor = nil;

static napi_value stop(napi_env env, napi_callback_info info) {
  if (event_monitor) {
    [NSEvent removeMonitor:event_monitor];
    event_monitor = nil;
  }
  if (callback_ref) {
    napi_delete_reference(env, callback_ref);
    callback_ref = nullptr;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "start requires a callback");
    return nullptr;
  }

  if (event_monitor) [NSEvent removeMonitor:event_monitor];
  if (callback_ref) napi_delete_reference(env, callback_ref);
  napi_create_reference(env, argv[0], 1, &callback_ref);

  event_monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
    handler:^NSEvent *(NSEvent *event) {
      napi_handle_scope scope;
      if (napi_open_handle_scope(env, &scope) != napi_ok) return event;
      napi_value callback;
      napi_value global;
      napi_value payload;
      napi_value value;
      napi_get_reference_value(env, callback_ref, &callback);
      napi_get_global(env, &global);
      napi_create_object(env, &payload);
      napi_create_int64(env, (int64_t)event.phase, &value);
      napi_set_named_property(env, payload, "phase", value);
      napi_create_int64(env, (int64_t)event.momentumPhase, &value);
      napi_set_named_property(env, payload, "momentumPhase", value);
      napi_create_double(env, event.scrollingDeltaX, &value);
      napi_set_named_property(env, payload, "deltaX", value);
      napi_create_double(env, event.scrollingDeltaY, &value);
      napi_set_named_property(env, payload, "deltaY", value);
      napi_get_boolean(env, event.hasPreciseScrollingDeltas, &value);
      napi_set_named_property(env, payload, "precise", value);
      napi_value ignored;
      napi_call_function(env, global, callback, 1, &payload, &ignored);
      napi_close_handle_scope(env, scope);
      return event;
    }];

  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr },
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

