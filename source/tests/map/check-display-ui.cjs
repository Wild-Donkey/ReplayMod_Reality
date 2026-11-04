const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const root=path.resolve(__dirname,'../../apps/desktop/src/renderer');
const compile=file=>ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
let state;
const settings={exports:{}};vm.runInNewContext(compile('features/settings/HDRSettings.tsx'),{exports:settings.exports,require:name=>name.includes('displayHDR')?{useHDRState:()=>state,setHDREnabled(){}}:require(name)});
for(const supported of [null,false,true]){
 state={supported,enabled:true,active:supported===true,label:'Fixture'};
 const html=renderToStaticMarkup(React.createElement(settings.exports.HDRSettings));
 assert(html.includes('role="switch"'));assert.equal(html.includes('disabled=""'),supported!==true);assert.equal(html.includes('checked=""'),supported===true);
}
const exposure={exports:{}};vm.runInNewContext(compile('features/map/terrainExposure.ts'),{exports:exposure.exports});
const legend={exports:{}};vm.runInNewContext(compile('features/map/TerrainLegend.tsx'),{exports:legend.exports,require:name=>name.includes('terrainExposure')?exposure.exports:name.startsWith('.')?{}:require(name)});
const html=renderToStaticMarkup(React.createElement(legend.exports.TerrainLegend,{appearance:{land:[123,1494],depth:[120,830],black:100,white:1500,headroom:2.67}}));
for(const text of ['123','1,494 m','120','830 m'])assert(html.includes(text));
assert(!html.includes('9,000 m')&&!html.includes('11,000 m'),'fixed global ticks are gone');
assert.equal((html.match(/<canvas/g)||[]).length,2,'both legends use floating-point colour canvases');
const landOnly=renderToStaticMarkup(React.createElement(legend.exports.TerrainLegend,{appearance:{land:[4500,4500],depth:null,black:4300,white:4700,headroom:1}}));
assert(landOnly.includes('4,500 m')&&landOnly.includes('当前视野无水域'));
console.log('Display UI passed: disabled HDR switch, checked state, dynamic land/depth ticks, floating-point legends and absent-water indication.');
