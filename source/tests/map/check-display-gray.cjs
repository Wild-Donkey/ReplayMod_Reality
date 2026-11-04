const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../apps/desktop/src/renderer/features/map');
const compile=file=>ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const hdrCode=ts.transpileModule(fs.readFileSync(path.resolve(root,'../../shared/hdr.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exposure={exports:{}};vm.runInNewContext(compile('terrainExposure.ts'),{exports:exposure.exports});
const shaders={exports:{}};vm.runInNewContext(compile('terrainShaders.ts'),{exports:shaders.exports,require:()=>exposure.exports});
app.setPath('userData',fs.mkdtempSync('/tmp/replay-gray-test-'));
app.whenReady().then(async()=>{
 const server=http.createServer((q,r)=>r.end('<body style="margin:0;display:flex"><canvas width="200" height="100" style="flex-shrink:0;width:200px;height:100px"></canvas><div style="flex-shrink:0;width:100px;height:100px;background:rgb(26,26,26)"></div><div style="flex-shrink:0;width:100px;height:100px;background:rgb(20,20,20)"></div>'));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const window=new BrowserWindow({show:false,useContentSize:true,width:400,height:150,webPreferences:{contextIsolation:true}});
 try{
  await window.loadURL('http://127.0.0.1:'+server.address().port);
  await window.webContents.executeJavaScript(`(async()=>{
   const device=await(await navigator.gpu.requestAdapter()).requestDevice();window.testDevice=device;
   const context=document.querySelector('canvas').getContext('webgpu');context.configure({device,format:'rgba16float',alphaMode:'opaque',toneMapping:{mode:'standard'}});
   const texture=device.createTexture({size:[200,100],format:'rg32float',usage:6});const data=new Float32Array(200*100*2);
   for(let y=0;y<100;y++)for(let x=0;x<200;x++){data[(y*200+x)*2]=x<100?0:1000000;data[(y*200+x)*2+1]=Number(x>=100);}
   device.queue.writeTexture({texture},data,{bytesPerRow:1600},[200,100]);
   const settings=device.createBuffer({size:32,usage:0x48});device.queue.writeBuffer(settings,0,new Float32Array([0,1,400,0,0,1,400,0]));
   const module=device.createShaderModule({code:${JSON.stringify(shaders.exports.toneShader)}});
   const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:'rgba16float'}]}});
   const binding=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView()},{binding:1,resource:{buffer:settings}}]});
   const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}]});
   pass.setPipeline(pipeline);pass.setBindGroup(0,binding);pass.draw(3);pass.end();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();
  })()`);
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const image=await window.webContents.capturePage(),size=image.getSize(),pixels=image.toBitmap(),ratio=size.width/400;
  const gray=x=>pixels[(Math.floor(30*ratio)*size.width+Math.floor(x*ratio))*4];
  const measured={land:gray(50),ocean:gray(150),reference10:gray(250),reference8:gray(350)};
  assert(Math.abs(measured.land-measured.reference10)<=1,JSON.stringify(measured));
  assert(measured.ocean<=measured.reference8&&measured.ocean>=measured.reference8-5,JSON.stringify(measured));
  const foreground=await window.webContents.executeJavaScript(`(async()=>{
    const exports={};new Function('exports','require',${JSON.stringify(hdrCode)})(exports,name=>name==='./gpu'?{requestGPUDevice:async()=>window.testDevice}:{getHDRState:()=>({active:true}),currentHDRHeadroom:()=>1,watchDisplayHDR:()=>()=>{}});
    const container=document.createElement('div');Object.assign(container.style,{position:'absolute',left:0,top:0,width:'100px',height:'100px'});document.body.append(container);
    const canvas=document.createElement('canvas');canvas.width=canvas.height=100;container.append(canvas);const context=canvas.getContext('2d');context.fillStyle='rgb(128,128,128)';context.fillRect(0,0,100,100);
    window.testPresentation=exports.presentHDR(canvas);
    for(let i=0;i<100&&canvas.style.opacity!=='0';i++)await new Promise(resolve=>setTimeout(resolve,10));
    await window.testDevice.queue.onSubmittedWorkDone();
    return canvas.style.opacity;
  })()`);
  assert.equal(foreground,'0','foreground HDR shader must compile and replace its source');
  const foregroundImage=await window.webContents.capturePage(),foregroundPixels=foregroundImage.toBitmap();
  const foregroundGray=foregroundPixels[(Math.floor(30*ratio)*foregroundImage.getSize().width+Math.floor(50*ratio))*4];
  assert(Math.abs(foregroundGray-128)<=1,'foreground must preserve 50% gray at unit headroom');
  console.log('Final display pixels passed:',JSON.stringify({...measured,foreground:foregroundGray}));
 }finally{window.destroy();server.close();}
 app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
