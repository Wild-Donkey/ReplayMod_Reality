const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const mod={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../../apps/desktop/src/renderer/features/map/terrainExposure.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:mod.exports});
const {elevationRadiance,exposureFromHistogram,adaptExposure,terrainLuminance,decodeElevation}=mod.exports;
const histogram=(height,count=576)=>{const data=new Uint32Array(256);data[Math.max(0,Math.min(255,Math.floor((height+12000)/22000*256)))]=count;return data;};
assert.equal(exposureFromHistogram(new Uint32Array(256)),null,'unloaded pixels do not alter exposure');
assert(exposureFromHistogram(histogram(4500))<0,'plateaus darken');
assert(exposureFromHistogram(histogram(-9000))>5,'deep sea brightens');
assert.equal(exposureFromHistogram(histogram(4500,1)),exposureFromHistogram(histogram(4500,576)),'resolution-independent metering');
const scene=histogram(4500);scene[255]=1;
assert.equal(exposureFromHistogram(scene),exposureFromHistogram(histogram(4500)),'a tiny summit must not drive overall exposure');
for(const headroom of [1,2.67,16])for(const ev of [-4,0,6,10]){
 let last=-1;
 for(let height=-11000;height<=9000;height+=100){const l=terrainLuminance(height,ev,headroom);assert(l>=last&&l<=headroom&&l>=0);last=l;}
}
for(const height of [-11000,-9000,0,4500,9000]){
 const code=Math.round((height+10000)*10);
 // Terrain-RGB has an encoding floor of -10000 m; deeper sources use their
 // provider's representable values. Verify all representable sub-metre data.
 if(code<0)continue;
 const bytes=new Uint8ClampedArray([code>>16,(code>>8)&255,code&255,255]);
 assert(Math.abs(decodeElevation(bytes)[0]-height)<0.001);
}
assert(elevationRadiance(-9000)>0,'dark ocean remains recoverable before exposure');
let one=adaptExposure(-1,6,1000),many=-1;
for(let i=0;i<100;i++)many=adaptExposure(many,6,10);
assert(Math.abs(one-many)<1e-12,'adaptation is independent of frame rate');
assert(one>-1&&one<6,'adaptation never overshoots');
assert.equal(adaptExposure(1,2,0),1);
console.log('Terrain exposure passed: raw precision, bright/dark scenes, sparse highlights, monotonic HDR shoulder, empty coverage, resolution and frame-rate invariance.');
const {toneWindowFromHistogram,mappedTerrainLuminance,rangeFromMeter}=mod.exports;
assert.equal(toneWindowFromHistogram(new Uint32Array(256)),null);
const regional=histogram(4000);regional.fill(0);for(let h=4000;h<=5000;h+=10)regional[Math.floor((h+12000)/22000*256)]++;
const window=toneWindowFromHistogram(regional);
assert(window[0]>3900&&window[1]<5100,'use the regional height window');
for(const limit of [1,2.67,16]) {
 const low=mappedTerrainLuminance(window[0],...window,limit),high=mappedTerrainLuminance(window[1],...window,limit);
 assert(low>.01&&high<limit*.9,'reserve shadow and highlight margins');assert(high-low>.15,'retain regional contrast above the land floor');
 let last=0;for(let h=3000;h<6000;h+=10){const l=mappedTerrainLuminance(h,...window,limit);assert(l>=last&&l<=limit);last=l;}
}
const meter=new Uint32Array(516);meter.set(histogram(4500));
const bits=value=>new Uint32Array(new Float32Array([value]).buffer)[0];
meter[512]=bits(20000-4500);meter[513]=bits(4500+20000);
assert.equal(JSON.stringify(rangeFromMeter(meter)),JSON.stringify([4500,4500]));
assert.equal(rangeFromMeter(meter,true),null,'do not show an ocean range when none is visible');
const flat=toneWindowFromHistogram(meter);assert.equal(flat[1]-flat[0],400,'do not amplify tiny DEM noise');assert.equal((flat[0]+flat[1])/2,4500);
console.log('Regional tone mapping passed: current ranges, absent land/ocean, bright peaks near HDR limit, monotonic tails and flat-ground guard.');

