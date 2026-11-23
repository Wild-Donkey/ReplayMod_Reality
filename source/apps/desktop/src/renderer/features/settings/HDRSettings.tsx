import { useHDRState, setHDREnabled } from "../../shared/displayHDR";

export function HDRSettings() {
  const hdr = useHDRState();
  const screen = hdr.label || "当前屏幕";
  const status = hdr.supported === null ? "正在检测屏幕 HDR 能力…"
    : !hdr.supported ? "当前屏幕或显示环境不支持 HDR，开关不可用。"
    : hdr.systemActive === false ? `${screen}支持 HDR。请在 Windows 的「设置 → 系统 → 显示」中开启「使用 HDR」。`
    : `${screen} · 支持 HDR${hdr.enabled ? " · 已开启" : " · 已关闭"}`;
  return <>
            <h3>显示</h3>
            <label className="settings-row" htmlFor="settings-hdr">
              <span>HDR 高动态范围</span>
              <input id="settings-hdr" type="checkbox" role="switch" checked={hdr.active}
                disabled={hdr.supported !== true || hdr.systemActive === false} aria-describedby="settings-hdr-status"
                onChange={event => setHDREnabled(event.target.checked)}/>
            </label>
            <p id="settings-hdr-status">{status}</p>
  </>;
}
