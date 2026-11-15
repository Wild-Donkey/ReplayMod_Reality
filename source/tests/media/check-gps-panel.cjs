const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const cache=fs.mkdtempSync(path.join(os.tmpdir(),'replay-gps-panel-'));app.setPath('userData',cache);
app.whenReady().then(async()=>{let win;try{
 const component=path.resolve('apps/desktop/src/renderer/features/timeline/MediaAlignmentPanel.tsx');
 const entry=path.join(cache,'entry.js');
 fs.writeFileSync(entry,`import React from ${JSON.stringify(require.resolve('react'))};import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};import {MediaAlignmentPanel} from ${JSON.stringify(component)};
 const source={sourcePath:'/fixture/video.mp4',creationTimeSeconds:1000,durationSeconds:2};const dataset={footprintTimestamps:[1000000,1001000,1002000],footprintCoordinates:[116,40,116.001,40,116.002,40]};
 window.calls=[];window.applied=[];window.aligned=[];window.before=JSON.stringify(dataset);window.dataset=dataset;
 window.replaymod={processMediaGps:async request=>{window.calls.push(request);return {points:request.points,correctedPoints:0,curvedIntervals:1,reason:'fixture'};},alignMediaTime:async request=>{window.aligned.push(request);return {source:{...source,creationTimeSeconds:1001},offsetSeconds:1,adjustmentSeconds:1,refined:true,reason:'fixture',backupPath:'/fixture/backup',timecodeUpdated:true};}};
 createRoot(document.getElementById('root')).render(React.createElement(MediaAlignmentPanel,{source,dataset,onProcessed:result=>window.applied.push(result),onAligned:()=>{}}));`);
 const {build}=await import('vite');const built=await build({configFile:false,resolve:{alias:{'react/jsx-runtime':require.resolve('react/jsx-runtime')}},logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},build:{write:false,lib:{entry,formats:['iife'],name:'GpsPanel'}}});
 win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});await win.loadURL('data:text/html,<div id="root"></div>');await win.webContents.executeJavaScript((Array.isArray(built)?built[0]:built).output.find(o=>o.type==='chunk').code);
 const result=await win.webContents.executeJavaScript(`(async()=>{
 const until=async test=>{for(let i=0;i<500;i++){if(test())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timeout');};
 await until(()=>document.querySelector('button'));
 [...document.querySelectorAll('button')].find(b=>b.textContent==='优化 GPS 与插值').click();await until(()=>window.applied.length===1&&!document.querySelector('button[type=submit]').disabled);
 const standalone={applied:window.applied.length,timestampWrites:window.aligned.length};
 document.querySelector('button[type=submit]').click();await until(()=>window.applied.length===2);
 return {standalone,processed:window.calls.length,aligned:window.aligned.length,rawUnchanged:JSON.stringify(window.dataset)===window.before,pointCount:window.calls[0].points.length,status:document.body.textContent.includes('后台轨迹已应用')};
 })()`);
 assert.deepEqual(result.standalone,{applied:1,timestampWrites:0});assert.equal(result.processed,2);assert.equal(result.aligned,1);assert(result.rawUnchanged);assert.equal(result.pointCount,3);assert(result.status);console.log('GPS panel passed: independent background processing, automatic processing after alignment, result consumption and immutable input.',result);
 }catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();fs.rmSync(cache,{recursive:true,force:true});app.exit(process.exitCode||0);}});
