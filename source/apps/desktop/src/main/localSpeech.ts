import {spawn,type ChildProcess} from "node:child_process";
import {access,readFile,mkdir,rename,writeFile,stat} from "node:fs/promises";
import path from "node:path";
import {LocalQwen,type LocalTranscript} from "../../../../packages/media/src/local-qwen";
import {assertCanStartChild,stopChild,trackChild} from "../../../../packages/media/src/childProcesses";
import catalog from "../../../../resources/speech/models.json";
import {discoverSpeechModels,inspectSpeechModel} from "./speechModels";
import type {LocalSpeechStatus,LocalSpeechUpdate,SpeechModelRole} from "../shared/localSpeech";
interface Selection {asr:string;aligner:string;folders:string[]}
export class LocalSpeech {
  private worker?:LocalQwen;
  private downloading?:Promise<LocalSpeechStatus>;
  private downloader?:ChildProcess;
  private closed=false;
  private activeJobs=0;
  private workerKey="";
  private changing=false;
  private configuration:Promise<unknown>=Promise.resolve();
  private configure<T>(action:()=>Promise<T>):Promise<T>{
    const job=this.configuration.catch(()=>{}).then(async()=>{this.changing=true;try{return await action();}finally{this.changing=false;}});this.configuration=job;return job;
  }
  private cache=new Map<string,{key:string;result:Promise<LocalTranscript>}>();
  readonly runtime:string;readonly resources:string;readonly modelDirectory:string;
  private readonly python:string;private readonly pythonPath?:string;
  constructor(appPath:string,resourcesPath:string,packaged:boolean,persistentRuntime:string) {
    this.runtime=packaged?persistentRuntime:path.resolve(appPath,"../.tools/qwen");
    this.resources=packaged?path.join(resourcesPath,"speech"):path.join(appPath,"resources/speech");
    this.modelDirectory=path.join(this.runtime,"models");
    this.python=packaged?path.join(resourcesPath,"speech-runtime/python/bin/python3.11"):path.join(this.runtime,"venv/bin/python");
    this.pythonPath=packaged?path.join(resourcesPath,"speech-runtime/site-packages"):undefined;
  }
  private async selection():Promise<Selection>{
    try{const value=JSON.parse(await readFile(path.join(this.runtime,"selection.json"),"utf8"));return {asr:typeof value.asr==="string"?value.asr:"",aligner:typeof value.aligner==="string"?value.aligner:"",folders:Array.isArray(value.folders)?value.folders.filter((p:unknown)=>typeof p==="string"):[]};}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("无法读取语音模型选择配置；原文件未覆盖。");return {asr:"",aligner:"",folders:[]};}
  }
  private async save(value:Selection){await mkdir(this.runtime,{recursive:true});const file=path.join(this.runtime,"selection.json");await writeFile(file+".tmp",JSON.stringify(value,null,2));await rename(file+".tmp",file);}
  async status():Promise<LocalSpeechStatus> {
    const supported=process.platform==="darwin"&&process.arch==="arm64";
    const runtimeReady=await access(this.python).then(()=>true,()=>false);
    const selected=await this.selection(),{installed,issues}=await discoverSpeechModels(this.modelDirectory,selected.folders);
    const asr=installed.find(m=>m.id===selected.asr&&m.role==="asr"),aligner=installed.find(m=>m.id===selected.aligner&&m.role==="aligner");
    const ready=supported&&runtimeReady&&!!asr&&!!aligner;
    return {supported,ready,runtimeReady,modelDirectory:this.modelDirectory,installed,issues,selected:{asr:selected.asr,aligner:selected.aligner},asrModel:asr?.label??"未选择",alignerModel:aligner?.label??"未选择",catalog:catalog.map(m=>({id:m.id,role:m.role as SpeechModelRole,label:m.label,source:m.source,revision:m.revision,bytes:m.files.reduce((n,f)=>n+f.size,0),directory:path.join(this.modelDirectory,m.id)})),message:!supported?"本地 MLX 识别需要 Apple Silicon Mac。":!runtimeReady?"缺少推理运行环境；开发环境请运行 npm run setup:speech，发行包应包含运行环境。":ready?"所选模型已就绪，推理离线运行。":"请选择已下载的 ASR 和对齐模型；可单独下载，也可手动放入模型目录后刷新。"};
  }
  select(role:SpeechModelRole,id:string){return this.configure(async()=>{
    if(!["asr","aligner"].includes(role)||typeof id!=="string")throw new Error("模型选择无效。");
    if(this.activeJobs)throw new Error("识别正在进行，请完成后切换模型。");
    if(id){const current=await this.status();if(!current.installed.some(m=>m.id===id&&m.role===role))throw new Error("该模型不可用，请刷新后重选。");}
    const value=await this.selection();value[role]=id;await this.save(value);this.resetWorker();this.cache.clear();return this.status();
  });}
  register(directory:string){return this.configure(async()=>{
    const model=await inspectSpeechModel(directory),value=await this.selection();if(!value.folders.includes(model.directory))value.folders.push(model.directory);await this.save(value);return this.status();
  });}
  download(id:string,progress:(value:LocalSpeechUpdate)=>void):Promise<LocalSpeechStatus>{
    if(!catalog.some(m=>m.id===id))return Promise.reject(new Error("未知模型。"));
    if(this.downloading)return Promise.reject(new Error("已有模型正在下载，请稍候。"));
    this.downloading=this.doDownload(id,progress).finally(()=>{this.downloading=undefined;});return this.downloading;
  }
  private async doDownload(id:string,progress:(value:LocalSpeechUpdate)=>void){
    await new Promise<void>((resolve,reject)=>{
      assertCanStartChild();
      const child=trackChild(spawn(process.execPath,[path.join(this.resources,"download.cjs"),this.modelDirectory,id],{env:{...process.env,ELECTRON_RUN_AS_NODE:"1"},stdio:["ignore","pipe","pipe"]}));
      this.downloader=child;
      let buffer="",errors="";child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
      child.stdout.on("data",data=>{buffer+=data;let end:number;while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const p=JSON.parse(line);if(p.type==="progress")progress({message:String(p.message),done:p.done,total:p.total});}catch{}}});
      child.stderr.on("data",data=>{errors=(errors+data).slice(-1000);});child.once("error",reject);child.once("close",code=>{if(this.downloader===child)this.downloader=undefined;code===0?resolve():reject(new Error(`模型下载失败，可重试续传：${errors.trim()}`));});
    });return this.status();
  }
  async transcribe(sourcePath:string,duration:number,progress?:(value:LocalSpeechUpdate)=>void):Promise<LocalTranscript> {
    if(this.closed)throw new Error("应用正在退出。");
    if(this.changing)throw new Error("模型选择正在变更，请稍候。");
    this.activeJobs++;
    try {
      const status=await this.status();if(!status.ready)throw new Error(status.message);
      const file=await stat(sourcePath);
      if(this.closed)throw new Error("应用正在退出。");
      const signature=[status.selected.asr,status.selected.aligner,...[status.selected.asr,status.selected.aligner].map(id=>status.installed.find(m=>m.id===id)!.fingerprint)].join(":");
      const key=[file.size,file.mtimeMs,duration,signature].join(":");
      const cached=this.cache.get(sourcePath);if(cached?.key===key)return await cached.result;
      if(this.worker&&this.workerKey!==signature){if(this.activeJobs>1)throw new Error("模型文件已变化，请等待当前识别完成后重试。");this.resetWorker();this.cache.clear();}
      this.worker??=new LocalQwen({runtime:this.runtime,worker:path.join(this.resources,"worker.py"),python:this.python,pythonPath:this.pythonPath,asr:status.selected.asr,aligner:status.selected.aligner});this.workerKey=signature;
      const result=this.worker.transcribe(sourcePath,duration,update=>progress?.({sourcePath,done:update.done,total:update.total,message:update.stage==="loading"?"正在加载所选本地模型…":`${update.stage==="asr"?"正在识别文字":"正在对齐词/字时间"} · ${update.done+1}/${update.total}`}));
      if(this.cache.size>=8)this.cache.delete(this.cache.keys().next().value!);this.cache.set(sourcePath,{key,result});
      try{return await result;}catch(error){if(this.cache.get(sourcePath)?.result===result)this.cache.delete(sourcePath);throw error;}
    }finally{this.activeJobs--;}
  }

  private resetWorker(){const closing=this.worker?.close();this.worker=undefined;this.workerKey="";return closing;}
  async close(){
    this.closed=true;
    await Promise.all([this.resetWorker(),this.downloader && stopChild(this.downloader)]);
  }
}
