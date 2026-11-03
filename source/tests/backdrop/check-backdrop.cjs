const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const rangeModule = {exports: {}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/map/elevationRange.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText, {exports: rangeModule.exports, Float32Array});
const {elevationAppearance, compressedRatio} = rangeModule.exports;
const range = {minimum: -12000, maximum: 15000};
assert.equal(elevationAppearance(0, range).gray, 255);
assert.equal(elevationAppearance(0, range).alpha, 0);
assert(Math.abs(elevationAppearance(4500, range).alpha - Math.pow(0.5,0.92)) < 1e-12);
assert.equal(elevationAppearance(9000, range).alpha, 1);
assert.equal(elevationAppearance(15000, range).alpha, 1);
assert.equal(elevationAppearance(0, range, true).gray, 0);
assert.equal(elevationAppearance(0, range, true).alpha, 0.2);
assert(Math.abs(elevationAppearance(-6000, range, true).alpha - (0.2+0.8*Math.pow(6000/11000,0.92))) < 1e-12);
assert.equal(elevationAppearance(-12000, range, true).alpha, 1);
assert.equal(elevationAppearance(4500, {minimum:-100,maximum:5000}).alpha, elevationAppearance(4500,range).alpha, 'land does not change with viewport extrema');
assert.equal(elevationAppearance(NaN, range, true).alpha, elevationAppearance(-100,range,true).alpha, 'missing depth uses 100 m');
assert(compressedRatio(1000,9000)>1000/9000, 'low values gain contrast');
assert(compressedRatio(1000,9000)-compressedRatio(0,9000)>compressedRatio(9000,9000)-compressedRatio(8000,9000), 'large values are compressed');
assert.equal(elevationAppearance(-100,{minimum:-100,maximum:9000},true).alpha,elevationAppearance(-100,{minimum:-11000,maximum:9000},true).alpha,'shallow viewport must not remap 100 m to opaque black');
assert(elevationAppearance(-100,range,true).alpha<0.23,'100 m is still near the surface opacity');
assert(elevationAppearance(4500,range).alpha<0.55,'plateau stays close to its linear normalized value');
// Provider Water fills include a zoom-dependent pixel shift. It must be
// explicitly neutralized so all three geometry paths share one coastline.
const waterModule={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/map/water.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports:waterModule.exports,require:()=>rangeModule.exports});
const paints=new Map(), added=[];
const waterMap={
  getStyle:()=>({layers:[{id:'Water',type:'fill',source:'planet','source-layer':'water',paint:{'fill-translate':{stops:[[0,[0,2]],[6,[0,3]],[14,[0,0]]]}}}]}),
  setLayoutProperty(){},setPaintProperty(id,name,value){paints.set(id+':'+name,value);},
  getLayer:()=>undefined,addLayer(layer){added.push(layer);}
};
waterModule.exports.restoreWaterLayers(waterMap,range);
assert.equal(JSON.stringify(paints.get('Water:fill-translate')),'[0,0]','provider pixel translation is removed');
assert.equal(paints.get('Water:fill-outline-color'),'rgba(0,0,0,0)','avoid a second outline');
assert.equal(added.length,1,'only one explicit coastline is drawn');
assert(elevationAppearance(0,range,true).alpha<=0.2,'water surface leaves at least 24 visible gray levels over RGB30');
let protocol;
const renderer = {exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/map/elevation.ts', 'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
}).outputText, {exports:renderer.exports, URL, Uint8Array, console,
  window:{replaymod:{loadMapResource: async url => {assert(!url.includes('replayElevation')); return new Uint8Array([1,2,3]);}}},
  require:name => name === './elevationRange' ? rangeModule.exports : name === 'maplibre-gl' ? {addProtocol:(_name,handler)=>{protocol=handler;}} : {},
});
const {validateStyleMin} = require('@maplibre/maplibre-gl-style-spec');
const ramp = renderer.exports.elevationRamp(range);
const landKnots = [];
for(let i=3;i<ramp.length;i+=2) landKnots.push([ramp[i],Number(ramp[i+1].match(/,([^,]+)\)$/)[1])]);
assert(landKnots.some(([h,a])=>h>500&&h<1500&&a>h/9000+.01), 'GPU ramp carries the mild gamma curve');

for(const ocean of [false,true]) {
  const style={version:8,sources:{dem:{type:'raster-dem',tiles:['https://example.com/{z}/{x}/{y}'],tileSize:512}},layers:[{id:'relief',type:'color-relief',source:'dem',paint:{'color-relief-color':renderer.exports.elevationRamp(range,ocean)}}]};
  assert.deepEqual(validateStyleMin(style), [], 'GPU ramp passes MapLibre style validation');
}
(async()=>{
  const result=await protocol({url:'elevation-dem://api.maptiler.com/tiles/terrain-rgb-v2/0/0/0?key=test&replayElevation=missing'},new AbortController());
  assert.deepEqual([...new Uint8Array(result.data)],[1,2,3], 'raw DEM stays unchanged for GPU rendering and cache reuse');
  console.log('Elevation passed: fixed normalized domains, mild gamma curve, 100 m fallback, valid GPU ramps and raw cache path.');
})().catch(error=>{console.error(error);process.exitCode=1;});
