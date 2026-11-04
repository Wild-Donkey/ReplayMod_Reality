const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const assert = require('node:assert/strict');
const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../apps/desktop/src/renderer/features/map/footprintDensity.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
app.whenReady().then(async () => {
 const window = new BrowserWindow({show:false, webPreferences:{contextIsolation:true}});
 try {
  await window.loadURL('data:text/html,<html></html>');
  const result = await window.webContents.executeJavaScript(`(() => {
   const mod = {exports:{}};
   new Function('exports','require',${JSON.stringify(code)})(mod.exports,()=>({MercatorCoordinate:{fromLngLat:()=>({x:0,y:0})}}));
   const {FootprintDensity,footprintOpacity,footprintRadius} = mod.exports;
   const canvas = document.createElement('canvas'); canvas.width=canvas.height=32;
   Object.defineProperty(canvas,'clientWidth',{value:32});
   const gl = canvas.getContext('webgl2', {antialias:false});
   if(!gl)throw new Error('No WebGL2');
   const map={getCanvas:()=>canvas,getZoom:()=>14,getCenter:()=>({lng:0}),triggerRepaint:()=>{}};
   const layer=new FootprintDensity([0,0]); layer.onAdd(map,gl);
   const matrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
   const sample=n=>{
     layer.setCoordinates(Array.from({length:n*2},()=>0));
     layer.prerender(gl,{defaultProjectionData:{mainMatrix:matrix}});
     gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,32,32);
     gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
     layer.render();
     const pixel=new Uint8Array(4);gl.readPixels(16,16,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
     const error=gl.getError();if(error)throw new Error('WebGL error '+error);
     return pixel[3]/255;
   };
   const counts=[0,1,2,4,16,64,256];
   const measured=counts.map(sample);
   const expected=counts.map(footprintOpacity);
   layer.onRemove();
   return {measured,expected,radii:[1,8,14].map(footprintRadius)};
  })()`);
  result.measured.forEach((value,i)=>assert(Math.abs(value-result.expected[i])<0.01, JSON.stringify(result)));
  assert.deepEqual(result.radii,[0.6,1.1,2]);
  assert(result.measured[3]-result.measured[2]<result.measured[2]-result.measured[1]*0.5);
  console.log('Real WebGL density passed: float accumulation, logarithmic overlap, half radii, zero coverage and GPU cleanup.',JSON.stringify(result));
 } finally {window.destroy();}
 app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
