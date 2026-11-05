const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const mod={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('apps/desktop/src/renderer/features/map/basemapStyle.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
}).outputText,{exports:mod.exports});
const {BUILDING_HEIGHT_SCALE,ROAD_OPACITY_SCALE,isRoadLayer,buildingOpacity,styleRoadLayers,hideRoadLayers,addElevationBuildings}=mod.exports;
assert.equal(BUILDING_HEIGHT_SCALE,10);
assert.equal(ROAD_OPACITY_SCALE,0.52);
assert(isRoadLayer({id:'Road primary',type:'line',source:'planet','source-layer':'transportation'}));
assert(!isRoadLayer({id:'Rail',type:'line',source:'planet','source-layer':'transportation'}));
assert.equal(buildingOpacity[2][0],'*');
const paints=new Map(),layouts=new Map(),added=[];
const layers=[
  {id:'Road motorway',type:'line',source:'planet','source-layer':'transportation'},
  {id:'Road residential',type:'line',source:'planet','source-layer':'transportation'},
  {id:'Building',type:'fill-extrusion',source:'planet','source-layer':'building',minzoom:13},
  {id:'City label',type:'symbol',source:'planet','source-layer':'place'},
];
const map={getStyle:()=>({layers}),setPaintProperty:(id,key,value)=>paints.set(`${id}:${key}`,value),setLayoutProperty:(id,key,value)=>layouts.set(`${id}:${key}`,value),getLayer:()=>undefined,addLayer:(layer,before)=>added.push({layer,before})};
styleRoadLayers(map);
assert.equal(paints.get('Road motorway:line-color'),'#ffffff');
assert(paints.get('Road motorway:line-opacity')<0.5);
assert(paints.get('Road motorway:line-opacity')>paints.get('Road residential:line-opacity'));
assert(paints.get('Road motorway:line-width')[4]>paints.get('Road residential:line-width')[4]);
styleRoadLayers(map,true);
assert.equal(paints.get('Road motorway:line-opacity'),1);
assert.equal(paints.get('Road motorway:line-color'),'#ffffff');
assert.equal(paints.get('Road residential:line-color'),'#929292');
assert.equal(paints.get('Road motorway:line-dasharray'),null);
hideRoadLayers(map);
assert.equal(layouts.get('Road motorway:visibility'),'none');
assert(addElevationBuildings(map));
assert.equal(layouts.get('Building:visibility'),'none');
assert.equal(added[0].layer.type,'fill');
assert.equal(added[0].layer['source-layer'],'building');
assert(!('fill-outline-color' in added[0].layer.paint));
assert.equal(added[0].layer.minzoom,7);
assert.equal(added[0].before,'City label');
console.log('Basemap style passed: white road hierarchy and 10x 2D building height shading.');
