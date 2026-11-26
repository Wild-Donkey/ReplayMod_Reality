const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file){const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,id=>id.startsWith('.')?load(require('node:path').join(require('node:path').dirname(file),id+'.ts')):require(id));return exports;}
const {processMotionGps}=load('packages/media/src/gps-motion.ts');
const {withProcessedTrajectory,motionInputPoints}=load('apps/desktop/src/renderer/features/timeline/processedTrajectory.ts');
const {continuousSpeed,hasProcessedCoverage,smoothedSpeed}=load('apps/desktop/src/renderer/features/timeline/metrics.ts');
const {alignedMediaStart,splitAlignmentOffset,validAlignmentOffset}=load('apps/desktop/src/shared/mediaAlignment.ts');
const {fitMotionTrajectory}=load('packages/media/src/trajectory-fit.ts');
const {packMotionGpsResult,unpackMotionGpsResult}=load('apps/desktop/src/shared/motionGpsWire.ts');
const R=6371000,rad=Math.PI/180,base=1800000000,v=10,w=.2;
const point=t=>({timeSeconds:base+t,longitude:116+v/w*(1-Math.cos(w*t))/(R*Math.cos(40*rad))/rad,latitude:40+v/w*Math.sin(w*t)/R/rad});
const gps=Array.from({length:21},(_,i)=>point(i));
const imu=Array.from({length:801},(_,i)=>{const t=i/40,h=w*t;return {timeSeconds:t,quaternion:[Math.cos(h/2),0,0,Math.sin(h/2)]};});
const original=JSON.stringify(gps),result=processMotionGps(imu,gps,base);
assert.equal(validAlignmentOffset(-.375),true);
assert.equal(validAlignmentOffset(.0001),false);
assert.deepEqual(splitAlignmentOffset(750,.375),{wholeSeconds:1,residualMs:125});
assert.deepEqual(splitAlignmentOffset(-750,-.375),{wholeSeconds:-1,residualMs:-125});
const fractionalStart=alignedMediaStart(base,.375);
const fractionalResult=processMotionGps(imu,gps.map(p=>({...p,timeSeconds:p.timeSeconds+.375})),fractionalStart);
assert.equal(fractionalResult.videoStartSeconds,base+.375);
assert.equal(fractionalResult.curvedIntervals,result.curvedIntervals,'Shifted GPS and relative attitude samples must align at subsecond resolution');
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
const smooth=processMotionGps([],gps,base-2,base+20);
assert(smooth.smoothedIntervals>0,'GPS-only interpolation must smooth between fixes');
assert.equal(smooth.curvedIntervals,0);
const smoothMidpoint=smooth.points.find(p=>Math.abs(p.timeSeconds-base-.5)<.001);
assert(metres(smoothMidpoint,linear)>.03,'GPS-only smoothing must change intermediate positions');
for(const p of gps)assert.deepEqual(smooth.points.find(q=>q.timeSeconds===p.timeSeconds),p);
const stopInput=[point(0),point(1),{...point(1),timeSeconds:base+3},point(4)];
for(const p of processMotionGps([],stopInput,base).points.filter(p=>p.timeSeconds>=base+1&&p.timeSeconds<=base+3))
 assert(metres(p,point(1))<1e-6,'Parked GPS interval should not drift');
const smoothTrack=withProcessedTrajectory(raw,smooth);
assert.equal(hasProcessedCoverage(smoothTrack,(base-1)*1000),false,'Do not invent a position before the first processed fix');
assert.equal(continuousSpeed(smoothTrack,(base-1)*1000),null);
assert(continuousSpeed(smoothTrack,(base+.5)*1000)>30,'Speed chart must use processed points');
const bridged=processMotionGps(imu,gps.filter((_,i)=>i<=3||i>=16),base,base+20);
assert.equal(bridged.bridgedIntervals,1);
const gapped=withProcessedTrajectory(raw,bridged);
assert.equal(hasProcessedCoverage(gapped,(base+10)*1000),true,'Fill a bracketed gap within the clip');
assert(continuousSpeed(gapped,(base+10)*1000)>0);
const clipped=processMotionGps([], [point(0),point(120)], base+50.123, base+53.456);
assert.equal(clipped.bridgedIntervals,1);
assert.equal(clipped.points[0].timeSeconds,base+50.123);
assert.equal(clipped.points.at(-1).timeSeconds,base+53.456);
assert(clipped.contextPoints.some(p=>p.timeSeconds<base+50.123)&&clipped.contextPoints.some(p=>p.timeSeconds>base+53.456));
assert(clipped.points.length<40,'Do not resample the hours outside the clip');
const wireReference = {
  ...clipped,
  points: clipped.points.map((p, i) => i % 3 === 0 ? {...p, altitude: i ? NaN : -0} : p),
};
const packed = packMotionGpsResult(wireReference);
const transferred = structuredClone(packed, {transfer: [packed.pointData.buffer, packed.altitudePresent.buffer]});
assert.equal(packed.pointData.byteLength, 0);
assert.equal(packed.altitudePresent.byteLength, 0);
assert.deepEqual(unpackMotionGpsResult(transferred), wireReference);
const {serialize,deserialize} = require('node:v8');
assert.deepEqual(unpackMotionGpsResult(deserialize(serialize(transferred))), wireReference);
const shortWindow=processMotionGps([],gps,base+3,base+8);
const wideWindow=processMotionGps([],gps,base,base+15);
assert.deepEqual(shortWindow.points,wideWindow.points.filter(p=>p.timeSeconds>=base+3&&p.timeSeconds<=base+8));
const shortTrack=withProcessedTrajectory(raw,shortWindow),wideTrack=withProcessedTrajectory(raw,wideWindow);
for(const time of [base+3,base+8])assert.equal(smoothedSpeed(shortTrack,time*1000),smoothedSpeed(wideTrack,time*1000),'Speed at the clip edge must use the same context');
const sparse={footprintTimestamps:Array.from({length:21},(_,i)=>(base+i*10)*1000),footprintCoordinates:Array.from({length:42},()=>0)};
const analysisPoints=motionInputPoints(sparse,base+80,40);
assert.equal(analysisPoints.filter(p=>p.timeSeconds<base+80).length,8);
assert.equal(analysisPoints.filter(p=>p.timeSeconds>base+120).length,8);
const unbracketed=withProcessedTrajectory(raw,processMotionGps([], [point(10),point(11)],base,base+20));
assert.equal(hasProcessedCoverage(unbracketed,(base+2)*1000),false);
assert.equal(hasProcessedCoverage(unbracketed,(base+15)*1000),false);
console.log('Motion GPS passed: smoothing before cropping, context on both sides, bracketed gaps and missing endpoints.');

