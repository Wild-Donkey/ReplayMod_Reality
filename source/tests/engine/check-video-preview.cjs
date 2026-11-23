const {app,BrowserWindow,net}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript'),assert=require('node:assert/strict');
const root=path.resolve('apps/desktop/src'),mod={exports:{}};
new Function('require','exports',ts.transpileModule(fs.readFileSync(path.join(root,'main/mediaPreviewProtocol.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText)(require,mod.exports);
mod.exports.registerMediaPreviewScheme();
const cache=fs.mkdtempSync(path.join(os.tmpdir(),'replay-video-preview-'));app.setPath('userData',cache);
app.whenReady().then(async()=>{
 let win;
 try{
  const fixture=process.env.REPLAY_PREVIEW_FIXTURE || path.join(cache,'测试 预览.mp4');
  const ffmpegName=process.platform==='win32'?'ffmpeg.exe':'ffmpeg';
  const localFfmpeg=['ffmpeg/bin','ffmpeg','ffmpeg-native/bin'].map(directory=>path.resolve('../.tools',directory,ffmpegName)).find(file=>fs.existsSync(file));
  if(!process.env.REPLAY_PREVIEW_FIXTURE)require('node:child_process').execFileSync(process.env.FFMPEG_PATH || localFfmpeg || ffmpegName,['-v','error','-f','lavfi','-i','color=c=red:s=320x180:r=24:d=2','-c:v','libx264','-pix_fmt','yuv420p','-y',fixture]);
  mod.exports.installMediaPreviewProtocol(new Set([fixture]));
  const response=await net.fetch('replay-media://preview/'+encodeURIComponent(fixture),{headers:{Range:'bytes=0-31'}});
  assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,32);
  assert.equal((await net.fetch('replay-media://preview/'+encodeURIComponent(path.join(cache,'not-authorized.mp4')))).status,404);
  const entry=path.join(cache,'entry.tsx');
  fs.writeFileSync(entry,`import React from ${JSON.stringify(require.resolve("react"))};import {createRoot} from ${JSON.stringify(require.resolve("react-dom/client"))};import {flushSync} from ${JSON.stringify(require.resolve("react-dom"))};import {VideoPreview, videoTimeBounds} from ${JSON.stringify(path.join(root,'renderer/features/export/VideoPreview.tsx'))};
  const root=createRoot(document.getElementById('root'));const source={sourcePath:${JSON.stringify(fixture)},creationTimeSeconds:1000,durationSeconds:2};
  window.videoBounds=videoTimeBounds(source);
  window.showPreview=(selected,time)=>{
    const media=selected==='untimed'?{...source,creationTimeSeconds:undefined}:selected==='adjusted'?{...source,creationTimeSeconds:1001}:selected?source:null;
    const range=videoTimeBounds(media);
    flushSync(()=>root.render(<VideoPreview source={media} range={range} time={time} playing={false} showOverlay={range!==null && time>=range[0] && time<=range[1]} onOverlayHost={()=>{}}/>));
  };`);
  const {build}=await import('vite');const built=await build({configFile:false,resolve:{alias:{'react/jsx-runtime':require.resolve('react/jsx-runtime')}},logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},build:{write:false,minify:false,lib:{entry,formats:['iife'],name:'PreviewCheck'}}});
  const bundle=(Array.isArray(built)?built[0]:built).output.find(o=>o.type==='chunk').code;
  win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});await win.loadURL('data:text/html,<div id="root"></div>');
  await win.webContents.insertCSS(fs.readFileSync(path.join(root,'renderer/app/styles.css'),'utf8'));await win.webContents.executeJavaScript(bundle);
  const result=await win.webContents.executeJavaScript(`(async()=>{
    window.showPreview(false,1000500);const black=getComputedStyle(document.querySelector('.video-preview')).backgroundColor;const noVideo=!document.querySelector('video');
    window.showPreview(true,1000500);const video=document.querySelector('video');
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Video load timeout '+video.error?.message)),10000);const check=()=>{if(video.readyState>=2&&Math.abs(video.currentTime-.5)<.1){clearTimeout(timer);resolve();}};video.addEventListener('seeked',check);video.addEventListener('loadeddata',check);check();});
    const loaded={width:video.videoWidth,time:video.currentTime,overlay:Boolean(document.querySelector('.video-preview-overlay'))};
    window.showPreview(true,1005000);
    const outside={controls:video.controls,visibility:getComputedStyle(video).visibility,overlay:getComputedStyle(document.querySelector('.video-preview-overlay')).visibility};
    window.showPreview('untimed',1000500);
    return {black,noVideo,loaded,outside,untimed:document.querySelector('video').controls,bounds:window.videoBounds};
  })()`);
  assert.equal(result.black,'rgb(0, 0, 0)');assert(result.noVideo);
  assert(process.env.REPLAY_PREVIEW_FIXTURE ? result.loaded.width > 0 : result.loaded.width === 320);
  assert(Math.abs(result.loaded.time-.5)<.1);assert(result.loaded.overlay);
  assert.deepEqual(result.bounds,[1000000,1002000]);
  assert.deepEqual(result.outside,{controls:true,visibility:'visible',overlay:'hidden'});assert(result.untimed);
  await win.webContents.executeJavaScript(`window.showPreview(true,1000500);window.beforeAdjustment=document.querySelector('video');true`);
  if (!process.env.REPLAY_PREVIEW_FIXTURE) {
    // The write path replaces the file at the same pathname.
    fs.copyFileSync(fixture, fixture+'.replacement');
    fs.renameSync(fixture+'.replacement', fixture);
  }
  const resumed=await win.webContents.executeJavaScript(`(async()=>{
    window.showPreview('adjusted',1001500);
    const video=document.querySelector('video');
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Updated preview did not seek '+video.error?.message)),10000);const check=()=>{if(video.readyState>=2&&Math.abs(video.currentTime-.5)<.1){clearTimeout(timer);resolve();}};video.addEventListener('seeked',check);video.addEventListener('loadeddata',check);check();});
    return video!==window.beforeAdjustment && video.src!==window.beforeAdjustment.src;
  })()`);
  assert.equal(resumed,true);
  console.log('Video preview passed: clip bounds, black background, synchronized seek, independent playback and authorized range streaming.',result);
 }catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();fs.rmSync(cache,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
