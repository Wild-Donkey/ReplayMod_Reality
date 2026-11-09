const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const assert = require('node:assert/strict');
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../apps/desktop/src/renderer/render-engine/FootprintDensityPass.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
app.whenReady().then(async () => {
 const window = new BrowserWindow({show:false, webPreferences:{contextIsolation:true}});
 try {
  await window.loadURL('data:text/html,<html></html>');
  const result = await window.webContents.executeJavaScript(`(() => {
   const mod = {exports:{}};
   new Function('exports',${JSON.stringify(code)})(mod.exports);
   const {FootprintDensityPass,footprintTone,footprintIntensity,footprintRadius,footprintRouteWidth} = mod.exports;
   const canvas = document.createElement('canvas'); canvas.width=canvas.height=32;
   let cssWidth=32;
   Object.defineProperty(canvas,'clientWidth',{get:()=>cssWidth});
   const gl = canvas.getContext('webgl2', {antialias:false});
   if(!gl)throw new Error('No WebGL2');
   let repaints=0;
   const layer=new FootprintDensityPass([0,0],[],(x,y)=>({x,y}),()=>{repaints++}); layer.attach(gl);
   const matrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
   const readPixel=(x,y)=>{
     const pixel=new Uint8Array(4);gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
     const error=gl.getError();if(error)throw new Error('WebGL error '+error);
     return [pixel[0]/255,pixel[1]/255,pixel[2]/255,pixel[3]/255];
   };
   let adapt=false;
   const renderOnce=()=>{
     // Fixed-curve checks hold adaptation time still; adaptive checks advance it.
     layer.lastFrame=adapt ? performance.now()-100 : 0;
     layer.accumulate({matrix,zoom:14,centerLongitude:0,cssWidth});
     gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,32,32);
     gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
     layer.compositeToViewport();
   };
   const sample=n=>{
     layer.setCoordinates(Array.from({length:n*2},()=>0));
     renderOnce();
     return readPixel(16,16);
   };
   const counts=[0,1,2,4,16,64,256];
   const measured=counts.map(sample);
   const expected=counts.map(n=>{const t=footprintTone(n);return [t.r,t.g,t.b,t.a];});
   // Line mode: coinciding strokes use the same convergent arctan response and
   // mint-to-white desaturation as point coverage. The clip-space segment spans
   // 16 device pixels horizontally through the centre under an identity matrix.
   layer.setMode('line');
   const lineSample=n=>{
     layer.setLinePaths(Array.from({length:n},()=>[[-0.25,0],[0.25,0]]));
     renderOnce();
     return readPixel(16,16);
   };
   const lineCounts=[1,2,4,16];
   const lineMeasured=lineCounts.map(lineSample);
   const lineExpected=lineCounts.map(n=>{const t=footprintTone(n);return [t.r,t.g,t.b,t.a];});
   // Homogeneous matrix scaling leaves projected positions and pixel widths
   // unchanged. Real map cameras have w far from one.
   const baseMatrix=matrix.slice();
   matrix.forEach((value,index)=>matrix[index]=value*10000);
   const scaledLine=lineSample(1);
   matrix.set(baseMatrix);
   const dprWidths=[1,2,3].map(dpr=>{
     cssWidth=32/dpr;
     lineSample(1);
     let width=0;
     for(let y=0;y<32;y++)if(readPixel(16,y)[3]>0.02)width++;
     return width;
   });
   cssWidth=32;
   layer.setVisible(false);
   renderOnce();
   const hiddenLine=readPixel(16,16);
   layer.setVisible(true);
   const revealedLine=lineSample(1);
   layer.setLinePaths(Array.from({length:16},()=>[[-0.25,0],[0.25,0]]));
   renderOnce();
   const outsideStroke=readPixel(16,20);
   // Multi-vertex ribbon with a corner: the TRIANGLE_STRIP miter join must stay
   // a continuous stroke along both segments (2-point paths never exercise the
   // previous/next vertex carry-over). NDC path maps to pixels (12,16) ->
   // (16,14.4) -> (20,16) on the 32 px canvas.
   const bent=[];
   layer.setLinePaths([[[-0.25,0],[0,-0.1],[0.25,0]]]);
   renderOnce();
   [[13,16],[14,15],[16,15],[18,15],[19,16]].forEach(([x,y])=>bent.push(readPixel(x,y)));
   const bentOutside=readPixel(16,22);
   layer.setLinePaths([]);
   renderOnce();
   const noPaths=readPixel(16,16);
   layer.setMode('points');
   const restoredPoints=sample(64);
   adapt=true;
   layer.setCoordinates([...Array.from({length:128},()=>0),0.5,0]);
   layer.exposure=0;
   renderOnce();
   const exposureBefore=readPixel(16,16);
   const sparseBefore=readPixel(24,16);
   for(let i=0;i<45;i++)renderOnce();
   const exposureAfter=readPixel(16,16);
   const sparseAfter=readPixel(24,16);
   const settledExposure=layer.exposure;
   // A camera change immediately after metering still requests a future frame.
   layer.lastMeter=performance.now();
   layer.targetExposure=layer.exposure;
   matrix[12]=0.01;
   repaints=0;
   renderOnce();
   const finalViewRepaint=repaints;
   layer.destroy();
   return {
     sparseBefore,sparseAfter,exposureBefore,exposureAfter,settledExposure,finalViewRepaint,
     measured,expected,radii:[1,8,14].map(footprintRadius),
     lineMeasured,lineExpected,scaledLine,dprWidths,hiddenLine,revealedLine,outsideStroke,noPaths,restoredPoints,bent,bentOutside,
     restoredExpected:(()=>{const t=footprintTone(64);return [t.r,t.g,t.b,t.a];})(),singleBaseline:footprintIntensity(1),
     routeWidths:[1,8,14,15].map(footprintRouteWidth),
   };
  })()`);
  const channels=['r','g','b','a'];
  const comparePixel=(actual,expected,tolerance,label)=>{
    channels.forEach((_,i)=>assert(Math.abs(actual[i]-expected[i])<tolerance,
      label+' channel '+channels[i]+' '+JSON.stringify({actual,expected})));
  };
  result.measured.forEach((pixel,i)=>comparePixel(pixel,result.expected[i],0.015,'coverage index '+i));
  assert.deepEqual(result.radii,[0.6,1.1,2]);
  // A single coverage is the just-visible baseline rather than a bright stroke.
  assert(Math.abs(result.singleBaseline-0.20)<1e-9);
  assert(Math.abs(result.measured[1][3]-0.20)<0.015, JSON.stringify(result.measured[1]));
  // Arctan converges: strictly increasing while the tail compresses, and very
  // heavy overlap approaches pure white in every channel instead of clipping.
  const alpha=result.measured.map(pixel=>pixel[3]);
  for(let i=1;i<alpha.length;i+=1) assert(alpha[i]>alpha[i-1],'response must be strictly increasing '+JSON.stringify(alpha));
  assert(alpha[6]-alpha[5]<alpha[2]-alpha[1],'response must converge at the tail '+JSON.stringify(alpha));
  result.measured[6].forEach(value=>assert(value>0.97,'heavy overlap must be near pure white '+JSON.stringify(result.measured[6])));
  result.lineMeasured.forEach((pixel,i)=>comparePixel(pixel,result.lineExpected[i],0.03,'route strokes'));
  comparePixel(result.scaledLine,result.lineMeasured[0],0.015,'homogeneous projection preserves stroke width');
  assert(result.dprWidths[1]>result.dprWidths[0] && result.dprWidths[2]>result.dprWidths[1], 'DPR scales physical stroke width '+JSON.stringify(result.dprWidths));
  comparePixel(result.hiddenLine,[0,0,0,0],0.001,'hidden density pass');
  comparePixel(result.revealedLine,result.lineMeasured[0],0.015,'revealed density pass');
  // Sixteen coincident strokes stay far below sixteen times a single stroke.
  assert(result.lineMeasured[3][3] < result.lineMeasured[0][3] * 8, 'repeated strokes must compress '+JSON.stringify(result.lineMeasured));
  // Mint tint at low intensity, desaturating towards white as overlap grows.
  // RGB is premultiplied, so compare the un-premultiplied light colour.
  const single=result.lineMeasured[0], singleA=Math.max(single[3],1e-6);
  const heavy=result.measured[6], heavyA=Math.max(heavy[3],1e-6);
  assert(single[1]/singleA>single[0]/singleA,'mint has green over red at low coverage '+JSON.stringify(single));
  const singleTint=single[1]/singleA-single[0]/singleA;
  const heavyTint=heavy[1]/heavyA-heavy[0]/heavyA;
  assert(heavyTint<singleTint*0.6,'mint must desaturate as overlap grows '+JSON.stringify({single,heavy}));
  [0,1,2].forEach(i=>assert(heavy[i]/heavyA>0.85,'heavy route overlap light colour must be near white '+JSON.stringify(heavy)));
  assert(result.outsideStroke.every(value=>value<0.02), 'coverage leaked outside the stroke '+JSON.stringify(result.outsideStroke));
  assert(result.noPaths.every(value=>value===0), 'empty line paths must render nothing '+JSON.stringify(result.noPaths));
  // The bent multi-vertex ribbon stays covered on both segments and through the
  // miter corner; a single coverage reads near the 0.20 baseline at its centre.
  result.bent.forEach((pixel,i)=>assert(pixel[3]>0.05, 'bent ribbon gap at sample '+i+' '+JSON.stringify(pixel)));
  assert(result.bentOutside.every(value=>value<0.02), 'bent ribbon leaked outside the stroke '+JSON.stringify(result.bentOutside));
  comparePixel(result.restoredPoints,result.restoredExpected,0.015,'points mode restore');
  assert.deepEqual(result.routeWidths,[0.7,1.4,2.4,2.4]);
  assert(result.exposureBefore[3]>0.9, 'dense reference must start bright');
  assert(result.exposureAfter[3]<0.7, 'GPU composite must actually darken after adaptation '+JSON.stringify(result));
  comparePixel(result.sparseAfter,result.sparseBefore,0.005,'sparse route visibility during adaptation');
  assert(result.sparseAfter[3]>=0.19,'isolated route must stay visible');
  assert(result.settledExposure < -3.9, 'meter must detect dense tracks');
  assert(result.finalViewRepaint>0, 'final camera frame within cooldown must schedule metering');
  console.log('Real WebGL density passed: float accumulation, convergent arctan response, mint-to-white heavy overlap, stacked route strokes, zoom route widths and cleanup.',JSON.stringify(result));
 } finally {window.destroy();}
 app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
