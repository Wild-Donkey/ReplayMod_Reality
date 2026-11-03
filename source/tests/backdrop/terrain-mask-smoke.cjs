const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const compile = file => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
app.whenReady().then(async()=>{
 const window = new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 try {
  await window.loadURL('data:text/html,<html></html>');
  const result = await window.webContents.executeJavaScript(`(async()=>{
   const range={exports:{}};new Function('exports',${JSON.stringify(compile('apps/desktop/src/renderer/features/map/elevationRange.ts'))})(range.exports);
   const mask={exports:{}};new Function('exports','require',${JSON.stringify(compile('apps/desktop/src/renderer/features/map/terrainWaterMask.ts'))})(mask.exports,()=>range.exports);
   const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;
   const ctx=canvas.getContext('2d');ctx.fillStyle='rgb(2,54,104)';ctx.fillRect(0,0,8,8);
   const polygon=[
    [[-90,-66.513260443],[90,-66.513260443],[90,66.513260443],[-90,66.513260443],[-90,-66.513260443]],
    [[-45,-40.97989807],[45,-40.97989807],[45,40.97989807],[-45,40.97989807],[-45,-40.97989807]]
   ];
   const map={getStyle:()=>({layers:[{id:'Water',type:'fill',source:'planet','source-layer':'water'}]}),getSource:()=>({}),isSourceLoaded:()=>true,querySourceFeatures:()=>[{geometry:{type:'Polygon',coordinates:polygon}}]};
   await mask.exports.maskTerrainWater(map,canvas,{z:0,x:0,y:0},new AbortController().signal);
   const pixel=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3).join(',');
   const basic={land:pixel(0,0),water:pixel(2,3),island:pixel(3,3)};
   ctx.fillStyle='rgb(2,54,104)';ctx.fillRect(0,0,8,8);
   const edgeMap={...map,querySourceFeatures:()=>[{geometry:{type:'Polygon',coordinates:[[
    [-112.5,-55.776573],[112.5,-55.776573],[112.5,55.776573],[-112.5,55.776573],[-112.5,-55.776573]
   ]]}}]};
   await mask.exports.maskTerrainWater(edgeMap,canvas,{z:0,x:0,y:0},new AbortController().signal);
   const raw=ctx.getImageData(0,0,8,8).data;const values=[];
   for(let i=0;i<raw.length;i+=4)values.push(Math.round((-10000+(raw[i]*65536+raw[i+1]*256+raw[i+2])*.1)*10)/10);
   const edgeValues=[...new Set(values)].sort((a,b)=>a-b);
   ctx.fillStyle='rgb(1,95,144)';ctx.fillRect(0,0,8,8);
   await mask.exports.maskTerrainWater(map,canvas,{z:0,x:0,y:0},new AbortController().signal,'water');
   return {...basic,edgeValues,oceanLand:pixel(0,0),oceanWater:pixel(2,3),oceanIsland:pixel(3,3)};
  })()`);
  if(result.land!=='2,54,104'||result.water!=='1,134,160'||result.island!=='2,54,104')throw new Error(JSON.stringify(result));
  if(result.edgeValues.some(value=>value!==0&&value!==4500))throw new Error('Coastal mask invented elevations: '+JSON.stringify(result.edgeValues));
  if(result.oceanLand!=='1,134,160'||result.oceanWater!=='1,95,144'||result.oceanIsland!=='1,134,160')throw new Error('Ocean boundary mask failed: '+JSON.stringify(result));
  console.log('Coastal edge decoded elevations:',result.edgeValues);
  console.log('Terrain water mask passed: real canvas clears white elevation inside water, preserves land and lake islands.');
 }finally{window.destroy();}
 app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
