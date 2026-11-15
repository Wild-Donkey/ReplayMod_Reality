const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file){const exports={};new Function('exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports);return exports;}
const {processMotionGps}=load('packages/media/src/gps-motion.ts');
const {withProcessedTrajectory}=load('apps/desktop/src/renderer/features/timeline/processedTrajectory.ts');
const R=6371000,rad=Math.PI/180,base=1800000000,v=10,w=.2;
const point=t=>({timeSeconds:base+t,longitude:116+v/w*(1-Math.cos(w*t))/(R*Math.cos(40*rad))/rad,latitude:40+v/w*Math.sin(w*t)/R/rad});
const gps=Array.from({length:21},(_,i)=>point(i));
const imu=Array.from({length:801},(_,i)=>{const t=i/40,h=w*t;return {timeSeconds:t,quaternion:[Math.cos(h/2),0,0,Math.sin(h/2)]};});
const original=JSON.stringify(gps),result=processMotionGps(imu,gps,base);
assert.equal(JSON.stringify(gps),original,'Never mutate input GPS');
assert.equal(result.points.length,201);assert(result.curvedIntervals>=18,result.reason);
for(const p of gps){const anchor=result.points.find(q=>q.timeSeconds===p.timeSeconds);assert.equal(anchor.longitude,p.longitude);assert.equal(anchor.latitude,p.latitude);}
const metres=(a,b)=>Math.hypot((a.longitude-b.longitude)*rad*R*Math.cos(40*rad),(a.latitude-b.latitude)*rad*R);
const curved=result.points.find(p=>Math.abs(p.timeSeconds-base-.5)<.001),linear={longitude:(gps[0].longitude+gps[1].longitude)/2,latitude:(gps[0].latitude+gps[1].latitude)/2};
assert(metres(curved,point(.5))<metres(linear,point(.5))*.15,'Gyro interpolation should recover curved paths between anchors');
const free=imu.map((s,i)=>{const h=Math.sin(i/8)*2;return {...s,quaternion:[Math.cos(h/2),0,0,Math.sin(h/2)]};});
assert.equal(processMotionGps(free,gps,base).curvedIntervals,0,'Free camera rotation must not deform GPS');
assert.equal(processMotionGps([],gps,base).curvedIntervals,0);
assert.equal(processMotionGps(imu,[gps[0],gps[20]],base).points.length,2,'Do not invent positions through outages');
const spike=gps.map(p=>({...p}));spike[10].latitude+=.02;
const repaired=processMotionGps(imu,spike,base);assert.equal(repaired.correctedPoints,1);assert(metres(repaired.points.find(p=>p.timeSeconds===base+10),gps[10])<2);
const raw={sourceName:'original.csv',timelineTimestamps:[(base-1)*1000,base*1000,(base+20)*1000,(base+21)*1000],timelineCoordinates:[116,40,116,40,gps[20].longitude,gps[20].latitude,116,40],timelineAltitudes:[0,10,30,40],footprintCoordinates:[1,2],photoCoordinates:[],footprintTimestamps:[1],photoTimestamps:[],pointCount:1,footprintPointCount:1,photoPointCount:0,skippedRowCount:0,bounds:[116,40,117,41],timeBounds:[(base-1)*1000,(base+21)*1000]};
const before=JSON.stringify(raw),derived=withProcessedTrajectory(raw,result);
assert.equal(JSON.stringify(raw),before);assert.equal(derived.sourceName,raw.sourceName);assert.equal(derived.footprintCoordinates,raw.footprintCoordinates);assert.equal(derived.timelineTimestamps[0],raw.timelineTimestamps[0]);assert.equal(derived.timelineTimestamps.at(-1),raw.timelineTimestamps.at(-1));assert.equal(derived.timelineAltitudes[1],10);assert.equal(derived.timelineAltitudes.at(-2),30);
assert(derived.timelineTimestamps.every((t,i)=>!i||t>derived.timelineTimestamps[i-1]));
console.log('Motion GPS passed: curved accuracy, 10 Hz, preserved anchors/source, spike repair, free-camera rejection, fallback, outages and derived timeline.');
