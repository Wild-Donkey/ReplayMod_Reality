import type {PointDataset} from "../../../../../../packages/data/src";
import type {MotionGpsResult} from "../../../../../../packages/media/src/gps-motion";

function timeBound(times: ArrayLike<number>, time: number, inclusive = false) {
 let low = 0, high = times.length;
 while (low < high) {
  const middle = (low + high) >>> 1;
  if (times[middle] < time || (inclusive && times[middle] === time)) low = middle + 1;
  else high = middle;
 }
 return low;
}

export function motionInputPoints(dataset: PointDataset, start: number, duration: number) {
 const times = dataset.footprintTimestamps;
 const startMs = Math.round(start * 1000), endMs = startMs + duration * 1000;
 let before = timeBound(times,startMs), after = timeBound(times,endMs,true);
 // Count distinct fixes so duplicate timestamps cannot consume the context quota.
 for (let count = 0; before > 0 && count < 8; count++) {
  const time = times[--before];
  while (before > 0 && times[before - 1] === time) before--;
 }
 for (let count = 0; after < times.length && count < 8; count++) {
  const time = times[after++];
  while (after < times.length && times[after] === time) after++;
 }
 const first = Math.min(before, timeBound(times,startMs - 25_000));
 const last = Math.max(after, timeBound(times,endMs + 25_000));
 return Array.from({length:last-first}, (_, index) => ({
  timeSeconds: times[first+index] / 1000,
  longitude: dataset.footprintCoordinates[(first + index) * 2],
  latitude: dataset.footprintCoordinates[(first + index) * 2 + 1],
 }));
}

/** Derived timeline only: source arrays, identity, path and source selection remain untouched. */
export function withProcessedTrajectory(raw:PointDataset,result:MotionGpsResult):PointDataset {
 if(result.points.length<2)return raw;
 const start=result.points[0].timeSeconds*1000,end=result.points.at(-1)!.timeSeconds*1000;
 const times = raw.timelineTimestamps;
 const first = timeBound(times,start), last = timeBound(times,end,true);
 const length = first + result.points.length + times.length - last;
 const coordinates = new Float64Array(length * 2), timestamps = new Float64Array(length), altitudes = new Float64Array(length);
 let cursor = Math.max(0,first-1), output = 0;
 const altitude=(time:number)=>{
  while(cursor<raw.timelineTimestamps.length-1&&raw.timelineTimestamps[cursor+1]<time)cursor++;
  const right=Math.min(cursor+1,raw.timelineTimestamps.length-1),dt=raw.timelineTimestamps[right]-raw.timelineTimestamps[cursor];
  const t=dt>0?Math.max(0,Math.min(1,(time-raw.timelineTimestamps[cursor])/dt)):0;
  return raw.timelineAltitudes[cursor]+(raw.timelineAltitudes[right]-raw.timelineAltitudes[cursor])*t;
 };
 const append = (time: number, longitude: number, latitude: number, height: number) => {
  timestamps[output] = time;
  coordinates[output*2] = longitude;
  coordinates[output*2+1] = latitude;
  altitudes[output++] = height;
 };
 const appendRaw=(i:number)=>append(times[i],raw.timelineCoordinates[i*2],raw.timelineCoordinates[i*2+1],raw.timelineAltitudes[i]);
 for (let i = 0; i < first; i++) appendRaw(i);
 for(const p of result.points){
  const time=p.timeSeconds*1000;
  append(time,p.longitude,p.latitude,p.altitude??altitude(time));
 }
 for (let i = last; i < times.length; i++) appendRaw(i);
 const context = result.contextPoints ?? [];
 const before = context.filter(point => point.timeSeconds < result.videoStartSeconds);
 const after = context.filter(point => point.timeSeconds > result.videoEndSeconds);
 const processedTimes = new Float64Array(before.length + result.points.length + after.length);
 const processedCoordinates = new Float64Array(processedTimes.length * 2);
 let sample = 0;
 for(const series of [before,result.points,after]) {
  for(const point of series){
   processedTimes[sample] = point.timeSeconds * 1000;
   processedCoordinates[sample*2] = point.longitude;
   processedCoordinates[sample*2+1] = point.latitude;
   sample++;
  }
 }
 return {...raw,timelineCoordinates:coordinates,timelineTimestamps:timestamps,timelineAltitudes:altitudes,
  processedMotion:{footprintTimestamps:processedTimes,footprintCoordinates:processedCoordinates,
   timeBounds:[result.videoStartSeconds*1000,result.videoEndSeconds*1000]}};
}
