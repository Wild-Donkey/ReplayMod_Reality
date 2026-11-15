const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-model-ui-'));app.setPath('userData',dir);
app.whenReady().then(async()=>{let win;try{
 const entry=path.join(dir,'entry.tsx');
 fs.writeFileSync(entry,`import React from ${JSON.stringify(require.resolve('react'))};import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};import {LocalSpeechModels} from ${JSON.stringify(path.resolve('apps/desktop/src/renderer/features/audio/LocalSpeechModels.tsx'))};
 let progress;window.actions=[];window.ready=[];window.busy=[];window.modelStatus={supported:true,ready:false,runtimeReady:true,modelDirectory:'/models',installed:[],selected:{asr:'',aligner:''},catalog:[{id:'asr',role:'asr',label:'ASR',source:'https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-8bit',revision:'abc123',bytes:100,directory:'/models/asr'},{id:'aligner',role:'aligner',label:'Aligner',source:'https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit',revision:'def456',bytes:200,directory:'/models/aligner'}],issues:[],message:'请选择模型'};
 const copy=()=>structuredClone(window.modelStatus);window.replaymod={getLocalSpeechStatus:async()=>copy(),onLocalSpeechProgress:callback=>{progress=callback;return()=>{};},downloadSpeechModel:async id=>{window.actions.push(['download',id]);progress({message:'download progress'});await new Promise(resolve=>window.finishDownload=resolve);if(window.failDownload)throw Error('network error');window.modelStatus.installed.push({id:'/models/'+id,role:id,label:id,directory:'/models/'+id});return copy();},selectSpeechModel:async(role,id)=>{window.actions.push(['select',role,id]);window.modelStatus.selected[role]=id;window.modelStatus.ready=!!(window.modelStatus.selected.asr&&window.modelStatus.selected.aligner);return copy();},openSpeechModelDirectory:async()=>{window.actions.push(['open']);},addSpeechModelFolder:async()=>{window.actions.push(['folder']);window.modelStatus.installed.push({id:'/external/aligner',role:'aligner',label:'External aligner',directory:'/external/aligner'});return copy();}};
 const root=createRoot(document.getElementById('root'));let revision=0;window.mountModels=()=>root.render(<LocalSpeechModels key={revision++} onReady={value=>window.ready.push(value)} onInstalling={value=>window.busy.push(value)}/>);window.mountModels();`);
 const {build}=await import('vite');const built=await build({configFile:false,resolve:{alias:{'react/jsx-runtime':require.resolve('react/jsx-runtime')}},logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},build:{write:false,minify:false,lib:{entry,formats:['iife'],name:'SpeechModelTest'}}});const bundle=(Array.isArray(built)?built[0]:built).output.find(o=>o.type==='chunk').code;
 win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});fs.writeFileSync(path.join(dir,'index.html'),'<div id="root"></div>');await win.loadFile(path.join(dir,'index.html'));await win.webContents.executeJavaScript(bundle);
 await win.webContents.executeJavaScript(`(async()=>{
 const check=(condition,message)=>{if(!condition)throw Error(message);};const wait=async fn=>{await new Promise(r=>setTimeout(r,10));for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('timeout: '+document.body.innerText);};
 const button=text=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===text);if(!b)throw Error('Missing '+text+': '+document.body.innerText);return b;};const select=label=>document.querySelector('[aria-label="'+label+'"]');const change=(label,value)=>{const element=select(label);element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));};
 await wait(()=>window.ready.length&&select('可下载模型').options.length===2&&document.body.textContent.includes('hf download'));document.querySelector('.local-model-download').open=true;check(window.actions.length===0,'first run must not download or select');check(select('语音识别模型').options.length===1,'empty initial list');check(document.body.innerText.includes('hf download'),'manual command is exposed');check(document.querySelector('a').href.startsWith('https://huggingface.co/'),'public source is exposed');
 button('下载所选模型').click();await wait(()=>window.finishDownload);check(select('语音识别模型').disabled,'selection is locked during transfer');check(document.body.innerText.includes('download progress'),'progress displayed');window.finishDownload();await wait(()=>select('语音识别模型').options.length===2&&!select('语音识别模型').disabled);check(select('语音识别模型').value==='','download does not silently select');
 change('语音识别模型','/models/asr');await wait(()=>select('语音识别模型').value==='/models/asr'&&!select('语音识别模型').disabled);check(!window.ready.at(-1),'ASR alone is not ready');
 button('添加已有模型文件夹').click();await wait(()=>select('词 / 字对齐模型').options.length===2&&!select('词 / 字对齐模型').disabled);change('词 / 字对齐模型','/external/aligner');await wait(()=>window.ready.at(-1));
 button('打开模型目录').click();await wait(()=>window.actions.some(a=>a[0]==='open')&&!select('语音识别模型').disabled);
 change('可下载模型','aligner');window.failDownload=true;window.finishDownload=null;button('下载所选模型').click();await wait(()=>window.finishDownload);window.finishDownload();await wait(()=>document.body.innerText.includes('network error')&&!select('语音识别模型').disabled);check(window.ready.at(-1),'failed download preserves selected models');
 check(window.busy.at(-1)===false,'controls unlocked after failure');
 window.replaymod.getLocalSpeechStatus=async()=>{throw Error("No handler registered for 'speech:status'");};window.mountModels();
 await wait(()=>document.body.textContent.includes('旧版本')&&select('可下载模型').options.length===3);
 document.querySelector('.local-model-download').open=true;
 check(document.body.innerText.includes('hf download mlx-community/Qwen3-ASR-0.6B-8bit'),'manual instructions survive a missing IPC handler');
 check(select('可下载模型').value==='Qwen3-ASR-0.6B-8bit','bundled catalog has a usable default');
 check(button('下载所选模型').disabled,'offline instructions do not enable broken IPC actions');
 check(!document.body.innerText.includes('正在读取'),'failed status is not shown as endless loading');
 delete window.replaymod.getLocalSpeechStatus;delete window.replaymod.onLocalSpeechProgress;window.mountModels();
 await wait(()=>document.body.textContent.includes('旧版本')&&select('可下载模型').options.length===3);
 window.replaymod.getLocalSpeechStatus=()=>new Promise(()=>{});window.mountModels();
 await wait(()=>select('可下载模型').options.length===3&&document.body.textContent.includes('hf download'));

 })()`);
 console.log('Model UI passed: no automatic download/selection, source and manual command, progress, independent selectors, external folder, open directory failed-download recovery, missing/stale bridge and pending-status offline instructions.');
 }finally{win?.destroy();fs.rmSync(dir,{recursive:true,force:true});app.quit();}}).catch(e=>{console.error(e);app.exit(1);});
