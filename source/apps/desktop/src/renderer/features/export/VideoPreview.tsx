import React, {useEffect, useRef, useState} from "react";
import type {TimeBounds} from "../../../../../../packages/data/src";
import type {MediaSource} from "../../../../../../packages/media/src";

export function videoTimeBounds(source: MediaSource | null): TimeBounds | null {
  if (!source || source.creationTimeSeconds === undefined || source.durationSeconds === null) return null;
  const start = Math.round(source.creationTimeSeconds * 1000);
  const end = start + source.durationSeconds * 1000;
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null;
}

export function VideoPreview({source, range, time, playing, showOverlay, onOverlayHost}: {
  source: MediaSource | null; range: TimeBounds | null; time: number | null; playing: boolean; showOverlay: boolean;
  onOverlayHost:(host:HTMLDivElement|null)=>void;
}) {
  const video=useRef<HTMLVideoElement>(null);
  const [retry, setRetry] = useState(0);
  const [failure, setFailure] = useState<{url: string; message: string} | null>(null);
  // Applying an offset replaces the file at the same path. Open a fresh media
  // resource so Chromium doesn't reuse the old stream or its failed decoder.
  const url = source ? `replay-media://preview/${encodeURIComponent(source.sourcePath)}?time=${source.creationTimeSeconds ?? ""}&retry=${retry}` : "";
  const error = failure?.url === url ? failure.message : "";
  const seconds = range && time !== null && time >= range[0] && time <= range[1] ? (time - range[0]) / 1000 : null;
  const independent = source !== null && seconds === null;
  const syncPlaying = seconds !== null && playing;
  const status = error || (independent
    ? source.creationTimeSeconds === undefined
      ? "视频缺少拍摄时间，可独立播放。"
      : "当前无法同步时间轴，可独立播放。"
    : "");
  useEffect(()=>{
    const element=video.current;
    if (!element) return;
    if (seconds === null) {
      element.pause();
      return;
    }
    const sync=()=>{
      if (!element.readyState) return;
      const target = Math.min(seconds, Math.max(0, (element.duration || Infinity) - .001));
      if (Math.abs(element.currentTime - target) > (syncPlaying ? .15 : .0005)) element.currentTime = target;
      if (syncPlaying) void element.play().catch(() => {}); else element.pause();
    };
    sync();element.addEventListener("loadedmetadata",sync);
    return()=>element.removeEventListener("loadedmetadata",sync);
  }, [seconds, syncPlaying, url]);
  return <div className="video-preview" aria-label={source ? "视频与仪表预览" : "黑底仪表预览"}>
    <div className="video-preview-frame">
      {source && <video key={url} ref={video} src={url}
        preload="auto" playsInline muted controls={independent}
        onError={event => {
          const mediaError = event.currentTarget.error;
          const message = mediaError?.code === 3 ? "视频解码失败。" :
            mediaError?.code === 4 ? "当前播放器无法读取此视频格式。" : "视频预览读取中断。";
          setFailure({url, message});
        }}/>}
      <div className="video-preview-overlay" ref={onOverlayHost} style={{visibility: showOverlay ? undefined : "hidden"}}/>
    </div>
    {status && <div className="video-preview-status" role="status">
      {status}
      {error && <button type="button" onClick={() => setRetry(value => value + 1)}>重新加载预览</button>}
    </div>}
  </div>;
}
