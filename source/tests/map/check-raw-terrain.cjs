const {app,BrowserWindow} = require('electron');
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),assert=require('node:assert/strict'),http=require('node:http');
const root=path.resolve(__dirname,'../../apps/desktop/src/renderer');
const sources={};
for(const file of ['features/map/RawTerrain','features/map/terrainExposure','features/map/terrainShaders','shared/gpu','features/map/elevation','features/map/water','features/map/elevationRange','features/map/terrainWaterMask']) sources[file]=ts.transpileModule(fs.readFileSync(path.join(root,file+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
app.setPath('userData',fs.mkdtempSync('/tmp/replay-terrain-test-'));
app.whenReady().then(async()=>{
 const server=http.createServer((req,res)=>res.end('<html></html>'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true}});
 try {
  await window.loadURL('http://127.0.0.1:'+server.address().port);
  await window.webContents.executeJavaScript(fs.readFileSync(path.resolve(__dirname,'../../node_modules/maplibre-gl/dist/maplibre-gl.js'),'utf8'));
  const result=await window.webContents.executeJavaScript(`(async()=>{
   const sources=${JSON.stringify(sources)},cache={};
   function load(id){
    if(id==='maplibre-gl')return window.maplibregl;
    if(id==='shared/displayHDR')return {getHDRState:()=>({active:true}),currentHDRHeadroom:()=>2.67,watchDisplayHDR:()=>()=>{}};
    if(cache[id])return cache[id];
    const exports=cache[id]={};
    new Function('exports','require',sources[id])(exports,name=>{
      if(name==='maplibre-gl')return window.maplibregl;
      const parts=id.split('/');parts.pop();for(const p of name.split('/')){if(p==='..')parts.pop();else if(p!=='.')parts.push(p);}return load(parts.join('/'));
    });return exports;
   }
   const {RawTerrain}=load('features/map/RawTerrain');
   const {decodeElevation,mappedTerrainLuminance}=load('features/map/terrainExposure');
   const source=document.createElement('canvas');source.width=64;source.height=32;document.body.append(source);
   let repaints=0,failed=false,appearance=null;
   const layers=new Map();
   const map={getCanvas:()=>source,getStyle:()=>({layers:[]}),addLayer:l=>layers.set(l.id,l),getLayer:id=>layers.get(id),removeLayer:id=>layers.delete(id),getCenter:()=>({lng:0}),getZoom:()=>2,triggerRepaint:()=>repaints++};
   const raw=await RawTerrain.create(map,()=>{failed=true},value=>{appearance=value});
   const errors=[];raw.device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
   const matrix=[2,0,0,0,0,-2,0,0,0,0,1,0,-1,1,0,1];
   const readHeights=async(target=raw)=>{
    const raw=target;
    const width=raw.canvas.width,height=raw.canvas.height,stride=Math.ceil(width*8/256)*256;const buffer=raw.device.createBuffer({size:stride*height,usage:9});const encoder=raw.device.createCommandEncoder();encoder.copyTextureToBuffer({texture:raw.heightTexture},{buffer,bytesPerRow:stride},[width,height]);raw.device.queue.submit([encoder.finish()]);await buffer.mapAsync(1);const packed=new Float32Array(buffer.getMappedRange()),values=[];for(let y=0;y<height;y++)for(let x=0;x<width;x++)values.push(packed[y*stride/4+x*2]);buffer.unmap();buffer.destroy();return values;
   };
   const half=value=>{const sign=(value&32768)?-1:1,exponent=(value>>10)&31,mantissa=value&1023;return sign*(exponent?2**(exponent-15)*(1+mantissa/1024):2**-14*mantissa/1024)};
   const linear=value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;
   const readTone=async(full=false)=>{
    const texture=raw.device.createTexture({size:[64,32],format:'rgba16float',usage:17});
    const buffer=raw.device.createBuffer({size:512*32,usage:9}),encoder=raw.device.createCommandEncoder();
    const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}]});pass.setPipeline(raw.tonePipeline);pass.setBindGroup(0,raw.toneBinding);pass.draw(3);pass.end();encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:512},[64,32]);raw.device.queue.submit([encoder.finish()]);await buffer.mapAsync(1);const pixels=new Uint16Array(buffer.getMappedRange());const value=linear(half(pixels[(16*64+32)*4]));let result=value;if(full){const values=[];for(let i=0;i<pixels.length;i+=4)values.push(linear(half(pixels[i])));result={minimum:Math.min(...values),maximum:Math.max(...values)};}buffer.unmap();buffer.destroy();texture.destroy();return result;
   };
   const sample=async(height,ocean=false)=>{
    if(ocean)raw.addTile({z:0,x:0,y:0,ocean:false,width:2,height:2,heights:new Float32Array(4),materials:new Uint8Array(4).fill(1)});
    raw.addTile({z:0,x:0,y:0,ocean,width:2,height:2,heights:new Float32Array(4).fill(height)});
    raw.render(matrix);await raw.device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,30));
    for(let i=0;i<35;i++){raw.lastFrame=performance.now()-100;raw.render(matrix);}
    await raw.device.queue.onSubmittedWorkDone();
    return {height:(await readHeights())[16*64+32],black:ocean?raw.oceanBlack:raw.black,white:ocean?raw.oceanWhite:raw.white,targetBlack:ocean?raw.targetOceanBlack:raw.targetBlack,targetWhite:ocean?raw.targetOceanWhite:raw.targetWhite,expected:mappedTerrainLuminance(height,ocean?raw.oceanBlack:raw.black,ocean?raw.oceanWhite:raw.white,2.67),luminance:await readTone(),imageRevision:raw.imageRevision};
   };
   const plateau=await sample(4500.1);
   raw.lastMeter=-Infinity;const sea=await sample(-9000.1,true);
   const before=raw.imageRevision;raw.lastFrame=performance.now()-100;raw.render(matrix);const reuse=before===raw.imageRevision;
   const decoded=Array.from(decodeElevation(new Uint8ClampedArray([2,54,105,255,0,39,15,255])));
   await raw.device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,30));
   const ocean=raw.tiles.get('true:0/0/0');ocean.texture.destroy();ocean.draws.forEach(draw=>draw.uniform.destroy());raw.tiles.delete('true:0/0/0');
   raw.addTile({z:0,x:0,y:0,ocean:false,width:2,height:2,heights:new Float32Array([4000,5000,4000,5000])});
   raw.lastMeter=-Infinity;raw.render(matrix);await raw.device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,30));
   for(let i=0;i<50;i++){raw.lastFrame=performance.now()-100;raw.render(matrix);}
   await new Promise(r=>setTimeout(r,150));raw.render(matrix);
   const ramp=await readTone(true);const rampRange=appearance.land;
   // A coarse ocean tile covering an estuary/lake must not determine shore
   // shape. The higher resolution surface material is authoritative.
   raw.addTile({z:0,x:0,y:0,ocean:true,width:2,height:2,heights:new Float32Array(4).fill(-100)});
   raw.render(matrix);await raw.device.queue.onSubmittedWorkDone();
   const lakeProtected=(await readHeights())[16*64+32];
   raw.addTile({z:0,x:0,y:0,ocean:false,width:2,height:2,heights:new Float32Array(4).fill(20),materials:new Uint8Array([2,1,2,1])});
   raw.render(matrix);await raw.device.queue.onSubmittedWorkDone();
   const coast=await readHeights();const classification={lake:coast[16*64+8],ocean:coast[16*64+56],lakeProtected};
   await new Promise(resolve=>setTimeout(resolve,40));raw.lastMeter=-Infinity;raw.render(matrix);await raw.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,40));
   const metering={landBlack:raw.targetBlack,landCenter:(raw.targetBlack+raw.targetWhite)/2,oceanCenter:(raw.targetOceanBlack+raw.targetOceanWhite)/2};
   raw.dispose();
   // Exercise the real MapLibre tile scheduler/protocol and the presentation
   // bridge together, with deterministic local DEMs and no remote requests.
   const container=document.createElement('div');Object.assign(container.style,{width:'128px',height:'64px'});document.body.append(container);
   const liveMap=new window.maplibregl.Map({container,style:{version:8,sources:{},layers:[]},center:[0,0],zoom:1,attributionControl:false});
   await new Promise(resolve=>liveMap.once('load',resolve));
   const png=async(value)=>{
    const encoded=Math.round((value+10000)*10),canvas=document.createElement('canvas');canvas.width=canvas.height=16;const context=canvas.getContext('2d');const pixels=context.createImageData(16,16);
    for(let i=0;i<pixels.data.length;i+=4){pixels.data[i]=encoded>>16;pixels.data[i+1]=(encoded>>8)&255;pixels.data[i+2]=encoded&255;pixels.data[i+3]=255;}context.putImageData(pixels,0,0);return new Uint8Array(await (await new Promise(resolve=>canvas.toBlob(resolve))).arrayBuffer());
   };
   const landPNG=await png(4500.1),oceanPNG=await png(0);let requests=0;
   window.replaymod={loadMapResource:async url=>{
    requests++;const dataset=url.includes('ocean-rgb')?'ocean-rgb':'terrain-rgb-v2';
    return url.includes('tiles.json')?new TextEncoder().encode(JSON.stringify({tiles:['https://api.maptiler.com/tiles/'+dataset+'/{z}/{x}/{y}.png'],minzoom:0,maxzoom:2})):dataset==='ocean-rgb'?oceanPNG:landPNG;
   }};
   let liveRaw;const create=RawTerrain.create;RawTerrain.create=async(...args)=>{liveRaw=await create(...args);return liveRaw;};
   const controller=new AbortController();
   let protocol;const register=window.maplibregl.addProtocol;window.maplibregl.addProtocol=(name,handler)=>{if(name==='elevation-dem')protocol=handler;register(name,handler);};
   const elevation=load('features/map/elevation');
   await elevation.addElevationGlass(liveMap,'fixture',controller.signal);
   for(let i=0;i<250;i++){if(liveRaw?.tiles.size && liveMap.areTilesLoaded())break;await new Promise(resolve=>setTimeout(resolve,20));}
   await new Promise(resolve=>setTimeout(resolve,100));
   const liveHeight=(await readHeights(liveRaw))[16*64+32];
   const integration={tiles:liveRaw.tiles.size,height:liveHeight,opacity:liveMap.getPaintProperty('elevation-glass','color-relief-opacity'),requests};
   liveRaw.fail();await new Promise(resolve=>setTimeout(resolve,0));integration.fallbackOpacity=liveMap.getPaintProperty('elevation-glass','color-relief-opacity');
   controller.abort();liveMap.remove();container.remove();
   // The legacy mask still clears lakes, but the raw renderer must receive
   // their original surface elevation before that compatibility operation.
   let alpineRaw=null;const fakeSources=new Map(),fakeLayers=new Map();
   RawTerrain.create=async()=>({addTile:tile=>{alpineRaw=tile.heights[136]},dispose(){}});
   const waterLayer={id:'Water',type:'fill',source:'water-source','source-layer':'water'};
   const fakeMap={getZoom:()=>0,getStyle:()=>({layers:[waterLayer]}),getLayer:id=>fakeLayers.get(id),addSource:(id,source)=>fakeSources.set(id,source),addLayer:layer=>fakeLayers.set(layer.id,layer),setPaintProperty(){},getSource:()=>({}),isSourceLoaded:()=>true,
    querySourceFeatures:()=>[{geometry:{type:'Polygon',coordinates:[[[-90,-66.513260443],[90,-66.513260443],[90,66.513260443],[-90,66.513260443],[-90,-66.513260443]]]}}]};
   const lakeController=new AbortController();await elevation.addElevationGlass(fakeMap,'fixture',lakeController.signal);
   const lakeURL=fakeSources.get('elevation-glass').tiles[0].replace('{z}','0').replace('{x}','0').replace('{y}','0');
   const result=await protocol({url:lakeURL},lakeController);const bitmap=await createImageBitmap(new Blob([result.data]));const legacyCanvas=document.createElement('canvas');legacyCanvas.width=legacyCanvas.height=16;const legacyContext=legacyCanvas.getContext('2d');legacyContext.drawImage(bitmap,0,0);const pixel=legacyContext.getImageData(8,8,1,1).data;const alpineLegacy=decodeElevation(pixel)[0];bitmap.close();lakeController.abort();
   return {plateau,sea,reuse,decoded,failed,errors,remainingLayers:layers.size,repaints,integration,ramp,rampRange,alpineRaw,alpineLegacy,classification,metering};
  })()`);
  assert(result.integration.tiles>0,JSON.stringify(result));assert.equal(result.integration.opacity,0);assert.equal(result.integration.fallbackOpacity,1);assert(Math.abs(result.integration.height-4500.1)<0.01,JSON.stringify(result));
  assert(Math.abs(result.alpineRaw-4500.1)<0.001,'alpine water retains its surface altitude');assert.equal(result.alpineLegacy,0,'legacy mask remains intact');
  assert(result.sea.luminance<=0.007194409291082934,'ocean cannot exceed 8% sRGB gray');
  assert(Math.abs(result.metering.landBlack-20)<0.01,'GPU meters land independently');assert(Math.abs(result.metering.oceanCenter+100)<0.01,'GPU meters ocean independently');
  assert.equal(result.failed,false,JSON.stringify(result));assert.deepEqual(result.errors,[],JSON.stringify(result));
  assert(Math.abs(result.plateau.height-4500.1)<0.001,JSON.stringify(result));
  assert(Math.abs(result.sea.height+9000.1)<0.001,JSON.stringify(result));
  assert(result.plateau.targetBlack>4000&&result.plateau.targetWhite<5000,'plateau window follows regional heights');assert(result.sea.targetWhite< -8000,'ocean window follows regional depth');
  for(const scene of [result.plateau,result.sea])assert(Math.abs(scene.luminance-scene.expected)<0.002,JSON.stringify(result));
  assert.equal(result.repaints,6,'only tile arrivals trigger MapLibre repaint; tone adaptation does not');
  assert(result.classification.lakeProtected>4000,'coarse bathymetry cannot overwrite land');assert.equal(result.classification.lake,20,'inland lake retains its surface elevation');assert.equal(result.classification.ocean,-100,'actual ocean uses bathymetry');
  assert(result.ramp.minimum>=0.010022825574869039&&result.ramp.maximum<2.0,JSON.stringify(result));assert(result.ramp.maximum-result.ramp.minimum>.5);assert.deepEqual(result.rampRange,[4000,5000]);
  assert.equal(result.reuse,true,'exposure-only frames reuse the cached R32F viewport');assert.equal(result.remainingLayers,0);
  assert(Math.abs(result.decoded[0]-4500.1)<0.001);assert(Math.abs(result.decoded[1]+9000.1)<0.001);
  console.log('Raw terrain GPU passed:',JSON.stringify(result));
 } finally {window.destroy();server.close();}
 app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
