import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {assertCanStartChild,runChild,stopChild,trackChild} from "./childProcesses";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import type {TimedTextCue} from "./types";
export interface LocalTranscript {sentences:TimedTextCue[];words:TimedTextCue[];elapsedSeconds?:number;peakMemoryBytes?:number}
export interface LocalSpeechProgress {stage:"loading"|"asr"|"align";done:number;total:number}
export interface LocalQwenPaths {runtime:string;worker:string;python:string;asr?:string;aligner?:string;pythonPath?:string}
interface Pending {resolve:(value:LocalTranscript)=>void;reject:(error:Error)=>void;progress?:(value:LocalSpeechProgress)=>void;duration:number;timer:ReturnType<typeof setTimeout>}
export function validateLocalTranscript(value:unknown,duration:number):LocalTranscript {
  if(!value || typeof value!=="object")throw new Error("本地模型返回无效结果。");
  const doc=value as LocalTranscript;
  const check=(cues:TimedTextCue[])=>{
    if(!Array.isArray(cues)||cues.length>100000)throw new Error("本地模型时间戳格式无效。");
    return cues.map(c=>{
      if(typeof c.text!=="string"||!Number.isFinite(c.startTimeSeconds)||!Number.isFinite(c.endTimeSeconds)||c.startTimeSeconds<0||c.startTimeSeconds>=duration||c.endTimeSeconds<=c.startTimeSeconds||c.endTimeSeconds>duration+.05)throw new Error("本地模型返回了超出音轨的时间戳。");
      return {...c,endTimeSeconds:Math.min(duration,c.endTimeSeconds)};
    }).sort((a,b)=>a.startTimeSeconds-b.startTimeSeconds);
  };
  const sentences=check(doc.sentences),words=check(doc.words);
  if(sentences.length&&!words.length)throw new Error("识别到文字，但 ForcedAligner 没有返回有效时间戳。");
  return {sentences,words,elapsedSeconds:doc.elapsedSeconds,peakMemoryBytes:doc.peakMemoryBytes};
}
/** One serialized offline worker keeps both models warm; idle shutdown returns GPU memory. */
export class LocalQwen {
  private child?:ChildProcessWithoutNullStreams;
  private conversion?:ReturnType<typeof runChild>["child"];
  private closed=false;
  private closing?:Promise<void>;
  private ready?:Promise<void>;
  private pending=new Map<number,Pending>();
  private sequence=0;
  private tail:Promise<unknown>=Promise.resolve();
  private count=0;
  private idle?:ReturnType<typeof setTimeout>;
  private stderr="";
  constructor(private readonly paths:LocalQwenPaths){}
  private start() {
    if(this.child && this.ready)return this.ready;
    assertCanStartChild();
    const child=trackChild(spawn(this.paths.python,[this.paths.worker,"--serve",this.paths.runtime,this.paths.asr??path.join(this.paths.runtime,"models/asr"),this.paths.aligner??path.join(this.paths.runtime,"models/aligner")],{stdio:["pipe","pipe","pipe"],env:{...process.env,...(this.paths.pythonPath?{PYTHONPATH:this.paths.pythonPath}:{}),PYTHONUNBUFFERED:"1",HF_HOME:path.join(this.paths.runtime,"huggingface"),HF_HUB_OFFLINE:"1",TRANSFORMERS_OFFLINE:"1",HF_HUB_DISABLE_TELEMETRY:"1"}}));
    this.child=child;this.stderr="";let buffer="";child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
    this.ready=new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>{reject(new Error("本地 Qwen 启动超时。"));if(this.child===child)void this.stopWorker();},90000);
      const fail=(error:Error)=>{clearTimeout(timeout);reject(error);};
      const stopped=(error:Error)=>{
        fail(error);
        if(this.child===child){for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();this.child=undefined;this.ready=undefined;}
      };
      child.once("error",stopped);
      child.once("exit",()=>stopped(new Error(`本地 Qwen 进程已退出。请检查本地模型环境后重试。${this.stderr.trim().split("\n").at(-1)?.slice(0,300)??""}`)));
      child.stdin.on("error",error=>{
        fail(error);
        if(this.child===child)void this.stopWorker();
      });
      child.stderr.on("data",data=>{this.stderr=(this.stderr+String(data)).slice(-8000);});
      child.stdout.on("data",data=>{
        buffer+=String(data);
        if(buffer.length>16*1024*1024){fail(new Error("本地模型输出过大。"));if(this.child===child)void this.stopWorker();return;}
        let end:number;
        while((end=buffer.indexOf("\n"))>=0){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let message;
          try {message=JSON.parse(line);}catch {continue;}
          if(message.type==="ready"){clearTimeout(timeout);resolve();continue;}
          const item=this.pending.get(message.id);if(!item)continue;
          if(message.type==="progress"){item.progress?.({stage:message.stage,done:message.done,total:message.total});continue;}
          clearTimeout(item.timer);this.pending.delete(message.id);
          try {if(message.type==="error")throw new Error(`本地 Qwen 识别失败：${String(message.message).slice(0,500)}`);item.resolve(validateLocalTranscript(message,item.duration));}catch(error){item.reject(error instanceof Error?error:new Error(String(error)));}
        }
      });
    });
    return this.ready;
  }
  transcribe(input:string,duration:number,progress?:(value:LocalSpeechProgress)=>void,ffmpeg="ffmpeg"):Promise<LocalTranscript> {
    if(this.closed)return Promise.reject(new Error("本地识别进程已结束。"));
    if(!Number.isFinite(duration)||duration<=0)return Promise.reject(new Error("音轨时长无效。"));
    if(this.count>=8)return Promise.reject(new Error("本地识别队列已满，请稍候。"));
    this.count++;clearTimeout(this.idle);
    const job=this.tail.catch(()=>{}).then(()=>this.execute(input,duration,progress,ffmpeg));
    this.tail=job;
    return job.finally(()=>{this.count--;if(!this.count&&!this.closed){this.idle=setTimeout(()=>{void this.stopWorker();},180000);this.idle.unref();}});
  }
  private async execute(input:string,duration:number,progress:((value:LocalSpeechProgress)=>void)|undefined,ffmpeg:string) {
    if(this.closed)throw new Error("本地识别进程已结束。");
    const temporary=await mkdtemp(path.join(tmpdir(),"replay-local-qwen-"));
    try {
      if(this.closed)throw new Error("本地识别进程已结束。");
      const audio=path.join(temporary,"audio.wav");
      progress?.({stage:"loading",done:0,total:1});
      const conversion=runChild(ffmpeg,["-v","error","-nostdin","-y","-i",input,"-vn","-ac","1","-ar","16000","-c:a","pcm_s16le",audio],{maxBuffer:4*1024*1024});
      this.conversion=conversion.child;
      try {await conversion;}
      finally {this.conversion=undefined;}
      if(this.closed)throw new Error("本地识别进程已结束。");
      await this.start();
      if(this.closed||!this.child)throw new Error("本地识别进程已结束。");
      return await new Promise<LocalTranscript>((resolve,reject)=>{
        const id=++this.sequence;
        const timer=setTimeout(()=>{reject(new Error("本地识别超时，请分段处理更短的素材。"));void this.stopWorker();},60*60*1000);
        this.pending.set(id,{resolve,reject,progress,duration,timer});
        this.child!.stdin.write(JSON.stringify({id,audio})+"\n",error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
      });
    } finally {await rm(temporary,{recursive:true,force:true});}
  }
  private stopWorker() {
    clearTimeout(this.idle);
    for(const item of this.pending.values()){
      clearTimeout(item.timer);
      item.reject(new Error("本地识别进程已结束。"));
    }
    this.pending.clear();
    const child=this.child;
    this.child=undefined;
    this.ready=undefined;
    return child && stopChild(child);
  }
  close() {
    this.closed=true;
    return this.closing??=Promise.allSettled([
      this.stopWorker(),this.conversion && stopChild(this.conversion),this.tail,
    ]).then(()=>{});
  }
}
