#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <commctrl.h>
#include <initguid.h>
#include <directmanipulation.h>
#include <wrl/client.h>
#include <cmath>
#include <cstring>

using Microsoft::WRL::ComPtr;

// Node-API entry points are exported by the running Electron executable.
// Resolve the stable ABI from the host so a renamed packaged executable works too.
using napi_env = struct napi_env__*;
using napi_value = struct napi_value__*;
using napi_callback_info = struct napi_callback_info__*;
using napi_callback = napi_value (*)(napi_env, napi_callback_info);
static int (*get_args)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
static int (*get_buffer)(napi_env, napi_value, void**, size_t*);

struct ScrollFrame {
  HWND window;
  double capture, dx, dy, zoom, x, y, attached;
};
static_assert(sizeof(ScrollFrame) == 64);

class Touchpad {
 public:
  void Attach(HWND parent);
  void Detach();
  void Poll(ScrollFrame& frame);

 private:
  static LRESULT CALLBACK WindowProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);
  bool Begin(UINT32 pointer);
  void Reset(bool force = false);

  HWND child_ = nullptr;
  ComPtr<IDirectManipulationManager> manager_;
  ComPtr<IDirectManipulationUpdateManager> update_;
  ComPtr<IDirectManipulationViewport> viewport_;
  ComPtr<IDirectManipulationContent> content_;
  RECT rect_{};
  POINT anchor_{};
  float dpi_ = 1, previous_scale_ = 1, previous_x_ = 0, previous_y_ = 0;
  bool activated_ = false, destroyed_ = false, capture_ = false, active_ = false;
  bool moved_ = false, pinch_ = false;
  ULONGLONG next_attach_attempt_ = 0;
};

static Touchpad touchpad;
static constexpr UINT_PTR kSubclass = 1;

void Touchpad::Attach(HWND parent) {
  HWND child = FindWindowExW(parent, nullptr, L"Chrome_RenderWidgetHostHWND", nullptr);
  if (!child || child == child_) return;
  Detach();
  child_ = child;
  if (FAILED(CoCreateInstance(CLSID_DirectManipulationManager, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&manager_))) ||
      FAILED(manager_->GetUpdateManager(IID_PPV_ARGS(&update_))) ||
      FAILED(manager_->CreateViewport(nullptr, child_, IID_PPV_ARGS(&viewport_)))) {
    Detach();
    return;
  }

  // Enable both translation axes without Windows Direct Manipulation rails.
  const auto configuration = static_cast<DIRECTMANIPULATION_CONFIGURATION>(
    DIRECTMANIPULATION_CONFIGURATION_INTERACTION | DIRECTMANIPULATION_CONFIGURATION_TRANSLATION_X |
    DIRECTMANIPULATION_CONFIGURATION_TRANSLATION_Y | DIRECTMANIPULATION_CONFIGURATION_TRANSLATION_INERTIA |
    DIRECTMANIPULATION_CONFIGURATION_SCALING);
  GetClientRect(child_, &rect_);
  if (FAILED(viewport_->ActivateConfiguration(configuration)) ||
      FAILED(viewport_->SetViewportOptions(DIRECTMANIPULATION_VIEWPORT_OPTIONS_MANUALUPDATE)) ||
      FAILED(viewport_->SetViewportRect(&rect_)) ||
      FAILED(viewport_->GetPrimaryContent(IID_PPV_ARGS(&content_))) ||
      FAILED(manager_->Activate(child_))) {
    Detach();
    return;
  }
  activated_ = true;
  if (FAILED(viewport_->Enable()) || !SetWindowSubclass(child_, WindowProc, kSubclass, reinterpret_cast<DWORD_PTR>(this))) {
    Detach();
  }
}

void Touchpad::Detach() {
  const HWND child = child_;
  child_ = nullptr;
  capture_ = active_ = moved_ = pinch_ = false;
  previous_scale_ = 1;
  previous_x_ = previous_y_ = 0;
  if (child && !destroyed_) RemoveWindowSubclass(child, WindowProc, kSubclass);
  if (viewport_) viewport_->Abandon();
  if (activated_ && !destroyed_ && IsWindow(child)) manager_->Deactivate(child);
  activated_ = destroyed_ = false;
  content_.Reset();
  viewport_.Reset();
  update_.Reset();
  manager_.Reset();
}

bool Touchpad::Begin(UINT32 pointer) {
  POINTER_INPUT_TYPE type;
  if (!GetPointerType(pointer, &type) || type != PT_TOUCHPAD) return false;
  RECT rect{};
  if (GetClientRect(child_, &rect) && !EqualRect(&rect_, &rect)) {
    viewport_->Stop();
    if (SUCCEEDED(viewport_->SetViewportRect(&rect))) {
      rect_ = rect;
      Reset(true);
    }
  }
  if (viewport_->SetContact(pointer) != S_OK) return false;
  GetCursorPos(&anchor_);
  ScreenToClient(GetParent(child_), &anchor_);
  dpi_ = GetDpiForWindow(child_) / 96.0f;
  if (dpi_ <= 0) dpi_ = 1;
  active_ = true;
  return true;
}

