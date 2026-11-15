import { useEffect,useRef,useState } from "react";
import type { PointDataset } from "../../../../../../packages/data/src";
import type { MediaSource } from "../../../../../../packages/media/src";
import type { MotionGpsResult,MediaAlignmentResult } from "../../../shared/mediaAlignment";

const signed=(value:number)=>`${value>0?"+":""}${value}`;
export function MediaAlignmentPanel({source,dataset,onAligned,onProcessed}:{source:MediaSource;dataset:PointDataset|null;onAligned:(source:MediaSource)=>void;onProcessed:(result:MotionGpsResult)=>void}) {
  const [offset,setOffset]=useState("0");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [result,setResult]=useState<MediaAlignmentResult|null>(null);
  const [gpsResult,setGpsResult]=useState<MotionGpsResult|null>(null);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const processGps=async (media=source)=>{
    if(!window.replaymod||!dataset)return;
    const start=media.creationTimeSeconds;
    if(start===undefined)throw new Error("请先对齐视频拍摄时间。");
    const points=[];
    for(let i=0;i<dataset.footprintTimestamps.length;i++){
      const timeSeconds=dataset.footprintTimestamps[i]/1000;
      if(timeSeconds<start-25||timeSeconds>start+(media.durationSeconds??0)+25)continue;
      points.push({timeSeconds,longitude:dataset.footprintCoordinates[i*2],latitude:dataset.footprintCoordinates[i*2+1]});
    }
    const result=await window.replaymod.processMediaGps({sourcePath:media.sourcePath,points});
    if(mounted.current){setGpsResult(result);onProcessed(result);}
  };
  const optimize=async()=>{
    if(busy)return;setBusy(true);setError("");
    try{await processGps();}catch(e){if(mounted.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(mounted.current)setBusy(false);}
  };
  const value=Number(offset);
  const valid=offset.trim()!==""&&Number.isSafeInteger(value)&&Math.abs(value)<=86400;
  const align=async()=>{
    if(!window.replaymod||!valid||busy)return;
    setBusy(true);setError("");setResult(null);
    try {
      const points=[];
      if(dataset) {
        const base=source.creationTimeSeconds;
        const start=base===undefined?-Infinity:base+value-25;
        const end=base===undefined?Infinity:base+value+(source.durationSeconds??0)+25;
        for(let i=0;i<dataset.footprintTimestamps.length;i++) {
          const timeSeconds=dataset.footprintTimestamps[i]/1000;
          if(timeSeconds<start||timeSeconds>end)continue;
          points.push({timeSeconds,longitude:dataset.footprintCoordinates[i*2],latitude:dataset.footprintCoordinates[i*2+1]});
        }
      }
      const saved=await window.replaymod.alignMediaTime({sourcePath:source.sourcePath,offsetSeconds:value,points});
      if(!mounted.current)return;
      onAligned(saved.source);setResult(saved);setOffset("0");
      if(dataset)await processGps(saved.source);
    } catch(e) {setError(e instanceof Error?e.message:String(e));}
    finally {setBusy(false);}
  };
  return <section className="media-alignment" aria-label="视频时间对齐">
    <h3 className="section-label">时间对齐</h3>
    {source.creationTimeSeconds!==undefined&&<p className="alignment-hint">当前拍摄时间：{new Date(source.creationTimeSeconds*1000).toLocaleString("zh-CN",{hour12:false})}</p>}
    <form onSubmit={e=>{e.preventDefault();void align();}}>
      <label htmlFor="media-time-offset">时间偏移（秒）</label>
      <div className="alignment-controls">
        <input id="media-time-offset" type="number" step="1" min="-86400" max="86400" value={offset} disabled={busy}
          onChange={e=>setOffset(e.target.value)} aria-describedby="media-time-offset-help" />
        <button type="submit" disabled={busy||!valid||!window.replaymod}>{busy?"正在对齐…":"对齐并微调"}</button>
      </div>
      <p className="alignment-hint" id="media-time-offset-help">相对当前拍摄时间：+ 推后，− 提前。例如快了 30 秒，输入 −30。</p>
      <p className="alignment-hint">在输入值附近自动微调，结果直接写回视频；写入前保留原文件备份。</p>
      {!dataset&&<p className="alignment-hint">载入 GPS 轨迹后可自动微调；当前会应用输入偏移。</p>}
    </form>
    <button type="button" disabled={busy||!dataset||!window.replaymod} onClick={()=>void optimize()}>{busy?"正在处理…":"优化 GPS 与插值"}</button>
    {gpsResult&&<p role="status">后台轨迹已应用：{gpsResult.points.length} 点，修正 {gpsResult.correctedPoints} 个跳点，姿态辅助 {gpsResult.curvedIntervals} 段。{gpsResult.reason} 原始 CSV 不变。</p>}
    {result&&<div className="alignment-result" role="status">
      <strong>已将视频时间调整 {signed(result.offsetSeconds)} 秒</strong>
      <p>{result.refined?`自动微调 ${signed(result.adjustmentSeconds)} 秒。`:""}{result.reason}</p>
      <p>{result.timecodeUpdated?"拍摄时间与时间码轨已更新。":"拍摄时间已更新；此视频没有时间码轨。"}</p>
      <details><summary>原视频备份</summary><span className="alignment-backup">{result.backupPath}</span></details>
    </div>}
    {error&&<p className="data-error" role="alert">{error}</p>}
  </section>;
}