const tail = new Uint32Array(256);tail[200]=9980;tail[240]=15;tail[255]=5;
const p999 = toneWindowFromHistogram(tail);
assert(Math.abs(p999[1]-(-12000+(240.5)/256*22000))<1e-8,'P99.9 includes the top 0.2% group but excludes the top 0.05% outliers');
console.log('P99.9 white-point regression passed.');

const linear=gray=>((gray+.055)/1.055)**2.4;
for(const headroom of [1,2.67,16])for(const height of [-10000,-100,0,100,9000]) {
 const land=mappedTerrainLuminance(height,-1000,1000,headroom,false);
 const ocean=mappedTerrainLuminance(height,-1000,1000,headroom,true);
 assert(land>=linear(.1)&&land<=headroom,'10% gray is a land floor, including below-sea-level land');
 assert(ocean>=0&&ocean<=linear(.08),'8% gray is an ocean ceiling, including coast pixels');
}
assert(mappedTerrainLuminance(4500,-1000,5000,2.67,false)>mappedTerrainLuminance(100,-1000,5000,2.67,false),'alpine lake surface can still brighten with altitude');
console.log('Material limits passed: 10% sRGB land floor, 8% sRGB ocean ceiling, independent of HDR headroom and elevation sign.');

const oceanMid = mappedTerrainLuminance(-9000,-9200,-8800,2.67,true);
assert(oceanMid>linear(.05)&&oceanMid<linear(.08),'8% is a soft highlight ceiling, not a multiplier that blacks out the sea');
assert(mappedTerrainLuminance(-9100,-9200,-8800,2.67,true)<oceanMid,'ocean retains depth contrast');
console.log('Ocean shoulder regression passed: visible midtones below the 8% ceiling.');

const {materialToneWindow}=mod.exports;
const split=new Uint32Array(516);split.set(histogram(100,900));split[200]=1;
split.set(histogram(-9000,10000),256);
const independentLand=materialToneWindow(split),independentOcean=materialToneWindow(split,true);
split.set(histogram(-100,1000000),256);
assert.equal(JSON.stringify(materialToneWindow(split)),JSON.stringify(independentLand),'ocean depth and coverage cannot move land black/white points');
split.set(histogram(-9000,10000),256);split.fill(0,0,256);split.set(histogram(7000,1000000));
assert.equal(JSON.stringify(materialToneWindow(split,true)),JSON.stringify(independentOcean),'land altitude and coverage cannot move ocean black/white points');
split.fill(0,0,256);assert.equal(materialToneWindow(split),null,'absent land must not borrow the ocean window');
console.log('Independent metering passed: land/ocean windows are invariant to the other material depth, altitude and coverage.');

for(const headroom of [1,2.67,16]) {
 for(const height of [-100,0,4500]) {
  const floor=mappedTerrainLuminance(height,height,height+1000,headroom,false);
  assert.equal(floor,mod.exports.LAND_MIN_LINEAR,'land P2 must hit the 10% gray anchor exactly');
  assert.equal(mappedTerrainLuminance(height-100,height,height+1000,headroom,false),floor,'lower outliers retain the gray floor');
  assert(mappedTerrainLuminance(height+100,height,height+1000,headroom,false)>floor,'higher ground retains contrast');
 }
}
const flatLandWindow=materialToneWindow(meter);
assert.equal(flatLandWindow[0],4500,'flat-land protection cannot lower the black anchor');
assert.equal(mappedTerrainLuminance(4500,...flatLandWindow,2.67,false),mod.exports.LAND_MIN_LINEAR);
console.log('Land black-point anchor passed: P2 reaches 10% gray, including flat terrain; higher terrain preserves contrast.');