LRESULT CALLBACK Touchpad::WindowProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam, UINT_PTR, DWORD_PTR data) {
  auto& input = *reinterpret_cast<Touchpad*>(data);
  if (message == DM_POINTERHITTEST && input.capture_ && input.Begin(GET_POINTERID_WPARAM(wparam))) return 0;
  if (message == WM_NCDESTROY) {
    input.destroyed_ = true;
    RemoveWindowSubclass(hwnd, WindowProc, kSubclass);
  }
  return DefSubclassProc(hwnd, message, wparam, lparam);
}

void Touchpad::Reset(bool force) {
  if (force || previous_scale_ != 1 || previous_x_ || previous_y_) {
    viewport_->ZoomToRect(0, 0, static_cast<float>(rect_.right), static_cast<float>(rect_.bottom), FALSE);
    update_->Update(nullptr);
  }
  active_ = moved_ = pinch_ = false;
  previous_scale_ = 1;
  previous_x_ = previous_y_ = 0;
}

void Touchpad::Poll(ScrollFrame& frame) {
  if (child_ && (destroyed_ || !IsWindow(child_))) Detach();
  if (!frame.capture && capture_ && active_) {
    viewport_->Stop();
    Reset(true);
  }
  capture_ = frame.capture != 0;
  const auto now = GetTickCount64();
  if (capture_ && !child_ && now >= next_attach_attempt_) {
    Attach(frame.window);
    capture_ = frame.capture != 0;
    next_attach_attempt_ = now + 250;
  }
  frame.attached = child_ != nullptr;
  if (!active_ || FAILED(update_->Update(nullptr))) return;
  DIRECTMANIPULATION_STATUS status{};
  float matrix[6]{};
  if (FAILED(viewport_->GetStatus(&status)) || FAILED(content_->GetContentTransform(matrix, 6)) || matrix[0] <= 0) return;
  const float scale = matrix[0], x = matrix[4], y = matrix[5];
  if (std::abs(scale - 1) > 0.00001f) pinch_ = true;
  if (pinch_) {
    frame.zoom = std::log2(scale / previous_scale_);
    frame.x = anchor_.x / dpi_;
    frame.y = anchor_.y / dpi_;
  } else {
    frame.dx = (previous_x_ - x) / dpi_;
    frame.dy = (previous_y_ - y) / dpi_;
  }
  previous_scale_ = scale;
  previous_x_ = x;
  previous_y_ = y;
  const bool running = status == DIRECTMANIPULATION_RUNNING || status == DIRECTMANIPULATION_INERTIA;
  if (running) moved_ = true;
  else if (moved_ || scale != 1 || x || y) Reset();
}

static napi_value poll(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0;
  napi_value arg;
  void* buffer;
  if (get_args(env, info, &argc, &arg, nullptr, nullptr) || argc != 1 ||
      get_buffer(env, arg, &buffer, &length) || length != sizeof(ScrollFrame)) return nullptr;
  ScrollFrame frame{};
  std::memcpy(&frame, buffer, sizeof(frame));
  frame.dx = frame.dy = frame.zoom = frame.x = frame.y = frame.attached = 0;
  touchpad.Poll(frame);
  std::memcpy(buffer, &frame, sizeof(frame));
  return nullptr;
}

static napi_value stop(napi_env, napi_callback_info) {
  touchpad.Detach();
  return nullptr;
}

extern "C" __declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  auto host = GetModuleHandleW(nullptr);
  get_args = reinterpret_cast<decltype(get_args)>(GetProcAddress(host, "napi_get_cb_info"));
  get_buffer = reinterpret_cast<decltype(get_buffer)>(GetProcAddress(host, "napi_get_buffer_info"));
  using CreateFunction = int (*)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
  using SetProperty = int (*)(napi_env, napi_value, const char*, napi_value);
  auto create = reinterpret_cast<CreateFunction>(GetProcAddress(host, "napi_create_function"));
  auto set = reinterpret_cast<SetProperty>(GetProcAddress(host, "napi_set_named_property"));
  if (!get_args || !get_buffer || !create || !set) return nullptr;
  napi_value value;
  if (create(env, "poll", 4, poll, nullptr, &value) || set(env, exports, "poll", value) ||
      create(env, "stop", 4, stop, nullptr, &value) || set(env, exports, "stop", value)) return nullptr;
  return exports;
}
