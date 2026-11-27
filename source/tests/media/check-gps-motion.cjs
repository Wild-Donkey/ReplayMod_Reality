const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file){const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,id=>id.startsWith('.')?load(require('node:path').join(require('node:path').dirname(file),id+'.ts')):require(id));return exports;}
const {withProcessedTrajectory,motionInputPoints}=load('apps/desktop/src/renderer/features/timeline/processedTrajectory.ts');
const {continuousSpeed,hasProcessedCoverage,smoothedSpeed}=load('apps/desktop/src/renderer/features/timeline/metrics.ts');
const {alignedMediaStart,splitAlignmentOffset,validAlignmentOffset}=load('apps/desktop/src/shared/mediaAlignment.ts');
const {packMotionGpsResult,unpackMotionGpsResult}=load('apps/desktop/src/shared/motionGpsWire.ts');
const R=6371000,rad=Math.PI/180,base=1800000000,v=10,w=.2;
const point=t=>({timeSeconds:base+t,longitude:116+v/w*(1-Math.cos(w*t))/(R*Math.cos(40*rad))/rad,latitude:40+v/w*Math.sin(w*t)/R/rad});
function fixture(start, end, first = start, last = end) {
  return {
    videoStartSeconds: base + start, videoEndSeconds: base + end,
    points: Array.from({length: Math.round((last - first) * 10) + 1}, (_, i) => point(first + i / 10)),
    contextPoints: [point(first - .1), point(last + .1)],
    correctedPoints: 0, curvedIntervals: 0, smoothedIntervals: 0, bridgedIntervals: 0, reason: 'fixture',
  };
}
const result = fixture(-2, 20, 0, 20);
assert.equal(validAlignmentOffset(-.375),true);
assert.equal(validAlignmentOffset(.0001),false);
assert.deepEqual(splitAlignmentOffset(750,.375),{wholeSeconds:1,residualMs:125});
assert.deepEqual(splitAlignmentOffset(-750,-.375),{wholeSeconds:-1,residualMs:-125});
assert.equal(alignedMediaStart(base,.375),base+.375);
const raw={sourceName:'original.csv',timelineTimestamps:[(base-1)*1000,base*1000,(base+20)*1000,(base+21)*1000],timelineCoordinates:[116,40,116,40,point(20).longitude,point(20).latitude,116,40],timelineAltitudes:[0,10,30,40],footprintCoordinates:[1,2],photoCoordinates:[],footprintTimestamps:[1],photoTimestamps:[],pointCount:1,footprintPointCount:1,photoPointCount:0,skippedRowCount:0,bounds:[116,40,117,41],timeBounds:[(base-1)*1000,(base+21)*1000]};
const before=JSON.stringify(raw),derived=withProcessedTrajectory(raw,result);
assert.equal(JSON.stringify(raw),before);assert.equal(derived.sourceName,raw.sourceName);assert.equal(derived.footprintCoordinates,raw.footprintCoordinates);assert.equal(derived.timelineTimestamps[0],raw.timelineTimestamps[0]);assert.equal(derived.timelineTimestamps.at(-1),raw.timelineTimestamps.at(-1));assert.equal(derived.timelineAltitudes[1],10);assert.equal(derived.timelineAltitudes.at(-2),30);
assert(derived.timelineTimestamps.every((t,i)=>!i||t>derived.timelineTimestamps[i-1]));
assert.equal(hasProcessedCoverage(derived,(base-1)*1000),false);
assert.equal(continuousSpeed(derived,(base-1)*1000),null);
assert(continuousSpeed(derived,(base+.5)*1000)>30,'Speed chart must use processed points');
assert.equal(hasProcessedCoverage(derived,(base+10)*1000),true);
assert(continuousSpeed(derived,(base+10)*1000)>0);
const clipped = fixture(50.125, 53.425);
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
const short = fixture(3, 8);
short.contextPoints = [...result.contextPoints, ...result.points].filter(p => p.timeSeconds < base+3 || p.timeSeconds > base+8).sort((a,b) => a.timeSeconds-b.timeSeconds);
const shortTrack = withProcessedTrajectory(raw, short);
for (const time of [base+3,base+8]) assert.equal(smoothedSpeed(shortTrack,time*1000),smoothedSpeed(derived,time*1000),'Speed at the clip edge must use the same context');
const sparse={footprintTimestamps:Array.from({length:21},(_,i)=>(base+i*10)*1000),footprintCoordinates:Array.from({length:42},()=>0)};
const analysisPoints=motionInputPoints(sparse,base+80,40);
assert.deepEqual(motionInputPoints({
  footprintTimestamps: Float64Array.from(sparse.footprintTimestamps),
  footprintCoordinates: Float64Array.from(sparse.footprintCoordinates),
},base+80,40),analysisPoints);
assert.equal(analysisPoints.filter(p=>p.timeSeconds<base+80).length,8);
assert.equal(analysisPoints.filter(p=>p.timeSeconds>base+120).length,8);
const unbracketed=withProcessedTrajectory(raw,fixture(0, 20, 10, 11));
assert.equal(hasProcessedCoverage(unbracketed,(base+2)*1000),false);
assert.equal(hasProcessedCoverage(unbracketed,(base+15)*1000),false);
console.log('Motion GPS passed: renderer integration, context and wire round trip.');

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
