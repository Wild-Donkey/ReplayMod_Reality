#!/usr/bin/env node
// Developer/build-time runtime preparation only. Never downloads model weights.
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const runtime=path.resolve(process.argv[2]||path.resolve(__dirname,'../../../.tools/qwen'));
const env={...process.env,UV_PYTHON_INSTALL_DIR:path.join(runtime,'python'),UV_CACHE_DIR:path.join(runtime,'cache'),HF_HOME:path.join(runtime,'huggingface'),HF_HUB_DISABLE_TELEMETRY:'1',PIP_DISABLE_PIP_VERSION_CHECK:'1'};
function step(message){process.stdout.write(JSON.stringify({type:'progress',message})+'\n');}
function run(command,args,extra={}){return new Promise((resolve,reject)=>{const child=spawn(command,args,{env,...extra,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>process.stderr.write(b));child.stderr.on('data',b=>process.stderr.write(b));child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${path.basename(command)} failed (${code??signal})`)));process.once('SIGTERM',()=>child.kill('SIGTERM'));});}
(async()=>{
 if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('此本地 MLX 后端需要 Apple Silicon Mac。');
 fs.mkdirSync(runtime,{recursive:true});
 const bootstrap=path.join(runtime,'bootstrap'),uv=path.join(bootstrap,'bin','uv');
 if(!fs.existsSync(uv)){step('安装隔离的环境管理工具…');await run('python3',['-m','pip','install','--target',bootstrap,'uv==0.13.8']);}
 const python=path.join(runtime,'venv','bin','python');
 if(!fs.existsSync(python)){step('安装项目专用 Python 3.11…');await run(uv,['venv','--python','3.11',path.join(runtime,'venv')]);}
 step('安装 MLX 本地识别运行环境…');
 await run(uv,['pip','install','--python',python,'-r',path.join(__dirname,'requirements.txt')]);
 step('推理运行环境已准备好；模型由用户另行选择和下载。');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
