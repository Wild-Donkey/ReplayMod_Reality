import type {PointDataset} from "../../../../../../packages/data/src";
import type {MotionGpsResult} from "../../../../../../packages/media/src/gps-motion";

export function motionInputPoints(dataset: PointDataset, start: number, duration: number) {
 const times = dataset.footprintTimestamps;
 const lowerBound = (time: number) => {
  let low = 0, high = times.length;
  while (low < high) {
   const middle = (low + high) >>> 1;
   if (times[middle] < time) low = middle + 1;
   else high = middle;
  }
  return low;
 };
 const startMs = Math.round(start * 1000), endMs = startMs + duration * 1000;
 let before = lowerBound(startMs), after = lowerBound(endMs);
 // Count distinct fixes so duplicate timestamps cannot consume the context quota.
 for (let count = 0; before > 0 && count < 8; count++) {
  const time = times[--before];
  while (before > 0 && times[before - 1] === time) before--;
 }
 while (after < times.length && times[after] <= endMs) after++;
 for (let count = 0; after < times.length && count < 8; count++) {
  const time = times[after++];
  while (after < times.length && times[after] === time) after++;
 }
 const first = Math.min(before, lowerBound(startMs - 25_000));
 const last = Math.max(after, lowerBound(endMs + 25_000));
 return times.slice(first, last).map((time, index) => ({
  timeSeconds: time / 1000,
  longitude: dataset.footprintCoordinates[(first + index) * 2],
  latitude: dataset.footprintCoordinates[(first + index) * 2 + 1],
 }));
}

/** Derived timeline only: source arrays, identity, path and source selection remain untouched. */
export function withProcessedTrajectory(raw:PointDataset,result:MotionGpsResult):PointDataset {
 if(result.points.length<2)return raw;
 const start=result.points[0].timeSeconds*1000,end=result.points.at(-1)!.timeSeconds*1000;
 const coordinates:number[]=[],timestamps:number[]=[],altitudes:number[]=[];
 let cursor=0;
 const altitude=(time:number)=>{
  while(cursor<raw.timelineTimestamps.length-1&&raw.timelineTimestamps[cursor+1]<time)cursor++;
  const right=Math.min(cursor+1,raw.timelineTimestamps.length-1),dt=raw.timelineTimestamps[right]-raw.timelineTimestamps[cursor];
  const t=dt>0?Math.max(0,Math.min(1,(time-raw.timelineTimestamps[cursor])/dt)):0;
  return raw.timelineAltitudes[cursor]+(raw.timelineAltitudes[right]-raw.timelineAltitudes[cursor])*t;
 };
 const appendRaw=(i:number)=>{timestamps.push(raw.timelineTimestamps[i]);coordinates.push(raw.timelineCoordinates[i*2],raw.timelineCoordinates[i*2+1]);altitudes.push(raw.timelineAltitudes[i]);};
 let i=0;while(i<raw.timelineTimestamps.length&&raw.timelineTimestamps[i]<start)appendRaw(i++);
 const processedTimes:number[]=[],processedCoordinates:number[]=[];
 for(const p of result.points){
  const time=p.timeSeconds*1000;
  timestamps.push(time);coordinates.push(p.longitude,p.latitude);altitudes.push(p.altitude??altitude(time));
 }
 while(i<raw.timelineTimestamps.length&&raw.timelineTimestamps[i]<=end)i++;
 while(i<raw.timelineTimestamps.length)appendRaw(i++);
 const context = result.contextPoints ?? [];
 const before = context.filter(point => point.timeSeconds < result.videoStartSeconds);
 const after = context.filter(point => point.timeSeconds > result.videoEndSeconds);
 for(const point of [...before,...result.points,...after]){
  processedTimes.push(point.timeSeconds * 1000);
  processedCoordinates.push(point.longitude,point.latitude);
 }
 return {...raw,timelineCoordinates:coordinates,timelineTimestamps:timestamps,timelineAltitudes:altitudes,
  processedMotion:{footprintTimestamps:processedTimes,footprintCoordinates:processedCoordinates,
   timeBounds:[result.videoStartSeconds*1000,result.videoEndSeconds*1000]}};
}
