#define COBJMACROS
#include <windows.h>
#include <dxgi1_6.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

// This request is newer than the DisplayConfig definitions in some MinGW SDKs.
enum { get_advanced_color_info_2 = 15, high_dynamic_range_supported = 1 << 4 };
typedef struct {
  DISPLAYCONFIG_DEVICE_INFO_HEADER header;
  UINT32 flags, encoding, bits_per_channel, active_mode;
} AdvancedColorInfo2;

static double read_target(const wchar_t *device, int hdr, int *supported) {
  for (int attempt = 0; attempt < 3; ++attempt) {
    UINT32 path_count, mode_count;
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &path_count, &mode_count)) break;
    if (!path_count || !mode_count) break;
    DISPLAYCONFIG_PATH_INFO *paths = calloc(path_count, sizeof(*paths));
    DISPLAYCONFIG_MODE_INFO *modes = calloc(mode_count, sizeof(*modes));
    LONG result = paths && modes ? QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &path_count, paths, &mode_count, modes, NULL) : ERROR_OUTOFMEMORY;
    double white = 0;
    if (!result) for (UINT32 i = 0; i < path_count; ++i) {
      DISPLAYCONFIG_PATH_TARGET_INFO target = paths[i].targetInfo;
      DISPLAYCONFIG_PATH_SOURCE_INFO source = paths[i].sourceInfo;
      DISPLAYCONFIG_SOURCE_DEVICE_NAME name = {{DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, sizeof(name), source.adapterId, source.id}};
      if (DisplayConfigGetDeviceInfo(&name.header) || _wcsicmp(name.viewGdiDeviceName, device)) continue;
      AdvancedColorInfo2 color = {{get_advanced_color_info_2, sizeof(color), target.adapterId, target.id}};
      if (!DisplayConfigGetDeviceInfo(&color.header)) {
        if (!(color.flags & high_dynamic_range_supported)) *supported = 0;
        else if (*supported < 0) *supported = 1;
      }
      if (!hdr) continue;
      DISPLAYCONFIG_SDR_WHITE_LEVEL level = {{DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, sizeof(level), target.adapterId, target.id}};
      if (!DisplayConfigGetDeviceInfo(&level.header) && level.SDRWhiteLevel) {
        double value = level.SDRWhiteLevel * 0.08;
        if (value > white) white = value;
      }
    }
    free(paths);
    free(modes);
    if (result != ERROR_INSUFFICIENT_BUFFER) return white;
  }
  return 0;
}

int main(int argc, char **argv) {
  HWND window = argc > 1 ? (HWND)(uintptr_t)strtoull(argv[1], NULL, 16) : NULL;
  if (argc > 1 && !IsWindow(window)) return 1;
  HMONITOR monitor = MonitorFromWindow(window, MONITOR_DEFAULTTOPRIMARY);
  IDXGIFactory1 *factory = NULL;
  if (FAILED(CreateDXGIFactory1(&IID_IDXGIFactory1, (void **)&factory))) return 1;
  IDXGIAdapter1 *adapter;
  DXGI_OUTPUT_DESC1 display;
  int found = 0;
  for (UINT a = 0; !found && IDXGIFactory1_EnumAdapters1(factory, a, &adapter) == S_OK; ++a) {
    IDXGIOutput *output;
    for (UINT o = 0; !found && IDXGIAdapter1_EnumOutputs(adapter, o, &output) == S_OK; ++o) {
      IDXGIOutput6 *advanced = NULL;
      if (SUCCEEDED(IDXGIOutput_QueryInterface(output, &IID_IDXGIOutput6, (void **)&advanced))) {
        found = SUCCEEDED(IDXGIOutput6_GetDesc1(advanced, &display)) && display.Monitor == monitor;
        IDXGIOutput6_Release(advanced);
      }
      IDXGIOutput_Release(output);
    }
    IDXGIAdapter1_Release(adapter);
  }
  IDXGIFactory1_Release(factory);
  if (!found) return 1;
  int hdr = display.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
  int supported = -1;
  double white = read_target(display.DeviceName, hdr, &supported);
  if (hdr) supported = 1;
  double headroom = 1;
  if (hdr && white > 0 && isfinite(display.MaxLuminance) && display.MaxLuminance > white) {
    headroom = display.MaxLuminance / white;
  }
  printf("{\"currentHeadroom\":%.4f,\"hdrActive\":%s,\"hdrSupported\":%s}\n",
         headroom, hdr ? "true" : "false", supported < 0 ? "null" : supported ? "true" : "false");
  return 0;
}
