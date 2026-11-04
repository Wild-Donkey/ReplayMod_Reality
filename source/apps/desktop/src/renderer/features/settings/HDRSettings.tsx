import { useHDRState, setHDREnabled } from "../../shared/displayHDR";

export function HDRSettings() {
  const hdr = useHDRState();
  return <>
            <h3>显示</h3>
            <label className="settings-row" htmlFor="settings-hdr">
              <span>HDR 高动态范围</span>
              <input id="settings-hdr" type="checkbox" role="switch" checked={hdr.active}
                disabled={hdr.supported !== true} aria-describedby="settings-hdr-status"
                onChange={event => setHDREnabled(event.target.checked)}/>
            </label>
            <p id="settings-hdr-status">{hdr.supported === null ? "正在检测屏幕 HDR 能力…" : hdr.supported ? `${hdr.label || "当前屏幕"} · 支持 HDR${hdr.enabled ? " · 已开启" : " · 已关闭"}` : "当前屏幕或显示环境不支持 HDR，开关不可用。"}</p>
  </>;
}
