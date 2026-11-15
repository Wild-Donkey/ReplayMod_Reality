import React, {useEffect, useRef, useState} from "react";
import type {MediaSource} from "../../../../../../packages/media/src";

export function VideoPreview({source,time,playing,onOverlayHost}: {
  source:MediaSource|null;time:number|null;playing:boolean;
  onOverlayHost:(host:HTMLDivElement|null)=>void;
}) {
  const video=useRef<HTMLVideoElement>(null);
  const [error,setError]=useState("");
  const start=source?.creationTimeSeconds;
  const seconds=time!==null && start!==undefined ? (time/1000-start) : 0;
  const outside=seconds<0 || (source?.durationSeconds!==null && source?.durationSeconds!==undefined && seconds>=source.durationSeconds);
  useEffect(()=>{setError("");},[source?.sourcePath]);
  useEffect(()=>{
    const element=video.current;
    if(!element)return;
    const sync=()=>{
      if(outside){element.pause();return;}
      if(Math.abs(element.currentTime-seconds)>.15)element.currentTime=Math.max(0,seconds);
      if(playing)void element.play().catch(()=>{});else element.pause();
    };
    sync();element.addEventListener("loadedmetadata",sync);
    return()=>element.removeEventListener("loadedmetadata",sync);
  },[seconds,playing,outside,source?.sourcePath]);
  return <div className="video-preview" aria-label={source ? "视频与仪表预览" : "黑底仪表预览"}>
    <div className="video-preview-frame">
      {source && <video ref={video} src={`replay-media://preview/${encodeURIComponent(source.sourcePath)}`}
        preload="auto" playsInline muted style={{visibility:outside?"hidden":"visible"}}
        onError={()=>setError("当前视频无法预览，请检查文件或编码格式。")}/>}
      <div className="video-preview-overlay" ref={onOverlayHost}/>
    </div>
    {error && <p className="video-preview-error" role="status">{error}</p>}
  </div>;
}
