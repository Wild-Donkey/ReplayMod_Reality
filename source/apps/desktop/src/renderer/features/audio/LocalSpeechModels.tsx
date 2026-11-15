import {speechDownloadCatalog} from "../../../shared/speechCatalog";
import {useEffect,useState} from "react";
import type {LocalSpeechStatus,SpeechModelRole} from "../../../shared/localSpeech";
const bundledCatalog=speechDownloadCatalog();
const restartMessage="当前应用主进程仍是旧版本，请完整退出应用后重新打开，再刷新本地模型。模型列表和手动下载说明仍可使用。";
function statusError(error:unknown){const text=error instanceof Error?error.message:String(error);return /No handler registered|is not a function|旧版本/.test(text)?restartMessage:`无法读取本地模型状态：${text}。可刷新重试；手动下载说明仍可使用。`;}
async function readStatus(){
  if(typeof window.replaymod?.getLocalSpeechStatus!=="function")throw new Error(restartMessage);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([window.replaymod.getLocalSpeechStatus(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("读取超时，请刷新或重启应用")),8000);})]);}finally{clearTimeout(timer);}
}
export function LocalSpeechModels({disabled=false,onReady,onInstalling}:{disabled?:boolean;onReady?:(ready:boolean)=>void;onInstalling?:(busy:boolean)=>void}) {
  const [status,setStatus]=useState<LocalSpeechStatus|null>(null),[message,setMessage]=useState("正在检查本地模型…"),[busy,setBusy]=useState(false),[downloadId,setDownloadId]=useState(bundledCatalog[0]?.id??"");
  const apply=(value:LocalSpeechStatus)=>{if(!value||!Array.isArray(value.installed)||!value.selected||!value.modelDirectory)throw new Error(restartMessage);setStatus(value);setMessage(value.message);onReady?.(value.ready);setDownloadId(id=>value.catalog?.some(m=>m.id===id)?id:value.catalog?.[0]?.id??bundledCatalog[0]?.id??"");};
  const publish=(value:LocalSpeechStatus)=>{apply(value);window.dispatchEvent(new CustomEvent("local-speech-ready",{detail:value}));};
  const task=async(action:()=>Promise<void>)=>{setBusy(true);onInstalling?.(true);try{await action();}catch(e){setMessage(/No handler registered|is not a function/.test(String(e))?restartMessage:e instanceof Error?e.message:String(e));}finally{setBusy(false);onInstalling?.(false);}};
  useEffect(()=>{
    let active=true;
    void readStatus().then(value=>{if(active)apply(value);}).catch(e=>{if(active)setMessage(statusError(e));});
    const unsubscribe=window.replaymod?.onLocalSpeechProgress?.(update=>{if(active&&!update.sourcePath)setMessage(update.message);});
    const changed=(event:Event)=>{if(active)apply((event as CustomEvent<LocalSpeechStatus>).detail);};window.addEventListener("local-speech-ready",changed);
    return()=>{active=false;unsubscribe?.();window.removeEventListener("local-speech-ready",changed);};
  },[]);
  const catalog=status?.catalog?.length?status.catalog:bundledCatalog;
  const locked=disabled||busy,download=catalog.find(m=>m.id===downloadId);
  const select=(role:SpeechModelRole,id:string)=>void task(async()=>publish(await window.replaymod!.selectSpeechModel(role,id)));
  return <details className="local-speech-models" open>
    <summary>本地语音模型 · {status?.ready?"已就绪":"请选择模型"}</summary>
    <p>ASR 识别文字，对齐模型标记词/字时间。应用不附带模型；选择后在本机离线运行。</p>
    {(["asr","aligner"] as const).map(role=><label key={role}>{role==="asr"?"语音识别模型":"词 / 字对齐模型"}
      <select aria-label={role==="asr"?"语音识别模型":"词 / 字对齐模型"} disabled={locked||!status} value={status?.selected[role]??""} onChange={e=>select(role,e.target.value)}>
        <option value="">未选择</option>
        {status?.selected[role]&&!status.installed.some(m=>m.id===status.selected[role])&&<option value={status.selected[role]}>所选模型已移动或不完整</option>}
        {status?.installed.filter(m=>m.role===role).map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
    </label>)}
    <p className="local-model-status" role="status">{message}</p>
    <div className="local-model-actions">
      <button disabled={locked} onClick={()=>void task(async()=>publish(await readStatus()))}>刷新本地模型</button>
      <button disabled={locked||!status} onClick={()=>void task(async()=>{await window.replaymod!.openSpeechModelDirectory();})}>打开模型目录</button>
      <button disabled={locked||!status} onClick={()=>void task(async()=>{const value=await window.replaymod!.addSpeechModelFolder();if(value)publish(value);})}>添加已有模型文件夹</button>
    </div>
    <details className="local-model-download"><summary>下载模型 / 手动下载说明</summary>
      <label>可下载模型<select aria-label="可下载模型" disabled={locked} value={downloadId} onChange={e=>setDownloadId(e.target.value)}>{catalog.map(m=><option key={m.id} value={m.id}>{m.label} · {(m.bytes/1e9).toFixed(2)} GB</option>)}</select></label>
      <button disabled={locked||!download||!status?.supported} onClick={()=>void task(async()=>{publish(await window.replaymod!.downloadSpeechModel(downloadId));setMessage("下载完成，请在上方下拉框选择模型。");})}>{busy?"正在处理…":"下载所选模型"}</button>
      {download&&<>
        <p>来源：<a href={download.source} target="_blank" rel="noreferrer">{download.source}</a>（Qwen 原模型的 MLX Community 转换版）。</p>
        <p>固定版本：<code>{download.revision}</code></p>
        <p>{status?"存放目录":"手动下载目录（可自行修改）"}：<code>{download.directory}</code></p>
        <p>可从<a href={`${download.source}/tree/${download.revision}`} target="_blank" rel="noreferrer">此版本的文件列表</a>手动下载整个模型文件夹，或使用：</p>
        <pre><code>{`hf download mlx-community/${download.id} --revision ${download.revision} --local-dir "${download.directory}"`}</code></pre>
        <p>保留 config、tokenizer、预处理配置和完整 .safetensors 权重。放好后刷新即可选择；也可直接添加其他位置的兼容 MLX 模型文件夹。原始 PyTorch 权重不能直接使用。内置下载只传输文件、校验完整性，支持断点续传。</p>
      </>}
    </details>
    <p>模型根目录：<code>{status?.modelDirectory??"尚未连接本地模型服务；可先下载到任意文件夹，重启应用后添加该文件夹。"}</code></p>
    {!!status?.issues.length&&<details><summary>未能识别的文件夹（{status.issues.length}）</summary>{status.issues.map(issue=><p key={issue}>{issue}</p>)}</details>}
  </details>;
}
