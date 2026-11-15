// Pure file transfer. No Python, model loading, conversions, or install receipt.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {createHash}=require('node:crypto');
const catalog=require('./models.json');
async function digest(file){const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function complete(file,entry){try{return (await fsp.stat(file)).size===entry.size&&(!entry.sha256||await digest(file)===entry.sha256);}catch{return false;}}
async function transfer(url,file,entry,progress=()=>{},fetcher=fetch){
 await fsp.mkdir(path.dirname(file),{recursive:true});
 if(await complete(file,entry)){progress(entry.size);return;}
 const partial=file+'.part';let offset=await fsp.stat(partial).then(s=>s.size).catch(()=>0);
 if(offset>entry.size){await fsp.rm(partial);offset=0;}
 if(offset<entry.size){
  const response=await fetcher(url,{headers:offset?{Range:`bytes=${offset}-`}:{},signal:AbortSignal.timeout(60*60*1000)});
  if(!response.ok||!response.body)throw Error(`下载失败 HTTP ${response.status}: ${entry.name}`);
  if(response.status===206){if(!offset||!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`))throw Error('下载源返回了错误的续传范围。');}
  else offset=0; // Servers without Range support restart this one file.
  const handle=await fsp.open(partial,offset?'a':'w');
  try{for await(const chunk of response.body){await handle.writeFile(chunk);offset+=chunk.length;if(offset>entry.size)throw Error('下载文件超过清单大小。');progress(offset);}}finally{await handle.close();}
 }
 if(!await complete(partial,entry)){await fsp.rm(partial,{force:true});throw Error(`文件校验失败：${entry.name}，请重试。`);}
 await fsp.rename(partial,file);
}
async function download(model,root,progress=()=>{}){
 const total=model.files.reduce((sum,f)=>sum+f.size,0);let previous=0;
 for(const file of model.files){
  if(path.basename(file.name)!==file.name)throw Error('模型清单路径无效。');
  const url=`https://huggingface.co/${model.repository}/resolve/${model.revision}/${encodeURIComponent(file.name)}`;
  await transfer(url,path.join(root,model.id,file.name),file,bytes=>progress({file:file.name,done:previous+bytes,total}));previous+=file.size;
 }
}
module.exports={download,transfer};
if(require.main===module){
 const model=catalog.find(m=>m.id===process.argv[3]);if(!model)throw Error('未知模型。');
 let last=0;download(model,path.resolve(process.argv[2]),p=>{if(Date.now()-last>250||p.done===p.total){last=Date.now();console.log(JSON.stringify({type:'progress',...p,message:`下载 ${model.label} · ${p.file} · ${(p.done/p.total*100).toFixed(1)}%`}));}}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
