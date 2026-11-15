// Exercise the real Deck capture inside production export CSS, including host borders.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const os=require('node:os');
const cache=fs.mkdtempSync(path.join(os.tmpdir(),'replay-capture-layout-'));
app.setPath('userData',cache);
app.whenReady().then(async()=>{
 let window;
 try {
  const {build}=await import('vite');
  const renderer=path.resolve('apps/desktop/src/renderer');
  const entry=`import {ReplayCanvasCapture} from ${JSON.stringify(renderer+'/render-engine/export/ReplayCanvasCapture.ts')};
  import {ReplayScene} from ${JSON.stringify(renderer+'/render-engine/ReplayScene.ts')};
  import {drawCircularMinimap} from ${JSON.stringify(renderer+'/features/export/CircularMinimap.ts')};
  import {drawMinimapTrail} from ${JSON.stringify(renderer+'/features/export/MinimapTrail.ts')};
  window.checkCapture=async()=>{
    const host=document.createElement('section');host.className='overlay-export';document.body.append(host);
    const preview=document.createElement('canvas');host.append(preview);
    const parent=document.createElement('div');parent.className='navigation-map-renderer';host.append(parent);
    const results=[];
    for(const pixelRatio of [1,2/3,2]){
      const scene=new ReplayScene(),capture=new ReplayCanvasCapture(parent,scene,{width:410,height:302,pixelRatio,metrics:false});
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      try{
        const canvas=await capture.capture(1000,0,scene.current.mapViewState,controller.signal);
        if(!canvas)throw Error('GPU frame did not complete');
        results.push({pixelRatio,width:canvas.width,height:canvas.height,clientWidth:canvas.clientWidth,clientHeight:canvas.clientHeight,border:getComputedStyle(canvas).borderLeftWidth});
      }finally{clearTimeout(timer);capture.destroy();}
    }
    results.push({previewBorder:getComputedStyle(preview).borderLeftWidth,childrenAfterCapture:parent.children.length});
    const output=document.createElement('canvas');output.width=1920;output.height=1080;
    const ctx=output.getContext('2d');ctx.fillStyle='red';ctx.fillRect(600,800,20,20);
    drawCircularMinimap(ctx,null,null,0);
    const alpha=(x,y)=>ctx.getImageData(60+x,662+y,1,1).data[3];
    const background=alpha(180,240),outer=alpha(306,306),inner=alpha(296,296);
    if(!(background>130&&background<170&&outer<10&&inner>outer&&inner<background&&alpha(0,0)===0))throw Error('Circular background or feather alpha failed');
    if(ctx.getImageData(605,805,1,1).data[3]!==255)throw Error('Map mask erased stats');
    const roads=document.createElement('canvas');roads.width=roads.height=360;const r=roads.getContext('2d');r.fillStyle='white';r.fillRect(0,0,360,360);
    ctx.clearRect(0,0,1920,1080);drawCircularMinimap(ctx,roads,null,0);
    if(!(alpha(0,0)===0&&alpha(180,240)===255&&alpha(306,306)<25))throw Error('Roads escape the circular feather mask');
    const north=(x,y)=>{
      const data=ctx.getImageData(60+x-14,662+y-14,28,28).data;
      let solid=0;for(let i=0;i<data.length;i+=4)if(data[i]>180&&data[i+1]<120&&data[i+2]<120&&data[i+3]>245)solid++;
      return solid;
    };
    ctx.clearRect(0,0,1920,1080);drawCircularMinimap(ctx,null,null,0);
    if(north(180,0)<20)throw Error('North must be fully opaque on the outer boundary');
    ctx.clearRect(0,0,1920,1080);drawCircularMinimap(ctx,null,null,90);
    if(north(0,180)<20||north(180,0)!==0)throw Error('Compass must rotate with the map');
    results.push({backgroundAlpha:background,featherInnerAlpha:inner,featherOuterAlpha:outer,roadCornersTransparent:true,statsPreserved:true,compassOpaqueAtBoundary:true,compassRotates:true});
    const trail=document.createElement('canvas');trail.width=trail.height=360;
    const tc=trail.getContext('2d');
    drawMinimapTrail(tc,[{x:-180,y:180,time:0},{x:180,y:180,time:10000}],360);
    const old=tc.getImageData(18,180,1,1).data,newer=tc.getImageData(162,180,1,1).data;
    if(!(old[3]<35&&newer[3]>220))throw Error('Visible five-second trail does not span the full fade range');
    ctx.clearRect(0,0,1920,1080);drawCircularMinimap(ctx,null,null,0);
    const pointer=ctx.getImageData(240,842,1,1).data;
    if(!(pointer[1]>180&&Math.abs(pointer[0]/pointer[1]-70/225)<.04&&Math.abs(pointer[2]/pointer[1]-135/225)<.04&&pointer[3]===255))throw Error('Pointer must use opaque main-map mint: '+Array.from(pointer));
    results.push({visibleTrailOldAlpha:old[3],visibleTrailNewAlpha:newer[3],pointerMatchesTrail:true});
    host.remove();return results;
  };`;
  const entryPath=path.join(cache,'capture-entry.js');fs.writeFileSync(entryPath,entry);
  const built=await build({configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},build:{write:false,minify:false,lib:{entry:entryPath,name:'CaptureLayout',formats:['iife']},target:'esnext'}});
  const bundle=(Array.isArray(built)?built[0]:built).output.find(o=>o.type==='chunk').code;
  window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
  await window.loadURL('data:text/html,<html><body></body></html>');
  const css=fs.readFileSync(path.join(renderer,'app/styles.css'),'utf8');
  await window.webContents.insertCSS(css);
  // Also protect capture buffers if a host still applies a generic canvas border.
  await window.webContents.insertCSS('.navigation-map-renderer canvas {border:1px solid red;box-sizing:border-box}');
  await window.webContents.executeJavaScript(bundle);
  const results=await window.webContents.executeJavaScript('window.checkCapture()');
  for(const r of results.slice(0,3)){assert.equal(r.width,Math.floor(410*r.pixelRatio));assert.equal(r.height,Math.floor(302*r.pixelRatio));assert.equal(r.clientWidth,410);assert.equal(r.clientHeight,302);assert.equal(r.border,'0px');}
  assert.equal(results[3].previewBorder,'1px');assert.equal(results[3].childrenAfterCapture,0);
  console.log('Capture layout passed: real GPU frames at 720p/1080p/4K ratios retain exact buffers under production/host CSS; preview border and cleanup verified.',results);
 }catch(e){console.error(e);process.exitCode=1;}finally{window?.destroy();fs.rmSync(cache,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