const scale=R*rad, training=[],withheld=[],turning=[];
let east=0,north=0;
for(let i=0;i<=2400;i++){
 const t=i/40, heading=.7*Math.sin(t/10)+.3*Math.sin(t/3);
 const sample={timeSeconds:base+t,longitude:east/scale,latitude:north/scale};
 turning.push({timeSeconds:t,quaternion:[Math.cos(heading/2),0,0,-Math.sin(heading/2)]});
 if(i%80===0)(t<=12||t>=50?training:withheld).push(sample);
 east+=Math.sin(heading)*.25;north+=Math.cos(heading)*.25;
}
const interpolation=processMotionGps([],training,base,base+60);
const gpsFit=fitMotionTrajectory([],training,base,base+60);
const attitudeFit=fitMotionTrajectory(turning,training,base,base+60);
const rmse=result=>Math.sqrt(withheld.reduce((sum,point)=>{
 const estimate=result.points[Math.round((point.timeSeconds-base)*10)];
 return sum+(scale*Math.hypot(estimate.longitude-point.longitude,estimate.latitude-point.latitude))**2;
},0)/withheld.length);
assert(attitudeFit.attitudeConstraints>0);
assert(rmse(attitudeFit)<rmse(gpsFit)*.75,'Attitude must improve the withheld 38 s gap');
assert(rmse(attitudeFit)<rmse(interpolation)*.75);
const long=Array.from({length:81},(_,index)=>({timeSeconds:base+index*10,longitude:0,latitude:index*90/scale}));
const stitched=fitMotionTrajectory([],long,base,base+800);
assert.equal(stitched.fittedWindows,4);
assert.equal(stitched.points.length,8001);
for(const time of [236,296,476,536,716,776]){
 const i=time*10;
 const v1=(stitched.points[i].latitude-stitched.points[i-1].latitude)*scale*10;
 const v2=(stitched.points[i+1].latitude-stitched.points[i].latitude)*scale*10;
 assert(Math.abs(v1-v2)<.01,'Velocity must not jump at an overlap edge');
}
const parked=fitMotionTrajectory([],[long[0]],base,base+15);
assert(parked.points.every(point=>Math.abs(point.latitude)<1e-10&&Math.abs(point.longitude)<1e-10));
console.log('Continuous fit RMSE across withheld 38 s (m):', [interpolation,gpsFit,attitudeFit].map(result=>rmse(result).toFixed(2)));

async function checkLatestJobQueue() {
  const {LatestJobQueue}=load('apps/desktop/src/main/latestJobQueue.ts');
  const started=[],published=[],failures=[],release=new Map(),signals=new Map();
  const queue=new LatestJobQueue(async (job,isCurrent,signal)=>{
    started.push(job);
    signals.set(job,signal);
    await new Promise(resolve=>release.set(job,resolve));
    if(job==='failed')throw new Error(job);
    if(isCurrent())published.push(job);
  },error=>failures.push(error.message));
  const settled=()=>new Promise(resolve=>setImmediate(resolve));
  queue.post('first');
  queue.post('obsolete');
  queue.post('latest');
  assert.deepEqual(started,['first']);
  assert.equal(signals.get('first').aborted,true);
  release.get('first')();
  await settled();
  assert.deepEqual(started,['first','latest']);
  assert.deepEqual(published,[]);
  release.get('latest')();
  await settled();
  assert.deepEqual(published,['latest']);
  queue.post('running');
  queue.post('cancelled');
  queue.cancel(job=>job==='cancelled');
  assert.equal(signals.get('cancelled'),undefined);
  release.get('running')();
  await settled();
  assert.deepEqual(started,['first','latest','running']);
  assert.deepEqual(published,['latest']);
  queue.post('manual');
  queue.cancel(job=>job==='manual');
  assert.equal(signals.get('manual').aborted,true);
  release.get('manual')();
  await settled();
  queue.post('failed');
  release.get('failed')();
  await settled();
  assert.deepEqual(failures,['failed']);
  queue.post('recovery');
  release.get('recovery')();
  await settled();
  assert.deepEqual(published,['latest','recovery']);
  console.log('GPS queue passed: newest pending request wins, obsolete results and cancelled work are discarded, and failure does not block the queue.');
}
checkLatestJobQueue().catch(error=>{console.error(error);process.exitCode=1;});
