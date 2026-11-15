const {app,BrowserWindow,net}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript'),assert=require('node:assert/strict');
const root=path.resolve('apps/desktop/src'),mod={exports:{}};
new Function('require','exports',ts.transpileModule(fs.readFileSync(path.join(root,'main/mediaPreviewProtocol.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(require,mod.exports);
mod.exports.registerMediaPreviewScheme();
const cache=fs.mkdtempSync(path.join(os.tmpdir(),'replay-video-preview-'));app.setPath('userData',cache);
app.whenReady().then(async()=>{
 let win;
 try{
  const fixture=process.env.REPLAY_PREVIEW_FIXTURE || path.join(cache,'preview.mp4');
  if(!process.env.REPLAY_PREVIEW_FIXTURE)require('node:child_process').execFileSync(process.env.FFMPEG_PATH || path.resolve('../.tools/ffmpeg/ffmpeg'),['-v','error','-f','lavfi','-i','color=c=red:s=320x180:r=24:d=2','-c:v','libx264','-pix_fmt','yuv420p','-y',fixture]);
  mod.exports.installMediaPreviewProtocol(new Set([fixture]));
  const response=await net.fetch('replay-media://preview/'+encodeURIComponent(fixture),{headers:{Range:'bytes=0-31'}});
  assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,32);
  assert.equal((await net.fetch('replay-media://preview/'+encodeURIComponent('/tmp/not-authorized.mp4'))).status,404);
  const entry=path.join(cache,'entry.tsx');
  fs.writeFileSync(entry,`import React from ${JSON.stringify(require.resolve("react"))};import {createRoot} from ${JSON.stringify(require.resolve("react-dom/client"))};import {flushSync} from ${JSON.stringify(require.resolve("react-dom"))};import {VideoPreview} from ${JSON.stringify(path.join(root,'renderer/features/export/VideoPreview.tsx'))};
  const root=createRoot(document.getElementById('root'));const source={sourcePath:${JSON.stringify(fixture)},creationTimeSeconds:1000,durationSeconds:2};
  window.showPreview=(selected,time)=>flushSync(()=>root.render(<VideoPreview source={selected?source:null} time={time} playing={false} onOverlayHost={()=>{}}/>));`);
  const {build}=await import('vite');const built=await build({configFile:false,resolve:{alias:{'react/jsx-runtime':require.resolve('react/jsx-runtime')}},logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},build:{write:false,minify:false,lib:{entry,formats:['iife'],name:'PreviewCheck'}}});
  const bundle=(Array.isArray(built)?built[0]:built).output.find(o=>o.type==='chunk').code;
  win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});await win.loadURL('data:text/html,<div id="root"></div>');
  await win.webContents.insertCSS(fs.readFileSync(path.join(root,'renderer/app/styles.css'),'utf8'));await win.webContents.executeJavaScript(bundle);
  const result=await win.webContents.executeJavaScript(`(async()=>{
    window.showPreview(false,1000500);const black=getComputedStyle(document.querySelector('.video-preview')).backgroundColor;const noVideo=!document.querySelector('video');
    window.showPreview(true,1000500);const video=document.querySelector('video');
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Video load timeout '+video.error?.message)),10000);const check=()=>{if(video.readyState>=2&&Math.abs(video.currentTime-.5)<.1){clearTimeout(timer);resolve();}};video.addEventListener('seeked',check);video.addEventListener('loadeddata',check);check();});
    const loaded={width:video.videoWidth,time:video.currentTime,overlay:Boolean(document.querySelector('.video-preview-overlay'))};
    window.showPreview(true,1005000);await new Promise(resolve=>setTimeout(resolve,20));return {black,noVideo,loaded,outside:video.style.visibility};
  })()`);
  assert.equal(result.black,'rgb(0, 0, 0)');assert(result.noVideo);assert.equal(result.loaded.width,320);assert(Math.abs(result.loaded.time-.5)<.1);assert(result.loaded.overlay);assert.equal(result.outside,'hidden');
  console.log('Video preview passed: black fallback, real decode/seek, overlay host, out-of-range black and authorized range streaming.',result);
 }catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();fs.rmSync(cache,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
