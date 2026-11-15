import {open,readFile,readdir,stat} from "node:fs/promises";
import path from "node:path";
import type {InstalledSpeechModel} from "../shared/localSpeech";

/** Discover ordinary MLX model directories, independent of how they were obtained. */
export async function inspectSpeechModel(directory:string):Promise<InstalledSpeechModel> {
  const config=JSON.parse(await readFile(path.join(directory,"config.json"),"utf8"));
  const type=config.thinker_config?.model_type??config.model_type;
  if(!["qwen3_asr","qwen3_forced_aligner"].includes(type)||!config.quantization)throw new Error("需要 MLX 格式的 Qwen3 ASR / ForcedAligner 模型。");
  for(const name of ["tokenizer_config.json","vocab.json","preprocessor_config.json"]){JSON.parse(await readFile(path.join(directory,name),"utf8"));}
  if(!(await stat(path.join(directory,"merges.txt"))).size)throw new Error("缺少 merges.txt。");
  const index=JSON.parse(await readFile(path.join(directory,"model.safetensors.index.json"),"utf8"));
  const weights=[...new Set<string>(Object.values(index.weight_map??{}))];
  if(!weights.length)throw new Error("模型权重清单为空。");
  const fingerprint:string[]=[];
  for(const name of ["config.json","tokenizer_config.json","vocab.json","merges.txt","preprocessor_config.json","model.safetensors.index.json"]){const info=await stat(path.join(directory,name));fingerprint.push(`${name}:${info.size}:${info.mtimeMs}`);}
  for(const name of weights){
    if(path.basename(name)!==name||!name.endsWith(".safetensors"))throw new Error("模型权重路径无效。");
    const file=await open(path.join(directory,name),"r");
    try{
      const info=await file.stat(),size=info.size,prefix=Buffer.alloc(8);fingerprint.push(`${name}:${size}:${info.mtimeMs}`);await file.read(prefix,0,8,0);
      const length=Number(prefix.readBigUInt64LE());if(length<2||length>16*1024*1024||8+length>=size)throw new Error("权重文件不完整；请确认下载的不是 Git LFS 指针。");
      const buffer=Buffer.alloc(length);await file.read(buffer,0,length,8);const header=JSON.parse(buffer.toString("utf8"));
      for(const [tensor,shard] of Object.entries(index.weight_map)){if(shard===name&&!header[tensor])throw new Error("权重与索引不匹配。");}
      let maximum=0;
      for(const [key,value] of Object.entries(header)){if(key==="__metadata__")continue;const offsets=(value as {data_offsets?:number[]}).data_offsets;if(!offsets||offsets.length!==2||!offsets.every(Number.isSafeInteger)||offsets[0]<0||offsets[1]<offsets[0])throw new Error("权重头无效。");maximum=Math.max(maximum,offsets[1]);}
      if(8+length+maximum!==size)throw new Error("权重文件尚未下载完整。");
    }finally{await file.close();}
  }
  const id=path.resolve(directory),role=type==="qwen3_forced_aligner"?"aligner":"asr";
  return {id,directory:id,role,label:`${role==="asr"?"Qwen3 ASR":"Qwen3 ForcedAligner"} · ${path.basename(id)} · MLX ${config.quantization.bits}-bit`,fingerprint:fingerprint.join("|")};
}
export async function discoverSpeechModels(root:string,external:string[]) {
  const children=await readdir(root,{withFileTypes:true}).catch(()=>[]);
  const directories=[...new Set([...children.filter(d=>d.isDirectory()||d.isSymbolicLink()).map(d=>path.join(root,d.name)),...external])];
  const installed:InstalledSpeechModel[]=[],issues:string[]=[];
  for(const directory of directories){try{installed.push(await inspectSpeechModel(directory));}catch(error){issues.push(`${directory}：${error instanceof Error?error.message:String(error)}`);}}
  return {installed,issues};
}
